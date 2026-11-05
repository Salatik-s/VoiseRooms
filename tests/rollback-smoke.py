"""Exercise the real rollback helpers with synthetic Docker fixtures on CI only."""
import contextlib
import importlib.util
import json
import os
import secrets
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from unittest import mock

ALPINE = "alpine:3.22@sha256:2e0b81d60597f449baa56dc25d355367869d2dca4cd57e866f1e2b52af3eb55f"
FIELDS = ("Entrypoint", "Cmd", "Env", "User", "WorkingDir", "Healthcheck",
          "ExposedPorts", "Volumes", "StopSignal", "Shell", "StopTimeout")
ROOT = Path(__file__).resolve().parents[1]


def docker(*args, check=True):
    return subprocess.run(["docker", *args], check=check, capture_output=True, text=True)


def inspect(kind, value):
    return json.loads(docker(kind, "inspect", value).stdout)[0]


def healthy(container):
    for _ in range(100):
        state = inspect("container", container)["State"]
        assert state["Running"], "Synthetic fixture exited"
        if state.get("Health", {}).get("Status") == "healthy":
            return
        time.sleep(0.1)
    raise AssertionError("Fixture healthcheck did not pass")


def main():
    assert sys.platform == "linux" and os.environ.get("GITHUB_ACTIONS") == "true", (
        "Run only on the ephemeral Linux GitHub Actions runner"
    )
    assert os.environ.get("SMOKE_ALPINE") == ALPINE
    spec = importlib.util.spec_from_file_location("rollback_update", ROOT / "deploy/update.py")
    updater = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(updater)
    assert callable(updater.snapshot_rollback_image) and callable(updater.preserve_rollback_image)
    nonce = secrets.token_hex(6)
    prefix, source_volume = "voicerooms-rollback-ci-" + nonce, "voicerooms-rollback-data-" + nonce
    source, base = prefix + "-source", prefix + ":base"
    tags = {case: "voicerooms-backend:rollback-ci-" + nonce + "-" + case
            for case in ("fast", "direct", "fallback", "failure", "denied")}
    containers, volumes, results = [source], [source_volume], {}
    marker = "synthetic-volume-only-" + nonce
    with tempfile.TemporaryDirectory(prefix="voicerooms-rollback-ci-") as temporary:
        private = Path(temporary)
        private.chmod(0o700)
        context = private / "context"
        context.mkdir()
        (context / "entrypoint.sh").write_text(
            '#!/bin/sh\nset -eu\nprintf "%s\\n" "$*" >/tmp/fixture-args\n'
            'touch /tmp/fixture-ready\ntrap "exit 0" TERM INT\n'
            'while :; do sleep 1 & wait "$!" || true; done\n', encoding="utf-8")
        (context / "Dockerfile").write_text(
            "FROM " + ALPINE + "\n"
            "RUN addgroup -g 12000 fixture && adduser -D -u 12000 -G fixture fixture "
            "&& mkdir -p /fixture/work /fixture/volume "
            "&& printf 'original\\n' >/fixture/original.txt "
            "&& printf 'delete-me\\n' >/fixture/deleted.txt "
            "&& printf 'underlying-image-file\\n' >/fixture/volume/underlying.txt "
            "&& chown -R 12000:12000 /fixture\n"
            "COPY --chmod=755 entrypoint.sh /fixture/entrypoint.sh\n"
            "ENV FIXTURE_DEFAULT=from-image FIXTURE_OVERRIDE=from-image\n"
            "LABEL org.voicerooms.synthetic-fixture=true\n"
            "WORKDIR /fixture/work\nUSER 12000:12000\n"
            "ENTRYPOINT [\"/fixture/entrypoint.sh\"]\n"
            "CMD [\"serve\", \"synthetic-default\"]\n"
            "HEALTHCHECK --interval=1s --timeout=1s --retries=2 CMD test -f /tmp/fixture-ready\n"
            "STOPSIGNAL SIGTERM\nEXPOSE 8080/tcp 9000/udp\nVOLUME [\"/fixture/volume\"]\n",
            encoding="utf-8")
        try:
            docker("image", "inspect", ALPINE)
            docker("build", "--network", "none", "--pull=false", "-t", base, str(context))
            docker("volume", "create", source_volume)
            docker("run", "-d", "--name", source, "--network", "none",
                   "--label", "com.docker.compose.project=voicerooms",
                   "--label", "com.docker.compose.service=backend",
                   "-e", "FIXTURE_OVERRIDE=from-container",
                   "-e", "FIXTURE_RUNTIME_SECRET=synthetic-only-no-real-secret",
                   "-v", source_volume + ":/fixture/volume", base)
            healthy(source)
            docker("exec", "-u", "0", source, "sh", "-ec",
                   "printf 'runtime-change\\n' >/fixture/original.txt; rm /fixture/deleted.txt; "
                   "printf 'added-at-runtime\\n' >/fixture/runtime.txt; "
                   "chown 12000:12000 /fixture/runtime.txt; chmod 440 /fixture/runtime.txt; "
                   "ln -s runtime.txt /fixture/runtime-link; "
                   "printf '%s\\n' '" + marker + "' >/fixture/volume/private-marker")
            before = inspect("container", source)
            descriptor = {"id": before["Id"], "image": before["Image"], "running": True}

            def backup(case):
                value = private / case
                value.mkdir(mode=0o700)
                return value

            def source_unchanged():
                now = inspect("container", source)
                assert now["Image"] == before["Image"]
                assert now["Config"] == before["Config"]
                assert now["State"]["Running"] and not now["State"]["Paused"]
                assert docker("exec", source, "cat", "/fixture/volume/private-marker").stdout.strip() == marker

            def verify_snapshot(tag, case):
                image = inspect("image", tag)
                for field in FIELDS:
                    assert image["Config"].get(field) == before["Config"].get(field), "Lost Config." + field
                for key, value in before["Config"].get("Labels", {}).items():
                    assert image["Config"].get("Labels", {}).get(key) == value
                assert len(image["RootFS"]["Layers"]) == 1, "Snapshot is not flattened"
                assert image.get("Parent", "") == "", "Snapshot depends on another image"
                restored, volume = prefix + "-" + case, prefix + "-" + case + "-data"
                containers.append(restored)
                volumes.append(volume)
                docker("volume", "create", volume)
                docker("run", "-d", "--network", "none", "--name", restored,
                       "-v", volume + ":/fixture/volume", tag)
                healthy(restored)
                docker("exec", restored, "sh", "-ec",
                       "test \"$(id -u)\" = 12000; test \"$PWD\" = /fixture/work; "
                       "test \"$FIXTURE_OVERRIDE\" = from-container; "
                       "test \"$FIXTURE_RUNTIME_SECRET\" = synthetic-only-no-real-secret; "
                       "test \"$(cat /tmp/fixture-args)\" = 'serve synthetic-default'; "
                       "test \"$(cat /fixture/original.txt)\" = runtime-change; "
                       "test ! -e /fixture/deleted.txt; "
                       "test \"$(cat /fixture/runtime-link)\" = added-at-runtime; "
                       "test \"$(readlink /fixture/runtime-link)\" = runtime.txt; "
                       "test \"$(stat -c '%a:%u:%g' /fixture/runtime.txt)\" = 440:12000:12000; "
                       "test ! -e /fixture/volume/private-marker; "
                       "test \"$(cat /fixture/volume/underlying.txt)\" = underlying-image-file")
                source_unchanged()

            assert updater.preserve_rollback_image("backend", descriptor, tags["fast"], backup("fast")) == "tagged"
            assert inspect("image", tags["fast"])["Id"] == before["Image"]
            source_unchanged()
            results["existingImageFastPath"] = True

            direct = backup("direct")
            updater.snapshot_rollback_image("backend", descriptor, tags["direct"], direct)
            verify_snapshot(tags["direct"], "direct")
            results.update(realExportLoadRun=True, runtimeFilesystemAndConfigPreserved=True,
                           mountedDataExcludedAndOriginalVolumeUnchanged=True)

            actual_run, missing_tags = updater.run, 0

            def missing_image(args, **kwargs):
                nonlocal missing_tags
                if args[:3] == ["docker", "image", "tag"]:
                    missing_tags += 1
                    return subprocess.CompletedProcess(
                        args, 1, stdout="", stderr="Error response from daemon: No such image: " + before["Image"])
                return actual_run(args, **kwargs)

            fallback = backup("fallback")
            with mock.patch.object(updater, "run", side_effect=missing_image):
                method = updater.preserve_rollback_image("backend", descriptor, tags["fallback"], fallback)
            assert method == "snapshot" and missing_tags == 1
            verify_snapshot(tags["fallback"], "fallback")
            results["forcedMissingImageFallbackRealDocker"] = True

            saw_paused = False

            def export_failure(args, **kwargs):
                nonlocal saw_paused
                if args[:3] == ["docker", "container", "export"]:
                    saw_paused = inspect("container", source)["State"]["Paused"]
                    raise subprocess.CalledProcessError(1, args, stderr="Synthetic export failure")
                return actual_run(args, **kwargs)

            with mock.patch.object(updater, "run", side_effect=export_failure):
                try:
                    updater.snapshot_rollback_image("backend", descriptor, tags["failure"], backup("export-failure"))
                except (subprocess.CalledProcessError, RuntimeError):
                    pass
                else:
                    raise AssertionError("Export failure was silently accepted")
            assert saw_paused, "Export did not run with a paused source"
            source_unchanged()
            assert docker("image", "inspect", tags["failure"], check=False).returncode != 0
            results["exportFailureUnpausesSource"] = True

            denied_exports = 0

            def permission_failure(args, **kwargs):
                nonlocal denied_exports
                if args[:3] == ["docker", "image", "tag"]:
                    return subprocess.CompletedProcess(args, 1, stdout="", stderr="permission denied: synthetic tag rejection")
                if args[:3] == ["docker", "container", "export"]:
                    denied_exports += 1
                return actual_run(args, **kwargs)

            with mock.patch.object(updater, "run", side_effect=permission_failure):
                try:
                    updater.preserve_rollback_image("backend", descriptor, tags["denied"], backup("permission-denied"))
                except (subprocess.CalledProcessError, RuntimeError):
                    pass
                else:
                    raise AssertionError("Unrelated Docker error was silently accepted")
            assert denied_exports == 0, "Non-missing-image error triggered snapshot fallback"
            source_unchanged()
            results["unrelatedTagErrorStopsBeforeSnapshot"] = True

            for directory in (direct, fallback):
                assert stat.S_IMODE(directory.stat().st_mode) == 0o700
                for value in directory.rglob("*"):
                    if value.is_file():
                        assert stat.S_IMODE(value.stat().st_mode) & 0o077 == 0, "Snapshot file is not private"
            results["snapshotFilesPrivate"] = True
            report = {
                "pass": True, "checks": results, "baseImage": ALPINE,
                "dockerVersion": docker("version", "--format", "{{.Server.Version}}").stdout.strip(),
                "imageStore": os.environ.get("SMOKE_IMAGE_STORE", "unknown"), "syntheticOnly": True,
            }
            output = ROOT / ".qa/rollback-smoke"
            output.mkdir(parents=True, exist_ok=True)
            (output / "summary.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
            print(json.dumps(report))
        finally:
            for container in reversed(containers):
                with contextlib.suppress(Exception):
                    docker("container", "unpause", container, check=False)
                    docker("container", "rm", "-f", container, check=False)
            for volume in reversed(volumes):
                with contextlib.suppress(Exception):
                    docker("volume", "rm", volume, check=False)
            for tag in [*tags.values(), base]:
                with contextlib.suppress(Exception):
                    docker("image", "rm", "-f", tag, check=False)


if __name__ == "__main__":
    main()
