"""Scoped Ubuntu deployment. No portfolio credentials or databases leave the host."""

import argparse
import fcntl
import hashlib
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import time
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from preflight import DOMAIN, IP, check
from prepare import private_write, read_env, render

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
ENV = Path("/etc/voicerooms/production.env")


def call(args, **kwargs):
    return subprocess.run(args, check=True, text=True, **kwargs)


def capture(args):
    return call(args, capture_output=True).stdout.strip()


def wait_url(url, seconds=120, expected=None):
    until = time.monotonic() + seconds
    while time.monotonic() < until:
        try:
            with urlopen(url, timeout=5) as response:
                body = response.read(1024 * 1024)
                if response.status == 200 and (expected is None or expected in body):
                    return
        except Exception:
            pass
        time.sleep(2)
    raise RuntimeError("Readiness check failed: " + url)


def verify_public_flow(origin):
    """Exercise real authorization and token creation without logging credentials."""
    def request(path, payload=None, token=None):
        headers = {"Accept": "application/json"}
        if token:
            headers["Authorization"] = "Bearer " + token
        body = None
        if payload is not None:
            body = json.dumps(payload).encode()
            headers["Content-Type"] = "application/json"
        with urlopen(Request(origin + path, data=body, headers=headers), timeout=15) as response:
            return json.load(response)

    token = request("/api/session")["token"]
    # This disposable key never leaves this process; only its derived proof does.
    key = secrets.token_urlsafe(32)
    proof = hashlib.sha256(("VoiceRooms admission v1:" + key).encode()).hexdigest()
    access_hash = hashlib.sha256(proof.encode()).hexdigest()
    room = request("/api/room/create", {"maxParticipants": 2, "accessHash": access_hash}, token)
    code = room["code"]
    try:
        try:
            request("/api/token", {"room": code}, token)
        except HTTPError as error:
            if error.code != 403:
                raise RuntimeError("Private invitation authorization check failed") from None
        else:
            raise RuntimeError("Private room admitted a request without its proof")
        minted = request("/api/token", {"room": code, "accessProof": proof}, token)
        if not isinstance(minted.get("token"), str) or not minted["token"]:
            raise RuntimeError("Media token creation failed")
    finally:
        request("/api/room/" + code + "/close", {}, token)
    print("Public HTTPS room creation, invitation gate, media token and closure: ok")


def nginx_apply(content):
    site = Path("/etc/nginx/sites-available/voise.24projects.ru")
    enabled = Path("/etc/nginx/sites-enabled/voise.24projects.ru")
    if site.is_symlink() or (enabled.exists() and enabled.resolve() != site):
        raise RuntimeError("Unexpected Nginx path; existing sites preserved")
    previous = site.read_bytes() if site.exists() else None
    if previous and b"# VoiceRooms managed" not in previous:
        raise RuntimeError("Existing site was not created by this installer")
    if previous:
        backup = Path("/etc/voicerooms/backups")
        backup.mkdir(parents=True, exist_ok=True)
        (backup / ("nginx-" + str(time.time_ns()) + ".conf")).write_bytes(previous)
    site.write_text(content, encoding="utf-8")
    site.chmod(0o644)
    created = False
    if not enabled.exists():
        enabled.symlink_to(site)
        created = True
    try:
        call(["nginx", "-t"])
        call(["systemctl", "reload", "nginx"])
    except Exception:
        if previous is not None:
            site.write_bytes(previous)
        else:
            site.unlink(missing_ok=True)
        if created:
            enabled.unlink(missing_ok=True)
        raise


def publish_portfolio():
    container = json.loads(capture(["docker", "inspect", "24projects-app-1"]))[0]
    labels = container.get("Config", {}).get("Labels") or {}
    if (
        labels.get("com.docker.compose.project") != "24projects"
        or labels.get("com.docker.compose.service") != "app"
    ):
        raise RuntimeError("Unexpected portfolio container")
    mounts = [m for m in container.get("Mounts", []) if m.get("Destination") == "/data"]
    if (
        len(mounts) != 1
        or mounts[0].get("Type") != "volume"
        or mounts[0].get("Name") != "24projects_app_data"
        or not mounts[0].get("RW")
    ):
        raise RuntimeError("Portfolio volume differs; no changes made")
    image = container["Image"]
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", image):
        raise RuntimeError("Unexpected portfolio image")
    locks = []
    try:
        for name in ["24projects-transfer.lock", "24projects-install.lock"]:
            fd = os.open(
                "/run/lock/" + name, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600
            )
            f = os.fdopen(fd, "r+")
            fcntl.flock(f, fcntl.LOCK_EX)
            locks.append(f)
        script = (
            (HERE / "portfolio-project.mjs").read_text()
            + "\n"
            + (HERE / "portfolio-apply.mjs").read_text()
        )
        was_running = container["State"]["Running"]
        if not was_running:
            raise RuntimeError("Portfolio is not running; no data changed")
        call(["docker", "stop", "24projects-app-1"], stdout=subprocess.DEVNULL)
        try:
            call(
                [
                    "docker",
                    "run",
                    "--rm",
                    "-i",
                    "--network",
                    "none",
                    "--read-only",
                    "--user",
                    "1000:1000",
                    "--memory",
                    "192m",
                    "--pids-limit",
                    "32",
                    "--cap-drop",
                    "ALL",
                    "--security-opt",
                    "no-new-privileges:true",
                    "--env",
                    "APP_ORIGIN=https://24projects.ru",
                    "--mount",
                    "type=volume,src=24projects_app_data,dst=/data",
                    "--entrypoint",
                    "node",
                    image,
                    "--input-type=module",
                    "-",
                    "--apply",
                ],
                input=script,
            )
        finally:
            call(["docker", "start", "24projects-app-1"], stdout=subprocess.DEVNULL)
        wait_url("https://24projects.ru/api/site", expected=b"voise.24projects.ru")
        print(
            "VoiceRooms published as Andrey’s personal project; other profiles and projects preserved."
        )
    finally:
        for f in reversed(locks):
            f.close()


def install(upload, agree_terms, publish, email):
    check()
    if not ROOT.is_relative_to(Path("/opt/voicerooms/releases")) or ROOT.is_symlink():
        raise RuntimeError("Unexpected release directory")
    incoming = read_env(upload)
    if incoming.get("DOMAIN") != DOMAIN or incoming.get("PUBLIC_IPV4") != IP:
        raise RuntimeError("Private configuration targets a different host")
    ENV.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if ENV.exists():
        current = read_env(ENV)
        for key in [
            "POSTGRES_PASSWORD",
            "DATABASE_URL",
            "INTERNAL_KEY",
            "LIVEKIT_API_KEY",
            "LIVEKIT_API_SECRET",
            "OWNER_TG_ID",
            "BOT_TOKEN",
        ]:
            if current.get(key) != incoming.get(key):
                raise RuntimeError(
                    "Private service keys differ from the installed release. Existing database and keys were preserved."
                )
    else:
        private_write(ENV, Path(upload).read_text(encoding="utf-8"))
    if not shutil.which("nginx") or not shutil.which("certbot"):
        call(["apt-get", "update"])
        call(["apt-get", "install", "-y", "nginx", "certbot"])
    env = read_env(ENV)
    proxy = False
    # Reuse the already installed owner-controlled relay; do not alter it.
    relay = subprocess.run(
        ["docker", "inspect", "24projects-vpn-1"], capture_output=True, text=True
    )
    if relay.returncode == 0:
        vpn = json.loads(relay.stdout)[0]
        if (
            vpn.get("State", {}).get("Running")
            and vpn.get("Config", {})
            .get("Labels", {})
            .get("com.docker.compose.project")
            == "24projects"
            and "24projects_backplane"
            in vpn.get("NetworkSettings", {}).get("Networks", {})
        ):
            proxy = True
            env["BOT_PROXY_URL"] = env.get("BOT_PROXY_URL") or "socks5://vpn:2080"
            private_write(ENV, "".join(k + "=" + v + "\n" for k, v in env.items()))
            (ROOT / "proxy.compose.yaml").write_text(
                "services:\n  bot:\n    networks: [default, portfolio_proxy]\nnetworks:\n  portfolio_proxy:\n    external: true\n    name: 24projects_backplane\n"
            )
    render(ENV, ROOT / "livekit.yaml")
    os.chown(ROOT / "livekit.yaml", 10001, 10001)
    command = [
        "docker",
        "compose",
        "--project-name",
        "voicerooms",
        "--project-directory",
        str(ROOT),
        "--env-file",
        str(ENV),
        "-f",
        str(ROOT / "compose.yaml"),
    ]
    if proxy:
        command += ["-f", str(ROOT / "proxy.compose.yaml")]
    call(command + ["config", "--quiet"])
    # Keep builds serial on the 1.5 GiB host.
    for service in ["backend", "frontend", "bot"]:
        call(command + ["build", service])
    call(command + ["up", "-d", "postgres", "livekit"])
    for _ in range(60):
        if (
            subprocess.run(
                command
                + [
                    "exec",
                    "-T",
                    "postgres",
                    "pg_isready",
                    "-U",
                    "voicerooms",
                    "-d",
                    "voicerooms",
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            ).returncode
            == 0
        ):
            break
        time.sleep(2)
    else:
        raise RuntimeError("PostgreSQL did not become ready")
    call(
        command
        + ["run", "--rm", "--no-deps", "backend", "npx", "prisma", "migrate", "deploy"]
    )
    call(command + ["up", "-d", "backend", "frontend"])
    wait_url("http://127.0.0.1:3099/api/ready", expected=b'"status":"ok"')
    wait_url("http://127.0.0.1:5199/", expected=b"<title>VoiceRooms</title>")
    if shutil.which("ufw") and "Status: active" in capture(["ufw", "status"]):
        for rule in ["80/tcp", "443/tcp", "7881/tcp", "50300:50350/udp"]:
            call(["ufw", "allow", rule])
    Path("/var/www/letsencrypt/.well-known/acme-challenge").mkdir(
        parents=True, exist_ok=True
    )
    acme = "location ^~ /.well-known/acme-challenge/ { root /var/www/letsencrypt; }"
    proxy_block = 'location / { proxy_pass http://127.0.0.1:5199; proxy_set_header Host $host; proxy_set_header X-Forwarded-Proto https; }\nlocation /livekit/ { proxy_pass http://127.0.0.1:7880/; proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade"; proxy_read_timeout 3600s; }'
    common = (
        "# VoiceRooms managed\nserver { listen 80; listen [::]:80; server_name "
        + DOMAIN
        + "; "
        + acme
        + " location / { return 301 https://$host$request_uri; } }\n"
    )
    certificate = Path("/etc/letsencrypt/live") / DOMAIN / "fullchain.pem"
    if not certificate.exists():
        nginx_apply(common)
        cert = [
            "certbot",
            "certonly",
            "--webroot",
            "-w",
            "/var/www/letsencrypt",
            "-d",
            DOMAIN,
            "--email",
            email,
            "--non-interactive",
        ]
        if agree_terms:
            cert += ["--agree-tos"]
        call(cert)
    https = (
        common
        + "server { listen 443 ssl; listen [::]:443 ssl; server_name "
        + DOMAIN
        + "; ssl_certificate /etc/letsencrypt/live/"
        + DOMAIN
        + "/fullchain.pem; ssl_certificate_key /etc/letsencrypt/live/"
        + DOMAIN
        + "/privkey.pem; ssl_protocols TLSv1.2 TLSv1.3; client_max_body_size 11m; access_log off; "
        + proxy_block
        + " }\n"
    )
    nginx_apply(https)
    hook = Path("/etc/letsencrypt/renewal-hooks/deploy/voicerooms-nginx.sh")
    hook.parent.mkdir(parents=True, exist_ok=True)
    hook.write_text("#!/bin/sh\nnginx -t && systemctl reload nginx\n")
    hook.chmod(0o755)
    wait_url("https://" + DOMAIN + "/api/ready", expected=b'"status":"ok"')
    wait_url("https://" + DOMAIN + "/", expected=b"<title>VoiceRooms</title>")
    verify_public_flow("https://" + DOMAIN)
    call(command + ["up", "-d", "bot"])
    # Verify the real provider from the bot container without printing the token.
    probe = """import asyncio,os
from aiogram import Bot
from aiogram.client.session.aiohttp import AiohttpSession
async def check():
    s=AiohttpSession(proxy=os.getenv("BOT_PROXY_URL") or None)
    b=Bot(os.environ["BOT_TOKEN"],session=s)
    try:
        me=await b.get_me()
        assert me.username=="vidagram_bot"
        print("Telegram provider: ok")
    finally:
        await s.close()
asyncio.run(check())
"""
    call(command + ["exec", "-T", "bot", "python", "-c", probe])
    for _ in range(30):
        logs = capture(command + ["logs", "--no-color", "--tail", "50", "bot"])
        if "TelegramConflictError" in logs or "Conflict:" in logs:
            raise RuntimeError(
                "Another process is polling this bot token. VoiceRooms is running; stop the old poller before retrying."
            )
        if "VoiceRooms bot ready" in logs:
            break
        time.sleep(2)
    else:
        raise RuntimeError(
            "The bot did not finish startup. Review its status; secrets are redacted from its logs."
        )
    current = Path("/opt/voicerooms/current")
    temporary = current.with_name(".current-" + str(time.time_ns()))
    temporary.symlink_to(ROOT, target_is_directory=True)
    os.replace(temporary, current)
    if publish:
        publish_portfolio()
    print(
        "VoiceRooms HTTPS, database, media API and bot provider checks passed.\nhttps://"
        + DOMAIN
        + "/\nPortfolio: https://24projects.ru/projects/voicerooms"
    )


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--env-upload", required=True)
    p.add_argument("--email", required=True)
    p.add_argument("--agree-terms", action="store_true")
    p.add_argument("--publish-portfolio", action="store_true")
    a = p.parse_args()
    try:
        with open("/run/lock/voicerooms-install.lock", "w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            install(a.env_upload, a.agree_terms, a.publish_portfolio, a.email)
    except Exception as e:
        print(
            "VoiceRooms deployment stopped: "
            + str(e)
            + "\nExisting projects and persistent volumes were preserved.",
            file=sys.stderr,
        )
        raise SystemExit(1)
