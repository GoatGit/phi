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
#[cfg(any(target_os = "macos", test))]
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
#[cfg(target_os = "macos")]
pub fn prepare(app: &str, cwd: &str, arguments: &str) -> Result<LaunchPlan, String> {
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
    // The PTY belongs to the terminal session, not to the initial CLI.
    // Run the CLI as a child, then return to a usable shell when it exits.
    let args: Vec<_> = args
        .iter()
        .map(|s| s.to_string())
        .chain(extra_args)
        .collect();
    let command = session_command(
        &crate::commands::misc::get_user_shell(),
        &executable.to_string_lossy(),
        &args,
    );
    let mut environment = BTreeMap::from([("PATH".into(), path)]);
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
    if let Some((key, value)) = custom {
        environment.insert(key.into(), value.to_string_lossy().into_owned());
    }
    Ok(LaunchPlan {
        command,
        cwd,
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
