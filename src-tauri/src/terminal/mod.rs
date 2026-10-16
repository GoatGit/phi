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
) -> Result<Snapshot, String> {
    authorize(&window)?;
    if !cfg!(target_os = "macos") {
        return Err("unsupported-platform".into());
    }
    if launch::cli(&app_id).is_none() || uuid::Uuid::parse_str(&request_id).is_err() {
        return Err("invalid-terminal-request".into());
    }
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
        let base = std::path::Path::new(&directory)
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| app_id.clone());
        let mut title = base.clone();
        let mut number = 2;
        while state
            .sessions
            .iter()
            .any(|s| s.app_id == app_id && s.title == title)
        {
            title = format!("{base} · {number}");
            number += 1;
        }
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
        snapshot
    };
    begin_start(window, snapshot.clone());
    Ok(snapshot)
}
fn begin_start(window: tauri::WebviewWindow, session: Snapshot) {
    #[cfg(target_os = "macos")]
    tauri::async_runtime::spawn(async move {
        let plan_session = session.clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            launch::prepare(
                &plan_session.app_id,
                &plan_session.launch_cwd,
                &plan_session.launch_args,
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
            let valid = {
                let state = registry().lock().unwrap();
                !state.closing
                    && state.sessions.iter().any(|s| {
                        s.id == session.id
                            && s.generation == session.generation
                            && s.phase == "checking"
                    })
            };
            if !valid {
                return;
            }
            transition(&session.id, session.generation, "starting", None);
            match native::create(&window, &session, &plan) {
                Ok(()) => transition(&session.id, session.generation, "running", None),
                Err(error) => transition(&session.id, session.generation, "failed", Some(error)),
            }
        });
    });
    #[cfg(not(target_os = "macos"))]
    let _ = (window, session);
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
pub fn terminal_set_visible(
    window: tauri::WebviewWindow,
    ids: Vec<String>,
) -> Result<(), String> {
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
    themes::resolve(&p.theme, p.dark)?;
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
            if p.revision <= registry.layout_revisions.values().copied().max().unwrap_or(0)
                && !registry.layout_revisions.is_empty()
            {
                return Ok(());
            }
            registry
                .layout_revisions
                .insert(String::new(), p.revision);
        }
    }
    #[cfg(target_os = "macos")]
    native::present(p);
    Ok(())
}
pub fn confirm_quit() -> bool {
    #[cfg(target_os = "macos")]
    {
        return native::confirm_quit();
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
