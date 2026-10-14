#!/usr/bin/env python3
"""Local raw-mode CLI fixture: intentionally skips terminal cleanup on Ctrl-C."""
import os
import re
import select
import time
import tty

tty.setraw(0)
# A nested Kitty stack exercises clearing all frames, not just popping once.
os.write(1, b"\x1b[>8u\x1b[>31uDIRTY_CLI_READY\r\n")
pending = b""
deadline = time.monotonic() + 10
while time.monotonic() < deadline:
    if not select.select([0], [], [], 0.1)[0]:
        continue
    pending += os.read(0, 4096)
    if re.search(rb"\x1b\[97(?::[0-9:]*)?;1?(?::1)?(?:;[0-9:]*)?u", pending):
        os.write(1, b"KITTY_KEY_RECEIVED\r\n")
        pending = b""
    if re.search(rb"\x1b\[99(?::[0-9:]*)?;5(?::1)?(?:;[0-9:]*)?u", pending):
        # Drain the test's key releases before returning the PTY to the shell.
        while select.select([0], [], [], 0.05)[0]:
            os.read(0, 4096)
        os.write(1, b"DIRTY_CLI_INTERRUPTED\r\n\x1b[>4;2m\x1b[?25l\x1b[8m")
        raise SystemExit(130)
raise SystemExit("Timed out waiting for test keyboard events")
