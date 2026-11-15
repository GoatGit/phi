#[cfg(target_os = "macos")]
use std::{collections::BTreeMap, path::PathBuf};

pub const CLI_APPS: [&str; 9] = [
    "claude",
    "codex",
    "gemini",
    "grokbuild",
    "opencode",
    "openclaw",
    "hermes",
    "pi",
    "mcode",
];
pub fn cli(app: &str) -> Option<(&'static str, &'static [&'static str])> {
    Some(match app {
        "claude" => ("claude", &[]),
        "codex" => ("codex", &[]),
        "gemini" => ("gemini", &[]),
        "grokbuild" => ("grok", &[]),
        "opencode" => ("opencode", &[]),
        "openclaw" => ("openclaw", &["tui"]),
        "hermes" => ("hermes", &[]),
        "pi" => ("pi", &[]),
        "mcode" => ("mcode", &[]),
        _ => return None,
    })
}
pub fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
#[cfg(any(target_os = "macos", test))]
fn session_command(shell: &str, executable: &str, args: &[String]) -> String {
    [
        "/bin/sh",
        "-c",
        include_str!("session.sh"),
        "phi-terminal",
        shell,
        executable,
    ]
    .into_iter()
    .chain(args.iter().map(String::as_str))
    .map(quote)
    .collect::<Vec<_>>()
    .join(" ")
}
pub fn parse_arguments(value: &str) -> Result<Vec<String>, String> {
    if value.len() > 16_384 || value.contains('\0') {
        return Err("invalid-arguments".into());
    }
    let args = shlex::split(value).ok_or("invalid-arguments")?;
    if args.len() > 256 {
        return Err("invalid-arguments".into());
    }
    Ok(args)
}
pub fn validate_directory(value: &str) -> Result<(), String> {
    let path = std::path::Path::new(value);
    if value.len() > 4096 || value.contains('\0') || !path.is_absolute() || !path.is_dir() {
        return Err("invalid-directory".into());
    }
    std::fs::read_dir(path).map_err(|_| "invalid-directory")?;
    Ok(())
}
#[cfg(target_os = "macos")]
pub struct LaunchPlan {
    pub command: String,
    pub cwd: PathBuf,
    pub environment: BTreeMap<String, String>,
}

/// 接棒需要的两样东西：哪个终端会话、退出记账往哪写。
/// 只有托管在 phi 自己的 PTY 里的会话才拿得到 CLI 的退出码。
#[cfg(target_os = "macos")]
pub struct ExitHookEnv<'a> {
    pub terminal_id: &'a str,
    pub journal: &'a std::path::Path,
}
/// 后台 worker 交给 pane 的东西：一条 argv，没有 shell 参与拼接。
///
/// 为什么不用 LaunchPlan 的那条命令串：zellij 的 pane 由 server 起的，
/// 客户端的环境变量不会被带进 pane（实测 `FOO=bar zellij action new-pane`
/// 里看不到 FOO）。所以 CLI 自己的配置目录、PATH、退出记账路径都必须写进
/// argv 本身——`/usr/bin/env K=V ...` 是唯一不需要再拼引号的做法。
#[cfg(target_os = "macos")]
pub struct WorkerLaunch {
    pub argv: Vec<String>,
    pub cwd: PathBuf,
}

/// `session.sh` 的同门师弟：跑 CLI、记退出码、不落回交互式 shell。
#[cfg(target_os = "macos")]
pub const WORKER_SUPERVISOR: &str = include_str!("worker.sh");

/// 启动一个 CLI 要的全部事实。托管 PTY 与 zellij pane 共用这一份解析，
/// 免得两条路径对「用哪个可执行文件、带哪些环境变量」各说一套。
#[cfg(target_os = "macos")]
struct Resolved {
    cwd: PathBuf,
    executable: PathBuf,
    args: Vec<String>,
    path: String,
    /// 该 CLI 自己的配置目录（CLAUDE_CONFIG_DIR / CODEX_HOME …）。
    custom: Option<(&'static str, String)>,
}

#[cfg(target_os = "macos")]
fn resolve(app: &str, cwd: &str, arguments: &str) -> Result<Resolved, String> {
    let (tool, args) = cli(app).ok_or("unsupported-app")?;
    let extra_args = parse_arguments(arguments)?;
    validate_directory(cwd)?;
    // PHI's directory setting alone does not redirect these CLIs. Refuse an
    // unverified override instead of silently launching with another account.
    let unverified_directory = match app {
        "gemini" => crate::settings::get_gemini_override_dir().map(|p| (p, ".gemini")),
        "grokbuild" => crate::settings::get_grok_override_dir().map(|p| (p, ".grok")),
        _ => None,
    };
    if let Some((directory, default)) = unverified_directory {
        if directory != crate::config::get_home_dir().join(default) {
            return Err("unsupported-config-directory".into());
        }
    }
    let cwd = PathBuf::from(cwd);
    let (executable, path) = crate::commands::misc::embedded_cli_environment(tool)?;
    let args: Vec<_> = args
        .iter()
        .map(|s| s.to_string())
        .chain(extra_args)
        .collect();
    let custom = match app {
        "claude" => crate::settings::get_claude_override_dir().map(|p| ("CLAUDE_CONFIG_DIR", p)),
        "codex" => crate::settings::get_codex_override_dir().map(|p| ("CODEX_HOME", p)),
        "hermes" => Some(("HERMES_HOME", crate::hermes_config::get_hermes_dir())),
        "opencode" => Some((
            "OPENCODE_CONFIG_DIR",
            crate::opencode_config::get_opencode_dir(),
        )),
        "openclaw" => Some((
            "OPENCLAW_STATE_DIR",
            crate::openclaw_config::get_openclaw_dir(),
        )),
        "pi" => Some((
            "PI_CODING_AGENT_DIR",
            crate::pi_config::get_pi_agent_dir().map_err(|_| "invalid-config-directory")?,
        )),
        "mcode" => Some(("MINIMAX_DATA_DIR", crate::mcode_config::data_dir())),
        _ => None,
    };
    Ok(Resolved {
        cwd,
        executable,
        args,
        path,
        custom: custom.map(|(key, value)| (key, value.to_string_lossy().into_owned())),
    })
}

#[cfg(target_os = "macos")]
pub fn prepare_with(
    app: &str,
    cwd: &str,
    arguments: &str,
    exit_hook: Option<ExitHookEnv<'_>>,
) -> Result<LaunchPlan, String> {
    let resolved = resolve(app, cwd, arguments)?;
    // The PTY belongs to the terminal session, not to the initial CLI.
    // Run the CLI as a child, then return to a usable shell when it exits.
    let command = session_command(
        &crate::commands::misc::get_user_shell(),
        &resolved.executable.to_string_lossy(),
        &resolved.args,
    );
    let mut environment: BTreeMap<String, String> =
        BTreeMap::from([("PATH".to_string(), resolved.path)]);
    if let Some((key, value)) = resolved.custom {
        environment.insert(key.into(), value);
    }
    if let Some(exit_hook) = exit_hook {
        // session.sh 只认这三个环境变量：没有它们就完全不记账，
        // 不走接棒的启动路径行为不变。
        environment.insert(
            crate::exit_hook::JOURNAL_ENV.into(),
            exit_hook.journal.to_string_lossy().into_owned(),
        );
        environment.insert(
            crate::exit_hook::TERMINAL_ENV.into(),
            exit_hook.terminal_id.into(),
        );
        environment.insert(crate::exit_hook::APP_ENV.into(), app.into());
    }
    Ok(LaunchPlan {
        command,
        cwd: resolved.cwd,
        environment,
    })
}

/// 后台 worker 的 argv：环境变量内联、监督脚本内联、CLI 作为最后一个可执行文件。
#[cfg(target_os = "macos")]
pub fn prepare_worker(
    app: &str,
    cwd: &str,
    arguments: &str,
    exit_hook: ExitHookEnv<'_>,
) -> Result<WorkerLaunch, String> {
    let resolved = resolve(app, cwd, arguments)?;
    let mut environment: BTreeMap<String, String> =
        BTreeMap::from([("PATH".to_string(), resolved.path)]);
    if let Some((key, value)) = resolved.custom {
        environment.insert(key.into(), value);
    }
    environment.insert(
        crate::exit_hook::JOURNAL_ENV.into(),
        exit_hook.journal.to_string_lossy().into_owned(),
    );
    environment.insert(
        crate::exit_hook::TERMINAL_ENV.into(),
        exit_hook.terminal_id.into(),
    );
    environment.insert(crate::exit_hook::APP_ENV.into(), app.into());
    let mut argv = vec!["/usr/bin/env".to_string()];
    argv.extend(
        environment
            .iter()
            .map(|(key, value)| format!("{key}={value}")),
    );
    argv.push("/bin/sh".into());
    argv.push("-c".into());
    argv.push(WORKER_SUPERVISOR.into());
    argv.push("phi-worker".into());
    argv.push(resolved.executable.to_string_lossy().into_owned());
    argv.extend(resolved.args);
    Ok(WorkerLaunch {
        argv,
        cwd: resolved.cwd,
    })
}

/// 直接跑一条 argv（查看器：把 `zellij attach` 挂进 phi 自己的终端）。
/// 与 CLI 启动不同，这里没有 CLI 白名单，所以只接受绝对路径的 program。
#[cfg(target_os = "macos")]
pub fn prepare_raw(
    cwd: &str,
    argv: &[String],
    environment: BTreeMap<String, String>,
) -> Result<LaunchPlan, String> {
    validate_directory(cwd)?;
    let (program, args) = argv.split_first().ok_or("invalid-arguments")?;
    if program.contains('\0') || !PathBuf::from(program).is_absolute() {
        return Err("invalid-arguments".into());
    }
    let command = session_command(&crate::commands::misc::get_user_shell(), program, args);
    Ok(LaunchPlan {
        command,
        cwd: PathBuf::from(cwd),
        environment,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn capabilities_are_not_proxy_apps() {
        assert_eq!(CLI_APPS.len(), 9);
        assert!(cli("claude-desktop").is_none());
        assert_eq!(cli("openclaw"), Some(("openclaw", &["tui"][..])));
        assert_eq!(cli("grokbuild").unwrap().0, "grok");
        assert!(cli("claude; rm").is_none());
    }
    #[test]
    fn parses_arguments_without_shell_expansion() {
        assert_eq!(parse_arguments("  ").unwrap(), Vec::<String>::new());
        assert_eq!(
            parse_arguments(r#"--model "model name" --resume '中文 session' '' a\ b '$(echo unsafe)' ';' "`date`""#).unwrap(),
            ["--model", "model name", "--resume", "中文 session", "", "a b", "$(echo unsafe)", ";", "`date`"]
        );
        for invalid in [
            "\"unterminated",
            "'unterminated",
            "trailing\\",
            "nul\0value",
        ] {
            assert_eq!(parse_arguments(invalid).unwrap_err(), "invalid-arguments");
        }
        assert!(parse_arguments(&"a ".repeat(257)).is_err());
        assert!(parse_arguments(&"a".repeat(16_385)).is_err());
    }
    #[test]
    fn launch_directory_must_be_an_accessible_absolute_directory() {
        let directory = tempfile::tempdir().unwrap();
        assert!(validate_directory(directory.path().to_str().unwrap()).is_ok());
        for value in ["", "relative/path", "\0", "/phi/nonexistent/workspace"] {
            assert_eq!(validate_directory(value).unwrap_err(), "invalid-directory");
        }
        let file = directory.path().join("file");
        std::fs::write(&file, "data").unwrap();
        assert!(validate_directory(file.to_str().unwrap()).is_err());
    }
    #[test]
    #[cfg(unix)]
    fn parsed_arguments_arrive_as_literal_argv() {
        let text = r#"--model 'model name' '' '中文项目' 'a"b' "'" '$(exit 99)' '`exit 98`' '; exit 97' '*.rs' '$HOME'"#;
        let args = parse_arguments(text).unwrap();
        let command = args.iter().map(|s| quote(s)).collect::<Vec<_>>().join(" ");
        let output = std::process::Command::new("/bin/sh")
            .args(["-c", &format!("printf '%s\\0' {command}")])
            .output()
            .unwrap();
        assert!(output.status.success());
        let actual: Vec<_> = output.stdout.split(|b| *b == 0).collect();
        assert_eq!(
            &actual[..actual.len() - 1],
            args.iter().map(|s| s.as_bytes()).collect::<Vec<_>>()
        );
    }
    #[test]
    #[cfg(unix)]
    fn supervisor_preserves_cli_arguments_and_enters_shell_after_nonzero_exit() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let cli = dir.path().join("cli with ' quotes");
        let shell = dir.path().join("shell with spaces");
        std::fs::write(&cli, "#!/bin/sh\nprintf '%s\\0' \"$@\"\nexit 7\n").unwrap();
        std::fs::write(&shell, "#!/bin/sh\nprintf 'SHELL_READY:%s' \"$1\"\n").unwrap();
        for path in [&cli, &shell] {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let args = vec![
            "model name".into(),
            "'".into(),
            "$(exit 99)".into(),
            "".into(),
        ];
        let command = session_command(shell.to_str().unwrap(), cli.to_str().unwrap(), &args);
        let result = std::process::Command::new("/bin/sh")
            .args(["-c", &command])
            .output()
            .unwrap();
        assert!(result.status.success());
        let mut expected = args.join("\0");
        expected.push_str("\0SHELL_READY:-il");
        assert_eq!(result.stdout, expected.as_bytes());
    }
    /// worker 的监督脚本只有两个职责：记账、把退出码原样交回去。
    /// 少了后者，pane 会被判成「成功退出」，一次真实的失败就变成了「完成」。
    ///
    /// 条件必须与 [`WORKER_SUPERVISOR`] 一致：那个常量只在 macOS 下定义，
    /// 用 `cfg(unix)` 会让 Linux 的 Backend Checks 在引用处直接编不过。
    #[test]
    #[cfg(target_os = "macos")]
    fn worker_supervisor_records_the_exit_code_and_hands_it_back() {
        let dir = tempfile::tempdir().unwrap();
        let journal = dir.path().join("journal.log");
        let output = std::process::Command::new("/bin/sh")
            .args([
                "-c",
                WORKER_SUPERVISOR,
                "phi-worker",
                "/bin/sh",
                "-c",
                "exit 7",
            ])
            .env("PHI_BATON_JOURNAL", &journal)
            .env("PHI_BATON_ID", "session-1")
            .env("PHI_BATON_APP", "codex")
            .env("PHI_BATON_WORKER_IGNORED", "1")
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(7));
        let line = std::fs::read_to_string(&journal).unwrap();
        let fields: Vec<&str> = line.trim_end().split('\t').collect();
        assert_eq!(fields[0], "session-1");
        assert_eq!(fields[1], "7");
        assert_eq!(fields[3], "codex");
    }

    /// 没有记账环境变量时不写文件、也不改变退出码：手动开的标签页不走这条路。
    #[test]
    #[cfg(target_os = "macos")]
    fn worker_supervisor_is_inert_without_the_journal_contract() {
        let output = std::process::Command::new("/bin/sh")
            .args([
                "-c",
                WORKER_SUPERVISOR,
                "phi-worker",
                "/bin/sh",
                "-c",
                "exit 3",
            ])
            .env_remove("PHI_BATON_JOURNAL")
            .env_remove("PHI_BATON_ID")
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(3));
        assert!(output.stdout.is_empty());
    }

    #[test]
    fn shell_tokens_are_literal() {
        #[cfg(unix)]
        for value in [
            "a b",
            "a'b",
            "$(touch /not-executed)",
            "中文\n项目",
            "`date`",
            "",
        ] {
            let output = std::process::Command::new("/bin/sh")
                .args(["-c", &format!("printf %s {}", quote(value))])
                .output()
                .unwrap();
            assert_eq!(String::from_utf8(output.stdout).unwrap(), value);
        }
    }
}
