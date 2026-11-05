"""Build a public runtime-only ZIP; local private applications are never selected."""

import argparse
import json
import plistlib
import struct
import subprocess
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from xml.etree import ElementTree

from update import DOWNLOADS, EXACT_FILES, MANIFEST, MAX_BUNDLE_BYTES, MAX_FILE_BYTES, REQUIRED, VERSION, file_sha, public_path, validate_bundle


def linked(path):
    return path.is_symlink() or bool(getattr(path, "is_junction", lambda: False)())


def safe_source(source, root):
    source, root = Path(source), Path(root)
    if not source.resolve(strict=True).is_relative_to(root.resolve(strict=True)):
        raise ValueError("Файл выпуска находится вне проекта")
    current = source
    while current != root:
        if linked(current):
            raise ValueError("Файл выпуска или его каталог является ссылкой")
        current = current.parent
    if not source.is_file() or source.stat().st_size > MAX_FILE_BYTES:
        raise ValueError("Неверный размер или тип файла выпуска")


def apk_manifest_attributes(raw):
    if raw.lstrip().startswith(b"<"):
        return ElementTree.fromstring(raw).attrib
    if len(raw) < 8 or struct.unpack_from("<H", raw, 0)[0] != 3:
        raise ValueError("В APK нет Android-манифеста")
    strings, offset = [], struct.unpack_from("<H", raw, 2)[0]
    while offset + 8 <= len(raw):
        kind, header, size = struct.unpack_from("<HHI", raw, offset)
        if size < 8 or offset + size > len(raw):
            raise ValueError("Повреждён Android-манифест")
        if kind == 1:
            count, _, flags, start, _ = struct.unpack_from("<IIIII", raw, offset + 8)
            if count > 100000 or count * 4 > size - header:
                raise ValueError("Повреждён список строк Android-манифеста")
            offsets = struct.unpack_from("<" + "I" * count, raw, offset + header)
            for relative in offsets:
                cursor = offset + start + relative
                if flags & 0x100:
                    first = raw[cursor]
                    cursor += 2 if first & 0x80 else 1
                    length = raw[cursor]
                    if length & 0x80:
                        length = ((length & 0x7F) << 8) | raw[cursor + 1]
                        cursor += 2
                    else:
                        cursor += 1
                    strings.append(raw[cursor:cursor + length].decode("utf-8"))
                else:
                    length = struct.unpack_from("<H", raw, cursor)[0]
                    cursor += 2
                    if length & 0x8000:
                        length = ((length & 0x7FFF) << 16) | struct.unpack_from("<H", raw, cursor)[0]
                        cursor += 2
                    strings.append(raw[cursor:cursor + length * 2].decode("utf-16le"))
        elif kind == 0x102:
            name = struct.unpack_from("<I", raw, offset + 20)[0]
            if strings[name] == "manifest":
                start, attribute_size, count = struct.unpack_from("<HHH", raw, offset + 24)
                values = {}
                for index in range(count):
                    attribute = offset + 16 + start + index * attribute_size
                    name_index, value_index = struct.unpack_from("<II", raw, attribute + 4)
                    data_type, data = raw[attribute + 15], struct.unpack_from("<I", raw, attribute + 16)[0]
                    value = strings[value_index] if value_index != 0xFFFFFFFF else strings[data] if data_type == 3 else str(data)
                    values[strings[name_index]] = value
                return values
        offset += size
    raise ValueError("В APK не найден корневой Android-манифест")


def validate_applications(root):
    apk, ipa = (root / name for name in sorted(DOWNLOADS))
    with zipfile.ZipFile(apk) as app:
        if "classes.dex" not in app.namelist() or "AndroidManifest.xml" not in app.namelist():
            raise ValueError("Пользовательский APK неполный")
        attributes = apk_manifest_attributes(app.read("AndroidManifest.xml"))
        package = attributes.get("package")
        version = attributes.get("versionName") or attributes.get("{http://schemas.android.com/apk/res/android}versionName")
        if package != "ru.voicerooms" or version != VERSION:
            raise ValueError("Для публикации нужен обычный VoiceRooms APK версии " + VERSION)
    with zipfile.ZipFile(ipa) as app:
        info_paths = [name for name in app.namelist() if len(Path(name).parts) == 3 and name.startswith("Payload/") and name.endswith(".app/Info.plist")]
        if len(info_paths) != 1:
            raise ValueError("В IPA должен быть ровно один пользовательский пакет")
        info = plistlib.loads(app.read(info_paths[0]))
        if info.get("CFBundleIdentifier") != "ru.voicerooms.app" or info.get("CFBundleShortVersionString") != VERSION:
            raise ValueError("Для публикации нужен обычный VoiceRooms IPA версии " + VERSION)
        executable = info.get("CFBundleExecutable", "")
        if not executable or "/" in executable or "\\" in executable:
            raise ValueError("В IPA не указан исполняемый файл")
        binary_path = str(Path(info_paths[0]).parent).replace("\\", "/") + "/" + executable
        binary = app.read(binary_path)[:32]
        if len(binary) < 8 or binary[:4] != b"\xcf\xfa\xed\xfe" or int.from_bytes(binary[4:8], "little") != 0x0100000C:
            raise ValueError("IPA должен содержать приложение для настоящего iPhone, а не симулятора")
        if "iPhoneOS" not in info.get("CFBundleSupportedPlatforms", []) and info.get("DTPlatformName") != "iphoneos":
            raise ValueError("Не подтверждена платформа iPhoneOS в IPA")


def git_metadata(root, allow_dirty=False):
    def git(*args):
        return subprocess.run(["git", "-C", str(root), *args], check=True, capture_output=True, text=True).stdout.strip()
    if git("remote", "get-url", "origin") != "https://github.com/Salatik-s/VoiseRooms.git":
        raise ValueError("Это не ожидаемый репозиторий VoiceRooms")
    revision = git("rev-parse", "HEAD")
    dirty = bool(git("status", "--porcelain", "--untracked-files=no"))
    if dirty and not allow_dirty:
        raise ValueError("Сохраните проверенные исходники в коммит перед отправкой. Для просмотра состава используйте -PlanOnly.")
    return revision, dirty


def create_bundle(root, output, allow_dirty=False, metadata=None):
    root, output = Path(root).resolve(strict=True), Path(output)
    revision, dirty = metadata or git_metadata(root, allow_dirty)
    selected = {name for name in EXACT_FILES if (root / name).is_file()}
    for folder in ["backend/src", "backend/prisma/migrations", "frontend/src", "frontend/public"]:
        base = root / folder
        if base.exists():
            for path in base.rglob("*"):
                name = path.relative_to(root).as_posix()
                if path.is_file() and public_path(name):
                    selected.add(name)
    for folder in ["bot", "deploy"]:
        base = root / folder
        if base.exists():
            for path in base.glob("*.py"):
                name = path.relative_to(root).as_posix()
                if public_path(name):
                    selected.add(name)
    if not REQUIRED.issubset(selected):
        missing = ", ".join(sorted(REQUIRED - selected))
        raise ValueError("Для выпуска не хватает обязательных публичных файлов: " + missing)
    total = 0
    records = {}
    for name in sorted(selected):
        safe_source(root / name, root)
        size = (root / name).stat().st_size
        total += size
        if total > MAX_BUNDLE_BYTES:
            raise ValueError("Файлы выпуска слишком большие")
        records[name] = {"size": size, "sha256": file_sha(root / name)}
    validate_applications(root)
    manifest = {"format": 1, "version": VERSION, "revision": revision, "dirty": dirty, "createdAt": datetime.now(timezone.utc).isoformat(), "files": records}
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.is_symlink() or linked(output.parent):
        raise ValueError("Небезопасный путь архива выпуска")
    with zipfile.ZipFile(output, "w") as bundle:
        for name in sorted(records):
            bundle.write(root / name, name, compress_type=zipfile.ZIP_STORED if name in DOWNLOADS else zipfile.ZIP_DEFLATED)
        bundle.writestr(MANIFEST, json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2), compress_type=zipfile.ZIP_DEFLATED)
    validate_bundle(output)
    return manifest, file_sha(output)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--allow-dirty", action="store_true")
    args = parser.parse_args()
    try:
        manifest, digest = create_bundle(args.source, args.output, args.allow_dirty)
        print(json.dumps({"archive": str(Path(args.output).resolve()), "sha256": digest, "revision": manifest["revision"], "version": VERSION, "fileCount": len(manifest["files"]), "dirty": manifest["dirty"], "updaterSha256": manifest["files"]["deploy/update.py"]["sha256"]}))
    except Exception as error:
        print("Не удалось подготовить VoiceRooms: " + str(error), file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
