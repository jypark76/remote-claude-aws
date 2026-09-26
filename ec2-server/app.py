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

# In plain English: this file is the "front door" of the server. It starts
# up the web server, hands it the real chat/grading logic (from chats.py),
# and serves up the website's HTML/JS/CSS files to the browser.
app = Flask(__name__)
# No CORS(app) here on purpose: the real site and this API are always served
# from the same origin (see config.js's API_BASE comment), so cross-origin
# requests are never legitimate - only ever an attacker's page trying to call
# a logged-in user's session. Nothing needs allowing.
app.config["MAX_CONTENT_LENGTH"] = 50 * 1024 * 1024  # 50MB - this box has an 8GB disk total
# Plug in every chat/grading feature (login checks, sending messages,
# uploading files, the database browser, etc.) - all of that lives in
# chats.py; this just switches it on.
init_chats(app)


# A simple "are you alive?" check. Nothing fancy - if this URL loads and
# says {"ok": true}, the server is up.
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
    # In plain English: whenever a browser asks for a page, hand back the
    # matching file if one exists (like a picture or a script file);
    # otherwise assume it's a request for the app itself and hand back the
    # main page, letting the React app figure out what to show.
    full = os.path.join(WEB_DIR, path)
    if path and os.path.isfile(full):
        return send_from_directory(WEB_DIR, path)
    resp = send_from_directory(WEB_DIR, "index.html")
    resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return resp


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, threaded=True)
