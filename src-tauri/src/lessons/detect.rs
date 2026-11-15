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

/// 会话所属的仓库根：从会话 cwd 向上找最近的 `.git`，找不到就用 cwd 本身。
///
/// 教训贴仓库长，而会话常常是在仓库的子目录里开的（`cargo test` 在 `src-tauri/`），
/// 所以归组要先把 cwd 抬到仓库根，否则同一个仓库会散成好几份清单。
/// 目录已经不在了（worktree 被清掉、临时目录被删）的会话直接跳过：给一份已经
/// 不存在的目录攒禁区清单，既扫不到文件也没处写 `AGENTS.md`。
pub(crate) fn project_of(meta: &SessionMeta) -> Option<std::path::PathBuf> {
    let dir = meta.project_dir.as_deref()?;
    let resolved = Path::new(dir).canonicalize().ok()?;
    if let Some(root) = git_root(&resolved) {
        return Some(root);
    }
    Some(resolved)
}

fn git_root(dir: &Path) -> Option<std::path::PathBuf> {
    let mut cursor = Some(dir);
    while let Some(path) = cursor {
        if path.join(".git").exists() {
            return Some(path.to_path_buf());
        }
        cursor = path.parent();
    }
    None
}

/// 把本机会话按所属仓库去重，得到「本机涉及到的所有仓库」。
pub(crate) fn projects(sessions: &[SessionMeta]) -> Vec<std::path::PathBuf> {
    let mut out: Vec<std::path::PathBuf> = Vec::new();
    for meta in sessions {
        let Some(root) = project_of(meta) else {
            continue;
        };
        if !out.contains(&root) {
            out.push(root);
        }
    }
    out
}

/// 扫描本机会话里属于 `workspace` 这个仓库的失败。
///
/// 会话按「最近的 `.git`」归属，所以同一个仓库的子目录会话不会被算到别的仓库上，
/// 嵌套仓库里的会话也不会在两个仓库各算一次。
pub(crate) fn collect(
    workspace: &Path,
    sessions: &[SessionMeta],
    since: i64,
    limit: usize,
) -> Collected {
    let mut candidates: Vec<&SessionMeta> = sessions
        .iter()
        .filter(|meta| last_active(meta) > since && project_of(meta).as_deref() == Some(workspace))
        .collect();
    candidates.sort_by_key(|meta| last_active(meta));

    let pending_sessions = candidates.len().saturating_sub(limit);
    let mut events = Vec::new();
    let mut scanned_sessions = 0;
    let mut scanned_through = since;

    for meta in candidates.into_iter().take(limit) {
        // 水位按「看过的会话」推进，而不是「读成功了的会话」：没有会话文件、或文件已
        // 经读不出来的会话如果不动水位，下次刷新会又一次把它们排在最前面，把单次
        // 上限吃完，新会话就永远轮不到。
        scanned_through = scanned_through.max(last_active(meta));
        let Some(source_path) = meta.source_path.as_deref() else {
            continue;
        };
        let Ok(loaded) = crate::session_manager::load_transcript(&meta.provider_id, source_path)
        else {
            // 会话文件可能刚被删掉：跳过而不是让整次刷新失败
            continue;
        };
        scanned_sessions += 1;
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

/// 一段消息里的失败事件。同一个会话里重复出现的同一种失败只算一次。
pub(crate) fn failures_in(workspace: &Path, messages: &[SessionMessage]) -> Vec<Detected> {
    let mut calls: HashMap<String, (ToolKind, String, bool)> = HashMap::new();
    let mut edited: Vec<String> = Vec::new();
    let mut out: Vec<Detected> = Vec::new();
    let mut seen: Vec<(ToolKind, String)> = Vec::new();
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
                    // 去重口径与教训 id 一致：同一个会话里同一条命令只算一次，退出码
                    // 变了也还是同一条（换个退出码不该让一次失败变两条）。
                    let key = (*kind, title.clone());
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
    let text = raw
        .trim()
        .trim_matches(|c: char| matches!(c, '"' | '\'' | '`'));
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
    if !head.is_empty() && !tail.is_empty() && tail.chars().all(|c| c.is_ascii_digit() || c == '-')
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

    fn meta(id: &str, last_active: i64, source: Option<&str>) -> SessionMeta {
        SessionMeta {
            provider_id: "codex".into(),
            session_id: id.into(),
            title: None,
            summary: None,
            project_dir: Some("/repo".into()),
            created_at: Some(last_active),
            last_active_at: Some(last_active),
            source_path: source.map(|path| path.to_string()),
            resume_command: None,
        }
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
    fn the_same_command_counts_once_even_when_the_exit_code_changes() {
        // 教训 id 只由「路径 + 命令」决定，会话内去重就该同一个口径
        let messages = vec![
            call("1", ToolKind::Shell, "cargo test"),
            result("1", ToolStatus::Error, Some(1)),
            call("2", ToolKind::Shell, "cargo test"),
            result("2", ToolStatus::Error, Some(101)),
        ];

        assert_eq!(failures_in(workspace(), &messages).len(), 1);
    }

    #[test]
    fn sessions_that_cannot_be_read_still_advance_the_watermark() {
        // 没有会话文件、或文件读不出来的会话如果不动水位，刷新会永远卡在同一批最老的
        // 会话上，后面的会话一辈子轮不到。
        let dir = tempfile::tempdir().expect("tempdir");
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(&repo).expect("mkdir");
        let repo = repo.canonicalize().expect("repo path");

        let mut empty = meta("s1", 100, None);
        empty.project_dir = Some(repo.to_string_lossy().into_owned());
        let mut broken = meta("s2", 200, Some("/nonexistent/phi-lessons-test.jsonl"));
        broken.project_dir = Some(repo.to_string_lossy().into_owned());

        let collected = collect(&repo, &[empty, broken], 0, 10);

        assert_eq!(collected.scanned_through, 200);
        assert_eq!(collected.pending_sessions, 0);
        // 读不出来就不算「扫过」，这一点保持不变
        assert_eq!(collected.scanned_sessions, 0);
        assert!(collected.events.is_empty());
    }

    #[test]
    fn sessions_are_grouped_by_the_nearest_git_root() {
        let dir = tempfile::tempdir().expect("tempdir");
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(repo.join("src/deep")).expect("mkdir");
        std::fs::create_dir(repo.join(".git")).expect("git dir");
        std::fs::create_dir_all(dir.path().join("scratch")).expect("mkdir");

        let mut inside = meta("s1", 100, None);
        inside.project_dir = Some(repo.join("src/deep").to_string_lossy().into_owned());
        let mut loose = meta("s2", 200, None);
        loose.project_dir = Some(dir.path().join("scratch").to_string_lossy().into_owned());

        let found = projects(&[inside.clone(), loose.clone()]);
        assert_eq!(found.len(), 2, "两个目录各算一个仓库");
        assert!(found.contains(&repo.canonicalize().expect("repo path")));

        // 子目录里的会话归到仓库根，不会在「仓库」和「子目录」各算一次
        let collected = collect(
            &repo.canonicalize().expect("repo path"),
            &[inside, loose],
            0,
            10,
        );
        assert_eq!(collected.scanned_through, 100);
    }

    #[test]
    fn sessions_in_vanished_directories_are_skipped() {
        // worktree 被清掉、临时目录被删：给一份已经不存在的目录攒清单没意义
        let mut ghost = meta("s1", 100, Some("/nonexistent/session.jsonl"));
        ghost.project_dir = Some("/nonexistent/phi-lessons-worktree".into());

        assert!(projects(&[ghost]).is_empty());
    }

    #[test]
    fn a_nested_repo_takes_its_own_sessions() {
        let dir = tempfile::tempdir().expect("tempdir");
        let outer = dir.path().join("outer");
        let inner = outer.join("inner");
        std::fs::create_dir_all(&inner).expect("mkdir");
        std::fs::create_dir(outer.join(".git")).expect("outer git");
        std::fs::create_dir(inner.join(".git")).expect("inner git");

        let mut session = meta("s1", 100, None);
        session.project_dir = Some(inner.to_string_lossy().into_owned());

        let found = projects(&[session]);
        assert_eq!(found, vec![inner.canonicalize().expect("inner path")]);
    }

    #[test]
    fn paths_are_relative_to_the_repo_and_unknown_shapes_are_dropped() {
        // 仓库根用真实的绝对路径：Windows 上 `/repo/src/app.rs` 既没有盘符也不是
        // 绝对路径，`strip_prefix` 根本走不到，那种写法只有 Unix 成立。
        let repo = std::env::temp_dir();
        let inside = repo.join("src/app.rs");
        let inside_with_lines = format!("{}:12-20", inside.to_string_lossy());
        let outside = repo
            .parent()
            .map(|parent| parent.join("elsewhere/src/app.rs"))
            .unwrap_or_else(|| repo.join("..").join("elsewhere/src/app.rs"));

        assert_eq!(
            normalize_path(&repo, &inside_with_lines),
            Some("src/app.rs".to_string())
        );
        assert_eq!(
            normalize_path(&repo, &inside.to_string_lossy()),
            Some("src/app.rs".to_string())
        );
        assert_eq!(
            normalize_path(&repo, "./src/app.rs"),
            Some("src/app.rs".to_string())
        );
        assert_eq!(normalize_path(&repo, "cargo test -- billing"), None);
        assert_eq!(normalize_path(&repo, &outside.to_string_lossy()), None);
        assert_eq!(normalize_path(&repo, "../outside.rs"), None);
    }
}
