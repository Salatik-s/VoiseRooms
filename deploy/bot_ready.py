"""Check the existing bot process; never import a second aiogram in its cgroup."""

import json
import subprocess
import time


def docker_output(args):
    result = subprocess.run(args, check=True, capture_output=True, text=True)
    # Python logging is normally on stderr; docker inspect JSON is only on stdout.
    if args[:2] == ["docker", "logs"]:
        return (result.stdout + result.stderr).strip()
    return result.stdout.strip()


def wait_for_bot(compose, capture=docker_output, attempts=45, pause=2):
    stable = 0
    previous = None
    for _ in range(attempts):
        identifiers = capture(compose + ["ps", "--all", "--quiet", "bot"]).split()
        if len(identifiers) != 1:
            raise RuntimeError("Expected exactly one VoiceRooms bot container")
        container = json.loads(capture(["docker", "inspect", identifiers[0]]))[0]
        state = container["State"]
        if state.get("OOMKilled"):
            raise RuntimeError("VoiceRooms bot reached its container memory limit; inspect its memory and status")
        started = state.get("StartedAt", "")
        if not started or started.startswith("0001-"):
            stable = 0
        else:
            logs = capture(["docker", "logs", "--since", started, "--tail", "80", identifiers[0]])
            if "TelegramConflictError" in logs or "Conflict:" in logs:
                raise RuntimeError("Another process is polling this bot token. Stop the old poller before retrying.")
            if "Bot stopped:" in logs:
                raise RuntimeError("VoiceRooms bot could not finish startup; inspect its redacted logs")
            version = (identifiers[0], started, container.get("RestartCount", 0))
            ready = state.get("Running") and not state.get("Restarting") and "VoiceRooms bot ready" in logs
            stable = stable + 1 if ready and version == previous else int(bool(ready))
            previous = version
            if stable >= 3:
                print("Telegram getMe and startup verified by the running bot; container remains stable")
                return
        time.sleep(pause)
    raise RuntimeError("VoiceRooms bot did not become ready; inspect its status and redacted logs")
