import contextlib
import hashlib
import importlib.util
import io
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
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


class _ResumableHandler(BaseHTTPRequestHandler):
    """支持 Range 的下载源：第一次只发一半就断开连接，模拟中途掉线。"""

    payload = b""
    ranges = []
    truncate_first = True

    def do_GET(self):
        range_header = self.headers.get("Range")
        type(self).ranges.append(range_header)
        start = int(range_header.split("=", 1)[1].split("-", 1)[0]) if range_header else 0
        body = type(self).payload[start:]
        self.send_response(206 if start else 200)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Accept-Ranges", "bytes")
        if start:
            self.send_header("Content-Range", f"bytes {start}-{len(type(self).payload) - 1}/{len(type(self).payload)}")
        self.end_headers()
        if type(self).truncate_first:
            type(self).truncate_first = False
            self.wfile.write(body[: len(body) // 2])
            self.wfile.flush()
            self.close_connection = True
            return
        self.wfile.write(body)

    def log_message(self, *args):
        pass


class DownloadTests(unittest.TestCase):
    def setUp(self):
        _ResumableHandler.ranges = []
        _ResumableHandler.truncate_first = True

    def test_download_resumes_from_the_partial_file(self):
        payload = b"payload" * (32 * 1024)
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "zig.tar.xz"
            calls = []

            def fake_run(command, **kwargs):
                output = Path(command[command.index("--output") + 1])
                calls.append(list(command))
                start = output.stat().st_size if "--continue-at" in command and output.exists() else 0
                if not start:
                    output.write_bytes(b"")
                chunk = payload[start : start + 100 * 1024]
                with open(output, "ab") as handle:
                    handle.write(chunk)
                done = start + len(chunk) == len(payload)
                return subprocess.CompletedProcess(command, 0 if done else 28)

            with patch.object(ghostty.subprocess, "run", fake_run), patch.object(ghostty, "DOWNLOAD_RETRY_DELAY_SECONDS", 0):
                ghostty.download("https://example.invalid/zig.tar.xz", target, hashlib.sha256(payload).hexdigest())

            self.assertEqual(target.read_bytes(), payload)
            self.assertGreaterEqual(len(calls), 2)
            self.assertNotIn("--continue-at", calls[0])
            self.assertIn("--continue-at", calls[1])
            self.assertFalse(target.with_suffix(".download").exists())

    def test_download_resumes_a_truncated_http_transfer(self):
        _ResumableHandler.payload = b"ghostty" * (64 * 1024)
        server = ThreadingHTTPServer(("127.0.0.1", 0), _ResumableHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as directory:
                target = Path(directory) / "ghostty.tar.gz"
                url = f"http://127.0.0.1:{server.server_port}/ghostty.tar.gz"
                with patch.object(ghostty, "DOWNLOAD_RETRY_DELAY_SECONDS", 0):
                    ghostty.download(url, target, hashlib.sha256(_ResumableHandler.payload).hexdigest())
                self.assertEqual(target.read_bytes(), _ResumableHandler.payload)
                self.assertGreaterEqual(len(_ResumableHandler.ranges), 2)
                self.assertIsNone(_ResumableHandler.ranges[0])
                self.assertIn("bytes=", _ResumableHandler.ranges[1])
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

    def test_download_restarts_when_the_server_refuses_to_resume(self):
        # codeload 这类现算的打包接口不支持 Range：带 --continue-at 时 curl 直接失败、
        # 一个字节都不传。这时候必须丢掉上次的牛途，不能每轮原地撞同一堵墙。
        payload = b"ghostty" * (16 * 1024)
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()):
            target = Path(directory) / "ghostty.tar.gz"
            partial = target.with_suffix(".download")
            partial.write_bytes(payload[: 30 * 1024])
            calls = []

            def fake_run(command, **kwargs):
                calls.append(list(command))
                if "--continue-at" in command:
                    return subprocess.CompletedProcess(command, 56)
                Path(command[command.index("--output") + 1]).write_bytes(payload)
                return subprocess.CompletedProcess(command, 0)

            with patch.object(ghostty.subprocess, "run", fake_run), patch.object(ghostty, "DOWNLOAD_RETRY_DELAY_SECONDS", 0):
                ghostty.download("https://example.invalid/ghostty.tar.gz", target, hashlib.sha256(payload).hexdigest())

            self.assertEqual(target.read_bytes(), payload)
            self.assertIn("--continue-at", calls[0])
            self.assertNotIn("--continue-at", calls[1])
            self.assertFalse(partial.exists())

    def test_download_rejects_a_corrupt_cached_archive(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "zig.tar.xz"
            target.write_bytes(b"not the pinned archive")
            with self.assertRaises(RuntimeError):
                ghostty.download("https://example.invalid/zig.tar.xz", target, hashlib.sha256(b"other").hexdigest())


if __name__ == "__main__":
    unittest.main()
