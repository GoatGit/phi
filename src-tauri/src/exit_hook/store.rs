//! 接棒记录的持久化，以及它需要的那几个只读查询（代理侧失败/成功）。
//!
//! 记录是本机事实，跟着这台机器上的会话走，不进 git。

use crate::database::lock_conn;
use crate::error::AppError;
use crate::exit_hook::classify::{FailureKind, ProxyFailure};
use crate::exit_hook::plan::History;
use crate::exit_hook::Attempt;
use crate::Database;
use rusqlite::{params, OptionalExtension};

fn error(e: impl std::fmt::Display) -> AppError {
    AppError::Database(format!("Baton: {e}"))
}

pub(crate) fn create_tables(conn: &rusqlite::Connection) -> Result<(), AppError> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS baton_attempts (
            id TEXT PRIMARY KEY,
            terminal_id TEXT NOT NULL,
            app_id TEXT NOT NULL,
            cwd TEXT NOT NULL,
            exit_code INTEGER NOT NULL,
            failure_kind TEXT NOT NULL,
            reason TEXT NOT NULL,
            resume_mode TEXT,
            resume_command TEXT,
            resume_terminal_id TEXT,
            handoff_path TEXT,
            decided_by TEXT,
            created_at INTEGER NOT NULL,
            UNIQUE (terminal_id, created_at)
        );
        CREATE INDEX IF NOT EXISTS idx_baton_attempts_terminal
            ON baton_attempts(terminal_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_baton_attempts_created
            ON baton_attempts(created_at DESC);",
    )
    .map_err(error)
}

/// 落库前的完整记录。`resume_command` 只用于「用户手动点接棒」时重放。
#[derive(Clone, Debug)]
pub(crate) struct RecordInput {
    pub terminal_id: String,
    pub app_id: String,
    pub cwd: String,
    pub exit_code: i32,
    pub kind: FailureKind,
    pub reason: String,
    /// 计划采用的恢复方式；`None` 表示只记录不重启。
    pub resume_mode: Option<&'static str>,
    pub resume_command: Option<String>,
    pub handoff_path: Option<String>,
    /// 采纳了哪个插件的决策（`None` 表示内置策略）。
    pub decided_by: Option<String>,
    pub created_at: i64,
}

/// 手动接棒时需要的那几条事实。
#[derive(Clone, Debug)]
pub(crate) struct AttemptPlan {
    pub app_id: String,
    pub cwd: String,
    pub mode: Option<String>,
    pub resume_command: Option<String>,
    pub handoff_path: Option<String>,
    pub reason: String,
}

const COLUMNS: &str = "id, terminal_id, app_id, cwd, exit_code, failure_kind, reason, \
                       resume_terminal_id, handoff_path, decided_by, created_at";

fn row_to_attempt(row: &rusqlite::Row<'_>) -> rusqlite::Result<Attempt> {
    let resume_terminal_id: Option<String> = row.get(7)?;
    Ok(Attempt {
        id: row.get(0)?,
        terminal_id: row.get(1)?,
        app_id: row.get(2)?,
        cwd: row.get(3)?,
        exit_code: row.get(4)?,
        failure_kind: row.get(5)?,
        reason: row.get(6)?,
        resumed: resume_terminal_id.is_some(),
        resume_terminal_id,
        handoff_path: row.get(8)?,
        decided_by: row.get(9)?,
        created_at: row.get(10)?,
    })
}

impl Database {
    /// 写入一条接棒记录。同一终端会话、同一秒的重复行直接忽略：
    /// journal 监听可能因为重启从头读一遍，不能因此重放两次接棒。
    pub(crate) fn baton_record(&self, input: &RecordInput) -> Result<String, AppError> {
        let id = uuid::Uuid::new_v4().to_string();
        let conn = lock_conn!(self.conn);
        conn.execute(
            "INSERT OR IGNORE INTO baton_attempts (
                id, terminal_id, app_id, cwd, exit_code, failure_kind, reason,
                resume_mode, resume_command, handoff_path, decided_by, created_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                id,
                input.terminal_id,
                input.app_id,
                input.cwd,
                input.exit_code,
                input.kind.as_str(),
                input.reason,
                input.resume_mode,
                input.resume_command,
                input.handoff_path,
                input.decided_by,
                input.created_at,
            ],
        )
        .map_err(error)?;
        // 被 UNIQUE 挡下时返回库里已有的那条，调用方据此判断是不是新事件。
        conn.query_row(
            "SELECT id FROM baton_attempts WHERE terminal_id = ?1 AND created_at = ?2",
            params![input.terminal_id, input.created_at],
            |row| row.get::<_, String>(0),
        )
        .map_err(error)
    }

    pub(crate) fn baton_mark_resumed(
        &self,
        id: &str,
        mode: &str,
        resume_terminal_id: &str,
    ) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        conn.execute(
            "UPDATE baton_attempts SET resume_mode = ?2, resume_terminal_id = ?3 WHERE id = ?1",
            params![id, mode, resume_terminal_id],
        )
        .map_err(error)?;
        Ok(())
    }

    pub(crate) fn baton_attempts(&self, limit: usize) -> Result<Vec<Attempt>, AppError> {
        let conn = lock_conn!(self.conn);
        let mut statement = conn
            .prepare(&format!(
                "SELECT {COLUMNS} FROM baton_attempts ORDER BY created_at DESC LIMIT ?1"
            ))
            .map_err(error)?;
        let rows = statement
            .query_map(params![limit as i64], row_to_attempt)
            .map_err(error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(error)
    }

    pub(crate) fn baton_attempt(&self, id: &str) -> Result<Option<Attempt>, AppError> {
        let conn = lock_conn!(self.conn);
        conn.query_row(
            &format!("SELECT {COLUMNS} FROM baton_attempts WHERE id = ?1"),
            params![id],
            row_to_attempt,
        )
        .optional()
        .map_err(error)
    }

    /// journal 监听重读时用：这条退出记账是否已经处理过。
    pub(crate) fn baton_attempt_exists(
        &self,
        terminal_id: &str,
        created_at: i64,
    ) -> Result<bool, AppError> {
        let conn = lock_conn!(self.conn);
        let found: bool = conn
            .query_row(
                "SELECT 1 FROM baton_attempts WHERE terminal_id = ?1 AND created_at = ?2",
                params![terminal_id, created_at],
                |_| Ok(true),
            )
            .optional()
            .map_err(error)?
            .unwrap_or(false);
        Ok(found)
    }

    /// 手动接棒要用的那几条事实。
    pub(crate) fn baton_attempt_plan(&self, id: &str) -> Result<Option<AttemptPlan>, AppError> {
        let conn = lock_conn!(self.conn);
        conn.query_row(
            "SELECT app_id, cwd, resume_mode, resume_command, handoff_path, reason \
             FROM baton_attempts WHERE id = ?1",
            params![id],
            |row| {
                Ok(AttemptPlan {
                    app_id: row.get(0)?,
                    cwd: row.get(1)?,
                    mode: row.get(2)?,
                    resume_command: row.get(3)?,
                    handoff_path: row.get(4)?,
                    reason: row.get(5)?,
                })
            },
        )
        .optional()
        .map_err(error)
    }

    /// 这个终端会话此前接过几次、最后一次因为什么。
    pub(crate) fn baton_history(&self, terminal_id: &str) -> Result<History, AppError> {
        let conn = lock_conn!(self.conn);
        let attempts: u32 = conn
            .query_row(
                "SELECT COUNT(*) FROM baton_attempts WHERE terminal_id = ?1",
                params![terminal_id],
                |row| row.get::<_, i64>(0),
            )
            .map_err(error)?
            .clamp(0, u32::MAX as i64) as u32;
        let last_kind: Option<String> = conn
            .query_row(
                "SELECT failure_kind FROM baton_attempts WHERE terminal_id = ?1 \
                 ORDER BY created_at DESC LIMIT 1",
                params![terminal_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(error)?;
        Ok(History {
            attempts,
            last_kind: last_kind.as_deref().and_then(FailureKind::from_str),
        })
    }

    /// 代理侧在窗口内的失败请求。`created_at` 是秒级时间戳（与代理日志一致）。
    pub(crate) fn baton_proxy_failures(
        &self,
        app_type: &str,
        from: i64,
        to: i64,
        limit: usize,
    ) -> Result<Vec<ProxyFailure>, AppError> {
        let conn = lock_conn!(self.conn);
        let mut statement = conn
            .prepare(
                "SELECT status_code, COALESCE(error_message, '') FROM proxy_request_logs \
                 WHERE app_type = ?1 AND status_code >= 400 AND created_at BETWEEN ?2 AND ?3 \
                 ORDER BY created_at DESC LIMIT ?4",
            )
            .map_err(error)?;
        let rows = statement
            .query_map(params![app_type, from, to, limit as i64], |row| {
                Ok(ProxyFailure {
                    status_code: row.get::<_, i64>(0)?.clamp(0, u16::MAX as i64) as u16,
                    message: row.get(1)?,
                })
            })
            .map_err(error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(error)
    }

    /// 窗口内成功过的请求数。交接单里写「已验证」用它，不替用户编结论。
    pub(crate) fn baton_proxy_successes(
        &self,
        app_type: &str,
        from: i64,
        to: i64,
    ) -> Result<i64, AppError> {
        let conn = lock_conn!(self.conn);
        conn.query_row(
            "SELECT COUNT(*) FROM proxy_request_logs \
             WHERE app_type = ?1 AND status_code < 400 AND created_at BETWEEN ?2 AND ?3",
            params![app_type, from, to],
            |row| row.get::<_, i64>(0),
        )
        .map_err(error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(terminal_id: &str, created_at: i64, kind: FailureKind) -> RecordInput {
        RecordInput {
            terminal_id: terminal_id.into(),
            app_id: "claude".into(),
            cwd: "/tmp/demo".into(),
            exit_code: 1,
            kind,
            reason: "test".into(),
            resume_mode: Some("same-session"),
            resume_command: Some("claude --resume abc".into()),
            handoff_path: None,
            decided_by: Some("session-baton".into()),
            created_at,
        }
    }

    #[test]
    fn duplicate_lines_do_not_replay_the_baton() {
        let db = Database::memory().unwrap();
        let first = db
            .baton_record(&record("t1", 1_762_900_000_000, FailureKind::Quota))
            .unwrap();
        let again = db
            .baton_record(&record("t1", 1_762_900_000_000, FailureKind::Quota))
            .unwrap();
        assert_eq!(first, again);
        assert_eq!(db.baton_attempts(10).unwrap().len(), 1);
    }

    #[test]
    fn history_counts_attempts_and_remembers_the_last_reason() {
        let db = Database::memory().unwrap();
        db.baton_record(&record("t1", 1_000, FailureKind::Crash))
            .unwrap();
        db.baton_record(&record("t1", 2_000, FailureKind::Quota))
            .unwrap();
        db.baton_record(&record("t2", 3_000, FailureKind::Provider))
            .unwrap();

        let history = db.baton_history("t1").unwrap();
        assert_eq!(history.attempts, 2);
        assert_eq!(history.last_kind, Some(FailureKind::Quota));
        assert_eq!(db.baton_history("missing").unwrap().attempts, 0);
    }

    #[test]
    fn marking_a_resume_flips_the_flag_and_keeps_the_handoff_path() {
        let db = Database::memory().unwrap();
        let mut input = record("t1", 1_000, FailureKind::Quota);
        input.handoff_path = Some("/tmp/handoff.md".into());
        let id = db.baton_record(&input).unwrap();
        assert!(!db.baton_attempt(&id).unwrap().unwrap().resumed);

        db.baton_mark_resumed(&id, "same-session", "terminal-2")
            .unwrap();
        let attempt = db.baton_attempt(&id).unwrap().unwrap();
        assert!(attempt.resumed);
        assert_eq!(attempt.resume_terminal_id.as_deref(), Some("terminal-2"));
        assert_eq!(attempt.handoff_path.as_deref(), Some("/tmp/handoff.md"));
        assert!(db.baton_attempt("nope").unwrap().is_none());
    }

    #[test]
    fn exists_answers_the_journal_dedup_question() {
        let db = Database::memory().unwrap();
        db.baton_record(&record("t1", 1_000, FailureKind::Crash))
            .unwrap();
        assert!(db.baton_attempt_exists("t1", 1_000).unwrap());
        assert!(!db.baton_attempt_exists("t1", 1_001).unwrap());
        assert!(!db.baton_attempt_exists("t2", 1_000).unwrap());
    }

    #[test]
    fn plan_exposes_what_a_manual_resume_needs() {
        let db = Database::memory().unwrap();
        let mut input = record("t1", 1_000, FailureKind::Quota);
        input.handoff_path = Some("/tmp/handoff.md".into());
        let id = db.baton_record(&input).unwrap();
        let plan = db.baton_attempt_plan(&id).unwrap().expect("plan");
        assert_eq!(plan.app_id, "claude");
        assert_eq!(plan.cwd, "/tmp/demo");
        assert_eq!(plan.mode.as_deref(), Some("same-session"));
        assert_eq!(plan.resume_command.as_deref(), Some("claude --resume abc"));
        assert_eq!(plan.handoff_path.as_deref(), Some("/tmp/handoff.md"));
        assert!(db.baton_attempt_plan("nope").unwrap().is_none());
    }

    #[test]
    fn decided_by_is_kept_for_attribution() {
        let db = Database::memory().unwrap();
        let id = db
            .baton_record(&record("t1", 1_000, FailureKind::Quota))
            .unwrap();
        assert_eq!(
            db.baton_attempt(&id)
                .unwrap()
                .unwrap()
                .decided_by
                .as_deref(),
            Some("session-baton")
        );
    }

    #[test]
    fn proxy_queries_only_look_inside_the_window() -> Result<(), Box<dyn std::error::Error>> {
        let db = Database::memory().unwrap();
        {
            let conn = lock_conn!(db.conn);
            for (id, status, at) in [("a", 429, 1_000), ("b", 200, 1_500), ("c", 503, 9_000)] {
                conn.execute(
                    "INSERT INTO proxy_request_logs (
                        request_id, provider_id, app_type, model, latency_ms, status_code,
                        error_message, created_at
                    ) VALUES (?1, 'p1', 'claude', 'm', 10, ?2, ?3, ?4)",
                    params![
                        id,
                        status,
                        if status >= 400 {
                            Some("rate limited")
                        } else {
                            None
                        },
                        at
                    ],
                )
                .unwrap();
            }
        }
        let failures = db.baton_proxy_failures("claude", 900, 2_000, 10).unwrap();
        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0].status_code, 429);
        assert_eq!(failures[0].message, "rate limited");
        assert_eq!(db.baton_proxy_successes("claude", 900, 2_000).unwrap(), 1);
        assert!(db
            .baton_proxy_failures("codex", 900, 2_000, 10)
            .unwrap()
            .is_empty());
        Ok(())
    }
}
