//! 成绩单的 Tauri 命令层。
//!
//! 扫描与解析都在阻塞线程池里跑；页面来回切时由 store 的节流挡住重复扫盘。

use crate::report_card::{self, ReportCard};
use crate::store::AppState;
use tauri::State;

#[tauri::command]
pub async fn report_card_page(
    state: State<'_, AppState>,
    days: Option<u32>,
    refresh: Option<bool>,
) -> Result<ReportCard, String> {
    let db = state.db.clone();
    let days = days.unwrap_or(30).clamp(1, 365);
    let force = refresh.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        report_card::report_card(&db, days, force).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("成绩单聚合失败: {e}"))?
}
