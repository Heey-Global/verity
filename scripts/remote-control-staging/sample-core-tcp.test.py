"""Host sampler guards; no Docker daemon or elevated permissions needed."""
import importlib.util
import pathlib
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("sampler", pathlib.Path(__file__).with_name("sample-core-tcp.py"))
sampler = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sampler)


class SamplerTests(unittest.TestCase):
    def test_subcommand_timeout_is_explicit(self):
        import subprocess
        with patch.object(sampler.subprocess, "run", side_effect=subprocess.TimeoutExpired("ss", 2)):
            with self.assertRaisesRegex(RuntimeError, "subcommand_timeout"):
                sampler.run(["ss"])

    def test_excessive_output_is_rejected(self):
        def child(_argv, **kwargs):
            kwargs["stdout"].write(b"x" * (sampler.MAX_OUTPUT + 1))
            return type("Result", (), {"returncode": 0})()
        with patch.object(sampler.subprocess, "run", side_effect=child):
            with self.assertRaisesRegex(RuntimeError, "subcommand_output_limit"):
                sampler.run(["ss"])

    def test_container_change_stops_before_sampling(self):
        with tempfile.TemporaryDirectory() as directory:
            output = pathlib.Path(directory) / "samples.jsonl"
            with patch("sys.argv", ["sampler", "--container", "core", "--output", str(output)]), \
                    patch.object(sampler.shutil, "which", return_value="/usr/bin/tool"), \
                    patch.object(sampler, "identity", side_effect=[("a", 2, "start", "1"), ("b", 3, "start", "2")]), \
                    patch.object(sampler, "run") as command:
                self.assertEqual(sampler.main(), 1)
                command.assert_not_called()
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)
            self.assertIn("container_or_pid_changed", output.read_text())

    def test_five_second_cadence_and_deadline(self):
        import json
        with tempfile.TemporaryDirectory() as directory:
            output = pathlib.Path(directory) / "samples.jsonl"
            current = [0.0]
            def sleep(seconds):
                current[0] += seconds
            with patch("sys.argv", ["sampler", "--container", "core", "--output", str(output),
                                    "--seconds", "12", "--interval", "5"]), \
                    patch.object(sampler.shutil, "which", return_value="/usr/bin/tool"), \
                    patch.object(sampler, "identity", return_value=("a", 2, "start", "1")), \
                    patch.object(sampler, "run", return_value="") as command, \
                    patch.object(sampler.time, "monotonic", side_effect=lambda: current[0]), \
                    patch.object(sampler.time, "sleep", side_effect=sleep) as paused:
                self.assertEqual(sampler.main(), 0)
            records = [json.loads(line) for line in output.read_text().splitlines()]
            self.assertEqual(records[0]["intervalSeconds"], 5)
            self.assertEqual(records[-1]["samples"], 3)
            self.assertEqual(command.call_count, 3)
            self.assertEqual([call.args[0] for call in paused.call_args_list], [5, 5, 2])

    def test_existing_output_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            output = pathlib.Path(directory) / "samples.jsonl"
            output.write_text("retain")
            with patch("sys.argv", ["sampler", "--container", "core", "--output", str(output)]), \
                    patch.object(sampler.shutil, "which", return_value="/usr/bin/tool"):
                with self.assertRaises(FileExistsError):
                    sampler.main()
            self.assertEqual(output.read_text(), "retain")


if __name__ == "__main__":
    unittest.main()
