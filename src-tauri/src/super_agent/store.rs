//! Auto-router 的 sqlite 存储：设置、运行态、租约、trace、规划节点。
//!
//! 三类事实分开存，互不推导：
//! - `router_task_runs` 是运行态的唯一来源，判定只看它；
//! - `router_leases` 只防重复派发，过期即回收；
//! - `router_traces` 只写不读（除排障与当天配额统计）。

use crate::database::lock_conn;
use crate::error::AppError;
use crate::super_agent::model::{
    Decision, QuotaUsage, RouterSettings, RouterTrace, RunState, TaskRun,
};
use crate::Database;
use rusqlite::{params, OptionalExtension};

fn error(e: impl std::fmt::Display) -> AppError {
    AppError::Database(format!("SuperAgent: {e}"))
}

/// 一次运行态写入的全部字段。
///
/// 参数单独成型，是为了让「写运行态」只有一个入口：调用方必须显式声明它是否
/// 保留 worker、会话与尝试次数，不能靠位置参数漏写。
pub(crate) struct RunWrite<'a> {
    pub state: RunState,
    pub worker_app: Option<&'a str>,
    pub session_id: Option<&'a str>,
    pub attempts: u32,
    pub detail: Option<&'a str>,
    pub card_fingerprint: Option<&'a str>,
    pub shadow: bool,
}

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

/// 当天 0 点（本地时区）的毫秒时间戳，配额按自然日结算。
pub(crate) fn start_of_today_ms(now: i64) -> i64 {
    use chrono::{Local, TimeZone};
    let fallback = now - 24 * 60 * 60 * 1000;
    Local
        .timestamp_millis_opt(now)
        .single()
        .map(|local| {
            local
                .date_naive()
                .and_hms_opt(0, 0, 0)
                .and_then(|naive| local.offset().from_local_datetime(&naive).single())
                .map(|midnight| midnight.timestamp_millis())
                .unwrap_or(fallback)
        })
        .unwrap_or(fallback)
}

pub(crate) fn create_tables(conn: &rusqlite::Connection) -> Result<(), AppError> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS router_settings (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS router_task_runs (
            task_id TEXT NOT NULL,
            root TEXT NOT NULL,
            state TEXT NOT NULL,
            worker_app TEXT,
            session_id TEXT,
            attempts INTEGER NOT NULL DEFAULT 0,
            detail TEXT,
            card_fingerprint TEXT,
            shadow INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL,
            -- 任务 id 只在单个仓库内唯一：不同 backlog 仓库都会有自己的 TASK-1，
            -- 所以键必须是 (仓库, 任务) 的组合，不能只用任务 id。
            PRIMARY KEY (root, task_id)
        );
        CREATE INDEX IF NOT EXISTS idx_router_task_runs_root
            ON router_task_runs(root, state);
        CREATE TABLE IF NOT EXISTS router_leases (
            task_id TEXT NOT NULL,
            root TEXT NOT NULL,
            holder TEXT NOT NULL,
            expires_at INTEGER NOT NULL,
            PRIMARY KEY (root, task_id)
        );
        CREATE TABLE IF NOT EXISTS router_dispatches (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id TEXT NOT NULL,
            root TEXT NOT NULL,
            app_id TEXT NOT NULL,
            at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_router_dispatches_at
            ON router_dispatches(at);
        CREATE TABLE IF NOT EXISTS router_traces (
            id TEXT PRIMARY KEY,
            root TEXT,
            created_at INTEGER NOT NULL,
            trigger TEXT NOT NULL,
            candidates INTEGER NOT NULL,
            narrowed INTEGER NOT NULL DEFAULT 0,
            degraded TEXT NOT NULL DEFAULT '[]',
            decisions TEXT NOT NULL DEFAULT '[]',
            judge_calls INTEGER NOT NULL DEFAULT 0,
            duration_ms INTEGER NOT NULL DEFAULT 0,
            unfinished INTEGER NOT NULL DEFAULT 0,
            shadow INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_router_traces_created
            ON router_traces(created_at);
        CREATE TABLE IF NOT EXISTS router_plan_nodes (
            task_id TEXT NOT NULL,
            node_id TEXT NOT NULL,
            title TEXT NOT NULL,
            worker_app TEXT,
            depends_on TEXT NOT NULL DEFAULT '[]',
            state TEXT NOT NULL,
            PRIMARY KEY (task_id, node_id)
        );",
    )
    .map_err(error)
}

// ---------------------------------------------------------------- settings

impl Database {
    pub(crate) fn router_settings(&self) -> Result<RouterSettings, AppError> {
        let conn = lock_conn!(self.conn);
        let raw: Option<String> = conn
            .query_row("SELECT json FROM router_settings WHERE id = 1", [], |row| {
                row.get(0)
            })
            .optional()
            .map_err(error)?;
        match raw {
            Some(raw) => Ok(serde_json::from_str(&raw).unwrap_or_default()),
            None => Ok(RouterSettings::default()),
        }
    }

    pub(crate) fn save_router_settings(&self, settings: &RouterSettings) -> Result<(), AppError> {
        let raw = serde_json::to_string(settings).map_err(error)?;
        let conn = lock_conn!(self.conn);
        conn.execute(
            "INSERT INTO router_settings (id, json) VALUES (1, ?1)
             ON CONFLICT(id) DO UPDATE SET json = excluded.json",
            params![raw],
        )
        .map_err(error)?;
        Ok(())
    }

    // ------------------------------------------------------------- run state

    pub(crate) fn router_runs(&self) -> Result<Vec<TaskRun>, AppError> {
        let conn = lock_conn!(self.conn);
        let mut statement = conn
            .prepare(
                "SELECT task_id, root, state, worker_app, session_id, attempts, detail,
                        card_fingerprint, shadow, updated_at
                 FROM router_task_runs",
            )
            .map_err(error)?;
        let rows = statement
            .query_map([], |row| {
                let state: String = row.get(2)?;
                Ok(TaskRun {
                    task_id: row.get(0)?,
                    root: row.get(1)?,
                    state: RunState::parse(&state).unwrap_or(RunState::Idle),
                    worker_app: row.get(3)?,
                    session_id: row.get(4)?,
                    attempts: row.get::<_, i64>(5)? as u32,
                    detail: row.get(6)?,
                    card_fingerprint: row.get(7)?,
                    shadow: row.get::<_, i64>(8)? != 0,
                    updated_at: row.get(9)?,
                })
            })
            .map_err(error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(error)
    }

    /// 一张卡的运行态。必须带仓库：任务 id 只在仓库内唯一。
    pub(crate) fn router_run(
        &self,
        root: &str,
        task_id: &str,
    ) -> Result<Option<TaskRun>, AppError> {
        Ok(self
            .router_runs()?
            .into_iter()
            .find(|run| run.task_id == task_id && run.root == root))
    }

    /// 写运行态。`attempts` 由调用方给绝对值，不在 SQL 里自增，
    /// 这样「重试一次」和「重置计数」用同一条路径。
    pub(crate) fn put_router_run(
        &self,
        root: &str,
        task_id: &str,
        run: RunWrite<'_>,
        at: i64,
    ) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        conn.execute(
            "INSERT INTO router_task_runs
                (task_id, root, state, worker_app, session_id, attempts, detail,
                 card_fingerprint, shadow, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(root, task_id) DO UPDATE SET
                state = excluded.state,
                worker_app = excluded.worker_app,
                session_id = excluded.session_id,
                attempts = excluded.attempts,
                detail = excluded.detail,
                card_fingerprint = excluded.card_fingerprint,
                shadow = excluded.shadow,
                updated_at = excluded.updated_at",
            params![
                task_id,
                root,
                run.state.as_str(),
                run.worker_app,
                run.session_id,
                run.attempts as i64,
                run.detail,
                run.card_fingerprint,
                run.shadow as i64,
                at
            ],
        )
        .map_err(error)?;
        Ok(())
    }

    /// 只改状态与说明，保留 worker / 会话 / 尝试次数。
    /// 用于暂停、恢复、转人工这类不该抹掉上下文的动作。
    pub(crate) fn set_router_state(
        &self,
        root: &str,
        task_id: &str,
        state: RunState,
        detail: Option<&str>,
        at: i64,
    ) -> Result<(), AppError> {
        let existing = self.router_run(root, task_id)?;
        let (worker, session, attempts, fingerprint, shadow) = match &existing {
            Some(run) => (
                run.worker_app.as_deref(),
                run.session_id.as_deref(),
                run.attempts,
                run.card_fingerprint.as_deref(),
                run.shadow,
            ),
            None => (None, None, 0, None, false),
        };
        self.put_router_run(
            root,
            task_id,
            RunWrite {
                state,
                worker_app: worker,
                session_id: session,
                attempts,
                detail,
                card_fingerprint: fingerprint,
                shadow,
            },
            at,
        )
    }

    // --------------------------------------------------------------- leases

    /// 抢租约。已有未过期租约时返回 false（说明别人正在派发这张卡）。
    pub(crate) fn acquire_router_lease(
        &self,
        root: &str,
        task_id: &str,
        holder: &str,
        expires_at: i64,
    ) -> Result<bool, AppError> {
        let conn = lock_conn!(self.conn);
        let now = now_ms();
        conn.execute(
            "DELETE FROM router_leases WHERE expires_at <= ?1",
            params![now],
        )
        .map_err(error)?;
        let changed = conn
            .execute(
                "INSERT INTO router_leases (task_id, root, holder, expires_at)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(root, task_id) DO NOTHING",
                params![task_id, root, holder, expires_at],
            )
            .map_err(error)?;
        Ok(changed == 1)
    }

    pub(crate) fn release_router_lease(&self, root: &str, task_id: &str) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        conn.execute(
            "DELETE FROM router_leases WHERE root = ?1 AND task_id = ?2",
            params![root, task_id],
        )
        .map_err(error)?;
        Ok(())
    }

    // --------------------------------------------------------------- traces

    pub(crate) fn insert_router_trace(&self, trace: &RouterTrace) -> Result<(), AppError> {
        let degraded = serde_json::to_string(&trace.degraded).map_err(error)?;
        let decisions = serde_json::to_string(&trace.decisions).map_err(error)?;
        let conn = lock_conn!(self.conn);
        conn.execute(
            "INSERT OR REPLACE INTO router_traces
                (id, root, created_at, trigger, candidates, narrowed, degraded, decisions,
                 judge_calls, duration_ms, unfinished, shadow)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                trace.id,
                trace.root,
                trace.created_at,
                trace.trigger,
                trace.candidates as i64,
                trace.narrowed as i64,
                degraded,
                decisions,
                trace.judge_calls as i64,
                trace.duration_ms,
                trace.unfinished as i64,
                trace.shadow as i64
            ],
        )
        .map_err(error)?;
        Ok(())
    }

    pub(crate) fn router_traces(&self, limit: usize) -> Result<Vec<RouterTrace>, AppError> {
        let conn = lock_conn!(self.conn);
        let mut statement = conn
            .prepare(
                "SELECT id, root, created_at, trigger, candidates, narrowed, degraded, decisions,
                        judge_calls, duration_ms, unfinished, shadow
                 FROM router_traces ORDER BY created_at DESC LIMIT ?1",
            )
            .map_err(error)?;
        let rows = statement
            .query_map(params![limit as i64], |row| {
                Ok(RouterTrace {
                    id: row.get(0)?,
                    root: row.get(1)?,
                    created_at: row.get(2)?,
                    trigger: row.get(3)?,
                    candidates: row.get::<_, i64>(4)? as usize,
                    narrowed: row.get::<_, i64>(5)? != 0,
                    degraded: serde_json::from_str(&row.get::<_, String>(6)?).unwrap_or_default(),
                    decisions: serde_json::from_str(&row.get::<_, String>(7)?).unwrap_or_default(),
                    judge_calls: row.get::<_, i64>(8)? as usize,
                    duration_ms: row.get(9)?,
                    unfinished: row.get::<_, i64>(10)? != 0,
                    shadow: row.get::<_, i64>(11)? != 0,
                })
            })
            .map_err(error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(error)
    }

    /// 记一次派发。配额按这张表算，不从运行态推——运行态会被后续状态覆盖。
    pub(crate) fn insert_router_dispatch(
        &self,
        task_id: &str,
        root: &str,
        app_id: &str,
        at: i64,
    ) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        conn.execute(
            "INSERT INTO router_dispatches (task_id, root, app_id, at) VALUES (?1, ?2, ?3, ?4)",
            params![task_id, root, app_id, at],
        )
        .map_err(error)?;
        Ok(())
    }

    /// 当天用掉的配额。判官次数看 trace，派发次数看派发流水，重启都不清零。
    pub(crate) fn router_quota_usage(&self, now: i64) -> Result<QuotaUsage, AppError> {
        let since = start_of_today_ms(now);
        let conn = lock_conn!(self.conn);
        let judge_calls: i64 = conn
            .query_row(
                "SELECT COALESCE(SUM(judge_calls), 0) FROM router_traces WHERE created_at >= ?1",
                params![since],
                |row| row.get(0),
            )
            .map_err(error)?;
        let dispatches: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM router_dispatches WHERE at >= ?1",
                params![since],
                |row| row.get(0),
            )
            .map_err(error)?;
        Ok(QuotaUsage {
            dispatches: dispatches as usize,
            judge_calls: judge_calls as usize,
        })
    }

    // ---------------------------------------------------------- plan nodes

    /// 规划节点整体替换。当前只有 `plan_task` 会写它（episode 的 sidecar 版），
    /// 规则版 episode 不拆任务，所以暂时没有调用方。
    #[allow(dead_code)]
    pub(crate) fn replace_router_plan(
        &self,
        task_id: &str,
        nodes: &[crate::super_agent::model::PlanNode],
    ) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        conn.execute(
            "DELETE FROM router_plan_nodes WHERE task_id = ?1",
            params![task_id],
        )
        .map_err(error)?;
        for node in nodes {
            let depends_on = serde_json::to_string(&node.depends_on).map_err(error)?;
            conn.execute(
                "INSERT INTO router_plan_nodes
                    (task_id, node_id, title, worker_app, depends_on, state)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    task_id,
                    node.node_id,
                    node.title,
                    node.worker_app,
                    depends_on,
                    node.state
                ],
            )
            .map_err(error)?;
        }
        Ok(())
    }

    pub(crate) fn router_plan(
        &self,
        task_id: &str,
    ) -> Result<Vec<crate::super_agent::model::PlanNode>, AppError> {
        let conn = lock_conn!(self.conn);
        let mut statement = conn
            .prepare(
                "SELECT node_id, title, worker_app, depends_on, state
                 FROM router_plan_nodes WHERE task_id = ?1 ORDER BY node_id",
            )
            .map_err(error)?;
        let rows = statement
            .query_map(params![task_id], |row| {
                Ok(crate::super_agent::model::PlanNode {
                    task_id: task_id.to_string(),
                    node_id: row.get(0)?,
                    title: row.get(1)?,
                    worker_app: row.get(2)?,
                    depends_on: serde_json::from_str(&row.get::<_, String>(3)?).unwrap_or_default(),
                    state: row.get(4)?,
                })
            })
            .map_err(error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(error)
    }
}

/// 让 trace 的 JSON 与前端一致：决策数组原样存，读回时容忍坏数据。
#[allow(dead_code)]
pub(crate) fn decisions_json(decisions: &[Decision]) -> String {
    serde_json::to_string(decisions).unwrap_or_else(|_| "[]".into())
}
