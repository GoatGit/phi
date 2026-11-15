//! 任务看板的 Tauri 命令层。
//!
//! 所有读写都限制在「用户登记过的工作区」内：`root` 参数先规范化，再比对本机
//! 登记表。这样前端即使拿到任意路径也读不了别人的目录。

use crate::store::AppState;
use crate::super_agent::model::RouterSettings;
use crate::tasks::model::{Board, NewTask, TaskDetail, TaskLink, WorkspaceInfo};
use crate::tasks::{board, document, repository};
use crate::Database;
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

fn registered_in(db: &Database, root: &str) -> Result<PathBuf, String> {
    let path = canonical(root)?;
    let roots = db.task_workspaces().map_err(|e| e.to_string())?;
    if !roots.iter().any(|entry| Path::new(entry) == path) {
        return Err("workspace-not-registered".into());
    }
    Ok(path)
}

fn registered(state: &AppState, root: &str) -> Result<PathBuf, String> {
    registered_in(&state.db, root)
}

pub(crate) fn open(state: &AppState, root: &str) -> Result<document::Workspace, String> {
    open_in(&state.db, root)
}

/// 只要 `Database` 的版本：门判定在阻塞线程池里跑，那里拿不到 `AppState`。
pub(crate) fn open_in(db: &Database, root: &str) -> Result<document::Workspace, String> {
    document::open(&registered_in(db, root)?)
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
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    root: String,
    input: NewTask,
) -> Result<TaskDetail, String> {
    let workspace = open(&state, &root)?;
    // 读不到调度设置不该拦住建卡：自动派发是附加能力，设置表出问题时
    // 退回默认值（未启用）就够，用户仍然能把卡建出来。
    let settings = state.db.router_settings().unwrap_or_else(|error| {
        log::warn!("router settings read failed, auto-start skipped: {error}");
        crate::super_agent::model::RouterSettings::default()
    });
    let (input, auto_started) = auto_start_input(&settings, &workspace.config.statuses, input);
    let detail = repository::create(&workspace, &input)?;
    let detail = detail_with_links(&state, &workspace, &detail.task.id)?;
    // 自动调度开着的时候，新建的卡已经落进触发列：立刻踢一轮，不用干等下一个
    // 节拍。否则用户建完看到的是一张不会动的卡，只能自己再拖一次或按「开始」。
    if auto_started {
        crate::super_agent::runtime::kick(&app);
    }
    Ok(detail)
}

/// 自动调度在跑的时候，新建的卡直接落进触发列。
///
/// 两处默认值叠在一起会让人以为调度器坏了：新建只收标题，状态走工作区的默认列
/// （`To Do`）；自动调度只认触发列（默认 `In Progress`）。所以「建完就等」永远
/// 等不到派发。这里的取舍是「新建 ＝ 交给调度器」。
///
/// 总开关关着或影子模式时不动它：影子模式不会真的派发，把卡挪进执行列只是骗人。
/// 用户显式指定了状态也尊重用户。
fn auto_start_input(
    settings: &RouterSettings,
    statuses: &[String],
    input: NewTask,
) -> (NewTask, bool) {
    if !settings.enabled || settings.shadow || input.status.is_some() {
        return (input, false);
    }
    if !statuses
        .iter()
        .any(|status| status == &settings.trigger_status)
    {
        return (input, false);
    }
    (
        NewTask {
            status: Some(settings.trigger_status.clone()),
            ..input
        },
        true,
    )
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

#[cfg(test)]
mod tests {
    use super::auto_start_input;
    use crate::super_agent::model::RouterSettings;
    use crate::tasks::model::NewTask;

    fn statuses() -> Vec<String> {
        vec!["To Do".into(), "In Progress".into(), "Done".into()]
    }

    fn new_task() -> NewTask {
        NewTask {
            title: "整理今天的AI新闻".into(),
            description: None,
            status: None,
            priority: None,
            assignees: None,
            labels: None,
            dependencies: None,
            acceptance: None,
        }
    }

    fn running() -> RouterSettings {
        RouterSettings {
            enabled: true,
            shadow: false,
            ..RouterSettings::default()
        }
    }

    #[test]
    fn new_task_enters_trigger_column_when_router_runs() {
        let (input, auto) = auto_start_input(&running(), &statuses(), new_task());
        assert!(auto, "调度器在跑时新建的卡应当直接交给它");
        assert_eq!(input.status.as_deref(), Some("In Progress"));
    }

    #[test]
    fn shadow_mode_keeps_the_default_column() {
        let settings = RouterSettings {
            shadow: true,
            ..running()
        };
        let (input, auto) = auto_start_input(&settings, &statuses(), new_task());
        assert!(!auto, "影子模式不会派发，挪进执行列只会骗人");
        assert!(input.status.is_none());
    }

    #[test]
    fn disabled_router_keeps_the_default_column() {
        let settings = RouterSettings {
            enabled: false,
            ..running()
        };
        let (_, auto) = auto_start_input(&settings, &statuses(), new_task());
        assert!(!auto);
    }

    #[test]
    fn explicit_status_wins() {
        let input = NewTask {
            status: Some("Done".into()),
            ..new_task()
        };
        let (kept, auto) = auto_start_input(&running(), &statuses(), input);
        assert!(!auto, "用户自己写了状态就不该被改写");
        assert_eq!(kept.status.as_deref(), Some("Done"));
    }

    #[test]
    fn unknown_trigger_column_falls_back() {
        let settings = RouterSettings {
            trigger_status: "执行中".into(),
            ..running()
        };
        let (_, auto) = auto_start_input(&settings, &statuses(), new_task());
        assert!(!auto, "触发列不在看板上时不能写一个不存在的状态");
    }
}
