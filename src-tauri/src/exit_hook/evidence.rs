//! 证据收集：退出码之外的旁证，以及「续跑要回到哪条会话」。
//!
//! 三条来源互相独立：
//! - 代理侧：这条应用在退出前半小时内的失败请求（走 PHI 代理时一定有）；
//! - 会话侧：会话文件尾部的错误消息（直连模式也有，代理看不到请求）；
//! - 会话目录：该项目最近的一条会话，作为 resume 的目标。

use super::classify::{Evidence, ProxyFailure};
use super::journal::ExitRecord;
use super::{PROXY_WINDOW_SECS, SESSION_LOOKBACK_SECS, SESSION_TAIL_BYTES};
use crate::session_manager::SessionMeta;
use crate::Database;
use std::io::{Read, Seek, SeekFrom};

/// 续跑要回到的那条会话。
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct SessionTarget {
    pub session_id: String,
    /// 完整命令（形如 `claude --resume <id>`），保留程序名便于排错。
    pub resume_command: String,
    pub source_path: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct Collected {
    pub evidence: Evidence,
    pub target: Option<SessionTarget>,
    /// 窗口内成功过的请求数，写进交接单的「已验证」。
    pub successes: i64,
}

fn same_directory(left: &str, right: &str) -> bool {
    let normalize = |value: &str| value.trim_end_matches('/').to_string();
    normalize(left) == normalize(right)
}

/// 该项目最近的一条会话。只看同一应用、同一目录，时间上不超过回看窗口。
pub(crate) fn newest_session(
    sessions: &[SessionMeta],
    app_id: &str,
    cwd: &str,
    since: i64,
) -> Option<SessionMeta> {
    sessions
        .iter()
        .filter(|session| session.provider_id == app_id)
        .filter(|session| {
            session
                .project_dir
                .as_deref()
                .map(|dir| same_directory(dir, cwd))
                .unwrap_or(false)
        })
        .filter(|session| session.last_active_at.unwrap_or(0) >= since)
        .max_by_key(|session| session.last_active_at.unwrap_or(0))
        .cloned()
}

/// 会话文件尾部命中的错误标记。
///
/// 只扫额度与上下文两类：这两类决定了「换链路」还是「换会话」。
/// 供应商类故障不从这里判——会话文本里出现 `upstream` 之类的词太常见，
/// 拿它当证据会把正常会话判成故障。
pub(crate) fn session_markers(path: &str) -> Vec<String> {
    if path.starts_with("sqlite:") {
        return Vec::new();
    }
    let Ok(mut file) = std::fs::File::open(path) else {
        return Vec::new();
    };
    let len = file.metadata().map(|meta| meta.len()).unwrap_or(0);
    let start = len.saturating_sub(SESSION_TAIL_BYTES);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return Vec::new();
    }
    let mut bytes = Vec::new();
    if file
        .take(SESSION_TAIL_BYTES)
        .read_to_end(&mut bytes)
        .is_err()
    {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&bytes);
    super::classify::actionable_markers(&text)
}

pub(crate) fn collect(db: &Database, record: &ExitRecord) -> Collected {
    let from = record.at - PROXY_WINDOW_SECS;
    let to = record.at;
    let failures: Vec<ProxyFailure> = db
        .baton_proxy_failures(&record.app_id, from, to, super::PROXY_FAILURE_LIMIT)
        .unwrap_or_else(|error| {
            log::warn!("[baton] 读取代理失败记录失败，按无证据处理: {error}");
            Vec::new()
        });
    let successes = db
        .baton_proxy_successes(&record.app_id, from, to)
        .unwrap_or_else(|error| {
            log::warn!("[baton] 读取代理成功记录失败，按 0 处理: {error}");
            0
        });

    let sessions = crate::session_manager::scan_sessions();
    let target_meta = newest_session(
        &sessions,
        &record.app_id,
        &record.cwd,
        record.at - SESSION_LOOKBACK_SECS,
    );

    let markers = target_meta
        .as_ref()
        .and_then(|meta| meta.source_path.as_deref())
        .map(session_markers)
        .unwrap_or_default();

    Collected {
        evidence: Evidence {
            exit_code: record.exit_code,
            proxy: failures,
            session_markers: markers,
        },
        target: target_meta.and_then(|meta| {
            meta.resume_command.as_ref().map(|command| SessionTarget {
                session_id: meta.session_id.clone(),
                resume_command: command.clone(),
                source_path: meta.source_path.clone(),
            })
        }),
        successes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(id: &str, app: &str, dir: Option<&str>, active: Option<i64>) -> SessionMeta {
        SessionMeta {
            provider_id: app.into(),
            session_id: id.into(),
            title: None,
            summary: None,
            project_dir: dir.map(str::to_string),
            created_at: active,
            last_active_at: active,
            source_path: Some(format!("/tmp/{id}.jsonl")),
            resume_command: Some(format!("{app} --resume {id}")),
        }
    }

    #[test]
    fn picks_the_newest_session_of_that_app_in_that_directory() {
        let sessions = vec![
            meta("old", "claude", Some("/tmp/demo"), Some(1_000)),
            meta("new", "claude", Some("/tmp/demo"), Some(2_000)),
            meta("other-app", "codex", Some("/tmp/demo"), Some(3_000)),
            meta("other-dir", "claude", Some("/tmp/elsewhere"), Some(4_000)),
        ];
        let picked = newest_session(&sessions, "claude", "/tmp/demo/", 500).expect("target");
        assert_eq!(picked.session_id, "new");
    }

    #[test]
    fn sessions_outside_the_lookback_window_are_ignored() {
        let sessions = vec![meta("stale", "claude", Some("/tmp/demo"), Some(10))];
        assert!(newest_session(&sessions, "claude", "/tmp/demo", 1_000).is_none());
    }

    #[test]
    fn sessions_without_a_directory_never_match() {
        let sessions = vec![meta("anonymous", "claude", None, Some(5_000))];
        assert!(newest_session(&sessions, "claude", "/tmp/demo", 0).is_none());
    }

    #[test]
    fn tail_scan_reads_the_end_of_the_file_only() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.jsonl");
        let mut text = String::from("{\"type\":\"user\",\"text\":\"hello\"}\n");
        text.push_str("{\"type\":\"assistant\",\"error\":\"You've hit your usage limit\"}\n");
        std::fs::write(&path, text).unwrap();
        let markers = session_markers(path.to_str().unwrap());
        assert!(markers.iter().any(|marker| marker.contains("usage limit")));
    }

    #[test]
    fn unreadable_or_sqlite_sources_yield_no_markers() {
        assert!(session_markers("sqlite:/tmp/db.sqlite").is_empty());
        assert!(session_markers("/nonexistent/session.jsonl").is_empty());
    }
}
