//! Session metadata is backend-owned. Native objects never cross an IPC or
//! worker-thread boundary. Navigation only changes presentation, not ownership.
mod launch;
#[cfg(target_os = "macos")]
pub(crate) use launch::{prepare_worker, ExitHookEnv};
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
    /// 这个窗格是哪个 worker 的查看器（只有查看器才有）。
    ///
    /// 查看器活着不代表 worker 活着：`zellij attach` 这个客户端会一直挂着，
    /// 它自己退出也杀不掉里面的 worker。界面要靠这个字段去问 worker 的状态，
    /// 不能把这个窗格的 phase 当成任务进度。
    pub worker_session: Option<String>,
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

/// 某个会话是否还在托管中。后台调度器用它判断派出去的 worker 是否已经退出。
pub(crate) fn session_exists(id: &str) -> bool {
    registry()
        .lock()
        .map(|state| state.sessions.iter().any(|session| session.id == id))
        .unwrap_or(false)
}

/// 只供测试：假装有一个托管会话活着。
///
/// 真实场景里，CLI 退出后 PTY 会落回一个交互式 shell，会话并没有从表里消失；
/// 回归用例需要同一个前提，又不想为了它起一个真 PTY。
#[cfg(test)]
pub(crate) fn register_test_session(id: &str) {
    let mut state = registry().lock().unwrap();
    state.sessions.push(Snapshot {
        id: id.to_string(),
        app_id: "claude".into(),
        title: "test".into(),
        launch_cwd: "/tmp".into(),
        launch_args: String::new(),
        phase: "running".into(),
        generation: 1,
        sequence: 1,
        error_code: None,
        worker_session: None,
    });
}

/// 关闭后台调度器自己派发的会话：不做 IPC 校验，按当前 generation 强制关闭。
/// 找不到会话视为已关，返回 Ok。
pub(crate) fn close_by_id(id: &str) -> Result<(), String> {
    let generation = {
        let mut state = registry().lock().unwrap();
        let Some(session) = state.sessions.iter().find(|session| session.id == id) else {
            return Ok(());
        };
        let generation = session.generation;
        state.sessions.retain(|session| session.id != id);
        generation
    };
    #[cfg(target_os = "macos")]
    native::close(id, generation);
    #[cfg(not(target_os = "macos"))]
    let _ = generation;
    Ok(())
}

/// 把一条恢复命令拆成 argv（与启动时用的是同一套规则）。
pub(crate) fn parse_arguments(value: &str) -> Result<Vec<String>, String> {
    launch::parse_arguments(value)
}

/// 把单个参数安全地拼回命令串，供 `parse_arguments` 再拆一次。
pub(crate) fn quote_argument(value: &str) -> String {
    launch::quote(value)
}

/// 后台 worker 的启动参数：非交互模式 + 一句指令。
///
/// 自动派发与看板上的「开始」都必须用它：两条入口各说一套，就会出现
/// 「机器派的知道干完就退出、人点的那个永远停在提示符」这种分叉。
pub(crate) fn worker_arguments(app: &str, prompt: &str) -> String {
    launch::worker_arguments(app, prompt)
}

/// 同一个应用下不重名的窗格标题。
fn unique_title(state: &Registry, app_id: &str, cwd: &str) -> String {
    unique_title_of(state, app_id, &default_title(cwd, app_id))
}

/// 默认标题：目录名，拿不到就用应用名。
fn default_title(cwd: &str, app_id: &str) -> String {
    std::path::Path::new(cwd)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| app_id.to_string())
}

/// 同一应用下不重名的标题。查看器要带着自己的标题来（`zellij · TASK-3`），
/// 不能拿目录名冒充——它显示的是「在哪看」，不显示「跑的是什么」。
fn unique_title_of(state: &Registry, app_id: &str, base: &str) -> String {
    let mut title = base.to_string();
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
            worker_session: None,
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
    {
        let plan_session = session.clone();
        begin_start_with(window, session, move || {
            let journal = crate::exit_hook::journal_path();
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
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (window, session);
}

/// 两条启动路径（CLI / 直接跑 argv）共用这一段：解析失败要落到具体的 phase，
/// 成功则回到主线程建 surface。分开写两份，迟早有一份忘了置失败态。
#[cfg(target_os = "macos")]
fn begin_start_with<F>(window: tauri::WebviewWindow, session: Snapshot, prepare: F)
where
    F: FnOnce() -> Result<launch::LaunchPlan, String> + Send + 'static,
{
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn(async move {
        let result = tauri::async_runtime::spawn_blocking(prepare).await;
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
}

/// 同一个 worker 已经开着的查看器。
///
/// 只认还活着的（checking / starting / running）：已经退出的查看器留着只是历史，
/// 再点「打开终端」必须重开一个，否则人会点到一个断开的空壳。
fn existing_viewer(sessions: &[Snapshot], worker_session: &str) -> Option<Snapshot> {
    sessions
        .iter()
        .find(|session| {
            session.worker_session.as_deref() == Some(worker_session)
                && matches!(session.phase.as_str(), "checking" | "starting" | "running")
        })
        .cloned()
}

/// 后台开一个「查看器」窗格：不做 CLI 解析，直接把 argv 交给 PTY。
///
/// 目前只有一处用处：worker 跑在 zellij 里，要把它显示在 phi 界面上，
/// 就挂一个 `zellij attach` 的客户端——关掉这个窗格只是断开查看，
/// worker 本身照旧在 zellij 的 server 里跑。
///
/// 同一个 worker 已经有活的查看器时直接把它交回去：一个 worker 挂两个客户端，
/// 两个标签页会抢同一块画面（zellij 的焦点是会话级的），看起来就像又挂错了 pane。
pub(crate) fn open_viewer(
    app: &tauri::AppHandle,
    app_id: &str,
    title: &str,
    cwd: &str,
    argv: Vec<String>,
    environment: std::collections::BTreeMap<String, String>,
    worker_session: &str,
) -> Result<Snapshot, String> {
    if !cfg!(target_os = "macos") {
        return Err("unsupported-platform".into());
    }
    launch::validate_directory(cwd)?;
    APP.get_or_init(|| app.clone());
    let snapshot = {
        let mut state = registry().lock().unwrap();
        if state.closing {
            return Err("application-exiting".into());
        }
        // 已经开着同一块 worker 的画面：别再加一个客户端。
        if let Some(existing) = existing_viewer(&state.sessions, worker_session) {
            return Ok(existing);
        }
        if state.sessions.len() >= 32 {
            return Err("terminal-limit".into());
        }
        let snapshot = Snapshot {
            id: uuid::Uuid::new_v4().to_string(),
            app_id: app_id.to_string(),
            title: unique_title_of(&state, app_id, title),
            launch_cwd: cwd.to_string(),
            // 查看器没有「重启后重新拉起」的语义：它的命令由调用方每次重新拼。
            launch_args: String::new(),
            phase: "checking".into(),
            generation: 1,
            sequence: 1,
            error_code: None,
            worker_session: Some(worker_session.to_string()),
        };
        state.sessions.push(snapshot.clone());
        snapshot
    };
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "missing-main-window".to_string())?;
    changed(&snapshot);
    #[cfg(target_os = "macos")]
    {
        let directory = cwd.to_string();
        begin_start_with(window, snapshot.clone(), move || {
            launch::prepare_raw(&directory, &argv, environment)
        });
    }
    // 非 macOS 上没有 Ghostty surface：参数在这里就算用掉了，函数开头已经
    // 返回 unsupported-platform，这一支只为让签名跨平台一致。
    #[cfg(not(target_os = "macos"))]
    let _ = (window, argv, environment);
    Ok(snapshot)
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
            worker_session: None,
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

#[cfg(test)]
mod tests {
    use super::*;

    fn viewer(id: &str, worker: &str, phase: &str) -> Snapshot {
        Snapshot {
            id: id.into(),
            app_id: "codex".into(),
            title: "zellij".into(),
            launch_cwd: "/tmp".into(),
            launch_args: String::new(),
            phase: phase.into(),
            generation: 1,
            sequence: 1,
            error_code: None,
            worker_session: Some(worker.into()),
        }
    }

    #[test]
    fn a_live_viewer_is_reused_instead_of_opening_a_second_client() {
        // 两个客户端挂同一个 zellij session 会抢同一块画面（焦点是会话级的），
        // 看起来就像又挂错了 pane；同一个 worker 只给一个查看器。
        let sessions = vec![
            viewer("a", "session-1", "running"),
            viewer("b", "session-2", "running"),
        ];
        assert_eq!(
            existing_viewer(&sessions, "session-1").map(|session| session.id),
            Some("a".into())
        );
        assert_eq!(
            existing_viewer(&sessions, "session-3").map(|session| session.id),
            None
        );

        // 已经退出的查看器只是历史，不是可复用的窗口。
        let stale = vec![viewer("c", "session-4", "exited")];
        assert_eq!(
            existing_viewer(&stale, "session-4").map(|session| session.id),
            None
        );
    }
}
