"""Shared Cognito JWT verification, used by both the grading routes and the chat routes."""
# In plain English: this file is the "ID checker." Every time someone logs
# in, AWS Cognito (a separate, outside login service) hands them a signed
# ID card (a "token"). This file's job is to check that the ID card is
# real, hasn't expired, and to read the person's username and role
# (admin/guest/regular user) off of it. Nothing in this app trusts a
# username or role that a request merely CLAIMS to have - it's always
# re-read from this verified card.
import json
import urllib.request
from functools import wraps

from flask import request, jsonify, g
from jose import jwt

COGNITO_REGION = "us-east-2"
COGNITO_USER_POOL_ID = "us-east-2_HteJiaJRw"
COGNITO_APP_CLIENT_ID = "2i3n92b14gl2gb6pl7jmivosdr"
COGNITO_ISSUER = f"https://cognito-idp.{COGNITO_REGION}.amazonaws.com/{COGNITO_USER_POOL_ID}"
JWKS_URL = f"{COGNITO_ISSUER}/.well-known/jwks.json"

_jwks_cache = None


# Fetches AWS Cognito's public "signature verification keys" (like a
# notary's official stamp pattern) so we can check an ID card was really
# signed by Cognito and not forged. Only fetched once and reused, since
# these keys practically never change.
def get_jwks():
    global _jwks_cache
    if _jwks_cache is None:
        with urllib.request.urlopen(JWKS_URL) as resp:
            _jwks_cache = json.loads(resp.read())
    return _jwks_cache


# The actual "is this ID card real?" check. Confirms the signature is
# genuinely from Cognito, that it was issued for THIS app specifically
# (not some other app using the same login service), and that it hasn't
# expired. Raises an error if anything about it looks wrong.
def verify_token(token):
    jwks = get_jwks()
    unverified_headers = jwt.get_unverified_headers(token)
    key = next((k for k in jwks["keys"] if k["kid"] == unverified_headers["kid"]), None)
    if key is None:
        raise ValueError("Signing key not found in Cognito's published key list")
    return jwt.decode(
        token,
        key,
        algorithms=["RS256"],
        audience=COGNITO_APP_CLIENT_ID,
        issuer=COGNITO_ISSUER,
    )


# Reads the username off of an already-verified ID card.
def username_from_claims(claims):
    return claims.get("cognito:username") or claims.get("username")


def role_for(claims):
    """Role comes from Cognito itself (username, and the signed cognito:groups
    claim for 'guests'), never from app-side string matching alone - a bug in
    a route handler can't accidentally grant guest privileges to a real user."""
    username = username_from_claims(claims)
    if username == "admin":
        return "admin"
    if "guests" in (claims.get("cognito:groups") or []):
        return "guest"
    return "user"


# A reusable "must be logged in" gate. Stick @require_auth above any web
# page/route and this runs first: it looks for the ID card in the request,
# checks it's real, and only then lets the actual page's own code run. If
# the card is missing or bad, the visitor gets rejected before your page's
# code ever sees the request.
def require_auth(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        auth_header = request.headers.get("Authorization", "")
        token = auth_header.replace("Bearer ", "").strip() or request.args.get("token", "")
        if not token:
            return jsonify({"error": "missing login token"}), 401
        try:
            claims = verify_token(token)
        except Exception as e:
            return jsonify({"error": "invalid or expired login token", "detail": str(e)}), 401
        g.username = username_from_claims(claims)
        g.role = role_for(claims)
        return f(*args, **kwargs)
    return wrapper


# Same ID check as verify_token, but for places where "not logged in" is a
# perfectly normal, expected outcome (not an error to reject with a 401) -
# it just quietly returns "nothing" instead of raising.
def verify_token_or_none(token):
    if not token:
        return None
    try:
        return verify_token(token)
    except Exception:
        return None
