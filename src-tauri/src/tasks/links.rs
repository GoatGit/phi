//! 任务 ↔ 会话的关联表。
//!
//! 任务本身是仓库里的 markdown 文件（随 git 走），关联是本机事实（跟着这台
//! 机器上的会话），所以放 sqlite。会话关掉后关联仍保留：回看任务时还能知道
//! 当时是哪个应用、花了多少。

use crate::database::lock_conn;
use crate::error::AppError;
use crate::tasks::model::TaskLink;
use crate::Database;
use rusqlite::{params, OptionalExtension};

fn error(e: impl std::fmt::Display) -> AppError {
    AppError::Database(format!("Tasks: {e}"))
}

pub(crate) fn create_tables(conn: &rusqlite::Connection) -> Result<(), AppError> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS task_workspaces (
            root TEXT PRIMARY KEY,
            added_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS task_session_links (
            root TEXT NOT NULL,
            task_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            app_id TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY (root, task_id, session_id)
        );
        CREATE INDEX IF NOT EXISTS idx_task_links_session
            ON task_session_links(session_id);",
    )
    .map_err(error)
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

impl Database {
    /// 已登记的工作区根目录（绝对路径）。
    pub fn task_workspaces(&self) -> Result<Vec<String>, AppError> {
        let conn = lock_conn!(self.conn);
        let mut statement = conn
            .prepare("SELECT root FROM task_workspaces ORDER BY added_at")
            .map_err(error)?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(error)
    }

    pub fn add_task_workspace(&self, root: &str) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        conn.execute(
            "INSERT INTO task_workspaces (root, added_at) VALUES (?1, ?2)
             ON CONFLICT(root) DO NOTHING",
            params![root, now()],
        )
        .map_err(error)?;
        Ok(())
    }

    /// 移除工作区登记，连带清掉它的会话关联（文件本身不动）。
    pub fn remove_task_workspace(&self, root: &str) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        conn.execute(
            "DELETE FROM task_session_links WHERE root = ?1",
            params![root],
        )
        .map_err(error)?;
        conn.execute("DELETE FROM task_workspaces WHERE root = ?1", params![root])
            .map_err(error)?;
        Ok(())
    }

    /// 一个任务关联的会话，附带按会话聚合的用量。
    pub fn task_links(&self, root: &str, task_id: &str) -> Result<Vec<TaskLink>, AppError> {
        let conn = lock_conn!(self.conn);
        let mut statement = conn
            .prepare(
                "SELECT session_id, app_id, created_at FROM task_session_links
                 WHERE root = ?1 AND task_id = ?2 ORDER BY created_at",
            )
            .map_err(error)?;
        let rows = statement
            .query_map(params![root, task_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })
            .map_err(error)?;

        let mut links = Vec::new();
        for row in rows {
            let (session_id, app_id, created_at) = row.map_err(error)?;
            let usage: (f64, i64) = conn
                .query_row(
                    "SELECT COALESCE(SUM(CAST(total_cost_usd AS REAL)), 0), COUNT(*)
                     FROM proxy_request_logs WHERE session_id = ?1",
                    params![session_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(error)?
                .unwrap_or((0.0, 0));
            links.push(TaskLink {
                session_id,
                app_id,
                created_at,
                cost_usd: usage.0,
                requests: usage.1,
            });
        }
        Ok(links)
    }

    pub fn link_task_session(
        &self,
        root: &str,
        task_id: &str,
        session_id: &str,
        app_id: &str,
    ) -> Result<TaskLink, AppError> {
        let conn = lock_conn!(self.conn);
        conn.execute(
            "INSERT INTO task_session_links (root, task_id, session_id, app_id, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(root, task_id, session_id) DO UPDATE SET app_id = excluded.app_id",
            params![root, task_id, session_id, app_id, now()],
        )
        .map_err(error)?;
        // 已经关联过就沿用原时间，而不是把这次重试当成新的关联
        let created_at: i64 = conn
            .query_row(
                "SELECT created_at FROM task_session_links
                 WHERE root = ?1 AND task_id = ?2 AND session_id = ?3",
                params![root, task_id, session_id],
                |row| row.get(0),
            )
            .map_err(error)?;
        Ok(TaskLink {
            session_id: session_id.to_string(),
            app_id: app_id.to_string(),
            created_at,
            cost_usd: 0.0,
            requests: 0,
        })
    }

    pub fn unlink_task_session(
        &self,
        root: &str,
        task_id: &str,
        session_id: &str,
    ) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        conn.execute(
            "DELETE FROM task_session_links
             WHERE root = ?1 AND task_id = ?2 AND session_id = ?3",
            params![root, task_id, session_id],
        )
        .map_err(error)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registers_workspaces_and_keeps_links_until_removed() {
        let db = Database::memory().expect("memory db");
        assert!(db.task_workspaces().expect("list").is_empty());

        db.add_task_workspace("/repo").expect("add");
        db.add_task_workspace("/repo").expect("add twice");
        assert_eq!(db.task_workspaces().expect("list"), vec!["/repo"]);

        let first = db
            .link_task_session("/repo", "TASK-1", "session-a", "codex")
            .expect("link");
        let again = db
            .link_task_session("/repo", "TASK-1", "session-a", "claude")
            .expect("relink");
        assert_eq!(again.created_at, first.created_at);

        let links = db.task_links("/repo", "TASK-1").expect("links");
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].app_id, "claude");

        db.unlink_task_session("/repo", "TASK-1", "session-a")
            .expect("unlink");
        assert!(db.task_links("/repo", "TASK-1").expect("links").is_empty());
    }

    #[test]
    fn removing_a_workspace_drops_its_links_only() {
        let db = Database::memory().expect("memory db");
        db.add_task_workspace("/a").expect("add a");
        db.add_task_workspace("/b").expect("add b");
        db.link_task_session("/a", "TASK-1", "s1", "codex")
            .expect("link a");
        db.link_task_session("/b", "TASK-1", "s2", "codex")
            .expect("link b");

        db.remove_task_workspace("/b").expect("remove b");

        assert_eq!(db.task_workspaces().expect("list"), vec!["/a"]);
        assert!(db.task_links("/b", "TASK-1").expect("links b").is_empty());
        assert_eq!(db.task_links("/a", "TASK-1").expect("links a").len(), 1);
    }

    #[test]
    fn links_report_usage_from_request_logs() {
        let db = Database::memory().expect("memory db");
        db.add_task_workspace("/repo").expect("add");
        db.link_task_session("/repo", "TASK-1", "session-a", "codex")
            .expect("link");
        {
            let conn = db.conn.lock().expect("lock");
            conn.execute(
                "INSERT INTO proxy_request_logs (
                    request_id, provider_id, app_type, model, total_cost_usd,
                    latency_ms, status_code, session_id, created_at)
                 VALUES ('r1', 'p', 'codex', 'm', '0.5', 10, 200, 'session-a', 1),
                        ('r2', 'p', 'codex', 'm', '1.25', 10, 200, 'session-a', 2)",
                [],
            )
            .expect("insert logs");
        }

        let links = db.task_links("/repo", "TASK-1").expect("links");
        assert_eq!(links[0].requests, 2);
        assert!((links[0].cost_usd - 1.75).abs() < f64::EPSILON);
    }
}
