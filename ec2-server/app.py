"""
remote_claude server. Runs on EC2, always on (managed by systemd, see
/etc/systemd/system/remote-claude.service).

The actual chat/grading engine lives in chats.py — it spawns the real Claude
Code CLI per chat, which reads and writes the shared Postgres database
directly via psql for anything assignment-related (rubrics, examples,
submissions, grading attempts). This file just wires up the Flask app and
serves the built React UI.
"""
from flask import Flask, jsonify, send_from_directory
import os

from chats import init_chats

app = Flask(__name__)
# No CORS(app) here on purpose: the real site and this API are always served
# from the same origin (see config.js's API_BASE comment), so cross-origin
# requests are never legitimate - only ever an attacker's page trying to call
# a logged-in user's session. Nothing needs allowing.
app.config["MAX_CONTENT_LENGTH"] = 50 * 1024 * 1024  # 50MB - this box has an 8GB disk total
init_chats(app)


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"ok": True})


WEB_DIR = os.path.join(os.path.expanduser("~"), "web")


@app.route("/", defaults={"path": ""})
@app.route("/<path:path>")
def serve_ui(path):
    """Serves the built React app. Anything that isn't a real file (e.g. a
    refresh on a client-side view) falls back to index.html.

    index.html itself is never cache-busted (its filename doesn't change),
    so it must never be cached - otherwise a browser can keep pointing at
    JS/CSS bundles that were already deleted off disk by a later deploy."""
    full = os.path.join(WEB_DIR, path)
    if path and os.path.isfile(full):
        return send_from_directory(WEB_DIR, path)
    resp = send_from_directory(WEB_DIR, "index.html")
    resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return resp


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, threaded=True)
