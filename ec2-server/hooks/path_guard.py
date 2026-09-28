#!/usr/bin/env python3
# PreToolUse hook for standard-user chats. A CLAUDE.md instruction to "stay
# in your folder" is a prompt, not a guardrail - this makes it a real one.
#
# Read/Write: block any call whose resolved path falls
# outside this chat's own directory (its cwd). Straightforward - the tool
# input names one file, so checking it is exact.
#
# Bash: a shell command can't be checked the same way - there is no bounded
# set of "bad" patterns to block, since a path can be encoded, substituted,
# or built up in effectively unlimited ways. So this does the opposite of
# blocking known-bad: it ALLOWS only a short list of known-good command
# shapes (the app's actual documented grading workflow - see chats.py's
# grading_persona) and blocks everything else by default. An allowlist
# doesn't need to anticipate every bypass trick; if a command doesn't
# structurally match one of these shapes, it never runs, full stop.
import json
import os
import re
import sys

try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)

tool = data.get("tool_name")
tool_input = data.get("tool_input") or {}


def block(reason):
    print(json.dumps({"decision": "block", "reason": reason}))
    sys.exit(0)


def allow():
    print(json.dumps({}))
    sys.exit(0)


if tool in ("Read", "Write"):
    path = tool_input.get("file_path") or tool_input.get("path")
    if path:
        chat_dir = os.path.realpath(os.getcwd())
        candidate = path if os.path.isabs(path) else os.path.join(os.getcwd(), path)
        resolved = os.path.realpath(candidate)
        if resolved != chat_dir and not resolved.startswith(chat_dir + os.sep):
            block(f"Blocked: '{path}' resolves outside this chat's own directory ({chat_dir}).")
    allow()

if tool == "Bash":
    cmd = (tool_input.get("command") or "").strip()

    # Belt-and-suspenders: no allowed shape ever needs ".." or an absolute
    # path outside the two fixed system binaries below, so reject it on
    # sight rather than trust the regexes below to catch every case of it.
    if ".." in cmd:
        block("Blocked: '..' is never valid in an allowed command shape.")

    ALLOWED = [
        # Direct SQL through the restricted grading_app role.
        r'^sudo /usr/local/bin/grading_query\.sh "(?:[^"\\]|\\.)*"$',
        # SQL from a file this same session already wrote via the Write
        # tool (which is itself bounded to this chat's own directory) -
        # relative path, no directory traversal, .sql only.
        r'^sudo /usr/local/bin/grading_query\.sh -f [A-Za-z0-9_.-]+\.sql$',
        # Turning text into an embedding for similarity search - no file
        # access at all, just stdin -> stdout.
        r'^echo "(?:[^"\\]|\\.)*" \| python3 /home/ec2-user/embed_text\.py$',
    ]
    if any(re.match(p, cmd) for p in ALLOWED):
        allow()
    block(
        "Blocked: this command doesn't match an allowed shape for this "
        "chat. Only running grading_query.sh (direct or -f a local .sql "
        "file) or embed_text.py is permitted here."
    )

allow()
