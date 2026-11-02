"""Read-only checks for the exact intended Ubuntu host."""

import json
import os
import shutil
import socket
import subprocess
import sys
from pathlib import Path

DOMAIN = "voise.24projects.ru"
IP = "157.228.191.231"


def run(args):
    return subprocess.run(
        args, check=True, capture_output=True, text=True, timeout=20
    ).stdout


def check():
    if sys.platform != "linux" or os.geteuid() != 0:
        raise RuntimeError("Use root on the intended Ubuntu host")
    if "ID=ubuntu" not in Path("/etc/os-release").read_text():
        raise RuntimeError("Ubuntu is required")
    addresses = {
        item["local"]
        for interface in json.loads(run(["ip", "-j", "address"]))
        for item in interface.get("addr_info", [])
    }
    if IP not in addresses:
        raise RuntimeError("Expected IPv4 is not assigned to this host")
    resolved = {
        x[4][0] for x in socket.getaddrinfo(DOMAIN, 443, type=socket.SOCK_STREAM)
    }
    if IP not in resolved or any(x not in addresses for x in resolved):
        raise RuntimeError(
            "DNS has a different A/AAAA destination; fix DNS before installing"
        )
    if (
        os.environ.get("DOCKER_HOST", "unix:///var/run/docker.sock")
        != "unix:///var/run/docker.sock"
    ):
        raise RuntimeError("Remote Docker contexts are not supported")
    endpoint = json.loads(run(["docker", "context", "inspect"]))[0]["Endpoints"][
        "docker"
    ]["Host"]
    if endpoint != "unix:///var/run/docker.sock":
        raise RuntimeError("Docker must use the local host socket")
    run(["docker", "compose", "version"])
    mem = {
        k: int(v.split()[0])
        for k, v in (
            line.split(":", 1)
            for line in Path("/proc/meminfo").read_text().splitlines()
        )
    }
    if mem["MemTotal"] < 1024 * 1024 or mem["MemAvailable"] < 180 * 1024:
        raise RuntimeError(
            "Not enough available memory; existing workloads were preserved"
        )
    if mem["SwapFree"] < 1024 * 1024:
        raise RuntimeError(
            "At least 1 GiB free swap is required for serial builds on this host"
        )
    free = shutil.disk_usage("/opt").free
    if free < 3 * 1024**3:
        raise RuntimeError("At least 3 GiB free disk is required")
    current = Path("/opt/voicerooms/current")
    if current.exists() and not current.is_symlink():
        raise RuntimeError("VoiceRooms current must be a managed release symlink")
    if current.exists() and not current.resolve().is_relative_to(
        Path("/opt/voicerooms/releases")
    ):
        raise RuntimeError("Unexpected VoiceRooms current path")
    # Only the VoiceRooms project may already own these host listener ports.
    ids = run(["docker", "ps", "-aq"]).split()
    containers = json.loads(run(["docker", "inspect"] + ids)) if ids else []
    reserved = {"7880", "7881", "3099", "5199"} | {str(p) for p in range(50300, 50351)}
    own_ports = set()
    for container in containers:
        labels = container.get("Config", {}).get("Labels") or {}
        for bindings in (
            container.get("HostConfig", {}).get("PortBindings") or {}
        ).values():
            for item in bindings or []:
                port = item.get("HostPort")
                if port in reserved and (
                    labels.get("com.docker.compose.project") != "voicerooms"
                    or not labels.get(
                        "com.docker.compose.project.working_dir", ""
                    ).startswith("/opt/voicerooms/releases/")
                ):
                    raise RuntimeError(
                        "A required port belongs to another project; nothing changed"
                    )
                if port in reserved and container.get("State", {}).get("Running"):
                    own_ports.add(port)
    for line in run(["ss", "-H", "-lntu"]).splitlines():
        fields = line.split()
        if len(fields) > 4:
            port = fields[4].rsplit(":", 1)[-1]
            if port in reserved and port not in own_ports:
                raise RuntimeError(
                    "A required listener belongs to an unmanaged process"
                )
    for config in Path("/etc/nginx/sites-enabled").glob("*"):
        if config.name != DOMAIN and config.is_file():
            import re

            for names in re.findall(
                r"server_name\s+([^;]+);", config.read_text(errors="replace")
            ):
                if DOMAIN in names.split():
                    raise RuntimeError(
                        "Domain already belongs to a different Nginx configuration"
                    )
    print(
        json.dumps(
            {
                "host": IP,
                "domain": DOMAIN,
                "dns": "ok",
                "memoryAvailableMiB": mem["MemAvailable"] // 1024,
                "swapFreeMiB": mem["SwapFree"] // 1024,
                "diskFreeGiB": free // 1024**3,
                "preflight": "ok",
            }
        )
    )


if __name__ == "__main__":
    try:
        check()
    except Exception as error:
        print("Preflight refused: " + str(error), file=sys.stderr)
        raise SystemExit(1)
