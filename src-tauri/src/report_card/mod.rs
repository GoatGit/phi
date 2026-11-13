//! 成绩单（结果账本）：给每个模型在用户自己的代码库上记成绩。
//!
//! 与用量统计的分工：
//! - 用量回答「这次调用花了多少」，数据来自请求日志；
//! - 成绩单回答「这次活干成了没有」，数据来自会话里的工具调用结果与写盘结果。
//!
//! 第一阶段只做可靠性：失败率、中断率、空交付率、单步耗时、单任务成本。
//! 没有验收命令与返工观察，所以不给「通过 / 返工」判决，也不排序质量——
//! `observation_state = "unproven"` 就是这条诚实的边界。

pub(crate) mod aggregate;
pub(crate) mod commands;
pub(crate) mod extract;
mod store;

use crate::database::Database;
use crate::error::AppError;
use aggregate::ModelScoreboardRow;
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};
pub use store::SyncReport;

/// 没有验收与返工证据时的观察状态，前端据此显示「未证实」
const OBSERVATION_UNPROVEN: &str = "unproven";

/// 页面需要的一张表：成绩单 + 本轮同步情况 + 样本覆盖。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportCard {
    pub rows: Vec<ModelScoreboardRow>,
    pub window_days: u32,
    pub since: i64,
    pub generated_at: i64,
    pub observation_state: String,
    pub total_tasks: u64,
    pub providers: u64,
    pub projects: u64,
    pub scanned_sources: u64,
    pub sync: SyncReport,
}

pub(crate) fn create_tables(conn: &rusqlite::Connection) -> Result<(), AppError> {
    store::create_tables(conn)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

/// 同步一轮（受节流约束），再按窗口聚合。
pub fn report_card(db: &Database, days: u32, force: bool) -> Result<ReportCard, AppError> {
    let sync = store::sync(db, force)?;
    assemble(db, days, sync)
}

/// 只做聚合，不扫盘：同步结果由调用方给（也让聚合可以脱库单测）。
fn assemble(db: &Database, days: u32, sync: SyncReport) -> Result<ReportCard, AppError> {
    let generated_at = now_ms();
    let since = generated_at - i64::from(days) * 86_400_000;
    let rows = store::task_rows(db, since)?;
    let (total_tasks, providers, projects) = aggregate::coverage(&rows);
    Ok(ReportCard {
        rows: aggregate::aggregate(&rows),
        window_days: days,
        since,
        generated_at,
        observation_state: OBSERVATION_UNPROVEN.to_string(),
        total_tasks,
        providers,
        projects,
        scanned_sources: store::scanned_sources(db)?,
        sync,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_database_reports_an_empty_unproven_card() {
        let db = Database::memory().expect("memory db");
        let card = assemble(&db, 30, SyncReport::default()).expect("report card");
        assert!(card.rows.is_empty());
        assert_eq!(card.total_tasks, 0);
        assert_eq!(card.observation_state, OBSERVATION_UNPROVEN);
        assert_eq!(card.window_days, 30);
    }
}
