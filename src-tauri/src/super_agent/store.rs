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
        -- 派发那一刻的智能体快照。智能体是可以改名、改模型、删掉的，
        -- 历史记录必须留下当时的那一份，否则上个月的运行记录会跟着配置变。
        CREATE TABLE IF NOT EXISTS router_run_agents (
            task_id TEXT NOT NULL,
            root TEXT NOT NULL,
            agent_id TEXT NOT NULL,
            agent_name TEXT NOT NULL,
            app_id TEXT NOT NULL,
            model TEXT,
            at INTEGER NOT NULL,
            PRIMARY KEY (root, task_id)
        );
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
        );
        -- worker 落在哪个运行时里：主键是派发时发给 CLI 的会话 id，
        -- 也是 journal 里的那一列，两条事实靠它对齐。
        CREATE TABLE IF NOT EXISTS router_workers (
            session_id TEXT PRIMARY KEY,
            root TEXT NOT NULL,
            task_id TEXT NOT NULL,
            backend TEXT NOT NULL,
            session_name TEXT,
            pane_id TEXT,
            app_id TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_router_workers_task
            ON router_workers(root, task_id);
        -- 持续 / 定时任务的「上次触发时刻」。排期本身写在卡片 frontmatter 里，
        -- 属于用户仓库；这里只记本机跑过几次，不进 git。
        CREATE TABLE IF NOT EXISTS router_schedules (
            root TEXT NOT NULL,
            task_id TEXT NOT NULL,
            last_fired_at INTEGER NOT NULL,
            PRIMARY KEY (root, task_id)
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
            // 存过的设置解释不了（字段类型被手改过、旧版本写的值）：退回默认值，
            // 但必须留一句日志——默默把开关关掉会让人以为是自己关的。
            Some(raw) => match serde_json::from_str(&raw) {
                Ok(settings) => Ok(settings),
                Err(error) => {
                    log::warn!("router settings unreadable, falling back to defaults: {error}");
                    Ok(RouterSettings::default())
                }
            },
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
                "SELECT r.task_id, r.root, r.state, r.worker_app, r.session_id, r.attempts,
                        r.detail, r.card_fingerprint, r.shadow, r.updated_at,
                        a.agent_id, a.agent_name, a.model
                 FROM router_task_runs r
                 LEFT JOIN router_run_agents a
                        ON a.root = r.root AND a.task_id = r.task_id",
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
                    agent_id: row.get(10)?,
                    agent_name: row.get(11)?,
                    agent_model: row.get(12)?,
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

    /// 记下这次派发用的智能体快照（名称、应用、请求的模型）。
    ///
    /// 与运行态分开写：它是「历史上用过谁」的事实，不随智能体配置改动。
    pub(crate) fn record_router_run_agent(
        &self,
        root: &str,
        task_id: &str,
        agent: &super::model::RouterAgent,
        at: i64,
    ) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        conn.execute(
            "INSERT INTO router_run_agents
                (task_id, root, agent_id, agent_name, app_id, model, at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(root, task_id) DO UPDATE SET
                agent_id = excluded.agent_id,
                agent_name = excluded.agent_name,
                app_id = excluded.app_id,
                model = excluded.model,
                at = excluded.at",
            params![
                task_id,
                root,
                agent.id,
                agent.name,
                agent.app_id,
                agent.model,
                at
            ],
        )
        .map_err(error)?;
        Ok(())
    }

    /// 新的一轮开始前清掉上一轮的智能体快照：排期重置时运行态也是空的，
    /// 两者得一起清，否则界面会出现「应用为空、却写着某个智能体」。
    pub(crate) fn clear_router_run_agent(&self, root: &str, task_id: &str) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        conn.execute(
            "DELETE FROM router_run_agents WHERE root = ?1 AND task_id = ?2",
            params![root, task_id],
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

    // -------------------------------------------------------------- schedules

    /// 一张卡上一次被排期触发的时刻（毫秒）。没跑过就是 `None`。
    pub(crate) fn router_schedule_last(
        &self,
        root: &str,
        task_id: &str,
    ) -> Result<Option<i64>, AppError> {
        let conn = lock_conn!(self.conn);
        conn.query_row(
            "SELECT last_fired_at FROM router_schedules WHERE root = ?1 AND task_id = ?2",
            params![root, task_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(error)
    }

    /// 记下「这一轮排期已经跑过了」。下一次从这一刻起算。
    pub(crate) fn mark_router_schedule(
        &self,
        root: &str,
        task_id: &str,
        at: i64,
    ) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        conn.execute(
            "INSERT INTO router_schedules (root, task_id, last_fired_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(root, task_id) DO UPDATE SET last_fired_at = excluded.last_fired_at",
            params![root, task_id, at],
        )
        .map_err(error)?;
        Ok(())
    }

    /// 卡片没有排期了：把触发记录一起丢掉。
    ///
    /// 留着它会让「取消排期 → 过几天又加回来」沿用那个很旧的起点，下一轮巡检
    /// 立刻补跑一次——用户刚设好的排期不该当场开跑。
    pub(crate) fn clear_router_schedule(&self, root: &str, task_id: &str) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        conn.execute(
            "DELETE FROM router_schedules WHERE root = ?1 AND task_id = ?2",
            params![root, task_id],
        )
        .map_err(error)?;
        Ok(())
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

// ---------------------------------------------------------------- workers

/// worker 跑在哪个运行时里。
///
/// `Zellij` 的进程不归 phi 的 PTY 所有，关终端、关应用都不杀它；
/// `Terminal` 是旧路径（托管 PTY），应用退出就一起结束。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum WorkerBackend {
    /// 跑在 zellij 里。非 macOS 上不会产生这条记录。
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    Zellij,
    Terminal,
}

impl WorkerBackend {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Zellij => "zellij",
            Self::Terminal => "terminal",
        }
    }

    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "zellij" => Some(Self::Zellij),
            "terminal" => Some(Self::Terminal),
            _ => None,
        }
    }
}

/// 一条 worker 归属：后台调度器重启后靠它找回自己派出去的那个 pane。
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WorkerRecord {
    pub session_id: String,
    pub root: String,
    pub task_id: String,
    pub backend: WorkerBackend,
    /// 下面的会话名与 pane id 只有 zellij 后端用得上：托管终端在自己进程里，
    /// 不需要这两列。别的平台上它们照写（为空），只是没人读。
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub session_name: Option<String>,
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub pane_id: Option<String>,
    pub app_id: String,
    pub created_at: i64,
}

impl Database {
    pub(crate) fn put_worker(&self, record: &WorkerRecord) -> Result<(), AppError> {
        let now = now_ms();
        let conn = lock_conn!(self.conn);
        conn.execute(
            "INSERT INTO router_workers
                (session_id, root, task_id, backend, session_name, pane_id, app_id,
                 created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(session_id) DO UPDATE SET
                root = excluded.root,
                task_id = excluded.task_id,
                backend = excluded.backend,
                session_name = excluded.session_name,
                pane_id = excluded.pane_id,
                app_id = excluded.app_id,
                updated_at = excluded.updated_at",
            params![
                record.session_id,
                record.root,
                record.task_id,
                record.backend.as_str(),
                record.session_name,
                record.pane_id,
                record.app_id,
                record.created_at,
                now
            ],
        )
        .map_err(error)?;
        Ok(())
    }

    pub(crate) fn worker(&self, session_id: &str) -> Result<Option<WorkerRecord>, AppError> {
        let conn = lock_conn!(self.conn);
        conn.query_row(
            "SELECT session_id, root, task_id, backend, session_name, pane_id, app_id, created_at
             FROM router_workers WHERE session_id = ?1",
            params![session_id],
            |row| {
                Ok(WorkerRecord {
                    session_id: row.get(0)?,
                    root: row.get(1)?,
                    task_id: row.get(2)?,
                    backend: WorkerBackend::parse(&row.get::<_, String>(3)?)
                        .unwrap_or(WorkerBackend::Terminal),
                    session_name: row.get(4)?,
                    pane_id: row.get(5)?,
                    app_id: row.get(6)?,
                    created_at: row.get(7)?,
                })
            },
        )
        .optional()
        .map_err(error)
    }

    /// 停掉一个 worker 之后删归属：留着会让下一次 probe 去问一个已经不在的 pane。
    pub(crate) fn delete_worker(&self, session_id: &str) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        conn.execute(
            "DELETE FROM router_workers WHERE session_id = ?1",
            params![session_id],
        )
        .map_err(error)?;
        Ok(())
    }
}
