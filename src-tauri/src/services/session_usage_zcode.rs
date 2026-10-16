//! ZCode（OpenCode 衍生的桌面端）会话用量解析
//!
//! 数据源：`~/.zcode/cli/db/db.sqlite`（WAL 模式，运行中持续写入）。
//! 表结构：`session`(id, parent_id, directory, title, title_source,
//! time_created, time_updated) + `message`(session_id, data=JSON)。
//!
//! message.data 关键字段（AI SDK 口径，解析自 internal/sessions/zcode.go +
//! opencode.go 的 magpie 实现）：
//! - `role`：user / assistant
//! - `time.created` / `time.completed`：毫秒时间戳（completed 缺失视为未完成）
//! - `modelID`（旧）或 `modelId`（新）：模型 ID
//! - `tokens{input, output, reasoning, cache{read, write}}`：
//!   input 已含缓存读写，output 已含 reasoning——入库前换算为
//!   fresh input = input − cache.read − cache.write，输出补回 reasoning。
//!
//! 注意：assistant 消息的 tokens 会在流式过程中被原地重写，
//! 因此必须整读数据库，不能按行增量。

use std::fs;
use std::time::SystemTime;

use crate::database::{lock_conn, Database};
use crate::error::AppError;
use crate::proxy::usage::calculator::CostCalculator;
use crate::proxy::usage::parser::TokenUsage;
use crate::services::session_usage::{metadata_modified_nanos, update_sync_state, SessionSyncResult};
use crate::services::usage_stats::{find_model_pricing, should_skip_session_insert, DedupKey};
use rust_decimal::Decimal;

#[derive(Debug, Clone)]
pub struct ZcodeMessageData {
    pub input_tokens: u32,
    pub output_tokens: u32,
    pub reasoning_tokens: u32,
    pub cache_read_tokens: u32,
    pub cache_write_tokens: u32,
    pub model_id: String,
    pub timestamp_ms: i64,
}

pub fn get_zcode_db_path() -> std::path::PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join(".zcode")
        .join("cli")
        .join("db")
        .join("db.sqlite")
}

pub fn get_zcode_db_dir() -> std::path::PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join(".zcode")
        .join("cli")
        .join("db")
}

/// 同步 ZCode 使用数据
pub fn sync_zcode_usage(db: &Database) -> Result<SessionSyncResult, AppError> {
    let db_path = get_zcode_db_path();

    if !db_path.exists() {
        return Ok(SessionSyncResult {
            imported: 0,
            skipped: 0,
            files_scanned: 0,
            suspected_duplicates: 0,
            deferred_files: 0,
            errors: vec![],
        });
    }

    let db_path_str = db_path.to_string_lossy().to_string();

    // WAL 模式：新提交先落在 -wal 文件里，主库文件 checkpoint 前不变。
    // 必须同时考虑 -wal 的 mtime，否则会漏掉刚写入的会话。
    let metadata = fs::metadata(&db_path)
        .map_err(|e| AppError::Config(format!("无法读取 db.sqlite 元数据: {e}")))?;
    let mut file_modified = metadata_modified_nanos(&metadata);

    let wal_path = db_path.with_extension("sqlite-wal");
    if let Ok(wal_meta) = fs::metadata(&wal_path) {
        file_modified = file_modified.max(metadata_modified_nanos(&wal_meta));
    }

    let cursors = crate::services::session_usage::load_sync_cursors(db)?;
    let last_modified = cursors.get(&db_path_str).map_or(0, |c| c.last_modified);

    // 文件未变化则跳过
    if file_modified <= last_modified {
        return Ok(SessionSyncResult {
            imported: 0,
            skipped: 0,
            files_scanned: 1,
            suspected_duplicates: 0,
            deferred_files: 0,
            errors: vec![],
        });
    }

    // 只读打开；运行中的 ZCode 持有该库，绝不写入
    let zcode_conn =
        rusqlite::Connection::open_with_flags(&db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| AppError::Database(format!("无法打开 db.sqlite: {e}")))?;

    let mut result = SessionSyncResult {
        imported: 0,
        skipped: 0,
        files_scanned: 1,
        suspected_duplicates: 0,
        deferred_files: 0,
        errors: vec![],
    };
    let mut has_sync_errors = false;

    // 查询所有会话（sync 水位 = 会话与消息时间的最大值）
    let sessions = query_sessions(&zcode_conn)?;

    for (session_id, time_updated) in &sessions {
        let sync_key = format!("{db_path_str}:{session_id}");
        let sess_last_modified = cursors.get(&sync_key).map_or(0, |c| c.last_modified);
        if *time_updated <= sess_last_modified {
            continue; // 会话未更新，跳过
        }

        let mut session_had_error = false;

        match query_assistant_messages(&zcode_conn, session_id) {
            Ok(messages) => {
                for (message_id, msg_data) in &messages {
                    let request_id =
                        format!("zcode_session:{session_id}:{message_id}");

                    match insert_zcode_message(db, &request_id, msg_data, session_id) {
                        Ok(true) => result.imported += 1,
                        Ok(false) => result.skipped += 1,
                        Err(e) => {
                            let msg = format!("ZCode 消息插入失败 {request_id}: {e}");
                            log::warn!("[ZCODE-SYNC] {msg}");
                            result.errors.push(msg);
                            result.skipped += 1;
                            session_had_error = true;
                        }
                    }
                }
            }
            Err(e) => {
                let msg = format!("ZCode 会话消息查询失败 {session_id}: {e}");
                log::warn!("[ZCODE-SYNC] {msg}");
                result.errors.push(msg);
                session_had_error = true;
            }
        }

        if session_had_error {
            has_sync_errors = true;
            continue;
        }

        // 更新会话级同步状态
        if let Err(e) = update_sync_state(db, &sync_key, *time_updated, 0) {
            let msg = format!("ZCode 会话同步状态更新失败 {session_id}: {e}");
            log::warn!("[ZCODE-SYNC] {msg}");
            result.errors.push(msg);
            has_sync_errors = true;
        }
    }

    // 仅在本轮完全成功时推进文件级状态；否则保留下次重试入口。
    if !has_sync_errors {
        update_sync_state(db, &db_path_str, file_modified, 0)?;
    }

    if result.imported > 0 {
        log::info!(
            "[ZCODE-SYNC] 同步完成: 导入 {} 条, 跳过 {} 条, 扫描 {} 个会话",
            result.imported,
            result.skipped,
            sessions.len()
        );
    }

    Ok(result)
}

/// 查询所有会话的 (id, sync_watermark)
fn query_sessions(
    conn: &rusqlite::Connection,
) -> Result<Vec<(String, i64)>, AppError> {
    let sql = "SELECT s.id, \
               MAX(s.time_updated, COALESCE(MAX(m.time_updated), s.time_updated)) AS sync_watermark \
               FROM session s \
               LEFT JOIN message m ON m.session_id = s.id \
               GROUP BY s.id \
               ORDER BY sync_watermark";
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| AppError::Database(format!("准备会话查询失败: {e}")))?;

    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(|e| AppError::Database(format!("查询会话失败: {e}")))?;

    let mut sessions = Vec::new();
    for row in rows {
        sessions.push(row.map_err(|e| AppError::Database(format!("读取会话行失败: {e}")))?);
    }

    Ok(sessions)
}

/// 查询某会话已完成计费的 assistant 消息，并标记是否还有未完成 usage 消息
fn query_assistant_messages(
    conn: &rusqlite::Connection,
    session_id: &str,
) -> Result<Vec<(String, ZcodeMessageData)>, AppError> {
    let sql = "SELECT id, data FROM message \
               WHERE session_id = ?1 AND role = 'assistant' \
               ORDER BY time_created";
    let mut stmt = conn
        .prepare(sql)
        .map_err(|e| AppError::Database(format!("准备消息查询失败: {e}")))?;

    let rows = stmt
        .query_map([session_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| AppError::Database(format!("查询消息失败: {e}")))?;

    let mut messages = Vec::new();
    for row in rows {
        let (message_id, data_json) =
            row.map_err(|e| AppError::Database(format!("读取消息行失败: {e}")))?;

        let value: serde_json::Value = match serde_json::from_str(&data_json) {
            Ok(v) => v,
            Err(_) => continue,
        };

        if value.get("tokens").is_none() {
            continue;
        }

        // 未完成的消息：进行中只有半截 token，且 INSERT OR IGNORE 无法回填
        let is_completed = value
            .get("time")
            .and_then(|t| t.get("completed"))
            .is_some();
        if !is_completed {
            continue;
        }

        if let Some(msg_data) = parse_message_data(&value) {
            messages.push((message_id, msg_data));
        }
    }

    Ok(messages)
}

/// 解析 message.data JSON 为结构化数据
fn parse_message_data(value: &serde_json::Value) -> Option<ZcodeMessageData> {
    let tokens = value.get("tokens")?;

    let input_total = tokens.get("input").and_then(|v| v.as_u64()).unwrap_or(0) as i64;
    let output_tokens = tokens.get("output").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    let reasoning_tokens = tokens
        .get("reasoning")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;

    let cache_obj = tokens.get("cache");
    let cache_read_tokens = cache_obj
        .and_then(|c| c.get("read"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;
    let cache_write_tokens = cache_obj
        .and_then(|c| c.get("write"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;

    if input_total == 0
        && output_tokens == 0
        && reasoning_tokens == 0
        && cache_read_tokens == 0
        && cache_write_tokens == 0
    {
        return None;
    }

    // AI SDK 口径：input 已含缓存读写，换算为 fresh input
    let input_tokens = (input_total - cache_read_tokens as i64 - cache_write_tokens as i64)
        .max(0) as u32;

    let model_id = value
        .get("modelID")
        .and_then(|v| v.as_str())
        .or_else(|| value.get("modelId").and_then(|v| v.as_str()))
        .unwrap_or("unknown")
        .to_string();

    let timestamp_ms = value
        .get("time")
        .and_then(|t| t.get("created"))
        .and_then(|v| v.as_i64())
        .unwrap_or(0);

    Some(ZcodeMessageData {
        input_tokens,
        output_tokens,
        reasoning_tokens,
        cache_read_tokens,
        cache_write_tokens,
        model_id,
        timestamp_ms,
    })
}

/// 插入单条 ZCode 消息记录到 proxy_request_logs
fn insert_zcode_message(
    db: &Database,
    request_id: &str,
    msg: &ZcodeMessageData,
    session_id: &str,
) -> Result<bool, AppError> {
    let conn = lock_conn!(db.conn);

    let created_at = if msg.timestamp_ms > 0 {
        msg.timestamp_ms / 1000
    } else {
        SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0)
    };

    // ZCode 是 AI SDK 口径：output 含 reasoning（按输出计费）
    let output_with_reasoning = msg.output_tokens + msg.reasoning_tokens;

    let dedup_key = DedupKey {
        app_type: "zcode",
        model: &msg.model_id,
        input_tokens: msg.input_tokens,
        output_tokens: output_with_reasoning,
        cache_read_tokens: msg.cache_read_tokens,
        cache_creation_tokens: msg.cache_write_tokens,
        created_at,
    };
    if should_skip_session_insert(&conn, request_id, &dedup_key)? {
        return Ok(false);
    }

    // ZCode 不自带费用，用 phi 的模型定价计算；缺定价则记 0 并由账本补齐流程处理
    let (input_cost, output_cost, cache_read_cost, cache_creation_cost, total_cost) =
        match find_model_pricing(&conn, &msg.model_id) {
            Some(pricing) => {
                let usage = TokenUsage {
                    input_tokens: msg.input_tokens,
                    output_tokens: output_with_reasoning,
                    cache_read_tokens: msg.cache_read_tokens,
                    cache_creation_tokens: msg.cache_write_tokens,
                    cache_creation_1h_tokens: 0,
                    model: Some(msg.model_id.clone()),
                    message_id: None,
                };
                let cost = CostCalculator::calculate_for_app(
                    "zcode",
                    &usage,
                    &pricing,
                    Decimal::from(1),
                );
                (
                    cost.input_cost.to_string(),
                    cost.output_cost.to_string(),
                    cost.cache_read_cost.to_string(),
                    cost.cache_creation_cost.to_string(),
                    cost.total_cost.to_string(),
                )
            }
            None => (
                "0".to_string(),
                "0".to_string(),
                "0".to_string(),
                "0".to_string(),
                "0".to_string(),
            ),
        };

    let inserted_rows = conn.execute(
        "INSERT OR IGNORE INTO proxy_request_logs (
            request_id, provider_id, app_type, model, request_model,
            input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
            input_cost_usd, output_cost_usd, cache_read_cost_usd, cache_creation_cost_usd, total_cost_usd,
            latency_ms, first_token_ms, status_code, error_message, session_id,
            provider_type, is_streaming, cost_multiplier, created_at, data_source
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24)",
        rusqlite::params![
            request_id,
            "_zcode_session",      // provider_id
            "zcode",               // app_type
            msg.model_id,
            "",                    // request_model
            msg.input_tokens,
            output_with_reasoning,
            msg.cache_read_tokens,
            msg.cache_write_tokens,
            input_cost,
            output_cost,
            cache_read_cost,
            cache_creation_cost,
            total_cost,
            0,                     // latency_ms
            0,                     // first_token_ms
            200,                   // status_code
            Option::<String>::None, // error_message
            session_id,
            "zcode_session",       // provider_type
            1,                     // is_streaming
            "1.0",                 // cost_multiplier
            created_at,
            "session_log",         // data_source
        ],
    )?;

    Ok(inserted_rows > 0)
}
