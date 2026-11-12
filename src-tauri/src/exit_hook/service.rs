//! 编排：监听 journal → 收证据 → 判决 → 问插件 → 写交接单 → 落库 → 拉起续跑会话。
//!
//! 几条边界写在这里，改代码前先读：
//! - **策略可以插件化，能力不行。** 插件只拿到事件、只回决策；进程、终端、
//!   交接单、重启都在这里。没装插件时回落到本模块的内置策略。
//! - **不擅自改用户配置。** 换账号/换供应商由代理层的故障转移负责；接棒在
//!   进程层重启同一个会话，不重写 provider 配置。
//! - **不接管别人的终端。** 只处理 journal 里出现的、由 phi 托管启动的会话。
//! - **有界。** 次数上限、重复原因停手、交接单与证据条数都有上限。

use super::classify::{self, Verdict};
use super::evidence;
use super::handoff::{self, HandoffInput};
use super::journal::ExitRecord;
use super::plan::{self, Decision, ResumeMode};
use super::store::{AttemptPlan, RecordInput};
use super::{Attempt, Policy};
use crate::plugin::PluginRuntime;
use crate::store::AppState;
use crate::Database;
use serde_json::{json, Value};
use std::sync::{Arc, OnceLock};
use tauri::{Emitter, Manager};

const POLICY_KEY: &str = "baton.policy";
const OFFSET_KEY: &str = "baton.journal_offset";
const EVENT_ATTEMPT: &str = "baton://attempt";
const EVENT_RESUMED: &str = "baton://resumed";
/// 一次 tick 最多处理多少条退出记账，防止 journal 被灌满时长时间占用线程。
const MAX_LINES_PER_TICK: usize = 20;

/// 插件运行时：与插件中心同一个根目录，TTL 刷新，改完插件最多等一个 TTL。
static PLUGINS: OnceLock<PluginRuntime> = OnceLock::new();

fn plugin_runtime() -> &'static PluginRuntime {
    PLUGINS.get_or_init(PluginRuntime::from_config_dir)
}

pub(crate) fn load_policy(db: &Database) -> Policy {
    db.get_setting(POLICY_KEY)
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str::<Policy>(&raw).ok())
        .map(Policy::sanitized)
        .unwrap_or_default()
}

pub(crate) fn save_policy(db: &Database, policy: Policy) -> Result<Policy, crate::error::AppError> {
    let policy = policy.sanitized();
    let raw = serde_json::to_string(&policy)
        .map_err(|error| crate::error::AppError::Config(format!("Baton: {error}")))?;
    db.set_setting(POLICY_KEY, &raw)?;
    Ok(policy)
}

/// 在工作目录里取两条 git 事实。取不到就返回空——交接单里宁可少一节，也不编。
fn run_git(cwd: &str, args: &[&str]) -> Option<String> {
    use std::process::{Command, Stdio};
    let mut child = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = std::time::Instant::now() + super::GIT_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(50))
            }
            // 超时或状态查询失败：杀掉子进程，按「没有 git 事实」处理。
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                log::warn!("[baton] git 查询超时或被中断: {args:?} in {cwd}");
                return None;
            }
        }
    }
    let output = child.wait_with_output().ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn git_facts(cwd: &str) -> (Option<String>, Vec<String>) {
    let branch = run_git(cwd, &["rev-parse", "--abbrev-ref", "HEAD"])
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty() && text != "HEAD");
    let changed = run_git(cwd, &["status", "--porcelain", "--untracked-files=no"])
        .map(|text| {
            text.lines()
                .filter_map(|line| line.get(3..).map(str::trim))
                .filter(|path| !path.is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    (branch, changed)
}

fn write_handoff(input: &HandoffInput) -> Option<String> {
    let directory = super::handoff_dir();
    if let Err(error) = std::fs::create_dir_all(&directory) {
        log::warn!("[baton] 交接单目录创建失败: {error}");
        return None;
    }
    let name = format!("{}-{}.md", super::now_ms(), sanitize(&input.app_id));
    let path = directory.join(name);
    match std::fs::write(&path, handoff::render(input)) {
        Ok(()) => Some(path.to_string_lossy().into_owned()),
        Err(error) => {
            log::warn!("[baton] 交接单写入失败: {error}");
            None
        }
    }
}

/// 只留 ascii 字母数字和连字符：文件名来自应用名，不能带出路径分隔符。
fn sanitize(value: &str) -> String {
    value
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .collect()
}

/// 交给插件的结构化事件。字段只增不改：插件按字段读取，改动会让别人的脚本失效。
fn plugin_event(
    record: &ExitRecord,
    kind: classify::FailureKind,
    reason: &str,
    collected: &evidence::Collected,
    policy: &Policy,
    history: plan::History,
    evidence_lines: &[String],
) -> Value {
    json!({
        "app": record.app_id,
        "cwd": record.cwd,
        "exitCode": record.exit_code,
        "failureKind": kind.as_str(),
        "reason": reason,
        "hasTarget": collected.target.is_some(),
        "attempts": history.attempts,
        "lastKind": history.last_kind.map(|kind| kind.as_str()),
        "maxAttempts": policy.max_attempts,
        "autoResume": policy.auto_resume,
        "evidence": evidence_lines,
        "successes": collected.successes,
    })
}

/// 恢复命令 → 启动参数。`terminal` 自己负责程序名，所以这里把命令的第一个词丢掉。
fn resume_arguments(plan: &AttemptPlan, prompt: Option<&str>) -> Option<String> {
    let mut parts: Vec<String> = match plan.mode.as_deref() {
        // 新会话：没有可 resume 的旧会话，直接把交接提示当首条消息带进去。
        Some("fresh-session") => Vec::new(),
        _ => {
            let command = plan.resume_command.as_deref()?;
            let mut argv = crate::terminal::parse_arguments(command).ok()?;
            if argv.is_empty() {
                return None;
            }
            argv.remove(0);
            argv
        }
    };
    if plan.mode.as_deref() == Some("fresh-session") {
        parts.push(prompt?.to_string());
    }
    Some(
        parts
            .iter()
            .map(|part| quote_argument(part))
            .collect::<Vec<_>>()
            .join(" "),
    )
}

/// 只给真的需要转义的部分加引号：命令串会被 shlex 再拆一次。
///
/// 全部包一层单引号也能工作，但会让日志里的命令难读，也容易让人误以为
/// 这些参数本来带引号。
fn quote_argument(part: &str) -> String {
    let safe = !part.is_empty()
        && part.chars().all(|c| {
            c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/' | ':' | '@' | '=' | '+')
        });
    if safe {
        part.to_string()
    } else {
        crate::terminal::quote_argument(part)
    }
}

fn spawn_resume(
    app: &tauri::AppHandle,
    plan: &AttemptPlan,
    prompt: Option<&str>,
) -> Result<String, String> {
    let arguments = resume_arguments(plan, prompt).ok_or_else(|| "no-resume-target".to_string())?;
    crate::terminal::resume_spawn(app, &plan.app_id, &plan.cwd, &arguments)
        .map(|snapshot| snapshot.id)
}

/// 处理一条退出记账。返回是否产生了一条新记录（测试与日志都靠它判断）。
fn handle_record(app: &tauri::AppHandle, record: &ExitRecord) -> bool {
    let state = app.state::<AppState>();
    let db = state.db.clone();
    match db.baton_attempt_exists(&record.terminal_id, record.at) {
        Ok(true) => return false,
        Ok(false) => {}
        Err(error) => log::warn!("[baton] 去重查询失败，按新事件处理: {error}"),
    }

    let collected = evidence::collect(&db, record);
    let verdict = classify::classify(&collected.evidence);
    let (kind, reason) = match &verdict {
        Verdict::Completed => {
            log::debug!(
                "[baton] {} 正常结束（exit 0），无需接棒: {}",
                record.app_id,
                record.cwd
            );
            return false;
        }
        Verdict::Interrupted => {
            log::debug!(
                "[baton] {} 被用户中断（exit {}），不接棒: {}",
                record.app_id,
                record.exit_code,
                record.cwd
            );
            return false;
        }
        Verdict::Failed { kind, reason } => (*kind, reason.clone()),
    };

    let (branch, changed_files) = git_facts(&record.cwd);
    let mut evidence_lines: Vec<String> = collected
        .evidence
        .proxy
        .iter()
        .take(3)
        .map(|failure| format!("上游 {}：{}", failure.status_code, failure.message))
        .collect();
    evidence_lines.extend(
        collected
            .evidence
            .session_markers
            .iter()
            .take(3)
            .map(|marker| format!("会话里出现「{marker}」")),
    );
    let mut verified = Vec::new();
    if collected.successes > 0 {
        verified.push(format!(
            "退出前 30 分钟内 {} 次请求成功",
            collected.successes
        ));
    }
    if let Some(target) = &collected.target {
        verified.push(format!("可恢复的会话：{}", target.session_id));
    }

    let handoff_input = HandoffInput {
        app_id: record.app_id.clone(),
        cwd: record.cwd.clone(),
        exit_code: record.exit_code,
        kind: Some(kind),
        reason: reason.clone(),
        evidence: evidence_lines.clone(),
        branch,
        changed_files,
        verified,
    };
    let handoff_path = write_handoff(&handoff_input);

    let policy = load_policy(&db);
    let history = db.baton_history(&record.terminal_id).unwrap_or_default();
    let has_target = collected.target.is_some();
    let host = plan::decide(
        &verdict,
        policy.auto_resume,
        policy.max_attempts,
        history,
        has_target,
    );
    // 内置策略说「该接」时，才轮到插件决定「怎么接」。插件不能把停下来的活重新拉起来。
    let (choice, decided_by) = match host {
        Decision::Resume { .. } => {
            // 插件中心把这个插件关掉，等于用户关掉这个功能：不回落、直接停。
            if plugin_runtime().session_exit_state()
                == crate::plugin::runtime::SessionExitState::Disabled
            {
                log::info!("[baton] 接棒插件已被停用，只记录不重启: {}", record.cwd);
                (Decision::Stop(plan::StopReason::Disabled), None)
            } else {
                let event = plugin_event(
                    record,
                    kind,
                    &reason,
                    &collected,
                    &policy,
                    history,
                    &evidence_lines,
                );
                match plugin_runtime().decide_session_exit(&event) {
                    Some(choice) => {
                        let plugin_id = choice.plugin_id.clone();
                        let mode = choice
                            .decision
                            .mode
                            .as_deref()
                            .and_then(ResumeMode::from_str);
                        let merged = match (choice.decision.action, mode) {
                            (crate::plugin::SessionExitAction::Record, _) => {
                                Decision::Stop(plan::StopReason::PluginDeclined)
                            }
                            (crate::plugin::SessionExitAction::Resume, Some(mode)) => {
                                plan::merge_plugin_decision(
                                    host,
                                    Some((mode, choice.decision.reason.clone())),
                                    has_target,
                                )
                                .0
                            }
                            // 插件说接但没指定方式：按内置判定走。
                            (crate::plugin::SessionExitAction::Resume, None) => host,
                        };
                        (merged, Some(plugin_id))
                    }
                    None => (host, None),
                }
            }
        }
        other => (other, None),
    };

    let (resume_mode, resume_command) = match &choice {
        Decision::Resume { mode, .. } => (
            Some(mode.as_str()),
            collected
                .target
                .as_ref()
                .map(|target| target.resume_command.clone()),
        ),
        Decision::Stop(stop) => {
            log::info!(
                "[baton] {} 不接棒（{}）：exit={} kind={} 决策者={}",
                record.app_id,
                stop.as_str(),
                record.exit_code,
                kind.as_str(),
                decided_by.as_deref().unwrap_or("内置策略")
            );
            (None, None)
        }
    };

    let input = RecordInput {
        terminal_id: record.terminal_id.clone(),
        app_id: record.app_id.clone(),
        cwd: record.cwd.clone(),
        exit_code: record.exit_code,
        kind,
        reason,
        resume_mode,
        resume_command,
        handoff_path: handoff_path.clone(),
        decided_by: decided_by.clone(),
        created_at: record.at,
    };
    let attempt_id = match db.baton_record(&input) {
        Ok(id) => id,
        Err(error) => {
            log::error!("[baton] 记录写入失败: {error}");
            return false;
        }
    };

    let mut attempt = db
        .baton_attempt(&attempt_id)
        .ok()
        .flatten()
        .unwrap_or(Attempt {
            id: attempt_id.clone(),
            terminal_id: record.terminal_id.clone(),
            app_id: record.app_id.clone(),
            cwd: record.cwd.clone(),
            exit_code: record.exit_code,
            failure_kind: kind.as_str().to_string(),
            reason: input.reason.clone(),
            resumed: false,
            resume_terminal_id: None,
            handoff_path: handoff_path.clone(),
            decided_by: decided_by.clone(),
            created_at: record.at,
        });
    let _ = app.emit_to("main", EVENT_ATTEMPT, &attempt);

    let Decision::Resume { mode, .. } = choice else {
        return true;
    };
    let resume_plan = match db.baton_attempt_plan(&attempt_id) {
        Ok(Some(plan)) => plan,
        Ok(None) | Err(_) => {
            log::warn!("[baton] 记录刚写入却取不到续跑计划: {attempt_id}");
            return true;
        }
    };
    let prompt = handoff_path
        .as_deref()
        .map(|path| handoff::prompt(&record.cwd, &input.reason, path));
    match spawn_resume(app, &resume_plan, prompt.as_deref()) {
        Ok(terminal_id) => {
            if let Err(error) = db.baton_mark_resumed(&attempt_id, mode.as_str(), &terminal_id) {
                log::warn!("[baton] 接棒结果写回失败: {error}");
            }
            attempt.resumed = true;
            attempt.resume_terminal_id = Some(terminal_id);
            let _ = app.emit_to("main", EVENT_RESUMED, &attempt);
            log::info!(
                "[baton] 已接棒 {}（{}，{}）：新会话 {}",
                record.app_id,
                kind.as_str(),
                mode.as_str(),
                attempt.resume_terminal_id.as_deref().unwrap_or("-")
            );
        }
        Err(error) => {
            // 起不来不算致命：记录还在，用户可以手动接。
            log::warn!("[baton] 接棒启动失败（{error}），保留记录等手动处理");
        }
    }
    true
}

fn tick(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    let db = state.db.clone();
    let path = super::journal_path();
    if !path.exists() {
        return;
    }
    // journal 只保留最近的记账：爆掉就整体截断，避免无限增长。
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > super::MAX_JOURNAL_BYTES {
            log::warn!(
                "[baton] journal 超过 {} 字节，已截断",
                super::MAX_JOURNAL_BYTES
            );
            let _ = std::fs::write(&path, b"");
            let _ = db.set_setting(OFFSET_KEY, "0");
            return;
        }
    }
    let offset = db
        .get_setting(OFFSET_KEY)
        .ok()
        .flatten()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    let (lines, new_offset) = super::journal::read_new_lines(&path, offset);
    if new_offset != offset {
        if let Err(error) = db.set_setting(OFFSET_KEY, &new_offset.to_string()) {
            log::warn!("[baton] 游标写入失败: {error}");
        }
    }
    if lines.is_empty() {
        return;
    }
    let mut processed = 0usize;
    for line in &lines {
        if processed >= MAX_LINES_PER_TICK {
            log::warn!(
                "[baton] 单次最多处理 {} 条退出记账，其余留到下一轮",
                MAX_LINES_PER_TICK
            );
            break;
        }
        match super::journal::parse_line(line) {
            Some(record) => {
                processed += 1;
                handle_record(app, &record);
            }
            None => log::warn!("[baton] 丢弃无法解析的退出记账（长度 {}）", line.len()),
        }
    }
}

/// 启动 journal 监听，并把内置策略插件补进插件目录。
///
/// 只在主应用启动时调用一次。
pub(crate) fn start(app: tauri::AppHandle) {
    super::install_bundled_plugin();
    if let Err(error) = std::fs::create_dir_all(super::data_dir()) {
        log::warn!("[baton] 数据目录创建失败，接棒不可用: {error}");
        return;
    }
    std::thread::spawn(move || {
        log::info!("[baton] 退出记账监听已启动");
        loop {
            tick(&app);
            std::thread::sleep(std::time::Duration::from_millis(super::POLL_INTERVAL_MS));
        }
    });
}

/// 手动接棒：用户在界面上点名一条记录，重放它的续跑计划。
pub(crate) fn resume_attempt(
    app: &tauri::AppHandle,
    db: &Arc<Database>,
    id: &str,
) -> Result<Attempt, String> {
    let plan = db
        .baton_attempt_plan(id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "unknown-attempt".to_string())?;
    let attempt = db
        .baton_attempt(id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "unknown-attempt".to_string())?;
    if attempt.resumed {
        return Err("already-resumed".into());
    }
    let prompt = plan
        .handoff_path
        .as_deref()
        .map(|path| handoff::prompt(&plan.cwd, &plan.reason, path))
        .filter(|_| plan.mode.as_deref() == Some("fresh-session"));
    let terminal_id = spawn_resume(app, &plan, prompt.as_deref()).map_err(|error| {
        log::warn!("[baton] 手动接棒启动失败: {error}");
        error
    })?;
    db.baton_mark_resumed(
        id,
        plan.mode.as_deref().unwrap_or("same-session"),
        &terminal_id,
    )
    .map_err(|error| error.to_string())?;
    db.baton_attempt(id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "unknown-attempt".to_string())
}

/// 供 UI 展示：策略 + 最近的记录。
pub(crate) fn status(db: &Database, limit: usize) -> (Policy, Vec<Attempt>) {
    let policy = load_policy(db);
    let attempts = db.baton_attempts(limit).unwrap_or_else(|error| {
        log::warn!("[baton] 读取记录失败: {error}");
        Vec::new()
    });
    (policy, attempts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exit_hook::classify::FailureKind;

    fn plan_with(mode: Option<&str>, command: Option<&str>, handoff: Option<&str>) -> AttemptPlan {
        AttemptPlan {
            app_id: "claude".into(),
            cwd: "/tmp/demo".into(),
            mode: mode.map(str::to_string),
            resume_command: command.map(str::to_string),
            handoff_path: handoff.map(str::to_string),
            reason: "命中 quota 标记：usage limit".into(),
        }
    }

    #[test]
    fn resume_arguments_drop_the_program_name() {
        let plan = plan_with(Some("same-session"), Some("claude --resume abc"), None);
        assert_eq!(resume_arguments(&plan, None).unwrap(), "--resume abc");
    }

    #[test]
    fn resume_arguments_quote_values_that_contain_spaces() {
        let plan = plan_with(
            Some("same-session"),
            Some("pi --session '/tmp/my project/session.json'"),
            None,
        );
        let arguments = resume_arguments(&plan, None).unwrap();
        assert_eq!(arguments, "--session '/tmp/my project/session.json'");
    }

    #[test]
    fn fresh_session_carries_the_handoff_prompt_as_first_message() {
        let plan = plan_with(Some("fresh-session"), None, Some("/tmp/handoff.md"));
        let arguments = resume_arguments(&plan, Some("继续 /tmp/demo 的活")).unwrap();
        assert_eq!(arguments, "'继续 /tmp/demo 的活'");
    }

    #[test]
    fn a_missing_resume_command_yields_no_arguments() {
        let plan = plan_with(Some("same-session"), None, None);
        assert!(resume_arguments(&plan, None).is_none());
    }

    #[test]
    fn fresh_session_without_a_prompt_is_not_spawned_blind() {
        let plan = plan_with(Some("fresh-session"), None, None);
        assert!(resume_arguments(&plan, None).is_none());
    }

    #[test]
    fn handoff_file_names_cannot_escape_the_directory() {
        assert_eq!(sanitize("../../etc/passwd"), "etcpasswd");
        assert_eq!(sanitize("claude"), "claude");
        assert_eq!(sanitize("a b\tc"), "abc");
    }

    #[test]
    fn policy_round_trips_through_settings() {
        let db = Database::memory().unwrap();
        assert_eq!(load_policy(&db), Policy::default());
        let saved = save_policy(
            &db,
            Policy {
                auto_resume: false,
                max_attempts: 99,
            },
        )
        .unwrap();
        assert_eq!(saved.max_attempts, 5, "上限必须被夹住");
        let loaded = load_policy(&db);
        assert!(!loaded.auto_resume);
        assert_eq!(loaded.max_attempts, 5);
    }

    #[test]
    fn broken_policy_json_falls_back_to_the_default() {
        let db = Database::memory().unwrap();
        db.set_setting(POLICY_KEY, "{not json").unwrap();
        assert_eq!(load_policy(&db), Policy::default());
    }

    #[test]
    fn the_plugin_event_carries_everything_a_policy_needs() {
        let record = ExitRecord {
            terminal_id: "3f2504e0-4f89-11d3-9a0c-0305e82c3301".into(),
            app_id: "claude".into(),
            exit_code: 1,
            at: 1_762_900_000,
            cwd: "/tmp/demo".into(),
        };
        let collected = evidence::Collected {
            target: Some(evidence::SessionTarget {
                session_id: "abc".into(),
                resume_command: "claude --resume abc".into(),
                source_path: None,
            }),
            successes: 3,
            ..Default::default()
        };
        let event = plugin_event(
            &record,
            FailureKind::Quota,
            "命中 quota 标记",
            &collected,
            &Policy::default(),
            plan::History {
                attempts: 1,
                last_kind: Some(FailureKind::Crash),
            },
            &["上游 429".to_string()],
        );
        assert_eq!(event["failureKind"], json!("quota"));
        assert_eq!(event["hasTarget"], json!(true));
        assert_eq!(event["attempts"], json!(1));
        assert_eq!(event["lastKind"], json!("crash"));
        assert_eq!(event["autoResume"], json!(true));
        assert_eq!(event["successes"], json!(3));
    }
}
