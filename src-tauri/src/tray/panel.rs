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
    model_options: Vec<PanelOption>,
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

fn group_options(catalog: &crate::gateway::Catalog, app_id: &str) -> Vec<PanelOption> {
    let selected = crate::gateway::routing::app_connection(catalog, app_id)
        .and_then(|p| p.group_id.as_deref());
    catalog
        .groups
        .iter()
        .filter(|g| g.enabled && g.app_ids.iter().any(|a| a == app_id))
        .map(|g| PanelOption {
            id: format!("group:{app_id}:{}", g.id),
            label: g.name.clone(),
            enabled: true,
            selected: selected == Some(g.id.as_str()),
        })
        .collect()
}

fn direct_model_options(app: &AppType, provider: &Provider) -> Vec<PanelOption> {
    let settings = &provider.settings_config;
    let config = settings
        .get("config")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse::<toml::Value>().ok());
    let selected = match app {
        AppType::Claude => settings
            .pointer("/env/ANTHROPIC_MODEL")
            .and_then(|v| v.as_str()),
        AppType::Gemini => settings
            .pointer("/env/GEMINI_MODEL")
            .and_then(|v| v.as_str()),
        AppType::Codex => config
            .as_ref()
            .and_then(|c| c.get("model"))
            .and_then(|v| v.as_str()),
        AppType::GrokBuild => config
            .as_ref()
            .and_then(|c| {
                c.get("models")
                    .and_then(|m| m.get("default"))
                    .or_else(|| c.get("model"))
            })
            .and_then(|v| v.as_str()),
        _ => None,
    };
    let models = if *app == AppType::GrokBuild {
        config
            .as_ref()
            .and_then(|c| c.get("model"))
            .and_then(|m| m.as_table())
            .map(|models| models.keys().cloned().collect())
            .unwrap_or_else(|| selected.into_iter().map(str::to_string).collect())
    } else if *app == AppType::ClaudeDesktop {
        // Desktop owns the active conversation model; PHI can publish its
        // catalog, but cannot set a native default that Desktop doesn't expose.
        provider
            .meta
            .as_ref()
            .map(|m| m.claude_desktop_model_routes.keys().cloned().collect())
            .unwrap_or_default()
    } else {
        crate::gateway::provider_models(provider)
    };
    models
        .into_iter()
        .map(|model| PanelOption {
            id: format!(
                "model:{}:{}",
                app.as_str(),
                serde_json::to_string(&(&provider.id, &model)).unwrap()
            ),
            selected: selected == Some(model.as_str()),
            label: model,
            enabled: matches!(
                app,
                AppType::Claude | AppType::Codex | AppType::Gemini | AppType::GrokBuild
            ),
        })
        .collect()
}

fn set_direct_model(
    app: &AppType,
    provider: &mut Provider,
    model: &str,
    catalog: &crate::gateway::Catalog,
) -> Result<(), String> {
    if !catalog_model_options(app, provider, catalog)
        .iter()
        .any(|o| o.enabled && o.label == model)
    {
        return Err("trayPanel.unavailable".into());
    }
    match app {
        AppType::Claude | AppType::Gemini => {
            let key = if *app == AppType::Claude {
                "ANTHROPIC_MODEL"
            } else {
                "GEMINI_MODEL"
            };
            let root = provider
                .settings_config
                .as_object_mut()
                .ok_or("trayPanel.unavailable")?;
            let env = root.entry("env").or_insert_with(|| serde_json::json!({}));
            env.as_object_mut()
                .ok_or("trayPanel.unavailable")?
                .insert(key.into(), serde_json::Value::String(model.into()));
        }
        AppType::Codex | AppType::GrokBuild => {
            let config = provider
                .settings_config
                .get("config")
                .and_then(|v| v.as_str())
                .ok_or("trayPanel.unavailable")?;
            let mut document = config
                .parse::<toml_edit::DocumentMut>()
                .map_err(|e| e.to_string())?;
            if *app == AppType::Codex || document.get("model").is_some_and(|v| v.is_str()) {
                document["model"] = toml_edit::value(model);
            } else {
                document["models"]["default"] = toml_edit::value(model);
            }
            provider.settings_config["config"] = serde_json::Value::String(document.to_string());
        }
        _ => return Err("trayPanel.unavailable".into()),
    }
    Ok(())
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
        // A provider selection always means direct access, regardless of the
        // current native menu mode (route/failover/stack).
        let mut providers = provider_options(&snapshot, &catalog, mode_state.is_proxy());
        let has_gateway = catalog
            .policies
            .iter()
            .any(|p| p.enabled && p.app_id == app_id)
            || !group_options(&catalog, app_id).is_empty();
        if can_connect {
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
                    enabled: has_gateway,
                    selected: gateway,
                },
            );
        }
        let direct_provider = if !mode_state.is_proxy() {
            snapshot
                .current_id
                .as_deref()
                .map(|id| state.db.get_provider_by_id(id, app_id))
                .transpose()
                .map_err(|e| e.to_string())?
                .flatten()
        } else {
            None
        };
        let model_options =
            selection_options(&snapshot.app, direct_provider.as_ref(), &catalog, gateway);
        let models = model_options.iter().map(|o| o.label.clone()).collect();
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
            model_options,
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

fn selection_options(
    app: &AppType,
    provider: Option<&Provider>,
    catalog: &crate::gateway::Catalog,
    gateway: bool,
) -> Vec<PanelOption> {
    if gateway {
        group_options(catalog, app.as_str())
    } else {
        let mut options = provider
            .map(|p| catalog_model_options(app, p, catalog))
            .unwrap_or_default();
        options.extend(
            group_options(catalog, app.as_str())
                .into_iter()
                .map(|mut option| {
                    // A saved group binding is not the active selection in direct mode.
                    option.selected = false;
                    option
                }),
        );
        options
    }
}

fn catalog_model_options(
    app: &AppType,
    provider: &Provider,
    catalog: &crate::gateway::Catalog,
) -> Vec<PanelOption> {
    let mut options = direct_model_options(app, provider);
    if let Some(supplier) = provider
        .id
        .strip_prefix("gateway-supplier:")
        .and_then(|id| catalog.suppliers.iter().find(|s| s.id == id))
    {
        for model in &supplier.models {
            if !options.iter().any(|o| o.label == *model) {
                options.push(PanelOption {
                    id: format!(
                        "model:{}:{}",
                        app.as_str(),
                        serde_json::to_string(&(&provider.id, model)).unwrap()
                    ),
                    label: model.clone(),
                    selected: false,
                    enabled: crate::gateway::direct_protocol_for(app)
                        == Some(supplier.endpoint.protocol.as_str()),
                });
            }
        }
    }
    options
}

fn provider_options(
    snapshot: &AppSnapshot,
    catalog: &crate::gateway::Catalog,
    is_proxy: bool,
) -> Vec<PanelOption> {
    let listed: Vec<_> = snapshot
        .providers
        .iter()
        .filter(|p| !p.id.starts_with("gateway-entry:"))
        .filter(|p| {
            !catalog
                .suppliers
                .iter()
                .any(|s| p.id == format!("gateway-supplier:{}", s.id))
        })
        .collect();
    let mut providers: Vec<_> = listed
        .iter()
        .zip(display_names(&listed))
        .map(|(p, label)| PanelOption {
            id: provider_id_for(&snapshot.app, &p.id),
            label,
            enabled: !p.needs_routing || snapshot.app == AppType::ClaudeDesktop,
            selected: !is_proxy && snapshot.current_id.as_deref() == Some(p.id.as_str()),
        })
        .collect();
    providers.extend(catalog.suppliers.iter().map(|supplier| PanelOption {
        id: format!("supplier:{}:{}", snapshot.app.as_str(), supplier.id),
        label: supplier.name.clone(),
        enabled: crate::gateway::direct_protocol_for(&snapshot.app)
            == Some(supplier.endpoint.protocol.as_str()),
        selected: !is_proxy
            && snapshot.current_id.as_deref()
                == Some(format!("gateway-supplier:{}", supplier.id).as_str()),
    }));
    providers
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
        .flat_map(|a| a.providers.iter().chain(&a.model_options))
        .chain(snapshot.profiles.iter().flat_map(|p| &p.items))
        .any(|o| o.id == id && o.enabled)
    {
        return Err("trayPanel.unavailable".into());
    }
    let mut warnings = vec![];
    if let Some(app_id) = id.strip_prefix("gateway:") {
        crate::commands::connect_gateway_app(state, app_id.into(), None, None).await?;
    } else if let Some(rest) = id.strip_prefix("group:") {
        let (app_id, group_id) = rest.split_once(':').ok_or("trayPanel.unavailable")?;
        crate::commands::connect_gateway_app(
            state.clone(),
            app_id.into(),
            Some(group_id.into()),
            None,
        )
        .await?;
    } else if let Some(rest) = id.strip_prefix("model:") {
        let (app_id, selection) = rest.split_once(':').ok_or("trayPanel.unavailable")?;
        let (provider_id, model): (String, String) =
            serde_json::from_str(selection).map_err(|_| "trayPanel.unavailable")?;
        let app_type = app_id.parse::<AppType>().map_err(|e| e.to_string())?;
        let mut provider = state
            .db
            .get_provider_by_id(&provider_id, app_id)
            .map_err(|e| e.to_string())?
            .ok_or("trayPanel.unavailable")?;
        let catalog = state.db.gateway_catalog().map_err(|e| e.to_string())?;
        set_direct_model(&app_type, &mut provider, &model, &catalog)?;
        crate::commands::update_provider(app.clone(), app_id.into(), provider, None, None).await?;
        emit_switched(&app, &app_type, &provider_id);
    } else if id.starts_with("prov:") || id.starts_with("supplier:") {
        let is_supplier = id.starts_with("supplier:");
        let rest = id
            .strip_prefix("supplier:")
            .or_else(|| id.strip_prefix("prov:"))
            .unwrap();
        let (app_id, target_id) = rest.split_once(':').ok_or("trayPanel.unavailable")?;
        let provider_id = if is_supplier {
            state
                .db
                .materialize_supplier_provider(app_id, target_id)
                .map_err(|e| e.to_string())?
        } else {
            target_id.to_string()
        };
        let app_type = app_id.parse::<AppType>().map_err(|e| e.to_string())?;
        if crate::mode::current::is_proxy(&app_type) {
            crate::mode::controller::exit(state.inner(), &app_type).await?;
        }
        warnings =
            crate::commands::switch_provider(app.clone(), app_id.into(), provider_id.clone())
                .await?
                .warnings;
        let app_type = app_id.parse::<AppType>().map_err(|e| e.to_string())?;
        clear_app_problems(&app_type);
        let mode = tray_mode(state.inner(), &app_type);
        let name = state
            .db
            .get_provider_by_id(&provider_id, app_id)
            .ok()
            .flatten()
            .map(|provider| provider.name)
            .unwrap_or_else(|| provider_id.clone());
        if let Some(feedback) = switch_feedback(&app_type, mode, name) {
            record_feedback(&app, feedback);
        }
        emit_switched(&app, &app_type, &provider_id);
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

    fn pool_catalog() -> crate::gateway::Catalog {
        let mut catalog = crate::gateway::Catalog::default();
        for (id, protocol) in [("pool", "openai_responses"), ("chat", "openai_chat")] {
            catalog.suppliers.push(
                serde_json::from_value(serde_json::json!({
                    "id": id, "name": format!("Supplier {id}"),
                    "endpoint": {"protocol": protocol, "baseUrl": "https://example.com"},
                    "models": ["one", "two"]
                }))
                .unwrap(),
            );
        }
        catalog
    }

    #[test]
    fn provider_options_include_pool_suppliers_without_duplicate_materialized_rows() {
        let catalog = pool_catalog();
        let provider = Provider::with_id(
            "gateway-supplier:pool".into(),
            "Old name".into(),
            serde_json::json!({}),
            None,
        );
        let snapshot = AppSnapshot {
            app: AppType::Codex,
            mode: TrayMode::Direct,
            providers: vec![provider_entry(&AppType::Codex, &provider)],
            current_id: Some(provider.id),
            queue: vec![],
            stack_members: vec![],
            quota: None,
            service_down: false,
            needs_attention: false,
            profiles: None,
        };
        let options = provider_options(&snapshot, &catalog, false);
        assert_eq!(options.len(), 2);
        let pool = options
            .iter()
            .find(|o| o.id == "supplier:codex:pool")
            .expect("pool supplier is listed");
        assert_eq!(pool.label, "Supplier pool");
        assert!(pool.enabled && pool.selected);
        assert!(
            !options
                .iter()
                .find(|o| o.id == "supplier:codex:chat")
                .unwrap()
                .enabled
        );
        assert!(provider_options(&snapshot, &catalog, true)
            .iter()
            .all(|o| !o.selected));
    }

    #[test]
    fn catalog_models_include_pool_updates_and_preserve_selected_model() {
        let catalog = pool_catalog();
        let provider = Provider::with_id(
            "gateway-supplier:pool".into(),
            "Pool".into(),
            serde_json::json!({"config": "model = \"one\""}),
            None,
        );
        let options = catalog_model_options(&AppType::Codex, &provider, &catalog);
        assert_eq!(
            options.iter().map(|o| o.label.as_str()).collect::<Vec<_>>(),
            vec!["one", "two"]
        );
        assert!(options[0].selected);
        assert!(!options[1].selected);
        let mut provider = provider;
        set_direct_model(&AppType::Codex, &mut provider, "two", &catalog).unwrap();
        assert!(catalog_model_options(&AppType::Codex, &provider, &catalog)
            .iter()
            .any(|o| o.label == "two" && o.selected));
        assert!(set_direct_model(&AppType::Codex, &mut provider, "unknown", &catalog).is_err());
    }

    #[test]
    fn grok_pool_models_preserve_scalar_native_config() {
        let catalog = pool_catalog();
        let mut provider = Provider::with_id(
            "gateway-supplier:pool".into(),
            "Pool".into(),
            serde_json::json!({"config": "# keep\nmodel = \"one\"\nbase_url = \"https://example.com\"\n"}),
            None,
        );
        let options = catalog_model_options(&AppType::GrokBuild, &provider, &catalog);
        assert!(options.iter().any(|o| o.label == "one" && o.selected));
        set_direct_model(&AppType::GrokBuild, &mut provider, "two", &catalog).unwrap();
        let config = provider.settings_config["config"].as_str().unwrap();
        assert!(config.contains("# keep"));
        let value: toml::Value = toml::from_str(config).unwrap();
        assert_eq!(value["model"].as_str(), Some("two"));
        assert_eq!(value["base_url"].as_str(), Some("https://example.com"));
    }

    #[test]
    fn route_groups_are_available_before_connecting_phi() {
        let mut catalog = pool_catalog();
        catalog.groups.push(
            serde_json::from_value(serde_json::json!({
                "id": "route", "name": "Route", "enabled": true, "appIds": ["codex"]
            }))
            .unwrap(),
        );
        let options = selection_options(&AppType::Codex, None, &catalog, false);
        assert_eq!(options.len(), 1);
        assert_eq!(options[0].id, "group:codex:route");
        assert!(!options[0].selected);
    }

    #[test]
    fn group_options_only_include_enabled_groups_for_the_app() {
        let mut catalog = crate::gateway::Catalog::default();
        for (id, enabled, app) in [
            ("one", true, "claude"),
            ("off", false, "claude"),
            ("other", true, "codex"),
        ] {
            catalog.groups.push(
                serde_json::from_value(serde_json::json!({
                    "id": id, "name": id, "enabled": enabled, "appIds": [app]
                }))
                .unwrap(),
            );
        }
        catalog.policies.push(crate::gateway::RoutePolicy {
            id: crate::gateway::routing::connection_id("claude"),
            name: "connection".into(),
            app_id: "claude".into(),
            enabled: true,
            match_model: String::new(),
            priority: 0,
            failover: true,
            candidates: vec![],
            group_id: Some("one".into()),
        });
        let options = group_options(&catalog, "claude");
        assert_eq!(options.len(), 1);
        assert_eq!(options[0].id, "group:claude:one");
        assert!(options[0].selected);
    }

    #[test]
    fn direct_model_change_preserves_credentials_and_other_settings() {
        let mut provider = Provider::with_id(
            "p:1".into(),
            "Test".into(),
            serde_json::json!({
                "env": {
                    "ANTHROPIC_MODEL": "sonnet",
                    "ANTHROPIC_DEFAULT_OPUS_MODEL": "opus",
                    "ANTHROPIC_AUTH_TOKEN": "test-key"
                },
                "permissions": { "allow": ["Read"] }
            }),
            None,
        );
        let options = direct_model_options(&AppType::Claude, &provider);
        assert!(options.iter().any(|o| o.selected && o.label == "sonnet"));
        let encoded = options[0].id.strip_prefix("model:claude:").unwrap();
        let (id, _): (String, String) = serde_json::from_str(encoded).unwrap();
        assert_eq!(id, "p:1");
        set_direct_model(
            &AppType::Claude,
            &mut provider,
            "opus",
            &crate::gateway::Catalog::default(),
        )
        .unwrap();
        assert_eq!(provider.settings_config["env"]["ANTHROPIC_MODEL"], "opus");
        assert_eq!(
            provider.settings_config["env"]["ANTHROPIC_AUTH_TOKEN"],
            "test-key"
        );
        assert_eq!(provider.settings_config["permissions"]["allow"][0], "Read");
        let saved = provider.settings_config.clone();
        assert!(set_direct_model(
            &AppType::Claude,
            &mut provider,
            "unknown",
            &crate::gateway::Catalog::default()
        )
        .is_err());
        assert_eq!(provider.settings_config, saved);
    }

    #[test]
    fn codex_model_change_preserves_toml_tables_and_comments() {
        let mut provider = Provider::with_id(
            "codex".into(),
            "Test".into(),
            serde_json::json!({
                "config": "# keep this\nmodel = \"one\"\n[model_catalog]\nmodels = [\"one\", \"two\"]\n[model_providers.custom]\nbase_url = \"https://example.com\"\n"
            }),
            None,
        );
        set_direct_model(
            &AppType::Codex,
            &mut provider,
            "two",
            &crate::gateway::Catalog::default(),
        )
        .unwrap();
        let config = provider.settings_config["config"].as_str().unwrap();
        assert!(config.starts_with("# keep this\n"));
        let document: toml::Value = config.parse().unwrap();
        assert_eq!(document["model"].as_str(), Some("two"));
        assert_eq!(
            document["model_providers"]["custom"]["base_url"].as_str(),
            Some("https://example.com")
        );
        assert_eq!(
            document["model_catalog"]["models"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }

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
