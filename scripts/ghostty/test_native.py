#!/usr/bin/env python3
"""Run real Ghostty/PTY + WKWebView checks in an isolated Cocoa window."""
import argparse
from pathlib import Path
import subprocess
import tempfile
import shlex
import sys

ROOT = Path(__file__).resolve().parents[2]
SDK = ROOT / "src-tauri/ghostty-sdk"
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--resources", type=Path, default=SDK / "share/ghostty")
options = parser.parse_args()
with tempfile.TemporaryDirectory(prefix="phi-native-test-") as directory:
    # Exercise the production supervisor with a clean, real interactive zsh.
    # User startup files and installed AI CLIs are not used by this fixture.
    shell = Path(directory) / "interactive-shell"
    shell.write_text("#!/bin/sh\nexec /bin/zsh -dfi\n")
    shell.chmod(0o755)
    session_command = shlex.join([
        "/bin/sh", "-c", (ROOT / "src-tauri/src/terminal/session.sh").read_text(),
        "phi-terminal", str(shell), "/bin/sh", "-c",
        'trap "printf INTERRUPTED; exit 130" INT; printf INTERRUPT_READY; read line',
    ])
    dirty_session_command = shlex.join([
        "/bin/sh", "-c", (ROOT / "src-tauri/src/terminal/session.sh").read_text(),
        "phi-terminal", str(shell), sys.executable,
        str(ROOT / "scripts/ghostty/dirty_keyboard_cli.py"),
    ])
    binary = Path(directory) / "smoke"
    command = ["xcrun", "clang", "-Os", "-fobjc-arc", "-fblocks", "-mmacosx-version-min=13.0",
               "-I" + str(SDK / "include"), "-I" + str(ROOT / "src-tauri/native"),
               str(ROOT / "scripts/ghostty/native_smoke.m"), str(ROOT / "src-tauri/native/terminal.m"),
               str(SDK / "lib/libghostty.a"), "-lc++", "-o", str(binary)]
    for framework in ["Cocoa", "WebKit", "Metal", "QuartzCore", "CoreText", "CoreGraphics", "Carbon", "IOSurface", "IOKit", "CoreVideo"]:
        command += ["-framework", framework]
    subprocess.run(command, check=True)
    screenshot = ROOT / "tmp/phi-terminal-native.png"
    screenshot.parent.mkdir(exist_ok=True)
    subprocess.run([str(binary), str(options.resources.resolve()), str(screenshot), str(ROOT / "src/config/terminalThemes.json"), session_command, dirty_session_command], check=True, timeout=45)
    print(f"Native screenshot: {screenshot}")
