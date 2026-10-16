//! 会话维度用量统计
//!
//! 基于 `proxy_request_logs`（会话导入 + 网关代理）按 session_id 聚合，
//! 支撑用量页的「会话」「上下文」两个统计面板：
//! - 会话：条数 / Token / 费用 / 缓存命中 / 活跃时长（相邻请求间隔 < 5 分钟才计为工作）
//! - 上下文：逐请求的上下文水位（fresh input + cache read + cache creation 的会话内累计），
//!   供前端做压缩识别复核与压缩阈值重放调优
//!
//! 与 magpie 的差异：数据来自已入库的请求行（明细保留 30 天，更早已 rollup 成无会话维度），
//! 而非全量解析会话文件；活跃时长按请求行间隔近似。

use crate::database::{lock_conn, Database};
use crate::error::AppError;
use crate::services::sql_helpers::{fresh_input_sql, INPUT_TOKEN_SEMANTICS_FRESH};
use chrono::{Datelike, Local, TimeZone, Timelike};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// 单个会话的聚合
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatsEntry {
    pub app_type: String,
    pub session_id: String,
    pub requests: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    pub cost_usd: f64,
    /// 首个请求时间（Unix 秒）
    pub first_at: i64,
    pub last_at: i64,
    /// 活跃时长（秒）：相邻请求间隔 < 5 分钟才累计
    pub active_seconds: i64,
    /// 上下文水位峰值（会话内累计的 fresh input + cache read + cache creation）
    pub peak_context_tokens: i64,
    /// 自动压缩次数（沿用 magpie 判定：前值 ≥ 20K 且后值 < 60%）
    pub compactions: u64,
}

/// 每日聚合（本地时区日期）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatsDay {
    pub date: String,
    pub app_type: String,
    pub requests: u64,
    pub sessions: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    pub cost_usd: f64,
    pub active_seconds: i64,
}

/// 星期 × 小时的活跃秒数
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatsHour {
    /// 0 = 周一
    pub weekday: u8,
    pub hour: u8,
    pub app_type: String,
    pub seconds: i64,
}

/// 上下文水位采样点（上下文统计用）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionContextPoint {
    pub app_type: String,
    pub session_id: String,
    /// Unix 秒
    pub created_at: i64,
    pub model: String,
    /// 该请求的上下文水位（会话内累计的 fresh input + cache read + cache creation）
    pub context_tokens: i64,
    pub output_tokens: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatsPage {
    pub sessions: Vec<SessionStatsEntry>,
    pub days: Vec<SessionStatsDay>,
    pub hours: Vec<SessionStatsHour>,
    pub context_points: Vec<SessionContextPoint>,
    pub generated_at: i64,
}

const IDLE_GAP_SECONDS: i64 = 5 * 60;
/// 压缩判定沿用 magpie：前值 ≥ 20K 且后值 < 60%
const COMPACTION_MIN_PREV: i64 = 20_000;
/// 上下文采样点：每会话保留最近 N 个
const POINTS_PER_SESSION: usize = 160;
/// 上下文点列表最多覆盖的会话数（按最近活跃排序）
const CONTEXT_SESSION_LIMIT: usize = 80;
/// 参与上下文统计的最少请求数
const CONTEXT_MIN_REQUESTS: u64 = 3;

/// 会话维度聚合。`days` 为 0 时取全部可用明细（明细保留 30 天，更早已 rollup）。
pub fn get_session_stats(db: &Database, days: u32) -> Result<SessionStatsPage, AppError> {
    let conn = lock_conn!(db.conn);
    get_session_stats_impl(&conn, days)
}

fn get_session_stats_impl(
    conn: &rusqlite::Connection,
    days: u32,
) -> Result<SessionStatsPage, AppError> {
    let fresh_input = fresh_input_sql("l");
    let since: i64 = if days == 0 {
        0
    } else {
        Local::now().timestamp() - (days as i64) * 86_400
    };

    // 逐行拉取（按会话、时间排序），在 Rust 侧一趟算出：
    // 会话聚合、每日聚合、小时热力图、活跃时长、上下文水位点。
    let sql = format!(
        "SELECT l.session_id,
                l.app_type,
                l.created_at,
                COALESCE(l.model, ''),
                {fresh_input},
                COALESCE(l.output_tokens, 0),
                COALESCE(l.cache_read_tokens, 0),
                COALESCE(l.cache_creation_tokens, 0),
                COALESCE(CAST(l.total_cost_usd AS REAL), 0),
                COALESCE(l.input_token_semantics, 0)
         FROM proxy_request_logs l
         WHERE l.created_at >= ?1 AND l.session_id <> ''
         ORDER BY l.session_id, l.created_at, l.rowid"
    );

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![since], |row| {
        let semantics: i64 = row.get(9)?;
        let cache_read: i64 = row.get(6)?;
        let cache_creation: i64 = row.get(7)?;
        Ok(RawPoint {
            session_id: row.get(0)?,
            app_type: row.get(1)?,
            created_at: row.get(2)?,
            model: row.get(3)?,
            // 水位口径统一为 fresh input + cache read + cache creation：
            // semantics 已是 FRESH 的行 fresh_input 就是原始 input（需补缓存两项）；
            // 其余行 fresh_input 已扣除缓存，直接三项相加。
            fresh_input: row.get(4)?,
            output: row.get(5)?,
            cache_read,
            cache_creation,
            cost: row.get(8)?,
            cache_extra: if semantics == INPUT_TOKEN_SEMANTICS_FRESH {
                cache_read + cache_creation
            } else {
                0
            },
        })
    })?;

    struct RawPoint {
        session_id: String,
        app_type: String,
        created_at: i64,
        model: String,
        fresh_input: i64,
        output: i64,
        cache_read: i64,
        cache_creation: i64,
        cost: f64,
        /// semantics = FRESH 的行 input 本身不含缓存，水位需补上这两项
        cache_extra: i64,
    }

    let mut sessions: Vec<SessionStatsEntry> = Vec::new();
    let mut day_map: HashMap<(String, String), SessionStatsDay> = HashMap::new();
    // 每天出现过的会话键（用于每日会话数去重）
    let mut day_session_keys: HashMap<(String, String), std::collections::HashSet<String>> =
        HashMap::new();
    let mut hour_map: HashMap<(String, u8, u8), i64> = HashMap::new();
    let mut context_points: Vec<SessionContextPoint> = Vec::new();
    let mut context_sessions: Vec<(String, i64)> = Vec::new(); // (session_key, last_at)

    // 当前会话的运行累计
    let mut cur_key = String::new();
    let mut cur_app = String::new();
    let mut cur_first: i64 = 0;
    let mut cur_prev: i64 = 0;
    let mut cur_active: i64 = 0;
    let mut cur_level: i64 = 0;
    let mut cur_peak: i64 = 0;
    let mut cur_compactions: u64 = 0;
    let mut cur_requests: u64 = 0;
    let mut cur_input: u64 = 0;
    let mut cur_output: u64 = 0;
    let mut cur_cache_read: u64 = 0;
    let mut cur_cache_creation: u64 = 0;
    let mut cur_cost: f64 = 0.0;
    let mut cur_points: Vec<SessionContextPoint> = Vec::new();

    for row in rows {
        let row = row?;
        let new_session = cur_key != row.session_id;

        if new_session {
            if !cur_key.is_empty() {
                sessions.push(flush_session(
                    &cur_key,
                    &cur_app,
                    cur_first,
                    cur_prev,
                    cur_active,
                    cur_peak,
                    cur_compactions,
                    cur_requests,
                    cur_input,
                    cur_output,
                    cur_cache_read,
                    cur_cache_creation,
                    cur_cost,
                    &cur_points,
                    &mut context_points,
                    &mut context_sessions,
                ));
            }
            cur_key = row.session_id.clone();
            cur_app = row.app_type.clone();
            cur_first = row.created_at;
            cur_prev = row.created_at;
            cur_active = 0;
            cur_level = 0;
            cur_peak = 0;
            cur_compactions = 0;
            cur_requests = 0;
            cur_input = 0;
            cur_output = 0;
            cur_cache_read = 0;
            cur_cache_creation = 0;
            cur_cost = 0.0;
            cur_points.clear();
        }

        let dt = Local
            .timestamp_opt(row.created_at, 0)
            .single()
            .unwrap_or_else(Local::now);

        // 活跃时长：与上一请求的间隔 < 5 分钟才计为工作，归属本行（后一行）的星期/小时
        let gap = row.created_at - cur_prev;
        if !new_session && gap >= 0 && gap < IDLE_GAP_SECONDS {
            cur_active += gap;
            let key = (
                row.app_type.clone(),
                (dt.weekday().num_days_from_monday()) as u8,
                dt.hour() as u8,
            );
            *hour_map.entry(key).or_insert(0) += gap;
        }

        // 每日聚合（本地日期 × 应用）
        let date = dt.format("%Y-%m-%d").to_string();
        let day = day_map
            .entry((date.clone(), row.app_type.clone()))
            .or_insert_with(|| SessionStatsDay {
                date: date.clone(),
                app_type: row.app_type.clone(),
                requests: 0,
                sessions: 0,
                input_tokens: 0,
                output_tokens: 0,
                cache_read_tokens: 0,
                cache_creation_tokens: 0,
                cost_usd: 0.0,
                active_seconds: 0,
            });
        day.requests += 1;
        day.input_tokens += row.fresh_input.max(0) as u64;
        day.output_tokens += row.output.max(0) as u64;
        day.cache_read_tokens += row.cache_read.max(0) as u64;
        day.cache_creation_tokens += row.cache_creation.max(0) as u64;
        day.cost_usd += row.cost;
        let day_key = format!("{}\0{}", row.session_id, date);
        if day_session_keys
            .entry((date, row.app_type.clone()))
            .or_default()
            .insert(day_key)
        {
            day.sessions += 1;
        }

        // 会话累计
        cur_requests += 1;
        cur_input += row.fresh_input.max(0) as u64;
        cur_output += row.output.max(0) as u64;
        cur_cache_read += row.cache_read.max(0) as u64;
        cur_cache_creation += row.cache_creation.max(0) as u64;
        cur_cost += row.cost;

        // 上下文水位：会话内累计 fresh input + cache read + cache creation
        cur_level += row.fresh_input + row.cache_read + row.cache_creation + row.cache_extra;
        if cur_level > cur_peak {
            cur_peak = cur_level;
        }
        if cur_requests > 1 && cur_prev >= COMPACTION_MIN_PREV && cur_level < (cur_prev * 3) / 5 {
            cur_compactions += 1;
        }
        cur_points.push(SessionContextPoint {
            app_type: cur_app.clone(),
            session_id: cur_key.clone(),
            created_at: row.created_at,
            model: row.model.clone(),
            context_tokens: cur_level,
            output_tokens: row.output,
        });
        if cur_points.len() > POINTS_PER_SESSION {
            cur_points.remove(0);
        }

        cur_prev = row.created_at;
    }
    if !cur_key.is_empty() {
        sessions.push(flush_session(
            &cur_key,
            &cur_app,
            cur_first,
            cur_prev,
            cur_active,
            cur_peak,
            cur_compactions,
            cur_requests,
            cur_input,
            cur_output,
            cur_cache_read,
            cur_cache_creation,
            cur_cost,
            &cur_points,
            &mut context_points,
            &mut context_sessions,
        ));
    }

    // 上下文点列表：只保留最近活跃的 N 个会话（每会话最多 POINTS_PER_SESSION 个点）
    context_sessions.sort_by(|a, b| b.1.cmp(&a.1));
    let keep: std::collections::HashSet<String> = context_sessions
        .into_iter()
        .take(CONTEXT_SESSION_LIMIT)
        .map(|(k, _)| k)
        .collect();
    context_points.retain(|p| keep.contains(&format!("{}\0{}", p.app_type, p.session_id)));

    let mut days: Vec<SessionStatsDay> = day_map.into_values().collect();
    days.sort_by(|a, b| {
        a.date
            .cmp(&b.date)
            .then_with(|| a.app_type.cmp(&b.app_type))
    });
    let mut hours: Vec<SessionStatsHour> = hour_map
        .into_iter()
        .map(|((app_type, weekday, hour), seconds)| SessionStatsHour {
            app_type,
            weekday,
            hour,
            seconds,
        })
        .collect();
    hours.sort_by_key(|h| (h.app_type.clone(), h.weekday, h.hour));

    Ok(SessionStatsPage {
        sessions,
        days,
        hours,
        context_points,
        generated_at: Local::now().timestamp(),
    })
}

#[allow(clippy::too_many_arguments)]
fn flush_session(
    key: &str,
    app_type: &str,
    first_at: i64,
    last_at: i64,
    active_seconds: i64,
    peak: i64,
    compactions: u64,
    requests: u64,
    input: u64,
    output: u64,
    cache_read: u64,
    cache_creation: u64,
    cost: f64,
    points: &[SessionContextPoint],
    context_points: &mut Vec<SessionContextPoint>,
    context_sessions: &mut Vec<(String, i64)>,
) -> SessionStatsEntry {
    if requests >= CONTEXT_MIN_REQUESTS {
        context_sessions.push((format!("{app_type}\0{key}"), last_at));
        context_points.extend_from_slice(points);
    }
    SessionStatsEntry {
        app_type: app_type.to_string(),
        session_id: key.to_string(),
        requests,
        input_tokens: input,
        output_tokens: output,
        cache_read_tokens: cache_read,
        cache_creation_tokens: cache_creation,
        cost_usd: cost,
        first_at,
        last_at,
        active_seconds,
        peak_context_tokens: peak,
        compactions,
    }
}
