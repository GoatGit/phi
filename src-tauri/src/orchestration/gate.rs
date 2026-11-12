//! 门 2 / 门 3 的判定。
//!
//! 门 2 = 「实现是否成立」：把卡片 `phi.accept` 里的命令真的跑一遍，再用
//! 相对基线的改动清单核对 `touched` / `forbidden`。门 3 = 「复查是否成立」：
//! 复查意见里的每条证据锚点都要能在源码里对上（见 `review` 模块）。
//!
//! 这里只负责判定，不负责调度：谁实现、谁复查、什么时候放行仍然是人和
//! 卡片的事，PHI 不替他们决定。

use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use super::model::{self, AcceptStep, ClaimCheck, Contract, GateEvidence, StepResult, Violation};
use super::review::{self, Claim};
use super::{contract, glob};

/// 门判定的结果：状态 + 证据 + 本轮用的基线。
#[derive(Clone, Debug)]
pub struct GateOutcome {
    pub status: String,
    pub evidence: GateEvidence,
    pub base: Option<String>,
}

impl GateOutcome {
    fn invalid(note: impl Into<String>) -> Self {
        Self {
            status: model::INVALID.to_string(),
            evidence: GateEvidence {
                note: Some(note.into()),
                ..Default::default()
            },
            base: None,
        }
    }
}

/// 跑门 2。`inherited_base` 是这张卡上一轮的基线，卡片自己没写 `phi.base` 时沿用它。
pub fn run_gate2(root: &Path, contract: &Contract, inherited_base: Option<String>) -> GateOutcome {
    let started = Instant::now();
    let mut evidence = GateEvidence::default();

    if contract.accept.is_empty() {
        return GateOutcome::invalid("卡片没有 phi.accept，门 2 无从判定");
    }

    let base = match resolve_base(root, contract.base.clone().or(inherited_base)) {
        Ok(base) => base,
        Err(reason) => return GateOutcome::invalid(format!("基线取不到：{reason}")),
    };

    let budget = contract
        .max_minutes
        .map(|minutes| Duration::from_secs(minutes * 60));
    let mut failed = false;
    for step in &contract.accept {
        if budget.is_some_and(|budget| started.elapsed() >= budget) {
            evidence.note = Some("时间预算已经用完，剩下的验收命令没有再跑".to_string());
            failed = true;
            break;
        }
        let result = run_step(root, contract, step);
        let ok = !result.timed_out && result.exit_code == Some(step.expect_exit);
        failed |= !ok;
        evidence.steps.push(result);
    }

    match changed_files(root, &base) {
        Ok(changed) => {
            evidence.violations = violations(&changed, contract);
            evidence.changed = changed;
        }
        Err(reason) => {
            evidence.note = Some(format!("拿不到改动清单（{reason}），越界检查做不了"));
            return GateOutcome {
                status: model::INVALID.to_string(),
                evidence,
                base: Some(base),
            };
        }
    }

    let status = if failed || !evidence.violations.is_empty() {
        model::FAIL
    } else {
        model::PASS
    };
    GateOutcome {
        status: status.to_string(),
        evidence,
        base: Some(base),
    }
}

/// 核对门 3：复查意见里的锚点全部对得上才算通过。
pub fn run_gate3(root: &Path, claims: &[Claim]) -> GateOutcome {
    if claims.is_empty() {
        return GateOutcome::invalid("卡片正文没有 phi-review 证据锚点，复查意见无法校验");
    }
    let checked: Vec<ClaimCheck> = review::verify(root, claims);
    let all_ok = checked.iter().all(|check| check.ok);
    GateOutcome {
        status: if all_ok { model::PASS } else { model::INVALID }.to_string(),
        evidence: GateEvidence {
            claims: checked,
            note: (!all_ok).then(|| "有证据锚点对不上源码，复查意见不成立".to_string()),
            ..Default::default()
        },
        base: None,
    }
}

/// 按卡片声明的超时跑一条验收命令，输出落到临时文件（避免管道写满死锁）。
fn run_step(root: &Path, contract: &Contract, step: &AcceptStep) -> StepResult {
    let started = Instant::now();
    let mut result = run_shell(root, &step.cmd, contract::step_timeout(contract, step));
    result.expect_exit = step.expect_exit;
    result.duration_ms = started.elapsed().as_millis() as i64;
    result
}

fn run_shell(root: &Path, cmd: &str, timeout: Duration) -> StepResult {
    let mut result = StepResult {
        cmd: cmd.to_string(),
        ..Default::default()
    };
    let started = Instant::now();

    let log = match tempfile::Builder::new().prefix("phi-gate2").tempfile() {
        Ok(file) => file,
        Err(error) => {
            result.output_tail = format!("临时文件建不出来：{error}");
            result.duration_ms = started.elapsed().as_millis() as i64;
            return result;
        }
    };

    let mut command = Command::new("/bin/sh");
    command
        .arg("-c")
        .arg(cmd)
        .current_dir(root)
        .stdin(Stdio::null());
    // 用 dup 出来的两个句柄共享同一个文件偏移，stdout / stderr 才不会互相覆盖
    match (log.as_file().try_clone(), log.as_file().try_clone()) {
        (Ok(stdout), Ok(stderr)) => {
            command
                .stdout(Stdio::from(stdout))
                .stderr(Stdio::from(stderr));
        }
        _ => {
            command.stdout(Stdio::null()).stderr(Stdio::null());
        }
    }

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            result.output_tail = format!("起不来：{error}");
            result.duration_ms = started.elapsed().as_millis() as i64;
            return result;
        }
    };

    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                result.exit_code = status.code();
                break;
            }
            Ok(None) => {
                if started.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    result.timed_out = true;
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(error) => {
                result.output_tail = format!("等不到退出状态：{error}");
                break;
            }
        }
    }

    let text = std::fs::read(log.path())
        .map(|bytes| String::from_utf8_lossy(&bytes).to_string())
        .unwrap_or_default();
    let kept = tail(&text, 40, 4000);
    if !kept.is_empty() {
        result.output_tail = kept;
    }
    result.duration_ms = started.elapsed().as_millis() as i64;
    result
}

/// 留最后若干行、并限制字符数：证据要够看，但不能把界面撑爆。
fn tail(text: &str, max_lines: usize, max_chars: usize) -> String {
    let lines: Vec<&str> = text.lines().collect();
    let start = lines.len().saturating_sub(max_lines);
    let mut kept = lines[start..].join("\n");
    if kept.chars().count() > max_chars {
        kept = kept
            .chars()
            .skip(kept.chars().count() - max_chars)
            .collect::<String>();
    }
    kept
}

/// 越界判定：`forbidden` 命中直接违规，没命中 `touched` 的就是越界。
pub fn violations(changed: &[String], contract: &Contract) -> Vec<Violation> {
    changed
        .iter()
        .filter_map(|path| {
            if contract
                .forbidden
                .iter()
                .any(|rule| glob::matches(rule, path))
            {
                return Some(Violation {
                    path: path.clone(),
                    rule: "forbidden".to_string(),
                });
            }
            if !contract.touched.is_empty()
                && !contract
                    .touched
                    .iter()
                    .any(|rule| glob::matches(rule, path))
            {
                return Some(Violation {
                    path: path.clone(),
                    rule: "out-of-scope".to_string(),
                });
            }
            None
        })
        .collect()
}

/// 相对基线的改动文件（含未跟踪），仓库相对路径、`/` 分隔。
pub fn changed_files(root: &Path, base: &str) -> Result<Vec<String>, String> {
    let mut names = git_names(root, &["diff", "--name-only", "-z", base, "--"])?;
    names.extend(git_names(
        root,
        &["ls-files", "--others", "--exclude-standard", "-z"],
    )?);
    names.retain(|name| !name.is_empty());
    names.sort();
    names.dedup();
    Ok(names)
}

fn resolve_base(root: &Path, declared: Option<String>) -> Result<String, String> {
    let revision = declared.unwrap_or_else(|| "HEAD".to_string());
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["rev-parse", "--verify", &format!("{revision}^{{commit}}")])
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(format!(
            "{revision} 不是一个能用的提交：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let sha = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if sha.is_empty() {
        return Err(format!("{revision} 解析不出提交号"));
    }
    Ok(sha)
}

fn git_names(root: &Path, args: &[&str]) -> Result<Vec<String>, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .split('\0')
        .map(|name| name.to_string())
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn contract_with(
        accept: Vec<AcceptStep>,
        touched: Vec<&str>,
        forbidden: Vec<&str>,
    ) -> Contract {
        Contract {
            accept,
            touched: touched.into_iter().map(|item| item.to_string()).collect(),
            forbidden: forbidden.into_iter().map(|item| item.to_string()).collect(),
            ..Default::default()
        }
    }

    fn step(cmd: &str, expect_exit: i32) -> AcceptStep {
        AcceptStep {
            cmd: cmd.to_string(),
            expect_exit,
            timeout_minutes: None,
        }
    }

    #[test]
    fn shell_keeps_exit_code_and_tail() {
        let root = tempfile::tempdir().unwrap();
        let result = run_shell(
            root.path(),
            "echo 一 >&2; echo done",
            Duration::from_secs(30),
        );
        assert_eq!(result.exit_code, Some(0));
        assert!(!result.timed_out);
        assert!(
            result.output_tail.contains("done"),
            "{}",
            result.output_tail
        );
        assert!(result.output_tail.contains('一'), "{}", result.output_tail);
    }

    #[test]
    fn shell_reports_failure_exit_code() {
        let root = tempfile::tempdir().unwrap();
        let result = run_shell(root.path(), "exit 3", Duration::from_secs(30));
        assert_eq!(result.exit_code, Some(3));
    }

    #[test]
    fn shell_kills_after_timeout() {
        let root = tempfile::tempdir().unwrap();
        let result = run_shell(root.path(), "sleep 5", Duration::from_millis(200));
        assert!(result.timed_out);
        assert_eq!(result.exit_code, None);
    }

    #[test]
    fn violations_split_forbidden_from_out_of_scope() {
        let contract = contract_with(
            vec![step("true", 0)],
            vec!["src/auth/**"],
            vec!["package.json"],
        );
        let found = violations(
            &[
                "src/auth/login.rs".to_string(),
                "src/billing/invoice.rs".to_string(),
                "package.json".to_string(),
            ],
            &contract,
        );
        assert_eq!(found.len(), 2);
        assert!(found
            .iter()
            .any(|item| item.path == "package.json" && item.rule == "forbidden"));
        assert!(found
            .iter()
            .any(|item| item.path == "src/billing/invoice.rs" && item.rule == "out-of-scope"));
    }

    #[test]
    fn gate2_blocks_on_failed_command() {
        let root = tempfile::tempdir().unwrap();
        let contract = contract_with(vec![step("exit 1", 0)], vec!["**"], vec![]);
        let outcome = run_gate2(root.path(), &contract, None);
        // 这里是个空目录，不是 git 仓库：命令先失败，而且拿不到改动清单
        assert_eq!(outcome.status, model::INVALID);
        assert!(outcome.evidence.note.is_some());
    }

    #[test]
    fn gate3_requires_claims() {
        let root = tempfile::tempdir().unwrap();
        let outcome = run_gate3(root.path(), &[]);
        assert_eq!(outcome.status, model::INVALID);
        assert!(outcome.evidence.note.unwrap().contains("phi-review"));
    }

    #[test]
    fn gate3_passes_when_anchor_matches() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("a.rs"), "fn a() {}\n").unwrap();
        let outcome = run_gate3(
            root.path(),
            &[Claim {
                file: "a.rs".into(),
                line: 1,
                quote: "fn a() {}".into(),
            }],
        );
        assert_eq!(outcome.status, model::PASS, "{:?}", outcome.evidence);
    }
}
