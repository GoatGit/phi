use super::launch::LaunchPlan;
use super::{Presentation, Snapshot};
use std::ffi::{c_char, c_void, CStr, CString};
use tauri::Manager;

extern "C" {
    fn phi_terminal_init(
        callback: extern "C" fn(*const c_char, *const c_char),
        resources: *const c_char,
    ) -> bool;
    fn phi_terminal_create(
        window: *mut c_void,
        id: *const c_char,
        command: *const c_char,
        cwd: *const c_char,
        environment: *const c_char,
    ) -> bool;
    fn phi_terminal_present(
        id: *const c_char,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        visible: bool,
        focus: bool,
        dark: bool,
        theme_config: *const c_char,
        overlay_config: *const c_char,
    );
    fn phi_terminal_hide();
    fn phi_terminal_close(id: *const c_char);
    fn phi_terminal_shutdown();
    fn phi_terminal_confirm_quit() -> bool;
}
fn c(value: &str) -> Result<CString, String> {
    CString::new(value).map_err(|_| "invalid-terminal-value".into())
}
extern "C" fn event(id: *const c_char, event: *const c_char) {
    if id.is_null() || event.is_null() {
        return;
    }
    let key = unsafe { CStr::from_ptr(id) }.to_string_lossy();
    let Some((id, generation)) = key.rsplit_once(':') else {
        return;
    };
    let Ok(generation) = generation.parse::<u32>() else {
        return;
    };
    if !super::registry()
        .lock()
        .unwrap()
        .sessions
        .iter()
        .any(|s| s.id == id && s.generation == generation)
    {
        return;
    }
    let event = unsafe { CStr::from_ptr(event) }.to_string_lossy();
    if event == "exited" {
        super::transition(id, generation, "exited", None);
    } else if let Some(app) = super::APP.get() {
        use tauri::Emitter;
        let _ = app.emit_to(
            "main",
            "terminal://action",
            serde_json::json!({"id":id,"action":event}),
        );
    }
}
pub fn create(
    window: &tauri::WebviewWindow,
    session: &Snapshot,
    plan: &LaunchPlan,
) -> Result<(), String> {
    let bundled = window
        .app_handle()
        .path()
        .resource_dir()
        .map_err(|_| "terminal-resources-missing")?
        .join("ghostty/share/ghostty");
    let resources = if bundled.is_dir() {
        bundled
    } else {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("ghostty-sdk/share/ghostty")
    };
    let resources = c(&resources.to_string_lossy())?;
    let id = c(&format!("{}:{}", session.id, session.generation))?;
    let command = c(&plan.command)?;
    let cwd = c(&plan.cwd.to_string_lossy())?;
    let environment =
        c(&serde_json::to_string(&plan.environment).map_err(|_| "invalid-environment")?)?;
    unsafe {
        if !phi_terminal_init(event, resources.as_ptr()) {
            return Err("terminal-engine-unavailable".into());
        }
        if !phi_terminal_create(
            window
                .ns_window()
                .map_err(|_| "native-window-unavailable")?,
            id.as_ptr(),
            command.as_ptr(),
            cwd.as_ptr(),
            environment.as_ptr(),
        ) {
            return Err("terminal-surface-failed".into());
        }
    }
    Ok(())
}
pub fn present(p: Presentation) {
    unsafe {
        let id = p.id.and_then(|id| {
            super::registry()
                .lock()
                .unwrap()
                .sessions
                .iter()
                .find(|s| s.id == id)
                .and_then(|s| c(&format!("{}:{}", s.id, s.generation)).ok())
        });
        if let Some(id) = id {
            // terminal_present validates the ID before this main-thread call.
            let theme = c(super::themes::resolve(&p.theme, p.dark).unwrap()).unwrap();
            let overlays: Vec<_> = p
                .overlays
                .iter()
                .map(|r| {
                    serde_json::json!({
                        "x": r.x, "y": r.y, "width": r.width, "height": r.height,
                    })
                })
                .collect();
            let overlay_config = c(&serde_json::json!({
                "rects": overlays, "blocked": p.blocked, "dimmed": p.dimmed,
            })
            .to_string())
            .unwrap();
            phi_terminal_present(
                id.as_ptr(),
                p.x,
                p.y,
                p.width,
                p.height,
                p.visible,
                p.focus,
                p.dark,
                theme.as_ptr(),
                overlay_config.as_ptr(),
            );
        } else {
            phi_terminal_hide();
        }
    }
}
pub fn close(id: &str, generation: u32) {
    if let Ok(id) = c(&format!("{id}:{generation}")) {
        unsafe {
            phi_terminal_close(id.as_ptr());
        }
    }
}
pub fn shutdown() {
    unsafe {
        phi_terminal_shutdown();
    }
}
pub fn hide() {
    unsafe { phi_terminal_hide() }
}
pub fn confirm_quit() -> bool {
    unsafe { phi_terminal_confirm_quit() }
}
