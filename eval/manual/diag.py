import os

# Find the running app.py process by scanning /proc ourselves (avoids shell quoting issues)
target_pid = None
for pid in os.listdir("/proc"):
    if not pid.isdigit():
        continue
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as f:
            cmdline = f.read()
        if b"app.py" in cmdline:
            target_pid = pid
            break
    except (FileNotFoundError, ProcessLookupError):
        continue

print("target_pid:", target_pid)

with open(f"/proc/{target_pid}/environ", "rb") as f:
    data = f.read()

for part in data.split(b"\x00"):
    if part.startswith(b"ANTHROPIC_API_KEY="):
        key = part[len(b"ANTHROPIC_API_KEY="):]
        print("byte len:", len(key))
        print("all ascii bytes (<128):", all(b < 128 for b in key))
        print("first 20 bytes:", key[:20])
        print("last 15 bytes:", key[-15:])
