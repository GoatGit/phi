# Arguments: interactive shell, CLI executable, then literal CLI arguments.
# Keep a supervisor alive while the CLI owns the terminal foreground group.
# A caught (not ignored) signal resets to the default disposition in the child.
phi_terminal_shell=$1
shift
trap ':' INT QUIT
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
  printf '\033[?2026l\033[<255u\033[=0u\033[>4;0m\033[?1l\033>\033[?2004l\033[?25h\033[0m'
fi
exec "$phi_terminal_shell" -il
