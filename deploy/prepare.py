"""Generate private production configuration outside the checkout; never print secrets."""

import argparse
import ipaddress
import re
import secrets
from pathlib import Path


def read_env(path):
    result = {}
    for line in Path(path).read_text(encoding="utf-8-sig").splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        key, sep, value = line.partition("=")
        if not sep or not re.fullmatch(r"[A-Z_][A-Z0-9_]*", key):
            raise ValueError("Invalid environment line")
        result[key] = value.strip().strip('"').strip("'")
    return result


def private_write(path, content):
    path = Path(path)
    if path.is_symlink():
        raise ValueError("Refusing symlink configuration")
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(content)
    path.chmod(0o600)


def prepare(source, target):
    base = read_env(target) if Path(target).exists() else {}
    old = read_env(source)
    for key in ["BOT_TOKEN", "OWNER_TG_ID"]:
        if not base.get(key):
            base[key] = old.get(key, "")
    if not re.fullmatch(r"\d+:[\w-]{25,}", base["BOT_TOKEN"]) or not re.fullmatch(
        r"[1-9][0-9]{1,15}", base["OWNER_TG_ID"]
    ):
        raise ValueError("Valid VoiceRooms bot token and owner ID are required")
    for key in ["POSTGRES_PASSWORD", "INTERNAL_KEY", "LIVEKIT_API_SECRET"]:
        base.setdefault(key, secrets.token_hex(32))
    base.setdefault("LIVEKIT_API_KEY", secrets.token_hex(12))
    base.update(DOMAIN="voise.24projects.ru", PUBLIC_IPV4="157.228.191.231")
    base.setdefault("MAX_ROOM_PARTICIPANTS", "8")
    base["DATABASE_URL"] = (
        "postgresql://voicerooms:"
        + base["POSTGRES_PASSWORD"]
        + "@postgres:5432/voicerooms?schema=public"
    )
    base.setdefault("BOT_PROXY_URL", "")
    base.setdefault("LE_ACCOUNT_EMAIL", old.get("LE_ACCOUNT_EMAIL", ""))
    allowed = [
        "DOMAIN",
        "PUBLIC_IPV4",
        "BOT_TOKEN",
        "OWNER_TG_ID",
        "POSTGRES_PASSWORD",
        "DATABASE_URL",
        "INTERNAL_KEY",
        "LIVEKIT_API_KEY",
        "LIVEKIT_API_SECRET",
        "MAX_ROOM_PARTICIPANTS",
        "BOT_PROXY_URL",
        "LE_ACCOUNT_EMAIL",
    ]
    for key in allowed:
        if any(c in base[key] for c in "\r\n$`\"'\\"):
            raise ValueError("Unsupported character in private configuration")
    private_write(target, "".join(k + "=" + base[k] + "\n" for k in allowed))


def render(env_path, destination):
    env = read_env(env_path)
    ip = str(ipaddress.IPv4Address(env["PUBLIC_IPV4"]))
    for key in ["LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"]:
        if not re.fullmatch(r"[A-Za-z0-9_-]{16,128}", env[key]):
            raise ValueError("Invalid media configuration")
    config = f"""port: 7880
bind_addresses: [0.0.0.0]
rtc:
  node_ip: {ip}
  use_external_ip: false
  tcp_port: 7881
  port_range_start: 50300
  port_range_end: 50350
keys:
  {env["LIVEKIT_API_KEY"]}: {env["LIVEKIT_API_SECRET"]}
webhook:
  api_key: {env["LIVEKIT_API_KEY"]}
  urls: [http://backend:3000/api/livekit/webhook]
logging:
  level: warn
"""
    private_write(destination, config)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source")
    parser.add_argument("--target", required=True)
    parser.add_argument("--render")
    args = parser.parse_args()
    if args.render:
        render(args.target, args.render)
    else:
        prepare(args.source, args.target)
        print("Private VoiceRooms configuration prepared; no secrets printed.")
