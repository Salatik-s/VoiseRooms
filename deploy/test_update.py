import contextlib
import hashlib
import http.server
import io
import json
import os
import plistlib
import struct
import subprocess
import sys
import tempfile
import threading
import types
import unittest
import warnings
import zipfile
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))
import package_release as package
import update

REVISION = "a" * 40


def binary_manifest(package_id="ru.voicerooms"):
    values = ["manifest", "package", package_id, "versionName", update.VERSION]
    strings, offsets = b"", []
    for value in values:
        encoded = value.encode("utf-8")
        offsets.append(len(strings))
        strings += bytes([len(value), len(encoded)]) + encoded + b"\0"
    start = 28 + len(values) * 4
    pool_size = (start + len(strings) + 3) // 4 * 4
    pool = struct.pack("<HHIIIIII", 1, 28, pool_size, len(values), 0, 0x100, start, 0) + struct.pack("<" + "I" * len(values), *offsets) + strings
    pool += b"\0" * (pool_size - len(pool))
    attrs = b"".join(struct.pack("<IIIHBBI", 0xFFFFFFFF, name, value, 8, 0, 3, value) for name, value in [(1, 2), (3, 4)])
    element = struct.pack("<HHIII", 0x102, 16, 36 + len(attrs), 1, 0xFFFFFFFF) + struct.pack("<IIHHHHHH", 0xFFFFFFFF, 0, 20, 20, 2, 0, 0, 0) + attrs
    return struct.pack("<HHI", 3, 8, 8 + len(pool) + len(element)) + pool + element


def applications(root, android_id="ru.voicerooms", ios_id="ru.voicerooms.app"):
    folder = root / "frontend/public/downloads"
    folder.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(folder / f"VoiceRooms-{update.VERSION}.apk", "w") as archive:
        archive.writestr("AndroidManifest.xml", binary_manifest(android_id))
        archive.writestr("classes.dex", b"dex\n035\0fixture")
    info = {"CFBundleIdentifier": ios_id, "CFBundleShortVersionString": update.VERSION, "CFBundleExecutable": "VoiceRooms", "CFBundleSupportedPlatforms": ["iPhoneOS"]}
    with zipfile.ZipFile(folder / f"VoiceRooms-{update.VERSION}.ipa", "w") as archive:
        archive.writestr("Payload/VoiceRooms.app/Info.plist", plistlib.dumps(info))
        archive.writestr("Payload/VoiceRooms.app/VoiceRooms", b"\xcf\xfa\xed\xfe" + (0x0100000C).to_bytes(4, "little") + b"\0" * 24)


def source_fixture(root):
    root.mkdir(parents=True, exist_ok=True)
    for name in update.REQUIRED - update.DOWNLOADS:
        target = root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("fixture\n", encoding="utf-8")
    migration = root / "backend/prisma/migrations/202611050001/migration.sql"
    migration.parent.mkdir(parents=True, exist_ok=True)
    migration.write_text('ALTER TABLE "Room" ADD COLUMN "test" BOOLEAN DEFAULT false;\n')
    applications(root)
    for name in [".env", "signing.jks", "android/app.apk", ".impeccable/runtime/private.env", "frontend/public/downloads/other.apk", "frontend/node_modules/private.js"]:
        target = root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("not-a-public-runtime-file")
    return root


def rewrite_bundle(path, mutate):
    with zipfile.ZipFile(path) as original:
        entries = {entry.filename: (entry, original.read(entry)) for entry in original.infolist()}
    manifest = json.loads(entries[update.MANIFEST][1])
    mutate(entries, manifest)
    entries[update.MANIFEST] = (update.MANIFEST, json.dumps(manifest).encode())
    with zipfile.ZipFile(path, "w") as archive:
        for entry, data in entries.values():
            archive.writestr(entry, data)


class ReleasePackageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.base = Path(self.temporary.name).resolve()
        self.addCleanup(self.temporary.cleanup)
        self.root = source_fixture(self.base / "source")
        self.archive = self.base / "release.zip"

    def bundle(self):
        return package.create_bundle(self.root, self.archive, metadata=(REVISION, False))

    def test_explicit_runtime_selection_and_checksums(self):
        manifest, digest = self.bundle()
        checked, actual = update.validate_bundle(self.archive, digest)
        self.assertEqual(digest, actual)
        self.assertEqual(manifest, checked)
        self.assertTrue(update.DOWNLOADS.issubset(manifest["files"]))
        self.assertFalse(any("node_modules" in name or name.endswith(".jks") or name.endswith("private.env") or name.startswith("android/") or name.endswith("other.apk") for name in manifest["files"]))
        destination = self.base / "extracted"
        update.extract_bundle(self.archive, destination, manifest)
        self.assertEqual((destination / "frontend/src/main.tsx").read_text(), "fixture\n")
        self.assertFalse((destination / ".env").exists())
        with self.assertRaises(ValueError):
            update.extract_bundle(self.archive, destination, manifest)

    def test_android_binary_manifest_and_exact_application_ids(self):
        self.assertEqual(package.apk_manifest_attributes(binary_manifest())["package"], "ru.voicerooms")
        applications(self.root, android_id="ru.not-public")
        with self.assertRaisesRegex(ValueError, "обычный VoiceRooms APK"):
            self.bundle()
        applications(self.root, ios_id="ru.not-public")
        with self.assertRaisesRegex(ValueError, "обычный VoiceRooms IPA"):
            self.bundle()

    def test_simulator_binary_is_not_a_phone_ipa(self):
        path = self.root / f"frontend/public/downloads/VoiceRooms-{update.VERSION}.ipa"
        with zipfile.ZipFile(path) as original:
            info = original.read("Payload/VoiceRooms.app/Info.plist")
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr("Payload/VoiceRooms.app/Info.plist", info)
            archive.writestr("Payload/VoiceRooms.app/VoiceRooms", b"\xcf\xfa\xed\xfe" + (0x01000007).to_bytes(4, "little") + b"\0" * 24)
        with self.assertRaisesRegex(ValueError, "настоящего iPhone"):
            self.bundle()

    def test_path_traversal_absolute_hidden_and_private_entries_are_refused(self):
        for name in ["../escape.py", "/root/escape.py", "C:/escape.py", "frontend\\src\\escape.ts", "frontend/src/../escape.ts", "frontend/src/.env", ".git/config", "frontend/public/downloads/extra.ipa"]:
            self.assertFalse(update.public_path(name), name)
        self.bundle()
        def attack(entries, manifest):
            name, body = "../escape.py", b"unsafe"
            entries[name] = (name, body)
            manifest["files"][name] = {"size": len(body), "sha256": hashlib.sha256(body).hexdigest()}
        rewrite_bundle(self.archive, attack)
        with self.assertRaises(ValueError):
            update.validate_bundle(self.archive)

    def test_symlinks_and_tampered_contents_are_refused(self):
        self.bundle()
        def attack(entries, manifest):
            name, body = "frontend/src/link.ts", b"outside"
            info = zipfile.ZipInfo(name)
            info.create_system = 3
            info.external_attr = 0o120777 << 16
            entries[name] = (info, body)
            manifest["files"][name] = {"size": len(body), "sha256": hashlib.sha256(body).hexdigest()}
        rewrite_bundle(self.archive, attack)
        with self.assertRaises(ValueError):
            update.validate_bundle(self.archive)
        self.bundle()
        rewrite_bundle(self.archive, lambda entries, _: entries.__setitem__("frontend/src/main.tsx", ("frontend/src/main.tsx", b"changed")))
        with self.assertRaises(ValueError):
            update.validate_bundle(self.archive)

    def test_expected_archive_digest_missing_artifact_and_destructive_migration(self):
        self.bundle()
        with self.assertRaisesRegex(ValueError, "Контрольная сумма"):
            update.validate_bundle(self.archive, "0" * 64)
        artifact = self.root / f"frontend/public/downloads/VoiceRooms-{update.VERSION}.ipa"
        artifact.unlink()
        with self.assertRaisesRegex(ValueError, "не хватает"):
            self.bundle()
        applications(self.root)
        (self.root / "backend/prisma/migrations/202611050001/migration.sql").write_text('DROP TABLE "Room";')
        with self.assertRaisesRegex(ValueError, "миграция"):
            self.bundle()

    def test_windows_powershell_plan_packages_without_ssh(self):
        if os.name != "nt":
            self.skipTest("Native Windows PowerShell test")
        subprocess.run(["git", "init", str(self.root)], check=True, capture_output=True)
        subprocess.run(["git", "-C", str(self.root), "remote", "add", "origin", "https://github.com/Salatik-s/VoiseRooms.git"], check=True, capture_output=True)
        subprocess.run(["git", "-C", str(self.root), "add", "."], check=True, capture_output=True)
        subprocess.run(["git", "-C", str(self.root), "-c", "user.name=Release tests", "-c", "user.email=tests@localhost", "commit", "-m", "Create release fixture"], check=True, capture_output=True)
        result = subprocess.run(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(Path(__file__).with_name("update.ps1")), "-PlanOnly", "-SourceRoot", str(self.root), "-Python", sys.executable, "-OutputDirectory", str(self.base / "plan")], capture_output=True, encoding="utf-8", errors="replace")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        packages = list((self.base / "plan").glob("*.zip"))
        self.assertEqual(len(packages), 1)
        update.validate_bundle(packages[0])
        self.assertNotIn("ssh.exe", result.stdout.lower())

    def test_first_install_uses_the_verified_bundle_without_portfolio_publication(self):
        _manifest,digest=self.bundle()
        host=self.base / "new-host"
        private=self.base / "production.env"
        private.write_text("private transfer fixture")
        calls=[]
        def helpers(_archive,name):
            return types.SimpleNamespace(check=lambda:None) if name=="preflight" else types.SimpleNamespace(read_env=lambda _:{"DOMAIN":update.DOMAIN,"PUBLIC_IPV4":update.IP})
        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch.object(update.sys,"platform","linux"))
            stack.enter_context(mock.patch.object(update.os,"geteuid",return_value=0,create=True))
            stack.enter_context(mock.patch.object(update,"verified_helper",side_effect=helpers))
            stack.enter_context(mock.patch.object(update,"run",side_effect=lambda args,**_:calls.append(args)))
            stack.enter_context(mock.patch.object(update,"wait_json"))
            stack.enter_context(mock.patch.object(update,"verify_downloads"))
            stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            update.first_install(self.archive,digest,private,"voice@example.com",True,{"base":str(host),"env":str(host / "production.env"),"upload_root":str(self.base)})
        self.assertEqual(len(calls),1)
        self.assertTrue(calls[0][1].endswith("install.py"))
        self.assertIn("--agree-terms",calls[0])
        self.assertNotIn("--publish-portfolio",calls[0])
        self.assertFalse(private.exists())
        self.assertEqual(len(list((host / "releases").iterdir())),1)

    def test_first_install_preserves_installed_configuration_and_refuses_unrelated_private_paths(self):
        _manifest,digest=self.bundle()
        host=self.base / "installed-host"
        host.mkdir()
        existing=host / "production.env"
        existing.write_text("installed configuration fixture")
        private=self.base / "production.env"
        private.write_text("private transfer fixture")
        with mock.patch.object(update.sys,"platform","linux"), mock.patch.object(update.os,"geteuid",return_value=0,create=True):
            with self.assertRaisesRegex(RuntimeError,"уже установлен"):
                update.first_install(self.archive,digest,private,"voice@example.com",False,{"base":str(host),"env":str(existing),"upload_root":str(self.base)})
        self.assertEqual(existing.read_text(),"installed configuration fixture")
        self.assertFalse(private.exists())
        unrelated=self.base / "unrelated.env"
        unrelated.write_text("preserve me")
        with mock.patch.object(update.sys,"platform","linux"), mock.patch.object(update.os,"geteuid",return_value=0,create=True):
            with self.assertRaisesRegex(ValueError,"Небезопасный путь"):
                update.first_install(self.archive,digest,unrelated,"voice@example.com",False,{"base":str(host),"env":str(existing),"upload_root":str(self.base)})
        self.assertEqual(unrelated.read_text(),"preserve me")

    def test_rollback_image_tag_and_missing_image_recovery_are_distinct(self):
        container = {"id": "b" * 64, "image": "sha256:" + "a" * 64, "running": True}
        tag = "voicerooms-backend:rollback-test"
        for status, message, expected in [(0, "", "tagged"), (1, "Error response from daemon: No such image: sha256:" + "a" * 64, "snapshot")]:
            with self.subTest(status=status), mock.patch.object(update, "run", return_value=types.SimpleNamespace(returncode=status, stderr=message)), mock.patch.object(update, "snapshot_rollback_image", return_value="snapshot") as snapshot, contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(update.preserve_rollback_image("backend", container, tag, self.base), expected)
                self.assertEqual(snapshot.call_count, status)
        with mock.patch.object(update, "run", return_value=types.SimpleNamespace(returncode=1, stderr="Cannot connect to the Docker daemon")), mock.patch.object(update, "snapshot_rollback_image") as snapshot:
            with self.assertRaisesRegex(RuntimeError, "обновление не начато"):
                update.preserve_rollback_image("backend", container, tag, self.base)
            snapshot.assert_not_called()

    def test_rollback_refuses_database_media_and_foreign_tags(self):
        container = {"id": "b" * 64, "image": "sha256:" + "a" * 64}
        for service, tag in [("postgres", "voicerooms-postgres:rollback-test"), ("livekit", "voicerooms-livekit:rollback-test"), ("backend", "another-project:rollback-test")]:
            with self.subTest(service=service), mock.patch.object(update, "run") as command:
                with self.assertRaises(ValueError):
                    update.preserve_rollback_image(service, container, tag, self.base)
                command.assert_not_called()

    def test_scoped_commands_and_rollback_keep_database_snapshot(self):
        manifest, digest = self.bundle()
        for fail_after_migration in [False, True]:
            with self.subTest(failure=fail_after_migration):
                host = self.base / ("failure" if fail_after_migration else "success")
                releases, backup = host / "releases", host / "backups"
                old_root = releases / "old"
                old_root.mkdir(parents=True)
                (old_root / "compose.yaml").write_text("services: {}")
                env = host / "production.env"
                env.write_text("DOMAIN=voise.24projects.ru\nPUBLIC_IPV4=157.228.191.231\n")
                before = {"previous": str(old_root), "environmentSha256": update.file_sha(env), "services": {name: {"id": hashlib.sha256(name.encode()).hexdigest(), "image": "sha256:" + "a" * 64, "running": True, "mounts": []} for name in ["postgres", "livekit", "backend", "frontend", "bot"]}}
                calls, switched = [], []
                def fake_run(args, **kwargs):
                    calls.append(args)
                    if "pg_dump" in args:
                        kwargs["stdout"].write(b"database-backup" * 20)
                    return types.SimpleNamespace(returncode=0)
                def helpers(_archive, name):
                    if name == "preflight":
                        return types.SimpleNamespace(check=lambda: None)
                    if name == "prepare":
                        return types.SimpleNamespace(read_env=lambda _: {"DOMAIN": update.DOMAIN, "PUBLIC_IPV4": update.IP}, render=lambda _env, path: path.write_text("private-media-config"))
                    return types.SimpleNamespace(wait_for_bot=lambda command: calls.append(command + ["verified-bot"]))
                def downloads(*_args):
                    if fail_after_migration:
                        raise RuntimeError("download check failed")
                layout = {"base": str(host), "env": str(env), "backups": str(backup), "lock": str(host / "install.lock")}
                fake_fcntl = types.SimpleNamespace(flock=lambda *_: None, LOCK_EX=1, LOCK_NB=2)
                with contextlib.ExitStack() as stack:
                    stack.enter_context(mock.patch.object(update.sys, "platform", "linux"))
                    stack.enter_context(mock.patch.object(update.os, "geteuid", return_value=0, create=True))
                    stack.enter_context(mock.patch.object(update.os, "chown", create=True))
                    stack.enter_context(mock.patch.dict(sys.modules, {"fcntl": fake_fcntl}))
                    stack.enter_context(mock.patch.object(update, "verified_helper", side_effect=helpers))
                    stack.enter_context(mock.patch.object(update, "installed_state", return_value=before))
                    stack.enter_context(mock.patch.object(update, "run", side_effect=fake_run))
                    stack.enter_context(mock.patch.object(update, "wait_json", return_value={"rooms": [{}, {}, {}]}))
                    stack.enter_context(mock.patch.object(update, "verify_downloads", side_effect=downloads))
                    stack.enter_context(mock.patch.object(update, "switch_current", side_effect=lambda *args: switched.append(args)))
                    stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
                    if fail_after_migration:
                        with self.assertRaisesRegex(RuntimeError, "Миграции базы автоматически не отменяются"):
                            update.apply_release(self.archive, digest, layout)
                    else:
                        update.apply_release(self.archive, digest, layout)
                compose_calls = [call for call in calls if call[:2] == ["docker", "compose"]]
                self.assertTrue(compose_calls)
                self.assertTrue(all(call[call.index("--project-name") + 1] == "voicerooms" for call in compose_calls))
                self.assertFalse(any("down" in call or "-v" in call for call in calls))
                self.assertEqual([call[-1] for call in compose_calls if "build" in call and "--no-build" not in call], ["backend", "frontend", "bot"])
                snapshots = list(backup.glob("update-*/database.dump"))
                self.assertEqual(len(snapshots), 1)
                self.assertGreater(snapshots[0].stat().st_size, 64)
                self.assertEqual(update.file_sha(env), before["environmentSha256"])
                if fail_after_migration:
                    rollback = json.loads(next(backup.glob("update-*/rollback.json")).read_text())
                    self.assertTrue(rollback["containersRestored"])
                    self.assertFalse(rollback["schemaRollback"])
                    failure = json.loads(next(backup.glob("update-*/failure.json")).read_text())
                    self.assertIn("localhost", failure["stage"])
                    self.assertEqual(failure["reason"], "download check failed")
                    self.assertEqual(switched[-1][1], old_root)
                    self.assertTrue(any(call[-3:] == ["backend", "frontend", "bot"] for call in compose_calls if "up" in call))


class DownloadReadinessTests(unittest.TestCase):
    def setUp(self):
        fixture = self
        self.failures = 0
        self.status = 200
        self.corrupt = False
        self.requests = []
        self.files = {"/downloads/" + Path(name).name: (Path(name).suffix + "-synthetic-file").encode() for name in update.DOWNLOADS}
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass
            def do_GET(self):
                fixture.requests.append((self.command, self.path))
                if fixture.failures:
                    fixture.failures -= 1
                    self.send_error(503)
                    return
                if fixture.status != 200:
                    self.send_error(fixture.status)
                    return
                body = fixture.files[self.path]
                if fixture.corrupt:
                    body = b"x" * len(body)
                self.send_response(200)
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.origin = "http://127.0.0.1:" + str(self.server.server_port)
        self.manifest = {"files": {name: {"size": len(self.files["/downloads/" + Path(name).name]), "sha256": hashlib.sha256(self.files["/downloads/" + Path(name).name]).hexdigest()} for name in update.DOWNLOADS}}
    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
    def test_real_http_startup_503_retries_then_checks_both_payloads(self):
        self.failures = 2
        update.verify_downloads(self.origin, self.manifest, seconds=5)
        self.assertEqual(len(self.requests), 4)
        self.assertTrue(all(method == "GET" for method, _ in self.requests))
        self.assertEqual({path for _, path in self.requests}, set(self.files))
    def test_same_size_wrong_payload_is_rejected_by_sha_without_retry(self):
        self.corrupt = True
        with self.assertRaisesRegex(RuntimeError, "SHA-256"):
            update.verify_downloads(self.origin, self.manifest, seconds=5)
        self.assertEqual(len(self.requests), 1)
    def test_permanent_http_404_reports_url_without_retry(self):
        self.status = 404
        with self.assertRaisesRegex(RuntimeError, "HTTP 404") as caught:
            update.verify_downloads(self.origin, self.manifest, seconds=5)
        self.assertIn(self.origin + "/downloads/", str(caught.exception))
        self.assertEqual(len(self.requests), 1)
    def test_connection_failure_deadline_is_bounded_and_error_redacts_command_arguments(self):
        from urllib.error import URLError
        with mock.patch.object(update, "urlopen", side_effect=URLError("synthetic connection refused")) as request:
            with self.assertRaisesRegex(RuntimeError, "URLError"):
                update.verify_downloads(self.origin, self.manifest, seconds=0)
            self.assertEqual(request.call_count, 1)
        message = update.failure_reason(subprocess.CalledProcessError(1, ["docker", "synthetic-private-argument"]))
        self.assertNotIn("synthetic-private-argument", message)


if __name__ == "__main__":
    unittest.main()
