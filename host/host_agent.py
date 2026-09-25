"""
Host agent. Runs on your PC. Connects OUT to a relay (local for now, AWS later).
Spawns Claude Code, reads its streaming JSON output, forwards replies to the relay.

Run: python host_agent.py
"""
import asyncio
import json
import os
import secrets
import websockets

CLAUDE = r"C:\Users\jypar\.local\bin\claude.exe"

# The relay's own room model has no real access control of its own - a room
# IS its token, so whoever knows the token can join it. The hardcoded
# token=test this used to send meant ANY client that also hardcoded "test"
# (as test_client.py did) landed in the SAME room automatically - not a
# secret, a public literal sitting in checked-in source. Since this agent
# spawns `claude --dangerously-skip-permissions` with full local access,
# whoever can join the room can run arbitrary commands on this machine.
# Currently harmless only because the relay binds to localhost - if this
# ever points at a real, non-local relay, a real secret is the only thing
# standing in the way. RELAY_TOKEN lets you pin a known value (e.g. to
# match what you've told a specific client out of band); otherwise a fresh
# unguessable one is generated and printed here each run - never reuse a
# hardcoded literal.
RELAY_TOKEN = os.environ.get("RELAY_TOKEN") or secrets.token_urlsafe(24)
print(f"relay token for this session: {RELAY_TOKEN}")
RELAY_URL = f"ws://localhost:3580/?token={RELAY_TOKEN}&role=host"

session_id = None  # lets Claude resume the same conversation across messages


async def run_claude(prompt: str, send_reply):
    """Spawn Claude with the given prompt, stream its text back via send_reply."""
    global session_id

    args = [CLAUDE, "--dangerously-skip-permissions",
            "--output-format", "stream-json", "--verbose", "--print", "-"]
    if session_id:
        args += ["--resume", session_id]

    proc = await asyncio.create_subprocess_exec(
        *args,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=os.path.expanduser("~"),
    )
    proc.stdin.write(prompt.encode())
    proc.stdin.close()

    response_text = ""
    async for line in proc.stdout:
        line = line.decode().strip()
        if not line:
            continue
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue

        if ev.get("type") == "system" and ev.get("subtype") == "init" and ev.get("session_id"):
            session_id = ev["session_id"]

        if ev.get("type") == "assistant":
            for block in ev.get("message", {}).get("content", []):
                if block.get("type") == "text" and block.get("text"):
                    response_text += block["text"]
                    await send_reply({"type": "output", "data": block["text"]})
                elif block.get("type") == "tool_use":
                    await send_reply({"type": "tool_use", "text": block.get("name", "")})

        if ev.get("type") == "result" and ev.get("session_id"):
            session_id = ev["session_id"]

    await proc.wait()
    await send_reply({"type": "response_done"})
    print(f"claude done: {response_text[:80]}")


async def main():
    async with websockets.connect(RELAY_URL) as ws:
        print("connected to relay")

        async def send_reply(msg):
            await ws.send(json.dumps(msg))

        async for raw in ws:
            msg = json.loads(raw)
            if msg.get("type") == "input":
                print(f"got message: {msg['data'][:60]}")
                await run_claude(msg["data"], send_reply)


if __name__ == "__main__":
    asyncio.run(main())
