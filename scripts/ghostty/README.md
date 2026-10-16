# PHI embedded Ghostty

The macOS terminal links Ghostty **1.2.3** (MIT) and Zig **0.14.1**. Build once
before `pnpm tauri dev` / `pnpm build`:

```sh
python3 scripts/build_ghostty.py
```

Command Line Tools, Python 3.12+ and an SDK compatible with Zig 0.14 are required.
Pass `--sdk /path/to/MacOSX15.4.sdk` if necessary. No Ghostty.app installation is
used. The script defaults to the current CPU architecture; use `--arch x86_64` or
`--arch aarch64` for the matching Rust target. CI builds each architecture and
passes resources to the universal app packaging job. macOS 13 is the deployment minimum.
`src-tauri/tauri.macos.conf.json` bundles terminfo and shell resources.

`phi-embedding.patch` contains the entire delta against the checksum-pinned
release tarball:

- Install the static embedding library without initializing Xcode/iOS targets.
- Compile embedded Metal source at runtime using Apple's Metal API. Full Xcode
  and its offline `metal` compiler are not required.
- Add `phi_ghostty_config_load` so the host sets its own configuration without
  reading the PHI process arguments or the user's Ghostty configuration.
- Bound process-group discovery and shutdown; escalate SIGHUP to SIGKILL after
  one second, and finish surviving descendants when the login wrapper exits.
- Normalize archives before Apple's libtool to retain Zig's unaligned members.

The native host is `src-tauri/native/terminal.m`. Input behavior is based on
Ghostty's `macos/Sources/Ghostty/SurfaceView_AppKit.swift` and
`NSEvent+Extension.swift`; preserve [Ghostty's license](GHOSTTY-LICENSE).
The build disables Sentry. `collect_licenses.py` copies license files and pinned
`build.zig.zon` manifests reachable from the downloaded dependency graph into
`share/ghostty/licenses`, including an inventory. These ship with the app.
Optional downloaded dependencies can appear in this inclusive inventory.

Do not substitute a parser-only WebAssembly package for this library: the host
uses Ghostty's native renderer, PTY, and child-process lifecycle.

## Native check

```sh
python3 scripts/ghostty/test_native.py
```

Opens an isolated Cocoa window with WKWebView and real Ghostty surfaces. Checks
PTY output/input, Chinese preedit and committed text, native shortcuts, sibling
hit testing, tab hiding, live terminal rendering with popup exclusion masks,
menu/click/window focus recovery, resize, nonzero exit, Ctrl-C delivery to the
foreground CLI followed by a usable shell in the same terminal, shell prompt
interrupts and explicit shell exit, modifier key events,
and a raw-mode CLI that leaves nested Kitty keyboard modes, modifyOtherKeys,
hidden cursor and concealed text behind when Ctrl-C exits it. The latter checks
AppKit character key presses/releases (not pasted text), echo before Return,
command execution, Chinese IME commits, retained output and menu/theme changes.
The suite also verifies cleanup of an owned HUP-ignoring child. It does not
invoke installed AI CLIs or read their credentials.
The ordinary interrupt fixture also starts with detached stdin and checks that
the supervisor reconnects the real PTY before the CLI reads input.
The screenshots are saved under `tmp/phi-terminal-native.png` and
`tmp/phi-terminal-input.png` (typed command before Return). This check requires a
logged-in macOS graphical session; human IME candidate-window and multi-display
checks remain separate.

To validate packaged resources, pass `--resources /path/to/PHI.app/Contents/Resources/ghostty/share/ghostty`. This uses the bundle resource directory while retaining the same isolated native test harness.

To additionally exercise an installed Codex, use
`--codex /absolute/path/to/codex`. This runs its real TUI with a temporary
`CODEX_HOME` and a local dummy provider; it neither uses the
user's Codex credentials nor submits a prompt. The check waits beyond ten
seconds, exits with Ctrl-C, then verifies physical character echo before
Return, command execution and Chinese text commits in the shell. It also
simulates detached stdin. `--user-shell` opts into local zsh startup files
instead of the clean test shell. A screenshot is saved as
`tmp/phi-terminal-codex.png`. Use `--session-script /path/to/session.sh` for a
before/after comparison without changing production code.

Codex checks use its default daemon path and stop only the daemon belonging to
the temporary `CODEX_HOME` before cleanup. Add `--codex-no-daemon` for a separate
check of the direct path.

Add `--system-ime` to dispatch CG-backed keyboard events through this test
application's AppKit queue. It temporarily selects ABC and macOS Pinyin, types
`zhongwen`, checks preedit and the candidate anchor, then selects `中文` with
Space. With `--codex`, this runs both inside the CLI and in the shell after
Ctrl-C; no prompt is submitted. It also covers the dirty-mode fixture without
Codex. The prior input source is restored on exit. ABC and Pinyin must be
enabled on the test machine. No global keyboard injection or Accessibility
permission is required. This catches mutable `insertText` strings that AppKit
clears after the callback; directly committing immutable Chinese text or using
`NSEvent.keyEventWithType` alone does not reproduce that failure. Candidate
window appearance and third-party IMEs still need separate visual checks.

## Terminal themes

The tab header’s … → Theme submenu offers Follow PHI and six bundled
palettes. `src/config/terminalThemes.json` is shared by the menu previews and
Rust's allowlisted configuration builder. Ghostty updates existing surfaces in
place; selecting a theme never restarts the CLI. The native check also samples
the rendered background for all six themes and verifies existing PTYs and
output survive switching across two running tabs.
