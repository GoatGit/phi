//! Compact menu-bar window. Snapshots reuse the native menu's availability rules
//! and cached quota data; no provider settings or credentials cross this DTO.
use super::*;
use tauri::{LogicalSize, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

pub const WINDOW_ID: &str = "tray-panel";
const WIDTH: f64 = 440.;
const HEIGHT: f64 = 520.;
static LAST_BLUR: Mutex<Option<std::time::Instant>> = Mutex::new(None);

/// Both mouse buttons share one release action; down/hover must not toggle twice.
pub fn click_anchor(event: &tauri::tray::TrayIconEvent) -> Option<tauri::Rect> {
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent};
    match event {
        TrayIconEvent::Click {
            button: MouseButton::Left | MouseButton::Right,
            button_state: MouseButtonState::Up,
            rect,
            ..
        } => Some(*rect),
        _ => None,
    }
}
pub fn dismiss_on_blur(app: &tauri::AppHandle) {
    *lock(&LAST_BLUR) = Some(std::time::Instant::now());
    hide(app);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelOption {
    id: String,
    label: String,
    enabled: bool,
    selected: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelQuota {
    text: String,
    remaining: Option<f64>,
    resets_at: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelAgent {
    id: String,
    name: String,
    mode: String,
    connected: bool,
    gateway: bool,
    can_connect: bool,
    provider_name: Option<String>,
    providers: Vec<PanelOption>,
    models: Vec<String>,
    quota: Vec<PanelQuota>,
    quota_error: Option<String>,
    attention: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelSnapshot {
    pub agents: Vec<PanelAgent>,
    pub problems: Vec<String>,
    pub feedback: Option<String>,
    pub routing_in_use: bool,
    pub profiles: Vec<PanelProfile>,
    pub updated_at: i64,
}
#[derive(Serialize)]
pub struct PanelProfile {
    scope: String,
    name: String,
    items: Vec<PanelOption>,
}

fn option(entry: TrayEntry) -> Option<PanelOption> {
    match entry {
        TrayEntry::Check {
            id,
            text,
            enabled,
            checked,
        } => Some(PanelOption {
            id,
            label: text,
            enabled,
            selected: checked,
        }),
        TrayEntry::Item { id, text, enabled } if !id.starts_with("info:") => Some(PanelOption {
            id,
            label: text,
            enabled,
            selected: false,
        }),
        _ => None,
    }
}
#[tauri::command]
pub async fn get_tray_panel(state: tauri::State<'_, AppState>) -> Result<PanelSnapshot, String> {
    let texts = TrayTexts::current();
    let (snapshots, status) = collect_status(state.inner(), &texts).map_err(|e| e.to_string())?;
    let catalog = state.db.gateway_catalog().map_err(|e| e.to_string())?;
    let mut agents = Vec::new();
    let mut profiles = Vec::new();
    for snapshot in snapshots {
        let app_id = snapshot.app.as_str();
        let mode_state = crate::mode::current::mode_state(&snapshot.app);
        let gateway = mode_state.is_proxy()
            && mode_state
                .proxy_route
                .as_deref()
                .is_some_and(|id| id.starts_with("gateway-entry:"));
        let can_connect = crate::mode::controller::PROXY_APPS.contains(&snapshot.app);
        let mut providers: Vec<_> = provider_rows(&texts, &snapshot)
            .into_iter()
            .filter_map(option)
            .collect();
        let has_gateway = catalog
            .policies
            .iter()
            .any(|p| p.enabled && p.app_id == app_id)
            || catalog
                .groups
                .iter()
                .any(|g| g.enabled && g.app_ids.iter().any(|a| a == app_id));
        if can_connect && has_gateway {
            if gateway {
                for option in &mut providers {
                    option.selected = false;
                }
            }
            providers.insert(
                0,
                PanelOption {
                    id: format!("gateway:{app_id}"),
                    label: "PHI".into(),
                    enabled: true,
                    selected: gateway,
                },
            );
        }
        let models = if gateway {
            catalog
                .groups
                .iter()
                .filter(|g| g.enabled && g.app_ids.iter().any(|a| a == app_id))
                .map(|g| format!("group/{}", g.id))
                .chain(
                    catalog
                        .policies
                        .iter()
                        .filter(|p| p.enabled && p.app_id == app_id)
                        .flat_map(|p| {
                            if !p.match_model.is_empty() {
                                vec![p.match_model.clone()]
                            } else {
                                p.candidates.iter().map(|c| c.model.clone()).collect()
                            }
                        }),
                )
                .collect()
        } else {
            snapshot
                .current_id
                .as_deref()
                .and_then(|id| state.db.get_provider_by_id(id, app_id).ok().flatten())
                .map(|p| crate::gateway::provider_models(&p))
                .unwrap_or_default()
        };
        let (quota, quota_error) = match &snapshot.quota {
            Some(QuotaView::Lines(lines)) => (
                lines
                    .iter()
                    .map(|line| PanelQuota {
                        text: line.text.clone(),
                        remaining: line.left.is_finite().then_some(line.left.clamp(0., 100.)),
                        resets_at: line.resets_at.clone(),
                    })
                    .collect(),
                None,
            ),
            Some(view @ QuotaView::Failed(_)) => {
                (vec![], quota_note(&texts, view, chrono::Local::now()))
            }
            None => (vec![], None),
        };
        if let Some(profile) = &snapshot.profiles {
            let mut items = vec![PanelOption {
                id: format!("profile_none_{}", profile.scope),
                label: texts.no_project_label.into(),
                enabled: true,
                selected: profile.current.is_none(),
            }];
            items.extend(profile.items.iter().map(|(id, name)| PanelOption {
                id: format!("profile_{}_{id}", profile.scope),
                label: name.clone(),
                enabled: true,
                selected: profile.current.as_ref() == Some(id),
            }));
            profiles.push(PanelProfile {
                scope: profile.scope.into(),
                name: app_display_name(&snapshot.app).into(),
                items,
            });
        }
        agents.push(PanelAgent {
            id: app_id.into(),
            name: app_display_name(&snapshot.app).into(),
            mode: match snapshot.mode {
                TrayMode::Direct | TrayMode::Desktop => "direct",
                TrayMode::Route => "route",
                TrayMode::Failover => "failover",
                TrayMode::Stack => "stack",
            }
            .into(),
            connected: snapshot.uses_service(),
            gateway,
            can_connect,
            provider_name: if gateway {
                Some("PHI".into())
            } else {
                snapshot.current().map(|p| p.name.clone())
            },
            providers,
            models,
            quota,
            quota_error,
            attention: snapshot.needs_attention,
        });
    }
    Ok(PanelSnapshot {
        agents,
        problems: status
            .problems
            .iter()
            .map(|p| problem_text(&texts, p))
            .collect(),
        feedback: status.feedback.as_ref().map(|f| feedback_text(&texts, f)),
        routing_in_use: status.routing_in_use,
        profiles,
        updated_at: chrono::Utc::now().timestamp_millis(),
    })
}

#[tauri::command]
pub async fn refresh_tray_panel(app: tauri::AppHandle) {
    refresh_all_usage_in_tray(&app).await;
}
#[tauri::command]
pub fn hide_tray_panel(app: tauri::AppHandle) {
    hide(&app);
}
pub fn hide(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(WINDOW_ID) {
        let _ = window.hide();
    }
}

/// UI actions are the same validated native menu entries. Provider/profile
/// operations retain the existing mode controller, native projection and errors.
#[tauri::command]
pub async fn tray_panel_action(app: tauri::AppHandle, id: String) -> Result<Vec<String>, String> {
    if id == "quit" {
        app.exit(0);
        return Ok(vec![]);
    }
    if matches!(
        id.as_str(),
        "show_main"
            | "nav:settings:general"
            | "nav:settings:apps"
            | "nav:page:routingOverview"
            | "nav:page:usage"
    ) || id.starts_with("nav:app:")
        || id.starts_with("nav:needs:")
    {
        hide(&app);
        handle_tray_menu_event(&app, &id);
        return Ok(vec![]);
    }
    let state = app.state::<AppState>();
    let snapshot = get_tray_panel(state.clone()).await?;
    if !snapshot
        .agents
        .iter()
        .flat_map(|a| &a.providers)
        .chain(snapshot.profiles.iter().flat_map(|p| &p.items))
        .any(|o| o.id == id && o.enabled)
    {
        return Err("trayPanel.unavailable".into());
    }
    let mut warnings = vec![];
    if let Some(app_id) = id.strip_prefix("gateway:") {
        crate::commands::connect_gateway_app(state, app_id.into(), None, None).await?;
    } else if let Some(rest) = id.strip_prefix("prov:") {
        let (app_id, provider_id) = rest.split_once(':').ok_or("trayPanel.unavailable")?;
        warnings = crate::commands::switch_provider(app.clone(), app_id.into(), provider_id.into())
            .await?
            .warnings;
        let app_type = app_id.parse::<AppType>().map_err(|e| e.to_string())?;
        clear_app_problems(&app_type);
        let mode = tray_mode(state.inner(), &app_type);
        let name = state
            .db
            .get_provider_by_id(provider_id, app_id)
            .ok()
            .flatten()
            .map(|provider| provider.name)
            .unwrap_or_else(|| provider_id.into());
        if let Some(feedback) = switch_feedback(&app_type, mode, name) {
            record_feedback(&app, feedback);
        }
        emit_switched(&app, &app_type, provider_id);
    } else if let Some(scope) = id.strip_prefix("profile_none_") {
        state
            .db
            .set_current_profile_id(scope, None)
            .map_err(|e| e.to_string())?;
    } else if let Some(rest) = id.strip_prefix("profile_") {
        let (scope, profile_id) = rest.split_once('_').ok_or("trayPanel.unavailable")?;
        let handle = app.clone();
        let scope = scope.to_string();
        let profile_id = profile_id.to_string();
        warnings = tauri::async_runtime::spawn_blocking(move || {
            crate::commands::apply_profile(
                handle.clone(),
                handle.state::<AppState>(),
                profile_id,
                scope,
            )
        })
        .await
        .map_err(|e| e.to_string())??;
    }
    refresh_tray_menu(&app);
    Ok(warnings)
}

/// Place in physical screen coordinates, including monitors to the left/above
/// the primary display. Clamp against the usable area, and flip above a taskbar.
fn placement(
    anchor: (f64, f64, f64, f64),
    area: (f64, f64, f64, f64),
    size: (f64, f64),
    gap: f64,
) -> (f64, f64) {
    let (ax, ay, aw, ah) = anchor;
    let (x, y, w, h) = area;
    let (pw, ph) = size;
    let left = (ax + aw / 2. - pw / 2.).clamp(x, (x + w - pw).max(x));
    let below = ay + ah + gap;
    let top = if below + ph <= y + h {
        below.max(y)
    } else {
        (ay - ph - gap).clamp(y, (y + h - ph).max(y))
    };
    (left, top)
}
pub fn toggle(app: &tauri::AppHandle, rect: tauri::Rect) -> tauri::Result<()> {
    // Clicking the status item first blurs the webview; avoid immediately reopening it.
    if lock(&LAST_BLUR).is_some_and(|at| at.elapsed() < std::time::Duration::from_millis(200)) {
        return Ok(());
    }

    if let Some(window) = app.get_webview_window(WINDOW_ID) {
        if window.is_visible()? {
            window.hide()?;
            return Ok(());
        }
    }
    let window = if let Some(window) = app.get_webview_window(WINDOW_ID) {
        window
    } else {
        WebviewWindowBuilder::new(app, WINDOW_ID, WebviewUrl::App("tray.html".into()))
            .title("PHI")
            .inner_size(WIDTH, HEIGHT)
            .resizable(false)
            .decorations(false)
            .transparent(true)
            .shadow(true)
            .skip_taskbar(true)
            .always_on_top(true)
            .visible_on_all_workspaces(true)
            .visible(false)
            .build()?
    };
    let initial = rect.position.to_physical::<f64>(window.scale_factor()?);
    let monitor = window
        .monitor_from_point(initial.x, initial.y)?
        .or(window.current_monitor()?);
    if let Some(monitor) = monitor {
        let scale = monitor.scale_factor();
        let area = monitor.work_area();
        let position = rect.position.to_physical::<f64>(scale);
        let anchor_size = rect.size.to_physical::<f64>(scale);
        let width = (WIDTH * scale).min(f64::from(area.size.width));
        let height = (HEIGHT * scale).min(f64::from(area.size.height));
        window.set_size(PhysicalSize::new(width as u32, height as u32))?;
        let (x, y) = placement(
            (
                position.x,
                position.y,
                anchor_size.width,
                anchor_size.height,
            ),
            (
                f64::from(area.position.x),
                f64::from(area.position.y),
                f64::from(area.size.width),
                f64::from(area.size.height),
            ),
            (width, height),
            6. * scale,
        );
        window.set_position(PhysicalPosition::new(x as i32, y as i32))?;
    } else {
        window.set_size(LogicalSize::new(WIDTH, HEIGHT))?;
    }
    window.show()?;
    window.set_focus()?;
    window.emit("tray-panel-shown", ())?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn both_buttons_toggle_once_on_release() {
        use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent};
        let rect = tauri::Rect {
            position: PhysicalPosition::new(800, 0).into(),
            size: PhysicalSize::new(24, 24).into(),
        };
        for button in [MouseButton::Left, MouseButton::Right, MouseButton::Middle] {
            for state in [MouseButtonState::Down, MouseButtonState::Up] {
                let event = TrayIconEvent::Click {
                    id: super::super::TRAY_ID.into(),
                    position: PhysicalPosition::new(812., 12.),
                    rect,
                    button,
                    button_state: state,
                };
                let anchor = click_anchor(&event);
                assert_eq!(
                    anchor.is_some(),
                    button != MouseButton::Middle && state == MouseButtonState::Up,
                );
                if let Some(anchor) = anchor {
                    assert_eq!(anchor.position, rect.position);
                    assert_eq!(anchor.size, rect.size);
                }
            }
        }
        assert!(click_anchor(&TrayIconEvent::Enter {
            id: super::super::TRAY_ID.into(),
            position: PhysicalPosition::new(812., 12.),
            rect,
        })
        .is_none());
    }
    #[test]
    fn placement_clamps_and_flips_across_monitors() {
        assert_eq!(
            placement(
                (900., 0., 24., 24.),
                (0., 24., 1000., 700.),
                (440., 520.),
                6.
            ),
            (560., 30.)
        );
        assert_eq!(
            placement(
                (-1100., 0., 24., 24.),
                (-1200., 24., 1200., 700.),
                (440., 520.),
                6.
            ),
            (-1200., 30.)
        );
        assert_eq!(
            placement(
                (500., 760., 24., 24.),
                (0., 0., 1200., 760.),
                (440., 520.),
                6.
            ),
            (292., 234.)
        );
    }
}
