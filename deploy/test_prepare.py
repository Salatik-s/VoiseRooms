import importlib.util
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "prepare", Path(__file__).with_name("prepare.py")
)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class ConfigurationTests(unittest.TestCase):
    def test_preserves_generated_keys_and_does_not_copy_other_credentials(self):
        with tempfile.TemporaryDirectory() as folder:
            self.assertTrue(
                Path(folder)
                .resolve()
                .is_relative_to(Path(tempfile.gettempdir()).resolve())
            )
            source, target = (
                Path(folder) / "source.env",
                Path(folder) / "production.env",
            )
            source.write_text(
                "BOT_TOKEN=123456:"
                + ("x" * 35)
                + "\nOWNER_TG_ID=1234567\nUNRELATED_TOKEN=do-not-copy\n",
                encoding="utf-8",
            )
            mod.prepare(source, target)
            first = mod.read_env(target)
            mod.prepare(source, target)
            second = mod.read_env(target)
            self.assertEqual(first, second)
            self.assertNotIn("UNRELATED_TOKEN", first)
            self.assertEqual(first["DOMAIN"], "voise.24projects.ru")
            self.assertGreaterEqual(len(first["INTERNAL_KEY"]), 32)

    def test_refuses_invalid_provider_configuration(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "source.env"
            source.write_text("BOT_TOKEN=invalid\nOWNER_TG_ID=0\n")
            with self.assertRaises(ValueError):
                mod.prepare(source, Path(folder) / "production.env")


if __name__ == "__main__":
    unittest.main()
