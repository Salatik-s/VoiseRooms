import importlib.util
import json
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("voice_bot_ready", Path(__file__).with_name("bot_ready.py"))
ready = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ready)


class BotReadinessTests(unittest.TestCase):
    def fake_docker(self, *, logs="WARNING voicerooms.bot: VoiceRooms bot ready", oom=False, restarting=False, moving=False):
        self.calls = []
        self.inspections = 0
        def capture(args):
            self.calls.append(args)
            self.assertNotIn("exec", args)
            if "ps" in args:
                return "fixture-container"
            if args[:2] == ["docker", "inspect"]:
                self.inspections += 1
                start = str(self.inspections) if moving else "2026-11-02T12:00:00Z"
                return json.dumps([{"State": {"Running": True, "Restarting": restarting, "OOMKilled": oom, "StartedAt": start}, "RestartCount": 0}])
            if args[:2] == ["docker", "logs"]:
                self.assertIn("--since", args)
                return logs
            raise AssertionError("Unexpected Docker command")
        return capture

    def test_checks_existing_process_without_extra_python(self):
        ready.wait_for_bot(["docker", "compose"], self.fake_docker(), attempts=3, pause=0)
        self.assertEqual(self.inspections, 3)

    def test_conflicting_poller_does_not_pass_on_ready_message(self):
        with self.assertRaisesRegex(RuntimeError, "Another process"):
            ready.wait_for_bot(["docker", "compose"], self.fake_docker(logs="VoiceRooms bot ready\nTelegramConflictError"), pause=0)

    def test_oom_is_reported_without_starting_diagnostics_inside_container(self):
        with self.assertRaisesRegex(RuntimeError, "memory limit"):
            ready.wait_for_bot(["docker", "compose"], self.fake_docker(oom=True), pause=0)

    def test_restarting_or_repeatedly_recreated_container_is_not_ready(self):
        for options in [{"restarting": True}, {"moving": True}]:
            with self.subTest(options=options), self.assertRaisesRegex(RuntimeError, "did not become ready"):
                ready.wait_for_bot(["docker", "compose"], self.fake_docker(**options), attempts=3, pause=0)

    def test_python_log_marker_on_stderr_is_not_lost(self):
        with patch.object(ready.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "", "VoiceRooms bot ready")):
            self.assertEqual(ready.docker_output(["docker", "logs", "fixture"]), "VoiceRooms bot ready")

    def test_inspect_keeps_stderr_out_of_json(self):
        with patch.object(ready.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "[]", "warning")):
            self.assertEqual(json.loads(ready.docker_output(["docker", "inspect", "fixture"])), [])


if __name__ == "__main__":
    unittest.main()
