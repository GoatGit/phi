#!/usr/bin/env python3
"""Run real Ghostty/PTY + WKWebView checks in an isolated Cocoa window."""
import argparse
from pathlib import Path
import subprocess
import tempfile
import shlex
import sys
import json
import os

ROOT = Path(__file__).resolve().parents[2]
SDK = ROOT / "src-tauri/ghostty-sdk"
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--resources", type=Path, default=SDK / "share/ghostty")
parser.add_argument("--codex", type=Path, help="Also check this installed Codex binary with isolated config and no model request")
parser.add_argument("--user-shell", action="store_true", help="Exercise the local zsh startup configuration as well")
parser.add_argument("--system-ime", action="store_true", help="Exercise queued CG-backed keys and macOS Pinyin composition (requires ABC and Pinyin input sources)")
parser.add_argument("--codex-no-daemon", action="store_true", help="Opt out of Codex's default daemon path for a separate compatibility check")
parser.add_argument("--session-script", type=Path, default=ROOT / "src-tauri/src/terminal/session.sh")
options = parser.parse_args()
supervisor = options.session_script.read_text()
with tempfile.TemporaryDirectory(prefix="phi-native-test-") as directory:
    # Exercise the production supervisor with a clean, real interactive zsh.
    # User startup files and installed AI CLIs are not used by this fixture.
    shell = Path(directory) / "interactive-shell"
    shell.write_text("#!/bin/sh\nexec /bin/zsh -dfi\n")
    shell.chmod(0o755)
    session_command = shlex.join([
        "/bin/sh", "-c", 'exec 0</dev/null; exec "$@"', "phi-detached-stdin",
        "/bin/sh", "-c", supervisor,
        "phi-terminal", str(shell), "/bin/sh", "-c",
        'trap "printf INTERRUPTED; exit 130" INT; printf INTERRUPT_READY; read line',
    ])
    dirty_session_command = shlex.join([
        "/bin/sh", "-c", supervisor,
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
    arguments = [str(binary), str(options.resources.resolve()), str(screenshot), str(ROOT / "src/config/terminalThemes.json"), session_command, dirty_session_command]
    if options.codex:
        config = Path(directory) / "codex-config"
        config.mkdir()
        (config / "config.toml").write_text('''model_provider = "phi_local_test"
model = "terminal-input-test"
[model_providers.phi_local_test]
name = "Local terminal test"
base_url = "http://127.0.0.1:9/v1"
wire_api = "responses"
requires_openai_auth = false
[projects."/tmp"]
trust_level = "trusted"
[projects."/private/tmp"]
trust_level = "trusted"
''')
        real_shell = Path(directory) / "codex-shell"
        real_shell.write_text("#!/bin/sh\n[ -t 0 ] && printf '\\nPHI_SHELL_TTY\\n'\nprintf '\\nPHI_SHELL_READY\\n'\nexec /bin/zsh " + ("-il" if options.user_shell else "-dfi") + "\n")
        real_shell.chmod(0o755)
        arguments += [shlex.join([
            "/bin/sh", "-c", 'exec 0</dev/null; exec "$@"', "phi-detached-stdin",
            "/bin/sh", "-c", supervisor,
            "phi-terminal", str(real_shell), str(options.codex.resolve()),
            *(["--no-daemon"] if options.codex_no_daemon else []),
        ]), json.dumps({"CODEX_HOME": str(config)})]
    environment = os.environ.copy()
    if options.system_ime:
        environment["PHI_TEST_SYSTEM_IME"] = "1"
    try:
        subprocess.run(arguments, check=True, timeout=120 if options.codex else 60, env=environment)
    except subprocess.CalledProcessError as error:
        sys.exit(error.returncode)
    finally:
        if options.codex and not options.codex_no_daemon:
            # Stop only the daemon owned by this temporary CODEX_HOME, before
            # deleting its files. Never touch the user's shared daemon.
            subprocess.run([str(options.codex.resolve()), "app-server", "daemon", "stop"],
                           env={**environment, "CODEX_HOME": str(config)},
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           timeout=15, check=False)
    print(f"Native screenshot: {screenshot}")
