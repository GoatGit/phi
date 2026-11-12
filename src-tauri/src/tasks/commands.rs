//! 任务看板的 Tauri 命令层。
//!
//! 所有读写都限制在「用户登记过的工作区」内：`root` 参数先规范化，再比对本机
//! 登记表。这样前端即使拿到任意路径也读不了别人的目录。

use crate::store::AppState;
use crate::tasks::model::{Board, NewTask, TaskDetail, TaskLink, WorkspaceInfo};
use crate::tasks::{board, document, repository};
use std::path::{Path, PathBuf};
use tauri::State;

fn canonical(root: &str) -> Result<PathBuf, String> {
    let path = Path::new(root)
        .canonicalize()
        .map_err(|_| "invalid-directory".to_string())?;
    if !path.is_dir() {
        return Err("invalid-directory".into());
    }
    Ok(path)
}

fn registered(state: &AppState, root: &str) -> Result<PathBuf, String> {
    let path = canonical(root)?;
    let roots = state.db.task_workspaces().map_err(|e| e.to_string())?;
    if !roots.iter().any(|entry| Path::new(entry) == path) {
        return Err("workspace-not-registered".into());
    }
    Ok(path)
}

fn open(state: &AppState, root: &str) -> Result<document::Workspace, String> {
    document::open(&registered(state, root)?)
}

fn detail_with_links(
    state: &AppState,
    workspace: &document::Workspace,
    id: &str,
) -> Result<TaskDetail, String> {
    let mut detail = repository::read(workspace, id)?;
    detail.links = state
        .db
        .task_links(&workspace.root.to_string_lossy(), &detail.task.id)
        .map_err(|e| e.to_string())?;
    Ok(detail)
}

#[tauri::command]
pub fn task_workspaces(state: State<'_, AppState>) -> Result<Vec<WorkspaceInfo>, String> {
    let roots = state.db.task_workspaces().map_err(|e| e.to_string())?;
    Ok(roots
        .iter()
        .map(|root| board::info(Path::new(root)))
        .collect())
}

/// 登记一个已存在的 backlog 工作区。缺 `backlog/config.yml` 时返回 `no-backlog`，
/// 前端据此提供「初始化」而不是让用户自己去建目录。
#[tauri::command]
pub fn task_workspace_add(
    state: State<'_, AppState>,
    root: String,
) -> Result<WorkspaceInfo, String> {
    let path = canonical(&root)?;
    let workspace = document::open(&path)?;
    let key = workspace.root.to_string_lossy().into_owned();
    state
        .db
        .add_task_workspace(&key)
        .map_err(|e| e.to_string())?;
    Ok(board::info(&workspace.root))
}

/// 在用户选中的目录里建一份最小的 backlog 布局（config.yml + tasks + archive）。
#[tauri::command]
pub fn task_workspace_init(
    state: State<'_, AppState>,
    root: String,
    project_name: Option<String>,
) -> Result<WorkspaceInfo, String> {
    let path = canonical(&root)?;
    let workspace = document::initialize(&path, project_name.as_deref().unwrap_or_default())?;
    let key = workspace.root.to_string_lossy().into_owned();
    state
        .db
        .add_task_workspace(&key)
        .map_err(|e| e.to_string())?;
    Ok(board::info(&workspace.root))
}

#[tauri::command]
pub fn task_workspace_remove(state: State<'_, AppState>, root: String) -> Result<(), String> {
    // 目录被删掉后也要能移除登记，所以先按原字符串比对；对不上再走规范化校验。
    let roots = state.db.task_workspaces().map_err(|e| e.to_string())?;
    let matched = roots
        .into_iter()
        .find(|entry| entry == &root)
        .or_else(|| {
            let path = registered(&state, &root).ok()?;
            Some(path.to_string_lossy().into_owned())
        })
        .ok_or_else(|| "workspace-not-registered".to_string())?;
    state
        .db
        .remove_task_workspace(&matched)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn task_board(state: State<'_, AppState>, root: String) -> Result<Board, String> {
    let workspace = open(&state, &root)?;
    let tasks = repository::list(&workspace)?;
    Ok(board::project(&workspace, tasks))
}

#[tauri::command]
pub fn task_detail(
    state: State<'_, AppState>,
    root: String,
    task_id: String,
) -> Result<TaskDetail, String> {
    let workspace = open(&state, &root)?;
    detail_with_links(&state, &workspace, &task_id)
}

#[tauri::command]
pub fn task_create(
    state: State<'_, AppState>,
    root: String,
    input: NewTask,
) -> Result<TaskDetail, String> {
    let workspace = open(&state, &root)?;
    let detail = repository::create(&workspace, &input)?;
    detail_with_links(&state, &workspace, &detail.task.id)
}

#[tauri::command]
pub fn task_set_status(
    state: State<'_, AppState>,
    root: String,
    task_id: String,
    status: String,
    fingerprint: String,
) -> Result<TaskDetail, String> {
    let workspace = open(&state, &root)?;
    if !workspace.config.statuses.iter().any(|item| item == &status) {
        return Err("unknown-status".into());
    }
    let detail = repository::set_status(&workspace, &task_id, &status, &fingerprint)?;
    detail_with_links(&state, &workspace, &detail.task.id)
}

#[tauri::command]
pub fn task_archive(
    state: State<'_, AppState>,
    root: String,
    task_id: String,
    fingerprint: String,
) -> Result<(), String> {
    let workspace = open(&state, &root)?;
    repository::archive(&workspace, &task_id, &fingerprint)
}

#[tauri::command]
pub fn task_link_session(
    state: State<'_, AppState>,
    root: String,
    task_id: String,
    session_id: String,
    app_id: String,
) -> Result<TaskLink, String> {
    let workspace = open(&state, &root)?;
    if session_id.trim().is_empty() || app_id.trim().is_empty() {
        return Err("invalid-link".into());
    }
    state
        .db
        .link_task_session(
            &workspace.root.to_string_lossy(),
            &task_id.trim().to_uppercase(),
            session_id.trim(),
            app_id.trim(),
        )
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn task_unlink_session(
    state: State<'_, AppState>,
    root: String,
    task_id: String,
    session_id: String,
) -> Result<(), String> {
    let workspace = open(&state, &root)?;
    state
        .db
        .unlink_task_session(
            &workspace.root.to_string_lossy(),
            &task_id.trim().to_uppercase(),
            session_id.trim(),
        )
        .map_err(|e| e.to_string())
}
