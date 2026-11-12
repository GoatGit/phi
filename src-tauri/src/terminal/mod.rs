//! Session metadata is backend-owned. Native objects never cross an IPC or
//! worker-thread boundary. Navigation only changes presentation, not ownership.
mod launch;
#[cfg(target_os = "macos")]
mod native;
mod themes;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use tauri::{Emitter, Manager};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub id: String,
    pub app_id: String,
    pub title: String,
    pub launch_cwd: String,
    pub launch_args: String,
    pub phase: String,
    pub generation: u32,
    pub sequence: u64,
    pub error_code: Option<String>,
}
#[derive(Default)]
struct Registry {
    sessions: Vec<Snapshot>,
    requests: HashMap<String, String>,
    closing: bool,
    /// 每个窗格各自的 present 序号。不能全局比大小：分屏时多个窗格并发
    /// present，全局门闸会让乱序后到的那一帧被静默丢弃，该窗格从此卡在
    /// 旧几何（表现为原终端内容消失、新窗格没有 shell）。
    layout_revisions: HashMap<String, u64>,
    /// 最近一次经 IPC 校验的主题（dark 标记，Ghostty 配置文本）。create 时先于
    /// PTY 启动应用：TUI 在启动后立即探测 OSC 10/11 背景色并长期缓存，迟到的
    /// 主题更新会被当成错误的浅色终端，导致浅色填充画在深色终端上。
    theme: Option<(bool, String)>,
}
static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
fn registry() -> &'static Mutex<Registry> {
    REGISTRY.get_or_init(Default::default)
}
fn authorize(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("terminal-access-denied".into());
    }
    Ok(())
}
fn changed(snapshot: &Snapshot) {
    if let Some(app) = APP.get() {
        let _ = app.emit_to("main", "terminal://changed", snapshot);
    }
}

/// 应用名只能是 `launch::cli` 认识的那几个。
/// 接棒从 journal 里读应用名，必须在拿它启动进程之前过这一关。
pub(crate) fn is_cli_app(app_id: &str) -> Result<(), String> {
    launch::cli(app_id)
        .map(|_| ())
        .ok_or_else(|| "unsupported-app".to_string())
}

/// 把一条恢复命令拆成 argv（与启动时用的是同一套规则）。
pub(crate) fn parse_arguments(value: &str) -> Result<Vec<String>, String> {
    launch::parse_arguments(value)
}

/// 把单个参数安全地拼回命令串，供 `parse_arguments` 再拆一次。
pub(crate) fn quote_argument(value: &str) -> String {
    launch::quote(value)
}

/// 同一个应用下不重名的窗格标题。
fn unique_title(state: &Registry, app_id: &str, cwd: &str) -> String {
    let base = std::path::Path::new(cwd)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| app_id.to_string());
    let mut title = base.clone();
    let mut number = 2;
    while state
        .sessions
        .iter()
        .any(|session| session.app_id == app_id && session.title == title)
    {
        title = format!("{base} · {number}");
        number += 1;
    }
    title
}
#[cfg(target_os = "macos")]
fn transition(id: &str, generation: u32, phase: &str, error: Option<String>) {
    let updated = {
        let mut registry = registry().lock().unwrap();
        let Some(session) = registry
            .sessions
            .iter_mut()
            .find(|s| s.id == id && s.generation == generation)
        else {
            return;
        };
        session.phase = phase.into();
        session.error_code = error;
        session.sequence += 1;
        session.clone()
    };
    changed(&updated);
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    supported: bool,
    apps: Vec<&'static str>,
    default_cwd: String,
}
#[tauri::command]
pub fn terminal_capabilities(window: tauri::WebviewWindow) -> Result<Capabilities, String> {
    authorize(&window)?;
    Ok(Capabilities {
        supported: cfg!(target_os = "macos"),
        default_cwd: crate::config::get_home_dir().to_string_lossy().into_owned(),
        apps: if cfg!(target_os = "macos") {
            launch::CLI_APPS.to_vec()
        } else {
            vec![]
        },
    })
}
#[tauri::command]
pub fn terminal_list(window: tauri::WebviewWindow) -> Result<Vec<Snapshot>, String> {
    authorize(&window)?;
    Ok(registry().lock().unwrap().sessions.clone())
}
#[tauri::command]
pub fn terminal_create(
    window: tauri::WebviewWindow,
    app_id: String,
    cwd: Option<String>,
    arguments: Option<String>,
    request_id: String,
    theme: Option<String>,
    dark: Option<bool>,
) -> Result<Snapshot, String> {
    authorize(&window)?;
    if !cfg!(target_os = "macos") {
        return Err("unsupported-platform".into());
    }
    if launch::cli(&app_id).is_none() || uuid::Uuid::parse_str(&request_id).is_err() {
        return Err("invalid-terminal-request".into());
    }
    let dark = dark.unwrap_or(false);
    let theme_config = themes::resolve(theme.as_deref().unwrap_or("auto"), dark)?;
    APP.get_or_init(|| window.app_handle().clone());
    let snapshot = {
        let mut state = registry().lock().unwrap();
        if state.closing {
            return Err("application-exiting".into());
        }
        if let Some(id) = state.requests.get(&request_id) {
            return state
                .sessions
                .iter()
                .find(|s| &s.id == id)
                .cloned()
                .ok_or("request-already-closed".into());
        }
        if state.sessions.len() >= 32 {
            return Err("terminal-limit".into());
        }
        let directory =
            cwd.unwrap_or_else(|| crate::config::get_home_dir().to_string_lossy().into_owned());
        launch::validate_directory(&directory)?;
        let arguments = arguments.unwrap_or_default();
        launch::parse_arguments(&arguments)?;
        let title = unique_title(&state, &app_id, &directory);
        let snapshot = Snapshot {
            id: uuid::Uuid::new_v4().to_string(),
            app_id,
            title,
            launch_cwd: directory,
            launch_args: arguments,
            phase: "checking".into(),
            generation: 1,
            sequence: 1,
            error_code: None,
        };
        state.requests.insert(request_id, snapshot.id.clone());
        state.sessions.push(snapshot.clone());
        state.theme = Some((dark, theme_config.to_owned()));
        snapshot
    };
    begin_start(window, snapshot.clone());
    Ok(snapshot)
}
fn begin_start(window: tauri::WebviewWindow, session: Snapshot) {
    #[cfg(target_os = "macos")]
    tauri::async_runtime::spawn(async move {
        let plan_session = session.clone();
        let journal = crate::exit_hook::journal_path();
        let result = tauri::async_runtime::spawn_blocking(move || {
            // 每个托管会话都记账：接棒的第一手事实是 CLI 自己的退出码。
            launch::prepare_with(
                &plan_session.app_id,
                &plan_session.launch_cwd,
                &plan_session.launch_args,
                Some(launch::ExitHookEnv {
                    terminal_id: &plan_session.id,
                    journal: &journal,
                }),
            )
        })
        .await;
        let plan = match result {
            Ok(Ok(plan)) => plan,
            error => {
                let code = match error {
                    Ok(Err(code)) => code,
                    _ => "startup-failed".into(),
                };
                transition(
                    &session.id,
                    session.generation,
                    if code == "missing-cli" {
                        "missing-cli"
                    } else {
                        "failed"
                    },
                    Some(code),
                );
                return;
            }
        };
        let app = window.app_handle().clone();
        let _ = app.run_on_main_thread(move || {
            let (valid, theme) = {
                let state = registry().lock().unwrap();
                let valid = !state.closing
                    && state.sessions.iter().any(|s| {
                        s.id == session.id
                            && s.generation == session.generation
                            && s.phase == "checking"
                    });
                (valid, state.theme.clone())
            };
            if !valid {
                return;
            }
            let (theme_dark, theme_config) = theme.unwrap_or((false, String::new()));
            transition(&session.id, session.generation, "starting", None);
            match native::create(&window, &session, &plan, theme_dark, &theme_config) {
                Ok(()) => transition(&session.id, session.generation, "running", None),
                Err(error) => transition(&session.id, session.generation, "failed", Some(error)),
            }
        });
    });
    #[cfg(not(target_os = "macos"))]
    let _ = (window, session);
}
/// 接棒用的入口：不经过前端，直接在后台新开一个托管窗格。
///
/// 与 `terminal_create` 的区别：没有 request_id 去重、不改全局主题——
/// 接棒是后台行为，不应该顺手改掉用户当前的终端主题。
pub(crate) fn resume_spawn(
    app: &tauri::AppHandle,
    app_id: &str,
    cwd: &str,
    arguments: &str,
) -> Result<Snapshot, String> {
    if !cfg!(target_os = "macos") {
        return Err("unsupported-platform".into());
    }
    is_cli_app(app_id)?;
    launch::validate_directory(cwd)?;
    launch::parse_arguments(arguments)?;
    APP.get_or_init(|| app.clone());
    let snapshot = {
        let mut state = registry().lock().unwrap();
        if state.closing {
            return Err("application-exiting".into());
        }
        if state.sessions.len() >= 32 {
            log::warn!(
                "[baton] 终端窗格已达上限，续跑被跳过: sessions={}",
                state.sessions.len()
            );
            return Err("terminal-limit".into());
        }
        let snapshot = Snapshot {
            id: uuid::Uuid::new_v4().to_string(),
            app_id: app_id.to_string(),
            title: unique_title(&state, app_id, cwd),
            launch_cwd: cwd.to_string(),
            launch_args: arguments.to_string(),
            phase: "checking".into(),
            generation: 1,
            sequence: 1,
            error_code: None,
        };
        state.sessions.push(snapshot.clone());
        snapshot
    };
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "missing-main-window".to_string())?;
    changed(&snapshot);
    begin_start(window, snapshot.clone());
    Ok(snapshot)
}

#[tauri::command]
pub fn terminal_restart(
    window: tauri::WebviewWindow,
    id: String,
    generation: u32,
) -> Result<Snapshot, String> {
    authorize(&window)?;
    let snapshot = {
        let mut registry = registry().lock().unwrap();
        if registry.closing {
            return Err("application-exiting".into());
        }
        let session = registry
            .sessions
            .iter_mut()
            .find(|s| s.id == id && s.generation == generation)
            .ok_or("stale-session")?;
        if !["failed", "missing-cli", "exited"].contains(&session.phase.as_str()) {
            return Err("terminal-still-running".into());
        }
        session.generation += 1;
        session.sequence = 1;
        session.phase = "checking".into();
        session.error_code = None;
        session.clone()
    };
    #[cfg(target_os = "macos")]
    native::close(&id, generation);
    changed(&snapshot);
    begin_start(window, snapshot.clone());
    Ok(snapshot)
}
#[tauri::command]
pub fn terminal_close(
    window: tauri::WebviewWindow,
    id: String,
    generation: u32,
    confirmed: bool,
) -> Result<(), String> {
    authorize(&window)?;
    {
        let mut registry = registry().lock().unwrap();
        if let Some(session) = registry.sessions.iter().find(|s| s.id == id) {
            if session.generation != generation {
                return Err("stale-session".into());
            }
            if ["starting", "running"].contains(&session.phase.as_str()) && !confirmed {
                return Err("terminal-confirm-required".into());
            }
        } else {
            return Ok(());
        }
        registry.sessions.retain(|s| s.id != id);
    }
    #[cfg(target_os = "macos")]
    native::close(&id, generation);
    Ok(())
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OverlayRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub struct Presentation {
    id: Option<String>,
    revision: u64,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    visible: bool,
    focus: bool,
    dark: bool,
    #[serde(default = "themes::default_theme")]
    theme: String,
    #[serde(default)]
    overlays: Vec<OverlayRect>,
    #[serde(default)]
    blocked: bool,
    #[serde(default)]
    dimmed: bool,
}
#[tauri::command]
pub fn terminal_set_visible(window: tauri::WebviewWindow, ids: Vec<String>) -> Result<(), String> {
    authorize(&window)?;
    if ids.len() > 32 {
        return Err("terminal-limit".into());
    }
    #[cfg(target_os = "macos")]
    native::set_visible(&ids);
    Ok(())
}
#[tauri::command]
pub fn terminal_present(
    window: tauri::WebviewWindow,
    presentation: Presentation,
) -> Result<(), String> {
    authorize(&window)?;
    let p = presentation;
    let theme_config = themes::resolve(&p.theme, p.dark)?;
    if [p.x, p.y, p.width, p.height]
        .iter()
        .any(|v| !v.is_finite() || *v < 0.0 || *v > 32000.0)
    {
        return Err("invalid-terminal-bounds".into());
    }
    if p.overlays.len() > 64
        || p.overlays.iter().any(|r| {
            [r.x, r.y, r.width, r.height]
                .iter()
                .any(|v| !v.is_finite() || *v < 0.0 || *v > 32000.0)
        })
    {
        return Err("invalid-terminal-overlays".into());
    }
    {
        let mut registry = registry().lock().unwrap();
        registry.theme = Some((p.dark, theme_config.to_owned()));
        if let Some(id) = &p.id {
            if !registry.sessions.iter().any(|s| &s.id == id) {
                return Err("unknown-session".into());
            }
            // 只和同一窗格自己的历史序号比：多窗格并发时互不挤占
            if p.revision <= registry.layout_revisions.get(id).copied().unwrap_or(0) {
                return Ok(());
            }
            registry.layout_revisions.insert(id.clone(), p.revision);
        } else {
            // 无 id 的 present（隐藏全部）用任意比历史大的值即可
            if p.revision
                <= registry
                    .layout_revisions
                    .values()
                    .copied()
                    .max()
                    .unwrap_or(0)
                && !registry.layout_revisions.is_empty()
            {
                return Ok(());
            }
            registry.layout_revisions.insert(String::new(), p.revision);
        }
    }
    #[cfg(target_os = "macos")]
    native::present(p);
    Ok(())
}
pub fn confirm_quit() -> bool {
    #[cfg(target_os = "macos")]
    {
        native::confirm_quit()
    }
    #[cfg(not(target_os = "macos"))]
    true
}
pub fn shutdown_main_thread() {
    registry().lock().unwrap().closing = true;
    #[cfg(target_os = "macos")]
    native::shutdown();
}
#[cfg(target_os = "macos")]
pub fn hide_main_thread() {
    native::hide();
}
pub fn has_sessions() -> bool {
    !registry().lock().unwrap().sessions.is_empty()
}
pub async fn prepare_restart(app: &tauri::AppHandle) -> Result<bool, String> {
    let (send, receive) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let accepted = confirm_quit();
        if accepted {
            shutdown_main_thread();
        }
        let _ = send.send(accepted);
    })
    .map_err(|_| "terminal-shutdown-failed")?;
    receive.await.map_err(|_| "terminal-shutdown-failed".into())
}
