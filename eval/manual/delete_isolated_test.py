import importlib.util
import os
import sys
import time

sys.path.insert(0, "/home/ec2-user")
os.chdir("/home/ec2-user")

spec = importlib.util.spec_from_file_location("chats_live", "/home/ec2-user/chats.py")
chats = importlib.util.module_from_spec(spec)
spec.loader.exec_module(chats)

CHAT_ID = f"delete-isolated-{int(time.time())}"
chat = {
    "id": CHAT_ID, "title": "delete isolated test", "dirName": CHAT_ID, "ownerId": "admin",
    "sessionId": None, "createdAt": int(time.time() * 1000), "updatedAt": int(time.time() * 1000),
    "messages": [],
}
chats.save_chat(chat)

msg = "Please delete the D353 Task 2 assignment from the table entirely."
chats.append_message(chat, "user", msg)
chats.run_claude_message(CHAT_ID, msg)

sess = chats.get_session(CHAT_ID)
deadline = time.time() + 120
while sess["running"] and time.time() < deadline:
    time.sleep(0.5)

fresh = chats.load_chat_by_id(CHAT_ID)
last = fresh["messages"][-1]
print(f"role={last['role']} thinkMs={last.get('thinkMs')} text={last['text']!r}")

# Run it 3 more times fresh, to see if it's deterministic or intermittent.
for i in range(3):
    CHAT_ID2 = f"delete-isolated-{int(time.time())}-{i}"
    chat2 = {
        "id": CHAT_ID2, "title": "t", "dirName": CHAT_ID2, "ownerId": "admin",
        "sessionId": None, "createdAt": int(time.time() * 1000), "updatedAt": int(time.time() * 1000),
        "messages": [],
    }
    chats.save_chat(chat2)
    chats.append_message(chat2, "user", msg)
    chats.run_claude_message(CHAT_ID2, msg)
    sess2 = chats.get_session(CHAT_ID2)
    deadline = time.time() + 120
    while sess2["running"] and time.time() < deadline:
        time.sleep(0.5)
    fresh2 = chats.load_chat_by_id(CHAT_ID2)
    last2 = fresh2["messages"][-1]
    print(f"retry {i}: role={last2['role']} thinkMs={last2.get('thinkMs')} text={last2['text'][:80]!r}")
