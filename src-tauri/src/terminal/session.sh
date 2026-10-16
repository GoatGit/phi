# Arguments: interactive shell, CLI executable, then literal CLI arguments.
# Keep a supervisor alive while the CLI owns the terminal foreground group.
# A caught (not ignored) signal resets to the default disposition in the child.
phi_terminal_shell=$1
shift
# Reattach a detached stdin to Ghostty's read/write PTY before starting the CLI
# or shell. zsh's /dev/tty fallback can mask a bad stdin until a TUI opens.
# Duplicate the real PTY: macOS kqueue readers cannot poll /dev/tty itself.
if [ -t 1 ] && [ ! -t 0 ]; then
  exec 0<&1
fi
trap ':' INT QUIT
# Keep this synchronous: a non-interactive shell gives background jobs
# /dev/null as stdin and ignores SIGINT for them. Do not time out or kill a
# healthy CLI; wait for its own exit before restoring terminal modes.
"$@"
trap - INT QUIT

# Some CLIs exit while the PTY is still in raw mode. Restore it before handing
# the same PTY, working directory and scrollback to an interactive login shell.
/bin/stty sane

# stty only restores the kernel line discipline. A TUI can also leave Ghostty's
# Kitty keyboard stack / modifyOtherKeys enabled, so zsh receives escape codes
# instead of printable characters. Restore ordinary keyboard/text modes before
# starting the shell, without changing screens or the saved cursor position.
# Do not use RIS (ESC c): that would discard the session's scrollback.
if [ -t 1 ]; then
  # <255u: 清空 Kitty 键盘栈；=0;1u: 把 flags 直接置 0（覆盖不经栈的 CSI= 设置）；
  # >4;0m: 关 modifyOtherKeys；其余为同步输出/光标键/小键盘/括号粘贴/鼠标/焦点上报复位。
  printf '\033[?2026l\033[<255u\033[=0;1u\033[>4;0m\033[?1l\033>\033[?2004l\033[?1000l\033[?1002l\033[?1003l\033[?1005l\033[?1006l\033[?1015l\033[?1016l\033[?1004l\033[?25h\033[0m'
fi
exec "$phi_terminal_shell" -il
