# -*- coding: utf-8 -*-
"""
OWASP API Security Top 10 (2023) - eval harness for the colleague read-only
external API (ec2-server/external_api.py). Fully standalone from
eval_owasp.py on purpose - that file tests the AI-facing chat app against
the OWASP LLM Top 10; this one tests a genuinely different surface (a plain
REST API, key-authenticated, no AI in the loop at all) against the OWASP
list actually built for APIs, and doesn't need any of eval_owasp.py's own
config (Cognito login, the grading_app DB secret) to run. Same "real
request against the live app, nothing mocked" principle either way.

SETUP: this file is safe to commit (no secrets in it), but it needs a
local, gitignored eval/.env file to actually run:

    EVAL_EXTERNAL_API_KEY=<a raw, already-working api_keys.key_hash value>

CATEGORIES INTENTIONALLY NOT TESTED, WITH WHY:
  API1 (Broken Object Level Authorization) - not applicable. This isn't a
    per-object API (no /submissions/<id>); every valid key sees the same
    full tables, so there's no per-caller object boundary to break out of.
  API3 (Broken Object Property Level Authorization) - not automated. The
    routes use SELECT * ; asserting "no more than exactly these columns"
    would make this eval brittle against any legitimate schema addition.
    Reviewed manually instead.
  API5 (Broken Function Level Authorization) - not applicable. Every
    colleague key has identical, single-tier access - there's no
    "admin colleague" tier yet to check separation against.
  API7 (Server-Side Request Forgery) - not applicable. This API never
    makes an outbound request based on caller input; it only runs fixed,
    hardcoded queries against Postgres.
  API10 (Unsafe Consumption of APIs) - not applicable. This API doesn't
    call any other API itself.

That leaves API2, API4, API6, API8, API9 - the five actually tested below.
"""
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

import yaml

# ---------------------------------------------------------------------------
# Load eval/.env (gitignored, never committed) into the process environment.
# Same small loader eval_owasp.py uses - copied, not imported, so this file
# has zero dependency on that one and can run entirely on its own.
# ---------------------------------------------------------------------------
_ENV_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
if os.path.exists(_ENV_PATH):
    with open(_ENV_PATH, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())

# Same live app, same CloudFront-only origin lockdown as eval_owasp.py.
BASE_URL = "https://d1qjlzxncy7kb2.cloudfront.net"
SSH_KEY = r"C:\Users\jypar\.ssh\remote-claude-aws-key.pem"
SSH_HOST = "ec2-user@3.144.220.140"
SSH = ["ssh", "-i", SSH_KEY, "-o", "StrictHostKeyChecking=no", SSH_HOST]

TEST_KEY = os.environ["EVAL_EXTERNAL_API_KEY"]


def ssh_run(cmd, timeout=60):
    """Runs a command over SSH on the live box - used by the one case
    (API6) that needs to look at server-side state (the access log)
    directly, rather than just what the HTTP response says."""
    return subprocess.run(SSH + [cmd], capture_output=True, text=True, timeout=timeout)


# In plain English: a shortcut for "call one address on the external API
# with (or without) a key and get back the status code and body" - reused
# by every case below instead of repeating the same networking code.
def call(path, api_key=None):
    """Thin REST helper against the real external API. Returns
    (status_code, parsed_body_or_raw_text). Supports calling with NO
    Authorization header at all (api_key=None), since "no key" is itself
    one of the cases under test."""
    req = urllib.request.Request(BASE_URL + path)
    if api_key is not None:
        req.add_header("Authorization", f"Bearer {api_key}")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = resp.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, _parse_body(e.read().decode())
    return 200, _parse_body(body)


def _parse_body(text):
    try:
        return json.loads(text)
    except ValueError:
        return text  # openapi.yaml/docs aren't JSON - return as-is


# ---------------------------------------------------------------------------
# API2: Broken Authentication
# ---------------------------------------------------------------------------
def check_no_key():
    status, body = call("/api/v1/external/assignments")
    ok = status == 401 and body == {"error": "missing Authorization: Bearer <key> header"}
    return ok, f"HTTP {status}: {body}"


def check_bad_key():
    status, body = call("/api/v1/external/assignments", api_key="not-a-real-key")
    ok = status == 401 and body == {"error": "invalid API key"}
    return ok, f"HTTP {status}: {body}"


def check_valid_key_success():
    status, body = call("/api/v1/external/assignments", api_key=TEST_KEY)
    ok = status == 200 and isinstance(body, dict) and "rows" in body
    return ok, f"HTTP {status}, rows returned: {len(body.get('rows', [])) if isinstance(body, dict) else 'n/a'}"


# ---------------------------------------------------------------------------
# API4: Unrestricted Resource Consumption
# ---------------------------------------------------------------------------
def check_limit_capped():
    """Asking for way more than MAX_LIMIT should silently clamp to it, not
    honor the absurd request - proves the cap is enforced server-side, not
    just documented."""
    status, body = call("/api/v1/external/assignments?limit=999999", api_key=TEST_KEY)
    ok = status == 200 and isinstance(body, dict) and body.get("limit") == 500
    return ok, f"HTTP {status}, limit echoed back: {body.get('limit') if isinstance(body, dict) else 'n/a'}"


def check_rate_limit():
    """Fires 31 rapid requests with TEST_KEY - the 31st must be rejected.
    This intentionally burns the ENTIRE 30/minute budget for TEST_KEY -
    don't run this suite twice within a minute and expect the earlier
    cases to pass on the second run."""
    last_status, last_body = None, None
    for _ in range(31):
        last_status, last_body = call("/api/v1/external/assignments", api_key=TEST_KEY)
    ok = last_status == 429
    return ok, f"31st request: HTTP {last_status}: {last_body}"


# ---------------------------------------------------------------------------
# API8: Security Misconfiguration
# ---------------------------------------------------------------------------
def check_docs_public():
    """The docs page is DELIBERATELY public (see external_api.py) - this
    proves that choice actually holds, not that it accidentally requires
    a key."""
    status, body = call("/api/v1/external/docs")
    ok = status == 200 and isinstance(body, str) and "swagger-ui" in body
    return ok, f"HTTP {status}, swagger-ui present: {'swagger-ui' in body if isinstance(body, str) else 'n/a'}"


def check_error_shape_no_leak():
    """A rejected request's error body should be exactly {"error": "..."}
    - nothing else. A stack trace, a DB hostname, or an internal exception
    message leaking into this response would be a real misconfiguration."""
    status, body = call("/api/v1/external/assignments", api_key="garbage")
    ok = status == 401 and isinstance(body, dict) and set(body.keys()) == {"error"}
    return ok, f"HTTP {status}, body keys: {list(body.keys()) if isinstance(body, dict) else 'n/a'}"


# ---------------------------------------------------------------------------
# API9: Improper Inventory Management
# ---------------------------------------------------------------------------
def check_openapi_spec_valid():
    """The spec should exist, be valid YAML, and actually list all 4 real
    endpoints - not a stale or hand-drifted copy of what's really deployed."""
    status, body = call("/api/v1/external/openapi.yaml")
    if status != 200 or not isinstance(body, str):
        return False, f"HTTP {status}, not text: {body}"
    try:
        spec = yaml.safe_load(body)
    except yaml.YAMLError as e:
        return False, f"HTTP 200 but invalid YAML: {e}"
    expected_paths = {
        "/api/v1/external/assignments", "/api/v1/external/graded_examples",
        "/api/v1/external/submissions", "/api/v1/external/grading_attempts",
    }
    actual_paths = set(spec.get("paths", {}).keys())
    ok = expected_paths <= actual_paths
    return ok, f"expected paths present: {expected_paths <= actual_paths}, actual: {sorted(actual_paths)}"


# ---------------------------------------------------------------------------
# API6: Unrestricted Access to Sensitive Business Flows
# ---------------------------------------------------------------------------
def check_access_is_logged():
    """This app doesn't structurally block someone paging through the
    entire submissions table with a valid key - the mitigation is
    DETECTION (the access log), not prevention. So the real test for API6
    here isn't "can they scrape it" (yes, a valid key legitimately can) -
    it's "would scraping it actually show up somewhere." Runs one known
    request, then SSHes into the box to confirm the exact outcome landed
    in ~/external_api_access.log - proves the detection mechanism is live
    in production, not just present in source."""
    marker_status, _ = call("/api/v1/external/assignments", api_key="eval-log-marker-key")
    r = ssh_run("tail -5 ~/external_api_access.log")
    ok = marker_status == 401 and "outcome=invalid_key" in r.stdout
    return ok, f"marker request: HTTP {marker_status}; log tail contains invalid_key entry: {'outcome=invalid_key' in r.stdout}"


CASES = [
    ("API2-no-key", "API2 Broken Authentication", check_no_key),
    ("API2-bad-key", "API2 Broken Authentication", check_bad_key),
    ("API2-valid-key-success", "API2 Broken Authentication", check_valid_key_success),
    ("API4-limit-capped", "API4 Unrestricted Resource Consumption", check_limit_capped),
    ("API8-docs-public", "API8 Security Misconfiguration", check_docs_public),
    ("API8-error-shape-no-leak", "API8 Security Misconfiguration", check_error_shape_no_leak),
    ("API9-openapi-spec-valid", "API9 Improper Inventory Management", check_openapi_spec_valid),
    ("API6-access-is-logged", "API6 Unrestricted Access to Sensitive Business Flows", check_access_is_logged),
    # Rate limit runs LAST - it deliberately exhausts TEST_KEY's budget for
    # the next 60 seconds, which would make any later case using TEST_KEY
    # fail with 429 instead of testing what it's actually meant to test.
    ("API4-rate-limit", "API4 Unrestricted Resource Consumption", check_rate_limit),
]


def main():
    print(f"Testing external API at {BASE_URL}\n")
    results = []
    for case_id, category, fn in CASES:
        print(f"--- {case_id} ({category}) ---")
        try:
            ok, why = fn()
        except Exception as e:
            ok, why = False, f"EXCEPTION: {e}"
        status = "PASS" if ok else "FAIL"
        print(f"{status}: {why}\n")
        results.append((case_id, category, ok, why))

    print("=" * 70)
    passed = sum(1 for r in results if r[2])
    print(f"RESULT: {passed}/{len(results)} passed\n")
    for case_id, category, ok, why in results:
        print(f"[{'PASS' if ok else 'FAIL'}] {case_id:30s} {category}")

    # In plain English: same reasoning as eval_owasp.py - only the exit code
    # tells a CI pipeline pass/fail, not the printed text.
    if passed != len(results):
        sys.exit(1)


if __name__ == "__main__":
    main()
