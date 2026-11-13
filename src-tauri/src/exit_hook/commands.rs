//! 接棒的 Tauri 命令层。前端只做展示与确认，判决与重启都在后端。

use crate::exit_hook::{service, Attempt, Policy, Status, MAX_HANDOFF_BYTES};
use crate::store::AppState;
use std::io::Read;
use tauri::{Emitter, State};

/// 最近记录条数的默认值与上限。界面偶尔会传大数字，这里夹住。
const DEFAULT_ATTEMPT_LIMIT: usize = 20;
const MAX_ATTEMPT_LIMIT: usize = 100;

fn attempt_limit(limit: Option<usize>) -> usize {
    limit
        .unwrap_or(DEFAULT_ATTEMPT_LIMIT)
        .clamp(1, MAX_ATTEMPT_LIMIT)
}

#[tauri::command]
pub fn baton_status(state: State<'_, AppState>, limit: Option<usize>) -> Result<Status, String> {
    let (policy, attempts) = service::status(&state.db, attempt_limit(limit));
    Ok(Status { policy, attempts })
}

#[tauri::command]
pub fn baton_policy_set(state: State<'_, AppState>, policy: Policy) -> Result<Policy, String> {
    service::save_policy(&state.db, policy).map_err(|error| error.to_string())
}

/// 手动接棒：用户在界面上点名一条记录。
#[tauri::command]
pub fn baton_resume(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<Attempt, String> {
    let attempt = service::resume_attempt(&app, &state.db, id.trim())?;
    let _ = app.emit_to("main", "baton://resumed", &attempt);
    Ok(attempt)
}

/// 读交接单正文。
///
/// 路径来自数据库，但仍要确认它确实落在接棒目录里——数据库不是信任边界。
#[tauri::command]
pub fn baton_handoff(state: State<'_, AppState>, id: String) -> Result<String, String> {
    let attempt = state
        .db
        .baton_attempt(id.trim())
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "unknown-attempt".to_string())?;
    let path = attempt
        .handoff_path
        .ok_or_else(|| "no-handoff".to_string())?;
    let path = std::path::PathBuf::from(path);
    if !path.starts_with(crate::exit_hook::handoff_dir()) {
        log::warn!("[baton] 交接单路径不在接棒目录内，已拒绝: {path:?}");
        return Err("invalid-handoff-path".into());
    }
    let file = std::fs::File::open(&path).map_err(|_| "no-handoff".to_string())?;
    let mut text = String::new();
    file.take(MAX_HANDOFF_BYTES)
        .read_to_string(&mut text)
        .map_err(|error| error.to_string())?;
    if text.len() as u64 == MAX_HANDOFF_BYTES {
        log::warn!("[baton] 交接单被截断到 {MAX_HANDOFF_BYTES} 字节: {path:?}");
        text.push_str("\n\n…（交接单过长，已截断）\n");
    }
    Ok(text)
}
