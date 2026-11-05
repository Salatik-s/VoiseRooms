"""Validate and apply one scoped VoiceRooms runtime release on the existing host."""

import argparse
import hashlib
import io
import http.client
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import time
import types
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

VERSION = "1.2.0"
DOMAIN = "voise.24projects.ru"
IP = "157.228.191.231"
MANIFEST = "release.json"
DOWNLOADS = {
    f"frontend/public/downloads/VoiceRooms-{VERSION}.apk",
    f"frontend/public/downloads/VoiceRooms-{VERSION}.ipa",
}
MAX_BUNDLE_BYTES = 512 * 1024 * 1024
MAX_FILE_BYTES = 300 * 1024 * 1024
MAX_FILES = 10000
EXACT_FILES = {
    ".dockerignore", "compose.yaml", "COPYRIGHT", "README.md", "SECURITY.md",
    "backend/.dockerignore", "backend/Dockerfile", "backend/package.json", "backend/package-lock.json", "backend/prisma/schema.prisma", "backend/prisma/migrations/migration_lock.toml",
    "frontend/.dockerignore", "frontend/Dockerfile", "frontend/package.json", "frontend/package-lock.json", "frontend/index.html", "frontend/nginx.conf", "frontend/tsconfig.json", "frontend/vite.config.js",
    "bot/.dockerignore", "bot/Dockerfile", "bot/requirements.txt",
}
REQUIRED = {
    ".dockerignore", "compose.yaml", "backend/Dockerfile", "backend/package.json", "backend/package-lock.json", "backend/prisma/schema.prisma", "backend/src/index.js", "frontend/Dockerfile", "frontend/package.json", "frontend/package-lock.json", "frontend/index.html", "frontend/nginx.conf", "frontend/src/main.tsx", "bot/Dockerfile", "bot/requirements.txt", "bot/bot.py", "deploy/update.py", "deploy/preflight.py", "deploy/prepare.py", "deploy/bot_ready.py", "deploy/install.py", "deploy/acme.py",
} | DOWNLOADS


def public_path(name):
    if not isinstance(name, str) or not name or "\\" in name or ":" in name or "\x00" in name:
        return False
    path = PurePosixPath(name)
    if path.is_absolute() or name != path.as_posix() or any(part in {"", ".", ".."} for part in path.parts):
        return False
    if name in EXACT_FILES or name in DOWNLOADS:
        return True
    if any(part.startswith(".") for part in path.parts):
        return False
    if name.startswith("backend/src/") and path.suffix == ".js":
        return True
    if name.startswith("backend/prisma/migrations/") and path.name == "migration.sql" and len(path.parts) == 5:
        return True
    if name.startswith("frontend/src/") and path.suffix in {".ts", ".tsx", ".js", ".jsx", ".css"}:
        return True
    if name.startswith("frontend/public/") and path.suffix.lower() in {".svg", ".png", ".jpg", ".jpeg", ".webp", ".ico", ".woff", ".woff2", ".json", ".webmanifest", ".txt", ".mp3"}:
        return True
    if len(path.parts) == 2 and path.parts[0] in {"bot", "deploy"} and path.suffix == ".py" and not path.name.startswith("test"):
        return True
    return False


def file_sha(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_bundle(archive, expected_sha=None):
    archive = Path(archive)
    if archive.is_symlink() or not archive.is_file():
        raise ValueError("Архив обновления не найден или является ссылкой")
    digest = file_sha(archive)
    if expected_sha is not None and (not re.fullmatch(r"[a-f0-9]{64}", expected_sha) or digest != expected_sha):
        raise ValueError("Контрольная сумма архива не совпадает")
    if archive.stat().st_size > MAX_BUNDLE_BYTES:
        raise ValueError("Архив обновления слишком большой")
    with zipfile.ZipFile(archive) as bundle:
        entries = bundle.infolist()
        names = [entry.filename for entry in entries]
        if len(entries) > MAX_FILES or len(set(name.casefold() for name in names)) != len(names):
            raise ValueError("В архиве слишком много файлов или повторяются пути")
        if sum(entry.file_size for entry in entries) > MAX_BUNDLE_BYTES:
            raise ValueError("Распакованный архив слишком большой")
        for entry in entries:
            if entry.is_dir() or stat.S_ISLNK(entry.external_attr >> 16) or entry.file_size > MAX_FILE_BYTES or (entry.filename != MANIFEST and not public_path(entry.filename)):
                raise ValueError("Архив содержит посторонний или небезопасный файл")
        if MANIFEST not in names or bundle.getinfo(MANIFEST).file_size > 2 * 1024 * 1024:
            raise ValueError("В архиве нет допустимого описания выпуска")
        manifest = json.loads(bundle.read(MANIFEST))
        if manifest.get("format") != 1 or manifest.get("version") != VERSION or not re.fullmatch(r"[a-f0-9]{40}", manifest.get("revision", "")):
            raise ValueError("Неверное описание выпуска")
        records = manifest.get("files")
        if not isinstance(records, dict) or not REQUIRED.issubset(records) or set(records) != set(names) - {MANIFEST}:
            raise ValueError("Состав архива не совпадает с описанием выпуска")
        for name, record in records.items():
            entry = bundle.getinfo(name)
            if not public_path(name) or not isinstance(record, dict) or record.get("size") != entry.file_size or not re.fullmatch(r"[a-f0-9]{64}", record.get("sha256", "")):
                raise ValueError("Неверное описание файла выпуска")
            checksum = hashlib.sha256()
            with bundle.open(entry) as source:
                for chunk in iter(lambda: source.read(1024 * 1024), b""):
                    checksum.update(chunk)
            if checksum.hexdigest() != record["sha256"]:
                raise ValueError("Контрольная сумма файла выпуска не совпадает")
        # Current migrations only extend the schema. Automatic container rollback
        # must not be offered for a destructive database migration.
        for name in records:
            if name.endswith("/migration.sql"):
                sql = re.sub(r"--[^\n]*", "", bundle.read(name).decode("utf-8-sig"))
                if re.search(r"\b(DROP|TRUNCATE|RENAME)\b|\bALTER\s+COLUMN\b", sql, re.I):
                    raise ValueError("В выпуске есть миграция, несовместимая с автоматическим откатом контейнеров")
    return manifest, digest


def extract_bundle(archive, destination, manifest):
    destination = Path(destination)
    if destination.is_symlink() or destination.exists():
        raise ValueError("Каталог нового выпуска уже существует или является ссылкой")
    destination.mkdir(parents=False, mode=0o755)
    destination.chmod(0o755)
    root = destination.resolve()
    with zipfile.ZipFile(archive) as bundle:
        for name in sorted(manifest["files"]):
            target = destination.joinpath(*PurePosixPath(name).parts)
            if not target.resolve().is_relative_to(root):
                raise ValueError("Небезопасный путь распаковки")
            target.parent.mkdir(parents=True, exist_ok=True)
            for parent in target.parents:
                if parent == destination:
                    break
                parent.chmod(0o755)
            with bundle.open(name) as source, target.open("xb") as output:
                shutil.copyfileobj(source, output, length=1024 * 1024)
            target.chmod(0o644)


def run(args, *, check=True, **kwargs):
    result = subprocess.run(args, check=check, **kwargs)
    return result


def capture(args):
    return run(args, capture_output=True, text=True).stdout.strip()


def write_json(path, value):
    path = Path(path)
    if path.is_symlink():
        raise RuntimeError("Небезопасный путь служебного файла")
    with path.open("x", encoding="utf-8", newline="\n") as output:
        json.dump(value, output, ensure_ascii=False, indent=2)
        output.write("\n")
    path.chmod(0o600)


def compose(root, env_file, images=None):
    root = Path(root)
    args = ["docker", "compose", "--project-name", "voicerooms", "--project-directory", str(root), "--env-file", str(env_file), "-f", str(root / "compose.yaml")]
    if (root / "proxy.compose.yaml").is_file():
        args += ["-f", str(root / "proxy.compose.yaml")]
    if images:
        args += ["-f", str(images)]
    return args


def image_override(path, images):
    if set(images) != {"backend", "frontend", "bot"} or any(not re.fullmatch(r"voicerooms-(backend|frontend|bot):[a-z0-9-]+", value) for value in images.values()):
        raise ValueError("Неожиданные образы выпуска")
    path = Path(path)
    if path.exists() or path.is_symlink():
        raise ValueError("Файл образов уже существует")
    path.write_text("services:\n" + "".join(f"  {service}:\n    image: {image}\n" for service, image in images.items()), encoding="utf-8")
    path.chmod(0o600)



def rollback_target(service, container, tag):
    if service not in {"backend", "frontend", "bot"} or not re.fullmatch(r"[a-f0-9]{64}", container.get("id", "")) or not re.fullmatch(r"sha256:[a-f0-9]{64}", container.get("image", "")):
        raise ValueError("Неожиданный контейнер резервного образа")
    if not re.fullmatch(r"voicerooms-" + service + r":rollback-[a-z0-9-]+", tag):
        raise ValueError("Неожиданное имя резервного образа")


def snapshot_rollback_image(service, container, tag, backup):
    """Save a parent-independent local image; never export mounted volumes or print config."""
    rollback_target(service, container, tag)
    backup = Path(backup)
    if backup.is_symlink() or not backup.is_dir() or backup.stat().st_mode & 0o077:
        raise ValueError("Небезопасный каталог резервных образов")
    identity = container["id"]
    details = json.loads(capture(["docker", "container", "inspect", identity]))[0]
    labels = details.get("Config", {}).get("Labels") or {}
    if details.get("Id") != identity or details.get("Image") != container["image"] or labels.get("com.docker.compose.project") != "voicerooms" or labels.get("com.docker.compose.service") != service or details.get("State", {}).get("Paused"):
        raise RuntimeError("Контейнер изменился до создания резервного образа; обновление не начато")
    descriptor_platform = (details.get("ImageManifestDescriptor") or {}).get("platform") or {}
    host_platform = capture(["docker", "info", "--format", "{{.OSType}}/{{.Architecture}}"])
    operating_system, _, host_arch = host_platform.partition("/")
    architecture = descriptor_platform.get("architecture") or {"x86_64": "amd64", "amd64": "amd64", "aarch64": "arm64", "arm64": "arm64"}.get(host_arch)
    if operating_system != "linux" or descriptor_platform.get("os", "linux") != "linux" or architecture not in {"amd64", "arm64"}:
        raise RuntimeError("Платформа резервного образа не поддерживается; обновление не начато")
    keys = {"Env", "Entrypoint", "Cmd", "User", "WorkingDir", "Labels", "ExposedPorts", "Volumes", "Healthcheck", "StopSignal", "ArgsEscaped", "Shell", "OnBuild"}
    configuration = {key: value for key, value in details["Config"].items() if key in keys and value is not None}
    layer = backup / ("." + service + "-rootfs.tar")
    archive = backup / (service + "-rollback-image.tar")
    paused = False
    try:
        with layer.open("xb") as output:
            os.chmod(output.name, 0o600)
            try:
                if details.get("State", {}).get("Running"):
                    run(["docker", "container", "pause", identity], capture_output=True)
                    paused = True
                run(["docker", "container", "export", identity], stdout=output)
            finally:
                if paused:
                    try:
                        run(["docker", "container", "unpause", identity], capture_output=True)
                    except subprocess.CalledProcessError:
                        raise RuntimeError("Не удалось возобновить контейнер " + service + ". Выполните docker unpause " + identity) from None
        created = datetime.now(timezone.utc).isoformat()
        config_bytes = json.dumps({"architecture": architecture, "os": "linux", "created": created, "config": configuration, "rootfs": {"type": "layers", "diff_ids": ["sha256:" + file_sha(layer)]}, "history": [{"created": created, "created_by": "VoiceRooms local rollback snapshot"}]}, sort_keys=True).encode()
        config_name = hashlib.sha256(config_bytes).hexdigest() + ".json"
        manifest_bytes = json.dumps([{"Config": config_name, "RepoTags": [tag], "Layers": ["layer.tar"]}]).encode()
        with archive.open("xb") as output:
            os.chmod(output.name, 0o600)
            with tarfile.open(fileobj=output, mode="w") as saved:
                for name, body in [(config_name, config_bytes), ("manifest.json", manifest_bytes)]:
                    entry = tarfile.TarInfo(name); entry.size = len(body); entry.mode = 0o600
                    saved.addfile(entry, io.BytesIO(body))
                entry = tarfile.TarInfo("layer.tar"); entry.size = layer.stat().st_size; entry.mode = 0o600
                with layer.open("rb") as rootfs:
                    saved.addfile(entry, rootfs)
        run(["docker", "image", "load", "--input", str(archive)], capture_output=True)
        restored = json.loads(capture(["docker", "image", "inspect", tag]))[0]
        if any((restored.get("Config", {}).get(key) or None) != (value or None) for key, value in configuration.items()):
            raise RuntimeError("Резервный образ не сохранил настройки контейнера; обновление не начато")
        write_json(backup / (service + "-snapshot.json"), {"method": "export/load", "container": identity, "originalImage": container["image"], "rollbackImage": tag, "archiveSha256": file_sha(archive), "size": archive.stat().st_size})
    finally:
        if layer.exists():
            layer.unlink()
    return "snapshot"


def preserve_rollback_image(service, container, tag, backup):
    rollback_target(service, container, tag)
    attempt = run(["docker", "image", "tag", container["image"], tag], check=False, capture_output=True, text=True)
    if attempt.returncode == 0:
        return "tagged"
    if "no such image" not in (attempt.stderr or "").lower():
        raise RuntimeError("Не удалось сохранить исходный образ " + service + "; обновление не начато")
    print("Исходный образ " + service + " недоступен. Сохраняем резервный образ из текущего контейнера…", flush=True)
    return snapshot_rollback_image(service, container, tag, backup)


def installed_state(current, env_file):
    current, env_file = Path(current), Path(env_file)
    releases = Path("/opt/voicerooms/releases")
    if not current.is_symlink():
        raise RuntimeError("Установленный выпуск VoiceRooms не найден. Для первой установки используйте deploy/update.ps1 -FirstInstall -AgreeLetsEncryptTerms.")
    previous = current.resolve(strict=True)
    if not previous.is_dir() or not previous.is_relative_to(releases.resolve()) or previous.parent != releases:
        raise RuntimeError("Текущий выпуск находится вне управляемого каталога")
    if env_file.is_symlink() or not env_file.is_file() or env_file.stat().st_mode & 0o077:
        raise RuntimeError("Приватная конфигурация не найдена или имеет небезопасные права")
    identifiers = capture(["docker", "ps", "-aq", "--filter", "label=com.docker.compose.project=voicerooms"]).split()
    containers = json.loads(capture(["docker", "inspect"] + identifiers)) if identifiers else []
    services = {}
    for container in containers:
        labels = container.get("Config", {}).get("Labels") or {}
        service = labels.get("com.docker.compose.service")
        if labels.get("com.docker.compose.oneoff") == "True":
            continue
        if service not in {"postgres", "livekit", "backend", "frontend", "bot"} or service in services:
            raise RuntimeError("Найден неожиданный состав контейнеров VoiceRooms")
        workdir = labels.get("com.docker.compose.project.working_dir", "")
        if not Path(workdir).is_relative_to(releases) or not re.fullmatch(r"sha256:[a-f0-9]{64}", container.get("Image", "")):
            raise RuntimeError("Контейнер VoiceRooms не принадлежит управляемому выпуску")
        services[service] = {"id": container["Id"], "image": container["Image"], "running": bool(container.get("State", {}).get("Running")), "mounts": [{"type": item.get("Type"), "name": item.get("Name"), "destination": item.get("Destination")} for item in container.get("Mounts", []) if item.get("Type") == "volume"]}
    if set(services) != {"postgres", "livekit", "backend", "frontend", "bot"} or not services["postgres"]["running"] or not services["livekit"]["running"]:
        raise RuntimeError("Работающий установленный VoiceRooms не найден. Первая установка выполняется отдельно.")
    expected_volumes = {"postgres": ("voicerooms_db_data", "/var/lib/postgresql/data"), "backend": ("voicerooms_uploads", "/app/uploads")}
    for service, (name, destination) in expected_volumes.items():
        if not any(mount["name"] == name and mount["destination"] == destination for mount in services[service]["mounts"]):
            raise RuntimeError("Тома VoiceRooms отличаются от ожидаемых; данные не изменены")
    return {"previous": str(previous), "environmentSha256": file_sha(env_file), "services": services}


def wait_json(url, expected, seconds=120):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            with urlopen(url, timeout=5) as response:
                data = json.load(response)
                if response.status == 200 and all(data.get(key) == value for key, value in expected.items()):
                    return data
        except Exception:
            pass
        time.sleep(2)
    raise RuntimeError("Сервис не прошёл проверку готовности: " + url)


def verify_downloads(origin, manifest, seconds=120):
    for name in sorted(DOWNLOADS):
        target = origin + "/downloads/" + PurePosixPath(name).name
        expected = manifest["files"][name]
        deadline = time.monotonic() + seconds
        last_problem = "сервис ещё запускается"
        while True:
            try:
                request = Request(target, headers={"Accept-Encoding": "identity", "Cache-Control": "no-cache"})
                with urlopen(request, timeout=min(10, max(0.1, deadline - time.monotonic()))) as response:
                    if response.status != 200:
                        raise RuntimeError("Проверка " + target + ": HTTP " + str(response.status))
                    if "text/html" in response.headers.get("Content-Type", "").lower():
                        raise RuntimeError("Проверка " + target + ": вместо приложения сервер вернул HTML-страницу")
                    digest, size = hashlib.sha256(), 0
                    while True:
                        chunk = response.read(1024 * 1024)
                        if not chunk:
                            break
                        size += len(chunk)
                        if size > expected["size"]:
                            raise RuntimeError("Проверка " + target + ": размер файла больше ожидаемого")
                        digest.update(chunk)
                    if size != expected["size"] or digest.hexdigest() != expected["sha256"]:
                        raise RuntimeError("Проверка " + target + ": размер или SHA-256 файла не совпадает с выпуском")
                break
            except HTTPError as error:
                error.close()
                if error.code not in {408, 425, 429, 500, 502, 503, 504}:
                    raise RuntimeError("Проверка " + target + ": HTTP " + str(error.code)) from None
                last_problem = "HTTP " + str(error.code)
            except (URLError, TimeoutError, ConnectionError, http.client.HTTPException, OSError) as error:
                last_problem = type(error).__name__
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RuntimeError("Не удалось дождаться скачивания " + target + "; последняя ошибка: " + last_problem)
            time.sleep(min(1, remaining))


def failure_reason(error):
    if isinstance(error, subprocess.CalledProcessError):
        return "Команда " + str(error.cmd[0]) + " завершилась с кодом " + str(error.returncode)
    if isinstance(error, HTTPError):
        return "Сервис вернул HTTP " + str(error.code)
    if isinstance(error, URLError):
        return "Ошибка подключения к сервису: " + type(error.reason).__name__
    return str(error)


def deployment_stage(value):
    print("Этап обновления: " + value, flush=True)
    return value


def switch_current(current, destination):
    current = Path(current)
    temporary = current.with_name(".current-update-" + str(time.time_ns()))
    temporary.symlink_to(destination, target_is_directory=True)
    os.replace(temporary, current)


def verified_helper(archive, name):
    if name not in {"preflight", "prepare", "bot_ready"}:
        raise ValueError("Неожиданный модуль обновления")
    with zipfile.ZipFile(archive) as bundle:
        code = bundle.read("deploy/" + name + ".py")
    module = types.ModuleType("voicerooms_update_" + name)
    module.__file__ = str(archive) + "!/deploy/" + name + ".py"
    # The archive and every helper were SHA-256 verified before any code is loaded.
    exec(compile(code, module.__file__, "exec"), module.__dict__)
    return module


def apply_release(archive, expected_sha, layout=None):
    if sys.platform != "linux" or os.geteuid() != 0:
        raise RuntimeError("Обновление запускается от root на целевом Ubuntu-хосте")
    import fcntl

    manifest, digest = validate_bundle(archive, expected_sha)
    settings = layout or {"base": "/opt/voicerooms", "env": "/etc/voicerooms/production.env", "backups": "/etc/voicerooms/backups", "lock": "/run/lock/voicerooms-install.lock"}
    base = Path(settings["base"])
    releases, current = base / "releases", base / "current"
    env_file, backup_base = Path(settings["env"]), Path(settings["backups"])
    preflight = verified_helper(archive, "preflight")
    prepare = verified_helper(archive, "prepare")
    bot_ready = verified_helper(archive, "bot_ready")
    if base.is_symlink() or releases.is_symlink() or backup_base.is_symlink():
        raise RuntimeError("Небезопасный каталог VoiceRooms")
    preflight.check()
    # Share the existing installer lock; concurrent update/install processes must not overlap.
    with open(settings["lock"], "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        state = installed_state(current, env_file)
        env = prepare.read_env(env_file)
        if env.get("DOMAIN") != DOMAIN or env.get("PUBLIC_IPV4") != IP:
            raise RuntimeError("Приватная конфигурация указывает на другой хост")
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + digest[:12]
        release = releases / stamp
        if release.exists():
            raise RuntimeError("Такой выпуск уже подготовлен. Повторите запуск через секунду.")
        backup_base.mkdir(parents=True, exist_ok=True, mode=0o700)
        backup = backup_base / ("update-" + stamp)
        backup.mkdir(mode=0o700)
        shutil.copy2(env_file, backup / "production.env")
        (backup / "production.env").chmod(0o600)
        write_json(backup / "before.json", state)
        extract_bundle(archive, release, manifest)
        old_root = Path(state["previous"])
        old_proxy = old_root / "proxy.compose.yaml"
        if old_proxy.exists():
            if old_proxy.is_symlink() or old_proxy.stat().st_size > 8192:
                raise RuntimeError("Неожиданная конфигурация подключения бота")
            shutil.copy2(old_proxy, release / "proxy.compose.yaml")
        prepare.render(env_file, release / "livekit.yaml")
        os.chown(release / "livekit.yaml", 10001, 10001)
        # Preserve old images before building; a removed parent needs a standalone snapshot.
        old_images, new_images = {}, {}
        for service in ["backend", "frontend", "bot"]:
            old_images[service] = f"voicerooms-{service}:rollback-{stamp.lower()}"
            new_images[service] = f"voicerooms-{service}:release-{stamp.lower()}"
            preserve_rollback_image(service, state["services"][service], old_images[service], backup)
        rollback_file, images_file = backup / "rollback-images.compose.yaml", release / "release-images.compose.yaml"
        image_override(rollback_file, old_images)
        image_override(images_file, new_images)
        old_command = compose(old_root, env_file, rollback_file)
        command = compose(release, env_file, images_file)
        changed = False
        migrated = False
        stage = deployment_stage("проверка конфигурации")
        try:
            run(command + ["config", "--quiet"])
            for service in ["backend", "frontend", "bot"]:
                stage = deployment_stage("сборка " + service)
                run(command + ["build", service])
            # The database snapshot stays on the server; credentials never leave it.
            stage = deployment_stage("резервная копия базы")
            with (backup / "database.dump").open("xb") as output:
                os.chmod(output.name, 0o600)
                run(["docker", "exec", state["services"]["postgres"]["id"], "pg_dump", "-U", "voicerooms", "-d", "voicerooms", "--format=custom", "--no-owner", "--no-acl"], stdout=output)
            if (backup / "database.dump").stat().st_size < 64:
                raise RuntimeError("Резервная копия базы данных не создана")
            stage = deployment_stage("миграции базы")
            run(command + ["run", "--rm", "--no-deps", "backend", "npx", "prisma", "migrate", "deploy"])
            migrated = True
            changed = True
            stage = deployment_stage("запуск API и проверка готовности")
            run(command + ["up", "-d", "--no-deps", "--no-build", "--force-recreate", "backend"])
            wait_json("http://127.0.0.1:3099/api/ready", {"status": "ok", "database": True, "media": True})
            stage = deployment_stage("запуск сайта")
            run(command + ["up", "-d", "--no-deps", "--no-build", "--force-recreate", "frontend"])
            stage = deployment_stage("готовность сайта и файлы через localhost")
            verify_downloads("http://127.0.0.1:5199", manifest)
            stage = deployment_stage("готовность API через HTTPS")
            wait_json("https://" + DOMAIN + "/api/ready", {"status": "ok", "database": True, "media": True})
            stage = deployment_stage("файлы через HTTPS")
            verify_downloads("https://" + DOMAIN, manifest)
            stage = deployment_stage("публичные комнаты")
            public = wait_json("https://" + DOMAIN + "/api/rooms/public", {})
            if len(public.get("rooms", [])) != 3:
                raise RuntimeError("Не найдены три публичные комнаты VoiceRooms")
            stage = deployment_stage("запуск и проверка бота")
            run(command + ["up", "-d", "--no-deps", "--no-build", "--force-recreate", "bot"])
            bot_ready.wait_for_bot(command)
            stage = deployment_stage("сохранность конфигурации и сервисов")
            if file_sha(env_file) != state["environmentSha256"]:
                raise RuntimeError("Приватная конфигурация изменилась во время обновления")
            after = installed_state(current, env_file)
            for service in ["postgres", "livekit"]:
                if after["services"][service]["id"] != state["services"][service]["id"]:
                    raise RuntimeError("Один из сохраняемых сервисов неожиданно изменился")
            switch_current(current, release)
            write_json(backup / "success.json", {"release": str(release), "revision": manifest["revision"], "bundleSha256": digest, "databaseMigrated": migrated})
        except Exception as error:
            reason = "Этап: " + stage + ". Причина: " + failure_reason(error)
            try:
                write_json(backup / "failure.json", {"stage": stage, "reason": failure_reason(error), "databaseMigrated": migrated})
            except OSError:
                pass
            if changed:
                try:
                    run(old_command + ["up", "-d", "--no-deps", "--no-build", "--force-recreate", "backend", "frontend", "bot"])
                    switch_current(current, old_root)
                    write_json(backup / "rollback.json", {"containersRestored": True, "databaseMigrated": migrated, "schemaRollback": False})
                except Exception:
                    raise RuntimeError(reason + ". Обновление остановлено. Автоматический возврат контейнеров не завершён. Резервная копия сохранена на хосте: " + str(backup)) from None
            raise RuntimeError(reason + ". Обновление остановлено; прежние контейнеры восстановлены, если запуск новых уже начался. Миграции базы автоматически не отменяются. Резервная копия: " + str(backup)) from error
        print(json.dumps({"status": "updated", "url": "https://" + DOMAIN, "revision": manifest["revision"], "backup": str(backup), "databaseMigrated": True, "otherProjectsChanged": False}))


def first_install(archive, expected_sha, env_upload, email, agree_terms=False, layout=None):
    if sys.platform != "linux" or os.geteuid() != 0:
        raise RuntimeError("Первая установка запускается от root на целевом Ubuntu-хосте")
    manifest, digest = validate_bundle(archive, expected_sha)
    settings = layout or {"base":"/opt/voicerooms","env":"/etc/voicerooms/production.env","upload_root":"/root/.cache"}
    base, env_file = Path(settings["base"]), Path(settings["env"])
    private = Path(env_upload)
    upload_root = Path(settings["upload_root"]).resolve()
    if private.name != "production.env" or private.is_symlink() or private.parent.resolve() != Path(archive).parent.resolve() or not private.parent.resolve().is_relative_to(upload_root) or not private.is_file():
        raise ValueError("Небезопасный путь переданной приватной конфигурации")
    private.chmod(0o600)
    try:
        if env_file.exists() or env_file.is_symlink() or (base / "current").exists() or (base / "current").is_symlink():
            raise RuntimeError("VoiceRooms уже установлен. Запустите обновление без -FirstInstall; конфигурация сохранена.")
        if base.is_symlink() or (base / "releases").is_symlink():
            raise RuntimeError("Небезопасный каталог первой установки")
        if not re.fullmatch(r"[A-Za-z0-9._+%-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", email):
            raise ValueError("Для первой установки нужен адрес электронной почты для сертификата")
        preflight = verified_helper(archive,"preflight")
        prepare = verified_helper(archive,"prepare")
        env = prepare.read_env(private)
        if env.get("DOMAIN") != DOMAIN or env.get("PUBLIC_IPV4") != IP:
            raise RuntimeError("Приватная конфигурация указывает на другой хост")
        preflight.check()
        releases = base / "releases"
        releases.mkdir(parents=True,exist_ok=True,mode=0o755)
        release = releases / (datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + digest[:12])
        extract_bundle(archive,release,manifest)
        command = [sys.executable,str(release / "deploy/install.py"),"--env-upload",str(private),"--email",email]
        if agree_terms:
            command.append("--agree-terms")
        # The existing installer only touches the portfolio with an explicit flag;
        # this entry point deliberately never passes that flag.
        run(command)
        wait_json("https://" + DOMAIN + "/api/ready",{"status":"ok","database":True,"media":True})
        verify_downloads("https://" + DOMAIN,manifest)
        print(json.dumps({"status":"installed","url":"https://" + DOMAIN,"revision":manifest["revision"],"otherProjectsChanged":False}))
    finally:
        # This path was verified to be the one private transfer file next to the ZIP.
        private.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", required=True)
    parser.add_argument("--sha256")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--apply", action="store_true")
    mode.add_argument("--first-install", action="store_true")
    parser.add_argument("--env-upload")
    parser.add_argument("--email")
    parser.add_argument("--agree-terms", action="store_true")
    args = parser.parse_args()
    try:
        manifest, digest = validate_bundle(args.archive, args.sha256)
        if args.first_install:
            if not args.sha256 or not args.env_upload or not args.email:
                raise ValueError("Для первой установки нужны контрольная сумма, приватная конфигурация и email")
            first_install(args.archive,args.sha256,args.env_upload,args.email,args.agree_terms)
        elif args.apply:
            if not args.sha256:
                raise ValueError("Для установки нужна контрольная сумма архива")
            apply_release(args.archive, args.sha256)
        else:
            print(json.dumps({"status": "plan", "version": manifest["version"], "revision": manifest["revision"], "sha256": digest, "fileCount": len(manifest["files"]), "downloads": {PurePosixPath(name).name: manifest["files"][name] for name in sorted(DOWNLOADS)}, "remoteChanges": False}))
    except Exception as error:
        print("Обновление VoiceRooms остановлено: " + str(error), file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
