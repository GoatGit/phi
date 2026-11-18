import contextlib
import importlib.util
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("build_ghostty", Path(__file__).parents[1] / "build_ghostty.py")
ghostty = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ghostty)


class GhosttyPatchTests(unittest.TestCase):
    def test_wayland_mirror_keeps_pinned_commit_and_hash(self):
        patch_text = (Path(__file__).parents[1] / "ghostty/phi-embedding.patch").read_text()
        commit = "f3c5d503e540ada8cbcb056420de240af0c094f7"
        digest = "wayland-0.4.0-dev-lQa1kjfIAQCmhhQu3xF0KH-94-TzeMXOqfnP0-Dg6Wyy"
        self.assertIn(f'-            .url = "https://codeberg.org/ifreund/zig-wayland/archive/{commit}.tar.gz"', patch_text)
        self.assertIn(f'+            .url = "https://github.com/ifreund/zig-wayland/archive/{commit}.tar.gz"', patch_text)
        self.assertIn(f'             .hash = "{digest}"', patch_text)


@unittest.skipUnless(sys.platform == "darwin" or sys.platform.startswith("linux"), "Ghostty build supervisor uses POSIX process groups")
class GhosttyBuildTests(unittest.TestCase):
    def run_build(self, source, directory, **kwargs):
        return ghostty.run_zig_build(
            [sys.executable, "-u", "-c", source], Path(directory), dict(os.environ), **kwargs
        )

    def test_output_is_delivered_before_process_exit_even_without_newline(self):
        with tempfile.TemporaryDirectory() as directory:
            gate = Path(directory) / "gate"

            class Progress(io.StringIO):
                def write(self, text):
                    if "progress" in text:
                        gate.touch()
                    return super().write(text)

            output = Progress()
            source = (
                "import pathlib,time; print('progress',end='',flush=True); "
                "gate=pathlib.Path('gate'); deadline=time.monotonic()+1; "
                "exec('while not gate.exists() and time.monotonic()<deadline: time.sleep(0.01)'); "
                "raise SystemExit(0 if gate.exists() else 7)"
            )
            with contextlib.redirect_stdout(output):
                self.run_build(source, directory)
            self.assertIn("progress", output.getvalue())

    def test_transient_fetch_error_retries_and_compile_error_does_not(self):
        # Count attempts instead of mocking time.sleep: the shared time module
        # is also used by subprocess while it reaps the child, so a global mock
        # records unrelated sleeps.
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()):
            source = (
                "import pathlib; p=pathlib.Path('attempts'); "
                "n=int(p.read_text())+1 if p.exists() else 1; p.write_text(str(n)); "
                "print('unable to fetch: EndOfStream' if n==1 else 'built'); "
                "raise SystemExit(1 if n==1 else 0)"
            )
            with patch.object(ghostty, "RETRY_DELAY_SECONDS", 0):
                self.run_build(source, directory)
            self.assertEqual((Path(directory) / "attempts").read_text(), "2")
            compile_error = (
                "import pathlib; p=pathlib.Path('compile-attempts'); "
                "n=int(p.read_text())+1 if p.exists() else 1; p.write_text(str(n)); "
                "print('compile error'); raise SystemExit(2)"
            )
            with self.assertRaises(subprocess.CalledProcessError) as error, patch.object(ghostty, "RETRY_DELAY_SECONDS", 0):
                self.run_build(compile_error, directory)
            self.assertEqual(error.exception.returncode, 2)
            self.assertIn("compile error", error.exception.output)
            self.assertEqual((Path(directory) / "compile-attempts").read_text(), "1")

    def test_unknown_host_fetch_error_retries(self):
        # The macOS runner saw this exact message when codeberg.org stopped
        # resolving mid-build; it is a network failure, not a source error.
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()):
            source = (
                "import pathlib; p=pathlib.Path('attempts'); "
                "n=int(p.read_text())+1 if p.exists() else 1; p.write_text(str(n)); "
                "print('error: unable to connect to server: UnknownHostName' if n==1 else 'built'); "
                "raise SystemExit(1 if n==1 else 0)"
            )
            with patch.object(ghostty, "RETRY_DELAY_SECONDS", 0):
                self.run_build(source, directory)
            self.assertEqual((Path(directory) / "attempts").read_text(), "2")

    def test_fetch_retries_are_bounded(self):
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()):
            source = (
                "import pathlib; p=pathlib.Path('attempts'); "
                "n=int(p.read_text())+1 if p.exists() else 1; p.write_text(str(n)); "
                "print('failed to fetch'); raise SystemExit(1)"
            )
            with self.assertRaises(subprocess.CalledProcessError), patch.object(ghostty, "RETRY_DELAY_SECONDS", 0):
                self.run_build(source, directory, attempts=2)
            self.assertEqual((Path(directory) / "attempts").read_text(), "2")

    def test_silent_build_times_out_and_kills_descendants(self):
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()) as output:
            child = "import pathlib,time; time.sleep(1); pathlib.Path('leaked').touch(); time.sleep(60)"
            source = (
                f"import subprocess,sys,time; subprocess.Popen([sys.executable,'-c',{child!r}]); "
                "print('child started',flush=True); time.sleep(60)"
            )
            started = time.monotonic()
            with self.assertRaises(subprocess.TimeoutExpired):
                self.run_build(source, directory, timeout_seconds=0.3)
            self.assertLess(time.monotonic() - started, 2)
            self.assertIn("child started", output.getvalue())
            time.sleep(1.1)
            self.assertFalse((Path(directory) / "leaked").exists())

    def test_silent_build_emits_heartbeat(self):
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()) as output:
            with patch.object(ghostty, "HEARTBEAT_SECONDS", 0.02):
                self.run_build("import time; time.sleep(0.1)", directory)
            self.assertIn("Ghostty build still running", output.getvalue())

    def test_timeout_after_output_pipe_is_closed(self):
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()):
            source = "import os,time; os.close(1); os.close(2); time.sleep(60)"
            with self.assertRaises(subprocess.TimeoutExpired):
                self.run_build(source, directory, timeout_seconds=0.2)

    def test_exited_leader_does_not_leave_child_holding_output_pipe(self):
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()):
            child = "import pathlib,time; time.sleep(1); pathlib.Path('leaked').touch(); time.sleep(60)"
            source = f"import subprocess,sys; subprocess.Popen([sys.executable,'-c',{child!r}])"
            with self.assertRaises(subprocess.TimeoutExpired):
                self.run_build(source, directory, timeout_seconds=0.2)
            time.sleep(1.1)
            self.assertFalse((Path(directory) / "leaked").exists())

    def test_invalid_budgets_do_not_spawn_processes(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(ghostty.subprocess, "Popen") as spawn:
            for budget in [0, -1, float("inf"), float("nan")]:
                with self.subTest(budget=budget), self.assertRaises(ValueError):
                    self.run_build("", directory, timeout_seconds=budget)
            with self.assertRaises(ValueError):
                self.run_build("", directory, attempts=0)
            spawn.assert_not_called()

    def test_timeout_is_shared_across_retries(self):
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(subprocess.TimeoutExpired):
                self.run_build("print('unable to fetch'); raise SystemExit(1)", directory, timeout_seconds=0.2)

    def test_output_tail_is_bounded_on_failure(self):
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(subprocess.CalledProcessError) as error:
                self.run_build("print('x'*300000); print('compile error'); raise SystemExit(2)", directory)
            self.assertLessEqual(len(error.exception.output), 128 * 1024)
            self.assertIn("compile error", error.exception.output)


if __name__ == "__main__":
    unittest.main()
