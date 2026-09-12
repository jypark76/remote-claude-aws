"""
Tiny local relay for testing, before AWS exists.
Same job as the Node relay: pass messages between one "host" and its "clients".
Run: python local_relay.py
"""
import asyncio
import json
from urllib.parse import urlparse, parse_qs
import websockets

rooms = {}  # token -> {"host": ws, "clients": set()}


def get_room(token):
    if token not in rooms:
        rooms[token] = {"host": None, "clients": set()}
    return rooms[token]


async def handler(ws):
    query = parse_qs(urlparse(ws.request.path).query)
    token = query.get("token", [None])[0]
    role = query.get("role", [None])[0]

    if not token or not role:
        await ws.close(4000, "missing params")
        return

    room = get_room(token)

    if role == "host":
        room["host"] = ws
        print(f"[{token[:8]}] host connected")
        for c in room["clients"]:
            await c.send(json.dumps({"type": "host_connected"}))
        try:
            async for raw in ws:
                for c in list(room["clients"]):
                    await c.send(raw)
        finally:
            if room["host"] is ws:
                room["host"] = None
                print(f"[{token[:8]}] host disconnected")

    else:
        room["clients"].add(ws)
        print(f"[{token[:8]}] client connected")
        alive = room["host"] is not None
        await ws.send(json.dumps({"type": "host_connected" if alive else "host_disconnected"}))
        try:
            async for raw in ws:
                if room["host"] is not None:
                    await room["host"].send(raw)
        finally:
            room["clients"].discard(ws)


async def main():
    async with websockets.serve(handler, "localhost", 3580):
        print("local relay listening on ws://localhost:3580")
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    asyncio.run(main())
