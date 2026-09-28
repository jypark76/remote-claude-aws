"""
Read-only external API — lets colleagues outside this app pull data from
Postgres (assignments, graded examples, submissions, grading attempts)
from a script, notebook, or BI tool, without ever touching the chat app
itself or the grading_app database role.

Talks to Postgres directly via psycopg2, using the readonly_api role's
credentials (READONLY_DB_HOST/READONLY_DB_USER/READONLY_DB_PASSWORD in
app.env) — a real database driver, not the grading_query.sh subprocess
wrapper, because that wrapper exists specifically to keep credentials out
of reach of the grading AI's own Bash tool. This code IS the trusted
Flask app process, so it can hold this credential directly.

readonly_api has SELECT-only grants (see the CREATE ROLE/GRANT statements
run directly against RDS — not tracked here, same as grading_app) so even
a bug in this file can't write to the database.

Rate limiting uses a SEPARATE role, rate_limiter (RATE_LIMITER_DB_USER/
RATE_LIMITER_DB_PASSWORD), scoped to SELECT/INSERT on exactly one table
(rate_limit_events) - never DELETE, and no access to the 4 real data
tables at all. Its state has to live in Postgres rather than this
process's own memory because this app runs on TWO EC2 instances behind a
load balancer; an in-memory counter on either box only ever sees the
traffic THAT box happened to receive, never the true total.
"""
import hashlib
import logging
import os
from functools import wraps
from logging.handlers import RotatingFileHandler

import psycopg2
import psycopg2.extras
from flask import g, jsonify, request, send_from_directory

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

MAX_LIMIT = 500
DEFAULT_LIMIT = 50
RATE_LIMIT_PER_MINUTE = 30

# Access log for this API specifically - the first structured logging
# anywhere in this app (everything else uses bare print()). Deliberately a
# local file, not the database: readonly_api is SELECT-only on purpose, and
# logging shouldn't be the reason a write-capable credential gets
# introduced. Rotated to bound disk use - this box has 8GB total (see
# app.py's MAX_CONTENT_LENGTH comment).
_access_logger = logging.getLogger("external_api.access")
_access_logger.setLevel(logging.INFO)
_access_logger.propagate = False  # keep this out of gunicorn's own stdout/stderr stream
_log_path = os.path.join(os.path.expanduser("~"), "external_api_access.log")
_handler = RotatingFileHandler(_log_path, maxBytes=5 * 1024 * 1024, backupCount=3)
_handler.setFormatter(logging.Formatter("%(asctime)s %(message)s"))
_access_logger.addHandler(_handler)


def _log_access(outcome, colleague_name=None, row_count=None):
    """One line per request, success or not. A burst of invalid_key/
    rate_limited entries is itself a signal (someone guessing keys or
    scripting past the limit) - not just success rows worth recording, per
    OWASP API Security Top 10's API2/API6."""
    _access_logger.info(
        "outcome=%s colleague=%s ip=%s endpoint=%s rows=%s",
        outcome,
        colleague_name or "-",
        request.remote_addr,
        request.path,
        row_count if row_count is not None else "-",
    )

# Every table this API is allowed to read from. Deliberately a fixed
# allowlist, not "any table name the caller sends" — same principle as
# chats.py's own /api/tables/<table_name> route, which validates against
# information_schema before ever using a name in a query.
TABLES = ("assignments", "graded_examples", "submissions", "grading_attempts")

# Swagger UI's JS/CSS loaded from jsdelivr, not installed as a Python
# package - this app has no templating engine, so the page is just a plain
# string constant, same pattern chats.py already uses for GREETING_TEXT/
# BASE_CLAUDE_MD. "@5" (not an exact pinned patch version) always resolves
# to the latest 5.x release, since this session's sandbox network policy
# blocks both jsdelivr and cdnjs, making it impossible to verify one exact
# version actually exists from here - confirm this page actually renders
# in a real browser once deployed.
DOCS_HTML = """<!doctype html>
<html>
<head>
  <title>External API docs</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css">
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    window.onload = () => SwaggerUIBundle({
      url: "/api/v1/external/openapi.yaml",
      dom_id: "#swagger-ui",
    });
  </script>
</body>
</html>"""


def _get_conn():
    """One connection per request — this API is low-traffic (a handful of
    colleagues, not the chat app's own traffic), so a connection pool would
    be more complexity than the load justifies right now."""
    return psycopg2.connect(
        host=os.environ["READONLY_DB_HOST"],
        dbname="postgres",
        user=os.environ["READONLY_DB_USER"],
        password=os.environ["READONLY_DB_PASSWORD"],
        connect_timeout=5,
    )


def _hash_key(raw_key):
    return hashlib.sha256(raw_key.encode("utf-8")).hexdigest()


def _get_rate_limiter_conn():
    """Separate connection, separate role from _get_conn()/readonly_api -
    rate_limiter can SELECT/INSERT on rate_limit_events only, nothing else,
    so it can't read any real data even if this code had a bug. Same
    READONLY_DB_HOST (same RDS server), different user/password."""
    return psycopg2.connect(
        host=os.environ["READONLY_DB_HOST"],
        dbname="postgres",
        user=os.environ["RATE_LIMITER_DB_USER"],
        password=os.environ["RATE_LIMITER_DB_PASSWORD"],
        connect_timeout=5,
    )


def _check_rate_limit(key_hash):
    """True if this key is still under RATE_LIMIT_PER_MINUTE, recording this
    request if so. Backed by Postgres, not in-process memory - two EC2
    instances behind the ALB each have their own separate process, so an
    in-memory counter only ever sees the fraction of a burst that the load
    balancer happened to route to THAT box, never the real total (this is
    exactly the bug an in-memory version of this function had - confirmed
    live via api_owasp.py's rate-limit case passing 31 rapid requests
    straight through with no 429, split roughly evenly across both
    instances). Postgres is one thing both instances already share, so
    counting there gives an accurate global count regardless of which
    instance(s) handle a given burst.

    Windowed COUNT, not delete-then-count: older rows are simply excluded
    by the WHERE clause, never removed - this code never issues a DELETE.
    rate_limit_events grows without automatic pruning as a result; at this
    app's actual scale (a handful of colleagues) that's a slow trickle,
    and reclaiming space later is a deliberate manual choice, not
    something the app does to itself.

    Two separate round trips (COUNT, then INSERT), not one atomic
    transaction - a theoretical race lets two near-simultaneous requests
    both pass the same count check before either INSERTs. Accepted at this
    scale, same tradeoff as _get_conn()'s one-connection-per-request (no
    pool)."""
    conn = _get_rate_limiter_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT COUNT(*) FROM rate_limit_events "
                "WHERE key_hash = %s AND requested_at > now() - interval '60 seconds'",
                (key_hash,),
            )
            (count,) = cur.fetchone()
            if count >= RATE_LIMIT_PER_MINUTE:
                return False
            cur.execute("INSERT INTO rate_limit_events (key_hash) VALUES (%s)", (key_hash,))
            conn.commit()
            return True
    finally:
        conn.close()


def require_api_key(view):
    """Checks Authorization: Bearer <key> against api_keys.key_hash. Colleagues
    never get a database credential of their own - just this key, which this
    decorator translates into 'yes, let the app's own readonly_api connection
    run the query on their behalf' (same shape as chats.py's require_auth,
    but keyed by a hashed API key instead of a Cognito JWT)."""

    @wraps(view)
    def wrapped(*args, **kwargs):
        auth_header = request.headers.get("Authorization", "")
        if not auth_header.startswith("Bearer "):
            _log_access("missing_key")
            return jsonify({"error": "missing Authorization: Bearer <key> header"}), 401
        raw_key = auth_header[len("Bearer "):].strip()
        if not raw_key:
            _log_access("missing_key")
            return jsonify({"error": "missing Authorization: Bearer <key> header"}), 401

        key_hash = _hash_key(raw_key)
        conn = _get_conn()
        try:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(
                    "SELECT colleague_name, revoked_at FROM api_keys WHERE key_hash = %s",
                    (key_hash,),
                )
                row = cur.fetchone()
        finally:
            conn.close()

        if row is None:
            _log_access("invalid_key")
            return jsonify({"error": "invalid API key"}), 401
        if row["revoked_at"] is not None:
            _log_access("revoked_key", colleague_name=row["colleague_name"])
            return jsonify({"error": "this API key has been revoked"}), 401

        # Rate limit is checked AFTER key validation, not before - an invalid
        # key should never be able to consume a valid key's rate-limit budget
        # (they're separate buckets, keyed by key_hash, so this ordering
        # doesn't actually matter for isolation - but checking auth first
        # means a bad key always gets the same 401 regardless of how many
        # requests were sent, rather than sometimes surfacing 429 instead).
        if not _check_rate_limit(key_hash):
            _log_access("rate_limited", colleague_name=row["colleague_name"])
            return jsonify({"error": f"rate limit exceeded ({RATE_LIMIT_PER_MINUTE} requests/minute)"}), 429

        g.colleague_name = row["colleague_name"]
        return view(*args, **kwargs)

    return wrapped


def _paginated_table_query(table_name):
    """Shared logic behind every table endpoint below: parse limit/offset,
    clamp them to sane bounds, run the query, return plain JSON-able rows."""
    try:
        limit = min(int(request.args.get("limit", DEFAULT_LIMIT)), MAX_LIMIT)
        offset = max(int(request.args.get("offset", 0)), 0)
    except ValueError:
        return jsonify({"error": "limit/offset must be integers"}), 400

    conn = _get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            # table_name is never taken from the request - each route below
            # calls this with one of the fixed names in TABLES, not a
            # caller-supplied string, so there is no injection surface here.
            cur.execute(f"SELECT * FROM {table_name} ORDER BY created_at DESC LIMIT %s OFFSET %s", (limit, offset))
            rows = cur.fetchall()
    finally:
        conn.close()
    _log_access("success", colleague_name=g.get("colleague_name"), row_count=len(rows))
    return jsonify({"rows": rows, "limit": limit, "offset": offset})


def init_external_api(app):
    """Wires up the /api/v1/external/* routes. Called from app.py the same
    way init_chats(app) is - keeping this as its own function/file instead
    of adding routes into chats.py, since this is a deliberately separate,
    external-facing surface from the AI-facing chat app."""

    @app.get("/api/v1/external/assignments")
    @require_api_key
    def external_assignments():
        return _paginated_table_query("assignments")

    @app.get("/api/v1/external/graded_examples")
    @require_api_key
    def external_graded_examples():
        return _paginated_table_query("graded_examples")

    @app.get("/api/v1/external/submissions")
    @require_api_key
    def external_submissions():
        return _paginated_table_query("submissions")

    @app.get("/api/v1/external/grading_attempts")
    @require_api_key
    def external_grading_attempts():
        return _paginated_table_query("grading_attempts")

    # Docs are deliberately public, no @require_api_key - they describe the
    # API's shape (endpoint names, parameters, that a key is required), not
    # actual data. Colleagues need to see how to use the API before they
    # have a key to test with, and hiding "here's how our API works" isn't
    # a meaningful security boundary anyway (this is the exact thing OWASP
    # API Security's API9, undocumented/forgotten APIs, argues should be
    # avoided - not something to hide).
    @app.get("/api/v1/external/openapi.yaml")
    def external_openapi_spec():
        return send_from_directory(BASE_DIR, "openapi.yaml", mimetype="application/yaml")

    @app.get("/api/v1/external/docs")
    def external_docs():
        return DOCS_HTML
