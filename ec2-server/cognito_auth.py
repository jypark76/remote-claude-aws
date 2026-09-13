"""Shared Cognito JWT verification, used by both the grading routes and the chat routes."""
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


def get_jwks():
    global _jwks_cache
    if _jwks_cache is None:
        with urllib.request.urlopen(JWKS_URL) as resp:
            _jwks_cache = json.loads(resp.read())
    return _jwks_cache


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


def username_from_claims(claims):
    return claims.get("cognito:username") or claims.get("username")


def role_for(username):
    return "admin" if username == "admin" else "user"


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
        g.role = role_for(g.username)
        return f(*args, **kwargs)
    return wrapper


def verify_token_or_none(token):
    if not token:
        return None
    try:
        return verify_token(token)
    except Exception:
        return None
