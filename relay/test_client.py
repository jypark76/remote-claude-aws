"""
Stand-in for the phone/React client, just to prove the loop works.
Run: python test_client.py "your message here"
"""
import asyncio
import json
import sys
import websockets

URL = "ws://localhost:3580/?token=test&role=client"


async def main():
    message = sys.argv[1] if len(sys.argv) > 1 else "say hello in 5 words"
    async with websockets.connect(URL) as ws:
        print(f"sending: {message}")
        await ws.send(json.dumps({"type": "input", "data": message}))
        async for raw in ws:
            msg = json.loads(raw)
            if msg.get("type") == "output":
                print(msg["data"], end="", flush=True)
            elif msg.get("type") == "tool_use":
                print(f"\n[tool: {msg['text']}]")
            elif msg.get("type") == "response_done":
                print("\n-- done --")
                break
            else:
                print(f"\n[{msg}]")


if __name__ == "__main__":
    asyncio.run(main())
