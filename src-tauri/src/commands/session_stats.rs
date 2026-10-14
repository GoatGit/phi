//! 会话维度用量统计命令

use crate::error::AppError;
use crate::services::session_stats::{get_session_stats as query_session_stats, SessionStatsPage};
use crate::store::AppState;
use tauri::State;

#[tauri::command]
pub async fn get_session_stats(
    state: State<'_, AppState>,
    days: Option<u32>,
) -> Result<SessionStatsPage, AppError> {
    let db = state.db.clone();
    // 聚合是纯 CPU 的单趟扫描，放到阻塞线程池避免卡 UI
    tauri::async_runtime::spawn_blocking(move || query_session_stats(&db, days.unwrap_or(30)))
        .await
        .map_err(|e| AppError::Config(format!("会话统计任务失败: {e}")))?
}
