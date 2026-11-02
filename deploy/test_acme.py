import functools
import importlib.util
import os
import stat
import tempfile
import threading
import unittest
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

spec = importlib.util.spec_from_file_location("voice_acme", Path(__file__).with_name("acme.py"))
acme = importlib.util.module_from_spec(spec)
spec.loader.exec_module(acme)


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


class RefusingHandler(QuietHandler):
    def do_GET(self):
        self.send_error(403)


class AcmeTests(unittest.TestCase):
    @unittest.skipIf(os.name == "nt", "POSIX permissions regression runs on Linux CI")
    def test_repairs_existing_private_directories_under_umask_077(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "webroot"
            previous = os.umask(0o077)
            try:
                challenge = root / ".well-known" / "acme-challenge"
                challenge.mkdir(parents=True)
                self.assertEqual(stat.S_IMODE(challenge.stat().st_mode), 0o700)
                acme.prepare_webroot(root)
                for directory in [root, root / ".well-known", challenge]:
                    self.assertEqual(stat.S_IMODE(directory.stat().st_mode), 0o755)
                private = Path(folder) / "production.env"
                private.write_text("private fixture")
                self.assertEqual(stat.S_IMODE(private.stat().st_mode), 0o600)
            finally:
                os.umask(previous)

    def exercise_http(self, handler, succeeds):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            server = ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(handler, directory=str(root)))
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            origin = "http://127.0.0.1:" + str(server.server_port)
            try:
                if succeeds:
                    acme.verify_http_challenge(root, "127.0.0.1:" + str(server.server_port), origin)
                else:
                    with self.assertRaisesRegex(RuntimeError, "HTTP 403"):
                        acme.verify_http_challenge(root, "127.0.0.1:" + str(server.server_port), origin)
                self.assertEqual(list((root / ".well-known" / "acme-challenge").iterdir()), [])
            finally:
                server.shutdown()
                server.server_close()
                thread.join()

    def test_reads_actual_http_file_and_removes_probe(self):
        self.exercise_http(QuietHandler, True)

    def test_http_403_stops_before_certificate_request_and_removes_probe(self):
        self.exercise_http(RefusingHandler, False)

    @unittest.skipIf(os.name == "nt", "Unprivileged Windows symlinks are unavailable")
    def test_refuses_symlink_challenge_directory(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "webroot"
            target = Path(folder) / "other"
            root.mkdir()
            target.mkdir()
            (root / ".well-known").symlink_to(target, target_is_directory=True)
            with self.assertRaises(RuntimeError):
                acme.prepare_webroot(root)


if __name__ == "__main__":
    unittest.main()
