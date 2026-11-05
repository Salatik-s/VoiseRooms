"""Real Nginx/Vite downloads and updater readiness checks on ephemeral Linux CI."""
import contextlib
import hashlib
import importlib.util
import json
import os
import secrets
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock
from urllib.error import HTTPError, URLError
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
ALPINE = "alpine:3.22@sha256:2e0b81d60597f449baa56dc25d355367869d2dca4cd57e866f1e2b52af3eb55f"


def docker(*args, check=True):
    result = subprocess.run(["docker", *args], capture_output=True, text=True)
    if check and result.returncode:
        raise RuntimeError("Synthetic Docker command failed: " + args[0] + "\n" + result.stderr[-2000:])
    return result


def inspect(container):
    return json.loads(docker("container", "inspect", container).stdout)[0]


@contextlib.contextmanager
def http_fixture(payloads, scenario):
    state = {"get": 0, "head": 0, "unavailable": 0}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_HEAD(self):
            state["head"] += 1
            self.send_error(405)

        def do_GET(self):
            state["get"] += 1
            if scenario == "retry" and state["get"] <= 2:
                state["unavailable"] += 1
                self.send_error(503)
                return
            body = b"<!DOCTYPE html><title>synthetic fallback</title>" if scenario == "html" else payloads[self.path.rsplit("/", 1)[-1]]
            self.send_response(200)
            self.send_header("Content-Type", "text/html" if scenario == "html" else "application/octet-stream")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield "http://127.0.0.1:" + str(server.server_port), state
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)


def main():
    assert sys.platform == "linux" and os.environ.get("GITHUB_ACTIONS") == "true", (
        "Run only on the ephemeral Linux GitHub Actions runner"
    )
    assert ROOT == Path(os.environ["GITHUB_WORKSPACE"]).resolve()
    assert os.environ.get("SMOKE_ALPINE") == ALPINE
    spec = importlib.util.spec_from_file_location("download_update", ROOT / "deploy/update.py")
    updater = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(updater)
    payloads = {
        "VoiceRooms-1.2.0.apk": b"PK\x03\x04synthetic APK fixture\n" + bytes(range(256)) * 513,
        "VoiceRooms-1.2.0.ipa": b"PK\x03\x04synthetic IPA fixture\n" + bytes(range(255, -1, -1)) * 1027,
    }
    expected = {
        "files": {
            "frontend/public/downloads/" + name: {"size": len(body), "sha256": hashlib.sha256(body).hexdigest()}
            for name, body in payloads.items()
        }
    }
    assert set(expected["files"]) == set(updater.DOWNLOADS)
    nonce = secrets.token_hex(6)
    prefix, image = "voicerooms-download-ci-" + nonce, "voicerooms-download-ci-" + nonce + ":frontend"
    network, backend = prefix + "-network", prefix + "-backend"
    containers, generated, results = [backend], [], {}
    try:
        # These ignored synthetic files exist only on this disposable runner.
        for name, body in payloads.items():
            path = ROOT / "frontend/public/downloads" / name
            assert not path.exists(), "Refusing to replace an existing application package"
            tracked = subprocess.run(["git", "ls-files", "--error-unmatch", str(path)], cwd=ROOT, capture_output=True)
            assert tracked.returncode != 0, "Fixture must not replace a tracked file"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(body)
            generated.append(path)
        docker("image", "inspect", ALPINE)
        docker("build", "--progress=plain", "-t", image, "-f", str(ROOT / "frontend/Dockerfile"), str(ROOT / "frontend"))
        docker("network", "create", network)
        docker("run", "-d", "--name", backend, "--network", network, "--network-alias", "backend",
               ALPINE, "sleep", "600")
        # Static downloads need only a live DNS alias for Nginx upstream parsing.
        assert inspect(backend)["State"]["Running"], "Synthetic backend DNS fixture exited"

        def verify(origin):
            counter = {"getAttempts": 0, "transientFailures": 0}
            actual = updater.urlopen

            def counted(request, **kwargs):
                assert request.get_method() == "GET", "Updater used HEAD instead of verifying bytes"
                counter["getAttempts"] += 1
                try:
                    return actual(request, **kwargs)
                except (URLError, TimeoutError, ConnectionError, OSError) as error:
                    counter["transientFailures"] += 1
                    if isinstance(error, HTTPError):
                        error.close()
                    raise

            start = time.monotonic()
            with mock.patch.object(updater, "urlopen", side_effect=counted):
                updater.verify_downloads(origin, expected, seconds=30)
            counter["elapsedMs"] = round((time.monotonic() - start) * 1000)
            for name, body in payloads.items():
                with urlopen(origin + "/downloads/" + name, timeout=5) as response:
                    assert response.status == 200 and response.read() == body
            return counter

        origins = {}
        for case in ("production-startup", "delayed-startup"):
            container = prefix + "-" + case
            containers.append(container)
            command = ["run", "-d", "--name", container, "--network", network,
                       "--memory", "48m", "--memory-swap", "96m", "--cpus", "0.20", "--pids-limit", "64",
                       "-p", "127.0.0.1::5173"]
            if case == "delayed-startup":
                # Exercise retry deterministically against the actual built Nginx,
                # keeping its original entrypoint/configuration after a brief delay.
                command += ["--entrypoint", "/bin/sh", image, "-ec",
                            "sleep 5; exec /docker-entrypoint.sh nginx -g 'daemon off;'"]
            else:
                command += [image]
            docker(*command)
            details = inspect(container)
            host = details["NetworkSettings"]["Ports"]["5173/tcp"][0]
            assert host["HostIp"] == "127.0.0.1"
            origin = "http://127.0.0.1:" + host["HostPort"]
            origins[case] = origin
            results[case] = verify(origin)
            if case == "delayed-startup":
                assert results[case]["transientFailures"] >= 1, "Delayed startup never exercised retry"
            details = inspect(container)
            assert details["State"]["Running"] and not details["State"]["OOMKilled"]
            config = details["HostConfig"]
            assert config["Memory"] == 48 * 1024 * 1024
            assert config["MemorySwap"] == 96 * 1024 * 1024
            assert config["NanoCpus"] == 200000000 and config["PidsLimit"] == 64

        wrong_hash = json.loads(json.dumps(expected))
        first = sorted(updater.DOWNLOADS)[0]
        wrong_hash["files"][first]["sha256"] = "0" * 64
        start = time.monotonic()
        try:
            updater.verify_downloads(origins["production-startup"], wrong_hash, seconds=30)
        except RuntimeError as error:
            assert "SHA-256" in str(error) and "/downloads/" in str(error)
        else:
            raise AssertionError("Same-size hash mismatch was accepted")
        assert time.monotonic() - start < 5, "Permanent mismatch was retried"
        results["sameSizeHashMismatchRejected"] = True

        first_name = Path(first).name
        docker("exec", prefix + "-production-startup", "rm", "/usr/share/nginx/html/downloads/" + first_name)
        start = time.monotonic()
        try:
            updater.verify_downloads(origins["production-startup"], expected, seconds=30)
        except RuntimeError as error:
            assert "404" in str(error) and "/downloads/" + first_name in str(error)
        else:
            raise AssertionError("Missing download was accepted")
        assert time.monotonic() - start < 5
        results["nginx404RejectedImmediately"] = True

        with http_fixture(payloads, "retry") as (origin, state):
            updater.verify_downloads(origin, expected, seconds=15)
            assert state == {"get": 4, "head": 0, "unavailable": 2}
            results["realHttp503Retry"] = state.copy()
        with http_fixture(payloads, "html") as (origin, state):
            try:
                updater.verify_downloads(origin, expected, seconds=15)
            except RuntimeError as error:
                assert "HTML" in str(error) and "/downloads/" in str(error)
            else:
                raise AssertionError("HTML fallback was accepted as an application")
            assert state["get"] == 1 and state["head"] == 0
            results["htmlFallbackRejectedImmediately"] = True

        report = {
            "pass": True, "syntheticOnly": True,
            "actualFrontendDockerfile": True, "productionResourceLimits": True,
            "downloads": {name: {"size": len(body), "sha256": hashlib.sha256(body).hexdigest()}
                          for name, body in payloads.items()},
            "checks": results,
        }
        destination = ROOT / ".qa/download-readiness"
        destination.mkdir(parents=True, exist_ok=True)
        (destination / "summary.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(report))
    except Exception as error:
        # CI fixtures contain synthetic values only. Do not print raw inspect,
        # Config.Env, mounts, or the full Docker configuration.
        diagnostics = []
        for container in containers:
            if container == backend:
                continue
            entry = {"container": container}
            try:
                details = inspect(container)
                state = details.get("State", {})
                entry["safeState"] = {key: state.get(key) for key in (
                    "Status", "ExitCode", "OOMKilled", "Error"
                )}
                entry["publishedPorts"] = details.get("NetworkSettings", {}).get("Ports", {})
                entry["requestedPorts"] = details.get("HostConfig", {}).get("PortBindings", {})
                logs = docker("logs", "--tail", "80", container, check=False)
                entry["logTail"] = (logs.stdout + logs.stderr)[-65536:].splitlines()
            except Exception as diagnostic_error:
                entry["diagnosticErrorType"] = type(diagnostic_error).__name__
            diagnostics.append(entry)
        failure = {
            "pass": False, "syntheticOnly": True,
            "errorType": type(error).__name__, "error": str(error)[:2000],
            "checks": results, "frontendDiagnostics": diagnostics,
        }
        print("SYNTHETIC_FRONTEND_FAILURE " + json.dumps(failure), flush=True)
        try:
            destination = ROOT / ".qa/download-readiness"
            destination.mkdir(parents=True, exist_ok=True)
            (destination / "summary.json").write_text(json.dumps(failure, indent=2) + "\n", encoding="utf-8")
        except Exception as diagnostic_error:
            print("Unable to write synthetic evidence: " + type(diagnostic_error).__name__, flush=True)
        raise
    finally:
        for container in reversed(containers):
            with contextlib.suppress(Exception):
                docker("container", "rm", "-f", container, check=False)
        with contextlib.suppress(Exception):
            docker("network", "rm", network, check=False)
        with contextlib.suppress(Exception):
            docker("image", "rm", "-f", image, check=False)
        for path in generated:
            path.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
