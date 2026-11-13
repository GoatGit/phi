//! 成绩单的落库与增量同步。
//!
//! 会话文件是唯一的原始数据。解析一次贵在会话数量级，所以按「文件指纹」增量：
//! 指纹没变就不重新解析；源文件被删，对应的任务事实一起删。
//!
//! 表里只有事实（调用、结果、耗时、成本），没有分数——判定留给聚合层。

use crate::database::{lock_conn, Database};
use crate::error::AppError;
use crate::report_card::aggregate::TaskRow;
use crate::report_card::extract::{extract_facts, TaskFact};
use crate::session_manager;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

/// 两次自动同步的最小间隔：页面来回切不应该反复扫盘
const SYNC_THROTTLE_MS: i64 = 5 * 60 * 1000;

const META_LAST_SYNC: &str = "last_sync_at";

fn error(e: impl std::fmt::Display) -> AppError {
    AppError::Database(format!("ReportCard: {e}"))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

pub(crate) fn create_tables(conn: &rusqlite::Connection) -> Result<(), AppError> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS report_card_sources (
            session_key TEXT PRIMARY KEY,
            provider_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            source_path TEXT NOT NULL,
            project_dir TEXT NOT NULL DEFAULT '',
            fingerprint TEXT NOT NULL,
            scanned_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS report_card_tasks (
            task_key TEXT PRIMARY KEY,
            session_key TEXT NOT NULL,
            provider_id TEXT NOT NULL,
            project_dir TEXT NOT NULL DEFAULT '',
            started_at INTEGER NOT NULL,
            ended_at INTEGER NOT NULL,
            model TEXT NOT NULL DEFAULT '',
            mixed_models INTEGER NOT NULL DEFAULT 0,
            tool_calls INTEGER NOT NULL DEFAULT 0,
            tool_failures INTEGER NOT NULL DEFAULT 0,
            interruptions INTEGER NOT NULL DEFAULT 0,
            write_attempts INTEGER NOT NULL DEFAULT 0,
            write_successes INTEGER NOT NULL DEFAULT 0,
            empty_delivery INTEGER NOT NULL DEFAULT 0,
            timed_calls INTEGER NOT NULL DEFAULT 0,
            duration_sum_ms INTEGER NOT NULL DEFAULT 0,
            exit_samples INTEGER NOT NULL DEFAULT 0,
            exit_failures INTEGER NOT NULL DEFAULT 0,
            cost_usd REAL NOT NULL DEFAULT 0,
            input_tokens INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_report_card_tasks_window
            ON report_card_tasks(ended_at);
        CREATE INDEX IF NOT EXISTS idx_report_card_tasks_session
            ON report_card_tasks(session_key);
        CREATE TABLE IF NOT EXISTS report_card_meta (
            key TEXT PRIMARY KEY,
            value INTEGER NOT NULL
        );",
    )
    .map_err(error)
}

/// 一轮同步的结果。`skipped` 为真表示本轮被节流或已有同步在跑，数据没动。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub scanned_sessions: u64,
    pub parsed_sessions: u64,
    pub unchanged_sessions: u64,
    pub failed_sessions: u64,
    pub dropped_sessions: u64,
    pub skipped: bool,
    pub synced_at: i64,
    pub duration_ms: u64,
}

struct SourceEntry {
    provider_id: String,
    session_id: String,
    source_path: String,
    session_key: String,
    project_dir: String,
    fingerprint: String,
    fallback: (i64, i64),
}

fn sync_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// 扫描会话目录 → 解析变化的会话 → 重写它的任务事实。
///
/// 解析走 `session_manager` 的转录缓存，同一个文件不会在一个进程里解析两遍。
pub fn sync(db: &Database, force: bool) -> Result<SyncReport, AppError> {
    let started = Instant::now();
    let last_sync = last_sync_at(db)?;
    let now = now_ms();
    if !force && last_sync > 0 && now - last_sync < SYNC_THROTTLE_MS {
        return Ok(SyncReport {
            skipped: true,
            synced_at: last_sync,
            ..SyncReport::default()
        });
    }
    // 已有同步在跑：不排队，直接让前端用现有数据
    let guard = match sync_lock().try_lock() {
        Ok(guard) => guard,
        Err(_) => {
            return Ok(SyncReport {
                skipped: true,
                synced_at: last_sync,
                ..SyncReport::default()
            })
        }
    };

    let entries = collect_sources();
    let scanned_sessions = entries.len() as u64;
    let known = known_fingerprints(db)?;
    let mut report = SyncReport {
        scanned_sessions,
        ..SyncReport::default()
    };

    for entry in &entries {
        if known
            .get(&entry.session_key)
            .is_some_and(|fingerprint| fingerprint == &entry.fingerprint)
        {
            report.unchanged_sessions += 1;
            continue;
        }
        match session_manager::load_transcript(&entry.provider_id, &entry.source_path) {
            Ok(loaded) => {
                let tasks = extract_facts(&loaded.transcript.messages, entry.fallback);
                store_session(db, entry, &tasks)?;
                report.parsed_sessions += 1;
            }
            // 解析失败不动旧数据：留下上一次的事实，比清空更接近真相
            Err(_) => report.failed_sessions += 1,
        }
    }

    let live: HashSet<&str> = entries
        .iter()
        .map(|entry| entry.session_key.as_str())
        .collect();
    report.dropped_sessions = drop_vanished(db, &live)?;
    set_last_sync_at(db, now)?;
    report.synced_at = now;
    report.duration_ms = started.elapsed().as_millis() as u64;
    drop(guard);
    Ok(report)
}

fn collect_sources() -> Vec<SourceEntry> {
    session_manager::scan_sessions()
        .into_iter()
        .filter_map(|meta| {
            let source_path = meta.source_path?;
            let fingerprint = fingerprint(&source_path, meta.last_active_at, meta.created_at);
            let session_key = format!("{}:{}", meta.provider_id, source_path);
            let created = meta.created_at.unwrap_or(0);
            let last_active = meta.last_active_at.or(meta.created_at).unwrap_or(created);
            Some(SourceEntry {
                provider_id: meta.provider_id,
                session_id: meta.session_id,
                source_path,
                session_key,
                project_dir: meta.project_dir.unwrap_or_default(),
                fingerprint,
                fallback: (created, last_active),
            })
        })
        .collect()
}

/// 文件改动才算变；SQLite 源的会话没有文件，用最近活跃时间兜底。
fn fingerprint(source_path: &str, last_active_at: Option<i64>, created_at: Option<i64>) -> String {
    if let Ok(metadata) = std::fs::metadata(source_path) {
        let modified = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        return format!("{}:{}", metadata.len(), modified);
    }
    format!(
        "source:{}:{}",
        last_active_at.unwrap_or(0),
        created_at.unwrap_or(0)
    )
}

fn known_fingerprints(db: &Database) -> Result<HashMap<String, String>, AppError> {
    let conn = lock_conn!(db.conn);
    let mut statement = conn
        .prepare("SELECT session_key, fingerprint FROM report_card_sources")
        .map_err(error)?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(error)?;
    rows.collect::<Result<HashMap<_, _>, _>>().map_err(error)
}

fn store_session(db: &Database, entry: &SourceEntry, tasks: &[TaskFact]) -> Result<(), AppError> {
    let mut conn = lock_conn!(db.conn);
    let transaction = conn.transaction().map_err(error)?;
    transaction
        .execute(
            "DELETE FROM report_card_tasks WHERE session_key = ?1",
            params![entry.session_key],
        )
        .map_err(error)?;
    {
        let mut statement = transaction
            .prepare(
                "INSERT INTO report_card_tasks (
                    task_key, session_key, provider_id, project_dir, started_at, ended_at,
                    model, mixed_models, tool_calls, tool_failures, interruptions,
                    write_attempts, write_successes, empty_delivery, timed_calls,
                    duration_sum_ms, exit_samples, exit_failures, cost_usd,
                    input_tokens, output_tokens
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
                           ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)",
            )
            .map_err(error)?;
        for (position, task) in tasks.iter().enumerate() {
            statement
                .execute(params![
                    format!("{}#{position}", entry.session_key),
                    entry.session_key,
                    entry.provider_id,
                    entry.project_dir,
                    task.started_at,
                    task.ended_at,
                    task.model,
                    i64::from(task.mixed_models),
                    task.tool_calls,
                    task.tool_failures,
                    task.interruptions,
                    task.write_attempts,
                    task.write_successes,
                    i64::from(task.empty_delivery),
                    task.timed_calls,
                    task.duration_sum_ms,
                    task.exit_samples,
                    task.exit_failures,
                    task.cost_usd,
                    task.input_tokens,
                    task.output_tokens,
                ])
                .map_err(error)?;
        }
    }
    transaction
        .execute(
            "INSERT INTO report_card_sources (
                session_key, provider_id, session_id, source_path, project_dir,
                fingerprint, scanned_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(session_key) DO UPDATE SET
                fingerprint = excluded.fingerprint,
                project_dir = excluded.project_dir,
                scanned_at = excluded.scanned_at",
            params![
                entry.session_key,
                entry.provider_id,
                entry.session_id,
                entry.source_path,
                entry.project_dir,
                entry.fingerprint,
                now_ms(),
            ],
        )
        .map_err(error)?;
    transaction.commit().map_err(error)
}

/// 源文件被删 / 会话被清理后，对应的事实一起删（否则榜单会一直记住已经不存在的活）。
fn drop_vanished(db: &Database, live: &HashSet<&str>) -> Result<u64, AppError> {
    let conn = lock_conn!(db.conn);
    let mut statement = conn
        .prepare("SELECT session_key FROM report_card_sources")
        .map_err(error)?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(error)?;
    let stale: Vec<String> = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(error)?
        .into_iter()
        .filter(|key| !live.contains(key.as_str()))
        .collect();
    drop(statement);

    let mut dropped = 0u64;
    for key in stale {
        conn.execute(
            "DELETE FROM report_card_tasks WHERE session_key = ?1",
            params![key],
        )
        .map_err(error)?;
        conn.execute(
            "DELETE FROM report_card_sources WHERE session_key = ?1",
            params![key],
        )
        .map_err(error)?;
        dropped += 1;
    }
    Ok(dropped)
}

fn last_sync_at(db: &Database) -> Result<i64, AppError> {
    let conn = lock_conn!(db.conn);
    let value: Option<i64> = conn
        .query_row(
            "SELECT value FROM report_card_meta WHERE key = ?1",
            params![META_LAST_SYNC],
            |row| row.get(0),
        )
        .ok();
    Ok(value.unwrap_or(0))
}

fn set_last_sync_at(db: &Database, value: i64) -> Result<(), AppError> {
    let conn = lock_conn!(db.conn);
    conn.execute(
        "INSERT INTO report_card_meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![META_LAST_SYNC, value],
    )
    .map_err(error)?;
    Ok(())
}

/// 窗口内的任务事实。按任务结束时间过滤：一个跨窗口的任务只算最近这一侧。
pub fn task_rows(db: &Database, since: i64) -> Result<Vec<TaskRow>, AppError> {
    let conn = lock_conn!(db.conn);
    let mut statement = conn
        .prepare(
            "SELECT provider_id, project_dir, started_at, ended_at, model, mixed_models,
                    tool_calls, tool_failures, interruptions, write_attempts,
                    write_successes, empty_delivery, timed_calls, duration_sum_ms,
                    exit_samples, exit_failures, cost_usd, input_tokens, output_tokens
             FROM report_card_tasks
             WHERE ended_at >= ?1
             ORDER BY ended_at DESC",
        )
        .map_err(error)?;
    let rows = statement
        .query_map(params![since], |row| {
            Ok(TaskRow {
                provider_id: row.get(0)?,
                project_dir: row.get(1)?,
                fact: TaskFact {
                    started_at: row.get(2)?,
                    ended_at: row.get(3)?,
                    model: row.get(4)?,
                    mixed_models: row.get::<_, i64>(5)? != 0,
                    tool_calls: row.get(6)?,
                    tool_failures: row.get(7)?,
                    interruptions: row.get(8)?,
                    write_attempts: row.get(9)?,
                    write_successes: row.get(10)?,
                    empty_delivery: row.get::<_, i64>(11)? != 0,
                    timed_calls: row.get(12)?,
                    duration_sum_ms: row.get(13)?,
                    exit_samples: row.get(14)?,
                    exit_failures: row.get(15)?,
                    cost_usd: row.get(16)?,
                    input_tokens: row.get(17)?,
                    output_tokens: row.get(18)?,
                },
            })
        })
        .map_err(error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(error)
}

/// 已扫描的会话数（覆盖统计用：样本覆盖不全时排序会偏）。
pub fn scanned_sources(db: &Database) -> Result<u64, AppError> {
    let conn = lock_conn!(db.conn);
    conn.query_row("SELECT COUNT(*) FROM report_card_sources", [], |row| {
        row.get(0)
    })
    .map_err(error)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(key: &str, fingerprint: &str) -> SourceEntry {
        SourceEntry {
            provider_id: "claude".into(),
            session_id: key.into(),
            source_path: format!("/tmp/{key}.jsonl"),
            session_key: key.into(),
            project_dir: "/repo".into(),
            fingerprint: fingerprint.into(),
            fallback: (1, 2),
        }
    }

    fn fact(model: &str, calls: u64) -> TaskFact {
        TaskFact {
            started_at: 100,
            ended_at: 200,
            model: model.into(),
            mixed_models: false,
            tool_calls: calls,
            tool_failures: 0,
            interruptions: 0,
            write_attempts: 0,
            write_successes: 0,
            empty_delivery: false,
            timed_calls: 0,
            duration_sum_ms: 0,
            exit_samples: 0,
            exit_failures: 0,
            cost_usd: 0.5,
            input_tokens: 10,
            output_tokens: 20,
        }
    }

    #[test]
    fn stores_and_replaces_a_session() {
        let db = Database::memory().expect("memory db");
        store_session(&db, &entry("s1", "fp1"), &[fact("m", 3)]).expect("store");
        assert_eq!(scanned_sources(&db).expect("count"), 1);
        assert_eq!(task_rows(&db, 0).expect("rows").len(), 1);

        // 同一个会话重新解析：旧任务被整体替换，而不是叠加
        store_session(&db, &entry("s1", "fp2"), &[fact("m", 1), fact("m", 2)]).expect("restore");
        let rows = task_rows(&db, 0).expect("rows");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows.iter().map(|row| row.fact.tool_calls).sum::<u64>(), 3);
    }

    #[test]
    fn window_filters_by_task_end() {
        let db = Database::memory().expect("memory db");
        store_session(&db, &entry("s1", "fp1"), &[fact("m", 1)]).expect("store");
        assert_eq!(task_rows(&db, 201).expect("rows").len(), 0);
        assert_eq!(task_rows(&db, 200).expect("rows").len(), 1);
    }

    #[test]
    fn drops_sessions_whose_source_disappeared() {
        let db = Database::memory().expect("memory db");
        store_session(&db, &entry("s1", "fp1"), &[fact("m", 1)]).expect("store s1");
        store_session(&db, &entry("s2", "fp1"), &[fact("m", 1)]).expect("store s2");

        let live: HashSet<&str> = HashSet::from(["s1"]);
        assert_eq!(drop_vanished(&db, &live).expect("drop"), 1);
        assert_eq!(scanned_sources(&db).expect("count"), 1);
        assert_eq!(task_rows(&db, 0).expect("rows").len(), 1);
    }

    #[test]
    fn files_without_source_metadata_use_session_time() {
        assert_eq!(
            fingerprint("/definitely/missing.jsonl", Some(7), Some(5)),
            "source:7:5"
        );
    }
}
