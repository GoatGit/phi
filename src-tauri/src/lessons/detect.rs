//! 采集：从会话记录里捞出「工具调用失败」这一事实。
//!
//! 不调模型，只看三样东西：工具调用的状态、退出码、同一会话里改过哪些文件。
//! 会话记录本身由 `session_manager` 统一解析，所以这里对九种应用一视同仁。

use crate::session_manager::model::{SessionBlock, SessionMessage, ToolKind, ToolStatus};
use crate::session_manager::SessionMeta;
use std::collections::HashMap;
use std::path::Path;

/// 一个会话里的一处失败（纯数据，便于单测）。
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Detected {
    pub ts: i64,
    pub kind: ToolKind,
    pub title: String,
    pub exit_code: Option<i32>,
    /// 能归因到的仓库相对路径；空表示这次失败没法归到具体文件
    pub paths: Vec<String>,
}

/// 带上来源的失败事件。
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct FailureEvent {
    pub app: String,
    pub session_id: String,
    pub ts: i64,
    pub kind: ToolKind,
    pub title: String,
    pub exit_code: Option<i32>,
    pub paths: Vec<String>,
}

pub(crate) struct Collected {
    pub events: Vec<FailureEvent>,
    pub scanned_sessions: usize,
    pub pending_sessions: usize,
    /// 下次扫描的起点：已处理会话里最新的活跃时间
    pub scanned_through: i64,
}

/// 一次刷新最多解析多少个会话：宁可让用户再点一次，也别让「刷新」卡成假死。
pub(crate) const SCAN_LIMIT: usize = 60;

/// 扫描本机会话里落在 `workspace` 下的失败。
pub(crate) fn collect(
    workspace: &Path,
    sessions: &[SessionMeta],
    since: i64,
    limit: usize,
) -> Collected {
    let mut candidates: Vec<&SessionMeta> = sessions
        .iter()
        .filter(|meta| last_active(meta) > since && belongs(meta.project_dir.as_deref(), workspace))
        .collect();
    candidates.sort_by_key(|meta| last_active(meta));

    let pending_sessions = candidates.len().saturating_sub(limit);
    let mut events = Vec::new();
    let mut scanned_sessions = 0;
    let mut scanned_through = since;

    for meta in candidates.into_iter().take(limit) {
        let Some(source_path) = meta.source_path.as_deref() else {
            continue;
        };
        let Ok(loaded) = crate::session_manager::load_transcript(&meta.provider_id, source_path)
        else {
            // 会话文件可能刚被删掉：跳过而不是让整次刷新失败
            continue;
        };
        scanned_sessions += 1;
        scanned_through = scanned_through.max(last_active(meta));
        for detected in failures_in(workspace, &loaded.transcript.messages) {
            events.push(FailureEvent {
                app: meta.provider_id.clone(),
                session_id: meta.session_id.clone(),
                ts: detected.ts.max(last_active(meta)),
                kind: detected.kind,
                title: detected.title,
                exit_code: detected.exit_code,
                paths: detected.paths,
            });
        }
    }

    Collected {
        events,
        scanned_sessions,
        pending_sessions,
        scanned_through,
    }
}

fn last_active(meta: &SessionMeta) -> i64 {
    meta.last_active_at.or(meta.created_at).unwrap_or(0)
}

/// 会话的 cwd 是否在这个仓库里（允许子目录里开的会话）。
fn belongs(project_dir: Option<&str>, workspace: &Path) -> bool {
    let Some(dir) = project_dir else {
        return false;
    };
    let path = Path::new(dir);
    let resolved = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    resolved == workspace || resolved.starts_with(workspace)
}

/// 一段消息里的失败事件。同一个会话里重复出现的同一种失败只算一次。
pub(crate) fn failures_in(workspace: &Path, messages: &[SessionMessage]) -> Vec<Detected> {
    let mut calls: HashMap<String, (ToolKind, String, bool)> = HashMap::new();
    let mut edited: Vec<String> = Vec::new();
    let mut out: Vec<Detected> = Vec::new();
    let mut seen: Vec<(ToolKind, String, Option<i32>)> = Vec::new();
    let mut clock = 0i64;

    for message in messages {
        if let Some(ts) = message.ts {
            clock = ts;
        }
        for block in &message.blocks {
            match block {
                SessionBlock::ToolCall {
                    id,
                    kind,
                    title,
                    by_user,
                    ..
                } => {
                    calls.insert(id.clone(), (*kind, title.clone(), *by_user));
                    if matches!(*kind, ToolKind::Edit | ToolKind::Write) {
                        if let Some(path) = normalize_path(workspace, title) {
                            if !edited.contains(&path) {
                                edited.push(path);
                            }
                        }
                    }
                }
                SessionBlock::ToolResult {
                    call_id,
                    status,
                    exit_code,
                    ..
                } => {
                    let failed = match status {
                        ToolStatus::Error => true,
                        // 状态说成功、退出码却非 0：以退出码为准
                        ToolStatus::Success => exit_code.is_some_and(|code| code != 0),
                        _ => false,
                    };
                    if !failed {
                        continue;
                    }
                    let Some((kind, title, by_user)) = calls.get(call_id) else {
                        // 没有配对的调用就无从归因，宁可漏报
                        continue;
                    };
                    if *by_user {
                        // 用户自己敲的命令失败，不是 agent 的判断失误
                        continue;
                    }
                    let key = (*kind, title.clone(), *exit_code);
                    if seen.contains(&key) {
                        continue;
                    }
                    seen.push(key);
                    out.push(Detected {
                        ts: clock,
                        kind: *kind,
                        title: title.clone(),
                        exit_code: *exit_code,
                        paths: tags_for(*kind, title, workspace, &edited),
                    });
                }
                _ => {}
            }
        }
    }

    out
}

/// 路径标签：改文件的失败归到自己那个文件；命令失败归到同一会话里最近改过的文件。
fn tags_for(kind: ToolKind, title: &str, workspace: &Path, edited: &[String]) -> Vec<String> {
    match kind {
        ToolKind::Edit | ToolKind::Write => normalize_path(workspace, title).into_iter().collect(),
        ToolKind::Shell => {
            let start = edited.len().saturating_sub(3);
            edited[start..].to_vec()
        }
        _ => Vec::new(),
    }
}

/// 把工具标题里的路径归一成仓库相对路径（认不出就返回 `None`）。
pub(crate) fn normalize_path(workspace: &Path, raw: &str) -> Option<String> {
    let text = raw.trim().trim_matches(|c: char| matches!(c, '"' | '\'' | '`'));
    if text.is_empty() {
        return None;
    }
    let text = strip_line_suffix(text);
    let candidate = Path::new(text);
    let relative = if candidate.is_absolute() {
        candidate
            .strip_prefix(workspace)
            .ok()?
            .to_string_lossy()
            .into_owned()
    } else {
        text.trim_start_matches("./").to_string()
    };
    // 带空格的「路径」多半不是路径（可能是命令或说明文字），不拿它当标签
    if relative.is_empty()
        || relative.starts_with("..")
        || relative.contains(char::is_whitespace)
        || relative.contains("://")
    {
        return None;
    }
    Some(relative.replace('\\', "/"))
}

/// 去掉 `src/a.rs:12` / `src/a.rs:12-20` 这类行号后缀。
fn strip_line_suffix(text: &str) -> &str {
    let Some((head, tail)) = text.rsplit_once(':') else {
        return text;
    };
    if !head.is_empty()
        && !tail.is_empty()
        && tail.chars().all(|c| c.is_ascii_digit() || c == '-')
    {
        return head;
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(id: &str, kind: ToolKind, title: &str) -> SessionMessage {
        SessionMessage {
            role: "assistant".into(),
            ts: Some(1_000),
            blocks: vec![SessionBlock::ToolCall {
                id: id.into(),
                raw_name: "tool".into(),
                kind,
                title: title.into(),
                detail: None,
                server: None,
                input_preview: String::new(),
                input_total_len: 0,
                input_full: None,
                diff: None,
                by_user: false,
            }],
            ..Default::default()
        }
    }

    fn result(call_id: &str, status: ToolStatus, exit_code: Option<i32>) -> SessionMessage {
        SessionMessage {
            role: "tool".into(),
            ts: Some(2_000),
            blocks: vec![SessionBlock::ToolResult {
                call_id: call_id.into(),
                status,
                preview: String::new(),
                total_len: 0,
                line_count: 0,
                truncated: false,
                full: None,
                exit_code,
                duration_ms: None,
                images: Vec::new(),
                saved_path: None,
            }],
            ..Default::default()
        }
    }

    fn workspace() -> &'static Path {
        Path::new("/repo")
    }

    #[test]
    fn shell_failure_is_tagged_with_the_files_edited_in_the_same_session() {
        let messages = vec![
            call("1", ToolKind::Edit, "src/billing/invoice.rs"),
            call("2", ToolKind::Shell, "cargo test -- billing"),
            result("2", ToolStatus::Error, Some(1)),
        ];

        let failures = failures_in(workspace(), &messages);
        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0].kind, ToolKind::Shell);
        assert_eq!(failures[0].exit_code, Some(1));
        assert_eq!(failures[0].paths, vec!["src/billing/invoice.rs"]);
    }

    #[test]
    fn exit_code_wins_over_a_success_status_and_interrupts_are_ignored() {
        let messages = vec![
            call("1", ToolKind::Shell, "cargo clippy"),
            result("1", ToolStatus::Success, Some(101)),
            call("2", ToolKind::Shell, "cargo test"),
            result("2", ToolStatus::Success, Some(0)),
            call("3", ToolKind::Shell, "cargo build"),
            result("3", ToolStatus::Interrupted, None),
        ];

        let failures = failures_in(workspace(), &messages);
        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0].title, "cargo clippy");
        assert_eq!(failures[0].exit_code, Some(101));
    }

    #[test]
    fn paired_failures_of_the_same_shape_count_once_per_session() {
        let messages = vec![
            call("1", ToolKind::Shell, "cargo test"),
            result("1", ToolStatus::Error, Some(1)),
            call("2", ToolKind::Shell, "cargo test"),
            result("2", ToolStatus::Error, Some(1)),
        ];

        assert_eq!(failures_in(workspace(), &messages).len(), 1);
    }

    #[test]
    fn paths_are_relative_to_the_repo_and_unknown_shapes_are_dropped() {
        assert_eq!(
            normalize_path(workspace(), "/repo/src/app.rs:12-20"),
            Some("src/app.rs".to_string())
        );
        assert_eq!(
            normalize_path(workspace(), "./src/app.rs"),
            Some("src/app.rs".to_string())
        );
        assert_eq!(normalize_path(workspace(), "cargo test -- billing"), None);
        assert_eq!(normalize_path(workspace(), "/elsewhere/src/app.rs"), None);
        assert_eq!(normalize_path(workspace(), "../outside.rs"), None);
    }
}
