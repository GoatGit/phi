//! 教训库的 sqlite 存储。
//!
//! 教训属于本机事实（这台机器上哪次会话炸的），所以不进 git；会进 git 的只有
//! 注入到仓库 `AGENTS.md` 的那一小块。命中次数单独记在 occurrence 表里，同一会话
//! 反复重扫不会把同一次失败数成两次。

use crate::database::lock_conn;
use crate::error::AppError;
use crate::lessons::model::Lesson;
use crate::Database;
use rusqlite::{params, OptionalExtension};

fn error(e: impl std::fmt::Display) -> AppError {
    AppError::Database(format!("Lessons: {e}"))
}

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

pub(crate) fn create_tables(conn: &rusqlite::Connection) -> Result<(), AppError> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS lessons (
            root TEXT NOT NULL,
            id TEXT NOT NULL,
            paths TEXT NOT NULL,
            trigger_text TEXT NOT NULL,
            evidence TEXT NOT NULL,
            next_step TEXT NOT NULL,
            hits INTEGER NOT NULL DEFAULT 0,
            first_seen INTEGER NOT NULL,
            last_seen INTEGER NOT NULL,
            apps TEXT NOT NULL,
            dismissed INTEGER NOT NULL DEFAULT 0,
            dismiss_reason TEXT,
            PRIMARY KEY (root, id)
        );
        CREATE INDEX IF NOT EXISTS idx_lessons_root_seen
            ON lessons(root, first_seen);
        CREATE TABLE IF NOT EXISTS lesson_occurrences (
            root TEXT NOT NULL,
            lesson_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            seen_at INTEGER NOT NULL,
            PRIMARY KEY (root, lesson_id, session_id)
        );
        CREATE TABLE IF NOT EXISTS lesson_settings (
            root TEXT PRIMARY KEY,
            inject INTEGER NOT NULL DEFAULT 0,
            version INTEGER NOT NULL DEFAULT 0,
            scanned_through INTEGER NOT NULL DEFAULT 0,
            last_scan_at INTEGER,
            scanned_sessions INTEGER NOT NULL DEFAULT 0,
            pending_sessions INTEGER NOT NULL DEFAULT 0,
            failures INTEGER NOT NULL DEFAULT 0
        );",
    )
    .map_err(error)
}

/// 一个工作区的注入开关、扫描水位与上次扫描的规模。
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct Settings {
    pub inject: bool,
    pub version: i64,
    pub scanned_through: i64,
    pub last_scan_at: Option<i64>,
    pub scanned_sessions: usize,
    pub pending_sessions: usize,
    pub failures: usize,
}

fn read_paths(raw: &str) -> Vec<String> {
    serde_json::from_str(raw).unwrap_or_default()
}

fn write_list(list: &[String]) -> String {
    serde_json::to_string(list).unwrap_or_else(|_| "[]".to_string())
}

fn row_to_lesson(row: &rusqlite::Row<'_>) -> rusqlite::Result<Lesson> {
    let dismissed: i64 = row.get(9)?;
    Ok(Lesson {
        id: row.get(0)?,
        paths: read_paths(&row.get::<_, String>(1)?),
        trigger: row.get(2)?,
        evidence: row.get(3)?,
        next_step: row.get(4)?,
        hits: row.get(5)?,
        first_seen: row.get(6)?,
        last_seen: row.get(7)?,
        apps: read_paths(&row.get::<_, String>(8)?),
        dismissed: dismissed != 0,
        dismiss_reason: row.get(10)?,
    })
}

impl Database {
    /// 一个工作区的全部教训，按首次出现排序（追加式：老的不因命中次数变化而挪位）。
    pub fn lessons(&self, root: &str) -> Result<Vec<Lesson>, AppError> {
        let conn = lock_conn!(self.conn);
        let mut statement = conn
            .prepare(
                "SELECT id, paths, trigger_text, evidence, next_step, hits, first_seen,
                        last_seen, apps, dismissed, dismiss_reason
                 FROM lessons WHERE root = ?1 ORDER BY first_seen, id",
            )
            .map_err(error)?;
        let rows = statement
            .query_map(params![root], row_to_lesson)
            .map_err(error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(error)
    }

    pub fn lesson(&self, root: &str, id: &str) -> Result<Option<Lesson>, AppError> {
        let conn = lock_conn!(self.conn);
        conn.query_row(
            "SELECT id, paths, trigger_text, evidence, next_step, hits, first_seen,
                    last_seen, apps, dismissed, dismiss_reason
             FROM lessons WHERE root = ?1 AND id = ?2",
            params![root, id],
            row_to_lesson,
        )
        .optional()
        .map_err(error)
    }

    pub fn insert_lesson(&self, root: &str, lesson: &Lesson) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        conn.execute(
            "INSERT INTO lessons (
                root, id, paths, trigger_text, evidence, next_step, hits,
                first_seen, last_seen, apps, dismissed, dismiss_reason)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
             ON CONFLICT(root, id) DO NOTHING",
            params![
                root,
                lesson.id,
                write_list(&lesson.paths),
                lesson.trigger,
                lesson.evidence,
                lesson.next_step,
                lesson.hits,
                lesson.first_seen,
                lesson.last_seen,
                write_list(&lesson.apps),
                i64::from(lesson.dismissed),
                lesson.dismiss_reason,
            ],
        )
        .map_err(error)?;
        Ok(())
    }

    /// 命中次数、最近出现时间、出现过的应用：只累加不改写现象与证据。
    pub fn touch_lesson(
        &self,
        root: &str,
        id: &str,
        hits: i64,
        last_seen: i64,
        apps: &[String],
    ) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        conn.execute(
            "UPDATE lessons
             SET hits = ?3, last_seen = ?4, apps = ?5
             WHERE root = ?1 AND id = ?2",
            params![root, id, hits, last_seen, write_list(apps)],
        )
        .map_err(error)?;
        Ok(())
    }

    /// 记一次「这个会话里出现过这条教训」，返回累计命中次数。
    pub fn add_lesson_occurrence(
        &self,
        root: &str,
        id: &str,
        session_id: &str,
        seen_at: i64,
    ) -> Result<i64, AppError> {
        let conn = lock_conn!(self.conn);
        conn.execute(
            "INSERT INTO lesson_occurrences (root, lesson_id, session_id, seen_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(root, lesson_id, session_id) DO NOTHING",
            params![root, id, session_id, seen_at],
        )
        .map_err(error)?;
        conn.query_row(
            "SELECT COUNT(*) FROM lesson_occurrences WHERE root = ?1 AND lesson_id = ?2",
            params![root, id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(error)
    }

    /// 删掉一条教训（带理由）：留在库里但不再注入。
    pub fn dismiss_lesson(&self, root: &str, id: &str, reason: &str) -> Result<bool, AppError> {
        let conn = lock_conn!(self.conn);
        let changed = conn
            .execute(
                "UPDATE lessons SET dismissed = 1, dismiss_reason = ?3
                 WHERE root = ?1 AND id = ?2",
                params![root, id, reason],
            )
            .map_err(error)?;
        Ok(changed > 0)
    }

    pub fn restore_lesson(&self, root: &str, id: &str) -> Result<bool, AppError> {
        let conn = lock_conn!(self.conn);
        let changed = conn
            .execute(
                "UPDATE lessons SET dismissed = 0, dismiss_reason = NULL
                 WHERE root = ?1 AND id = ?2",
                params![root, id],
            )
            .map_err(error)?;
        Ok(changed > 0)
    }

    pub(crate) fn lesson_settings(&self, root: &str) -> Result<Settings, AppError> {
        let conn = lock_conn!(self.conn);
        let row = conn
            .query_row(
                "SELECT inject, version, scanned_through, last_scan_at,
                        scanned_sessions, pending_sessions, failures
                 FROM lesson_settings WHERE root = ?1",
                params![root],
                |row| {
                    Ok(Settings {
                        inject: row.get::<_, i64>(0)? != 0,
                        version: row.get(1)?,
                        scanned_through: row.get(2)?,
                        last_scan_at: row.get(3)?,
                        scanned_sessions: row.get::<_, i64>(4)? as usize,
                        pending_sessions: row.get::<_, i64>(5)? as usize,
                        failures: row.get::<_, i64>(6)? as usize,
                    })
                },
            )
            .optional()
            .map_err(error)?;
        Ok(row.unwrap_or_default())
    }

    pub(crate) fn save_lesson_settings(
        &self,
        root: &str,
        settings: Settings,
    ) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        conn.execute(
            "INSERT INTO lesson_settings (
                root, inject, version, scanned_through, last_scan_at,
                scanned_sessions, pending_sessions, failures)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(root) DO UPDATE SET
                inject = excluded.inject,
                version = excluded.version,
                scanned_through = excluded.scanned_through,
                last_scan_at = excluded.last_scan_at,
                scanned_sessions = excluded.scanned_sessions,
                pending_sessions = excluded.pending_sessions,
                failures = excluded.failures",
            params![
                root,
                i64::from(settings.inject),
                settings.version,
                settings.scanned_through,
                settings.last_scan_at,
                settings.scanned_sessions as i64,
                settings.pending_sessions as i64,
                settings.failures as i64,
            ],
        )
        .map_err(error)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lesson(id: &str, paths: &[&str]) -> Lesson {
        Lesson {
            id: id.into(),
            paths: paths.iter().map(|p| (*p).to_string()).collect(),
            trigger: format!("`cargo test` 退出码 1（{id}）"),
            evidence: "codex 会话 abcdef12（2026-11-12）".into(),
            next_step: "下次：先跑 `cargo test` 确认基线".into(),
            hits: 0,
            first_seen: 1_700_000_000_000,
            last_seen: 1_700_000_000_000,
            apps: vec!["codex".into()],
            dismissed: false,
            dismiss_reason: None,
        }
    }

    #[test]
    fn keeps_lessons_in_first_seen_order_and_counts_sessions_once() {
        let db = Database::memory().expect("memory db");
        db.insert_lesson("/repo", &lesson("a", &["src/a.rs"]))
            .expect("insert a");
        db.insert_lesson("/repo", &lesson("b", &["src/b.rs"]))
            .expect("insert b");

        assert_eq!(db.add_lesson_occurrence("/repo", "a", "s1", 10).unwrap(), 1);
        // 同一个会话重扫不应把同一次失败数成两次
        assert_eq!(db.add_lesson_occurrence("/repo", "a", "s1", 11).unwrap(), 1);
        assert_eq!(db.add_lesson_occurrence("/repo", "a", "s2", 12).unwrap(), 2);
        db.touch_lesson("/repo", "a", 2, 12, &["codex".into(), "claude".into()])
            .expect("touch");

        let list = db.lessons("/repo").expect("list");
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].id, "a");
        assert_eq!(list[0].hits, 2);
        assert_eq!(list[0].apps, vec!["codex", "claude"]);
        assert_eq!(list[1].id, "b");
    }

    #[test]
    fn dismissed_lessons_stay_visible_and_keep_the_reason() {
        let db = Database::memory().expect("memory db");
        db.insert_lesson("/repo", &lesson("a", &[]))
            .expect("insert");

        assert!(db.dismiss_lesson("/repo", "a", "误报").expect("dismiss"));
        let stored = db.lesson("/repo", "a").expect("get").expect("exists");
        assert!(stored.dismissed);
        assert_eq!(stored.dismiss_reason.as_deref(), Some("误报"));

        assert!(db.restore_lesson("/repo", "a").expect("restore"));
        let stored = db.lesson("/repo", "a").expect("get").expect("exists");
        assert!(!stored.dismissed);
        assert!(stored.dismiss_reason.is_none());
    }

    #[test]
    fn settings_default_to_off_and_roundtrip() {
        let db = Database::memory().expect("memory db");
        let defaults = db.lesson_settings("/repo").expect("defaults");
        assert!(!defaults.inject);
        assert_eq!(defaults.version, 0);
        assert_eq!(defaults.scanned_through, 0);

        db.save_lesson_settings(
            "/repo",
            Settings {
                inject: true,
                version: 3,
                scanned_through: 99,
                last_scan_at: Some(100),
                scanned_sessions: 7,
                pending_sessions: 2,
                failures: 5,
            },
        )
        .expect("save");

        let saved = db.lesson_settings("/repo").expect("settings");
        assert!(saved.inject);
        assert_eq!(saved.version, 3);
        assert_eq!(saved.scanned_through, 99);
        assert_eq!(saved.last_scan_at, Some(100));
        assert_eq!(saved.scanned_sessions, 7);
        assert_eq!(saved.pending_sessions, 2);
        assert_eq!(saved.failures, 5);
    }
}
