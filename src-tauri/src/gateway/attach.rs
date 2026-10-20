//! 累加式应用的路由接入。
//!
//! 这些应用没有代理模式：路由以一行「PHI」供应商写进应用原生配置，客户端把请求发给
//! 本地网关的 `/<app>/v1`。本模块负责接入、还原和启动时按新令牌刷新。
//!
//! 接入状态记在设备本地的 live-state（`gatewayRouteAttachment`），令牌只在本进程有效，
//! 所以启动时必须重写一次，否则客户端会拿上一进程的令牌收到 401。

use serde::{Deserialize, Serialize};

use crate::app_config::AppType;
use crate::live::engine::DeviceStore;
use crate::mode::state;
use crate::provider::{ClaudeDesktopMode, ClaudeDesktopModelRoute, Provider, ProviderMeta};
use crate::services::provider::ProviderService;
use crate::store::AppState;

use super::apps::{self, Attachment};
use super::local_apps;

const ATTACHMENT_KEY: &str = "gatewayRouteAttachment";

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AttachmentRecord {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    previous_provider_id: Option<String>,
    /// 路由专用应用接入前激活键的值（退出时原样放回）。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    previous_values: Vec<local_apps::SavedValue>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentStatus {
    pub app_id: String,
    pub attached: bool,
    pub provider_id: String,
    pub group_id: Option<String>,
    pub previous_provider_id: Option<String>,
    pub ingress: String,
}

fn unsupported(app: &AppType) -> String {
    format!("{} 不支持供应商行接入", app.as_str())
}

fn record_of(app: &AppType) -> AttachmentRecord {
    record_of_id(app.as_str())
}

fn record_of_id(app_id: &str) -> AttachmentRecord {
    state::load(&DeviceStore::for_device())
        .ok()
        .and_then(|live| {
            live.apps
                .get(app_id)
                .and_then(|entry| entry.extra.get(ATTACHMENT_KEY))
                .cloned()
        })
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default()
}

fn remember(app: &AppType, record: Option<AttachmentRecord>) -> Result<(), String> {
    remember_id(app.as_str(), record)
}

fn remember_id(app_id: &str, record: Option<AttachmentRecord>) -> Result<(), String> {
    state::update(&DeviceStore::for_device(), |live| {
        let entry = live.apps.entry(app_id.into()).or_default();
        match record {
            Some(record) => {
                entry.extra.insert(
                    ATTACHMENT_KEY.into(),
                    serde_json::to_value(record).expect("attachment serializes"),
                );
            }
            None => {
                entry.extra.remove(ATTACHMENT_KEY);
            }
        }
    })
    .map_err(|error| error.to_string())
}

/// 本地网关里该应用的入口根地址。
fn ingress_base(proxy_url: &str, app: &AppType) -> Result<String, String> {
    let spec = apps::spec(app).ok_or_else(|| unsupported(app))?;
    Ok(format!(
        "{}{}/v1",
        proxy_url.trim_end_matches('/'),
        spec.ingress
    ))
}

fn desktop_routes(models: &[String]) -> std::collections::HashMap<String, ClaudeDesktopModelRoute> {
    models
        .iter()
        .map(|model| {
            (
                model.clone(),
                ClaudeDesktopModelRoute {
                    model: model.clone(),
                    label_override: None,
                    supports_1m: None,
                },
            )
        })
        .collect()
}

fn build_provider(app: &AppType, proxy_url: &str, models: &[String]) -> Result<Provider, String> {
    let spec = apps::spec(app).ok_or_else(|| unsupported(app))?;
    let base = ingress_base(proxy_url, app)?;
    let token = crate::proxy::ingress::token(spec.id);
    let settings =
        apps::provider_settings(app, &base, token, models).ok_or_else(|| unsupported(app))?;
    let mut provider = Provider::with_id(apps::provider_id(app), "PHI".into(), settings, None);
    provider.category = Some("gateway".into());
    if *app == AppType::ClaudeDesktop {
        provider.meta = Some(ProviderMeta {
            claude_desktop_mode: Some(ClaudeDesktopMode::Proxy),
            claude_desktop_model_routes: desktop_routes(models),
            ..ProviderMeta::default()
        });
    }
    Ok(provider)
}

/// 应用自己记录的启用供应商（目前只有 Hermes 在 PHI 切换时会跟着改写）。
fn native_active_provider(app: &AppType) -> Option<String> {
    if *app != AppType::Hermes {
        return None;
    }
    crate::hermes_config::get_model_config()
        .ok()
        .flatten()
        .and_then(|config| config.provider)
        .filter(|id| !id.trim().is_empty() && !apps::is_gateway_provider_id(id))
}

fn models_for(state: &AppState, app: &AppType) -> Result<Vec<String>, String> {
    models_for_id(state, app.as_str())
}

fn models_for_id(state: &AppState, app_id: &str) -> Result<Vec<String>, String> {
    let catalog = state
        .db
        .gateway_catalog()
        .map_err(|error| error.to_string())?;
    Ok(super::routing::published_models(&catalog, app_id))
}

/// 把应用的当前路由组落成一行供应商并切换过去。
pub async fn connect(
    state: &AppState,
    app: &AppType,
    group_id: &str,
    revision: Option<u64>,
) -> Result<(), String> {
    let spec = apps::spec(app).ok_or_else(|| unsupported(app))?;
    if spec.attachment != Attachment::Provider {
        return Err(unsupported(app));
    }
    if !state.proxy_service.is_running().await {
        state.proxy_service.start().await?;
    }
    let previous_connection = state
        .db
        .select_gateway_group(app.as_str(), group_id, revision)
        .map_err(|error| error.to_string())?;
    // 已经接入时，本次尝试失败要把原来的 PHI 供应商行保留下来：应用原生配置
    // 仍可能指向它。首连接才需要清理失败时新建的行。
    let provider_id = apps::provider_id(app);
    let had_provider = state
        .db
        .get_provider_by_id(&provider_id, app.as_str())
        .map_err(|error| error.to_string())?
        .is_some();
    let result = connect_selected(state, app, group_id).await;
    if result.is_err() {
        if !had_provider {
            let _ = state.db.delete_provider(app.as_str(), &provider_id);
        }
        state
            .db
            .restore_gateway_group_connection(app.as_str(), group_id, previous_connection)
            .map_err(|error| format!("{}; {error}", result.as_ref().unwrap_err()))?;
    }
    result
}

async fn connect_selected(state: &AppState, app: &AppType, group_id: &str) -> Result<(), String> {
    let models = models_for(state, app)?;
    if models.is_empty() {
        return Err("gateway.emptyGroup".into());
    }
    let (proxy_url, _) = state.proxy_service.build_proxy_urls().await?;
    let provider = build_provider(app, &proxy_url, &models)?;
    // 已经接入时直连指针可能已被上一次切换改成 PHI 行；保留最初记录的上一家。
    let previous = match record_of(app).previous_provider_id {
        Some(previous) => Some(previous),
        None => {
            let pointer = crate::mode::current::provider_for(
                &state.db,
                app,
                crate::mode::current::Purpose::Direct,
            )
            .map_err(|error| error.to_string())?
            .filter(|id| !apps::is_gateway_provider_id(id));
            // Hermes 的「切换」会改写 model.provider；先记下原值，退出时才能切回。
            pointer.or_else(|| native_active_provider(app))
        }
    };
    let provider_id = provider.id.clone();
    let previous_provider = state
        .db
        .get_provider_by_id(&provider_id, app.as_str())
        .map_err(|error| error.to_string())?;
    let previous_current = crate::mode::current::in_use_pointer(&state.db, app.as_str())
        .map_err(|error| error.to_string())?;
    state
        .db
        .save_provider(app.as_str(), &provider)
        .map_err(|error| error.to_string())?;
    // 切换失败时连原生配置和当前指针一起退回：优先用恢复后的旧 PHI 行重写，
    // 首连接则用尝试前的当前供应商；两者都没有时清除指针。
    let rollback = |state: &AppState| {
        match &previous_provider {
            Some(previous) => {
                let _ = state.db.save_provider(app.as_str(), previous);
            }
            None => {
                let _ = state.db.delete_provider(app.as_str(), &provider_id);
            }
        }
        let restore = if previous_provider.is_some() {
            Some(provider_id.clone())
        } else {
            previous_current.clone()
        };
        if let Some(id) = restore {
            if state
                .db
                .get_provider_by_id(&id, app.as_str())
                .ok()
                .flatten()
                .is_some()
            {
                if let Err(error) = ProviderService::switch(state, app.clone(), &id) {
                    log::warn!(
                        "[GATEWAY] {} 接入失败后恢复供应商 {} 失败: {error}",
                        app.as_str(),
                        id
                    );
                }
            }
        } else {
            let _ = crate::settings::set_current_provider(app, None);
            let _ = state.db.clear_current_provider(app.as_str());
        }
    };
    if let Err(error) = ProviderService::switch(state, app.clone(), &provider.id) {
        rollback(state);
        return Err(format!("写入 {} 路由配置失败: {error}", group_id));
    }
    if let Err(error) = remember(
        app,
        Some(AttachmentRecord {
            previous_provider_id: previous.clone(),
            previous_values: Vec::new(),
        }),
    ) {
        rollback(state);
        return Err(format!("保存 {} 接入状态失败: {error}", app.as_str()));
    }
    log::info!(
        "[GATEWAY] {} 接入路由组 {}，发布模型 {:?}",
        app.as_str(),
        group_id,
        models
    );
    Ok(())
}

/// 退出路由：切回接入前的供应商，再移除 PHI 写入的供应商行和组连接。
pub async fn disconnect(state: &AppState, app: &AppType) -> Result<(), String> {
    let spec = apps::spec(app).ok_or_else(|| unsupported(app))?;
    if spec.attachment != Attachment::Provider {
        return Err(unsupported(app));
    }
    let provider_id = apps::provider_id(app);
    let record = record_of(app);
    let mut restored = record.previous_provider_id.clone();
    if restored.as_ref().is_some_and(|id| {
        state
            .db
            .get_provider_by_id(id, app.as_str())
            .ok()
            .flatten()
            .is_none()
    }) {
        restored = None;
    }
    if restored.is_none() && *app == AppType::ClaudeDesktop {
        // Desktop 的“原生配置”就是官方模式；没有记录的上一家时回到官方。
        let official = crate::database::CLAUDE_DESKTOP_OFFICIAL_PROVIDER_ID;
        if state
            .db
            .get_provider_by_id(official, app.as_str())
            .map_err(|error| error.to_string())?
            .is_some()
        {
            restored = Some(official.to_string());
        }
    }
    if let Some(previous) = &restored {
        ProviderService::switch(state, app.clone(), previous)
            .map_err(|error| format!("切回供应商 {previous} 失败: {error}"))?;
    } else if *app == AppType::Hermes {
        // 原供应商不在 PHI 的库里（Hermes 原生配置的供应商）时无法走 switch，
        // 至少把 model.provider 指回原值，别留在一个已被删除的供应商上。
        if let Some(previous) = record.previous_provider_id.as_deref() {
            if let Ok(Some(mut model)) = crate::hermes_config::get_model_config() {
                model.provider = Some(previous.to_string());
                let _ = crate::hermes_config::set_model_config(&model);
            }
        }
    }
    // 先解除组连接：即使供应商行删不掉（MCode 在应用内还把 PHI 设为默认模型时会拒绝），
    // 界面也应回到「原生配置」，不把用户卡在半接入状态。
    state
        .db
        .clear_gateway_group_connection(app.as_str())
        .map_err(|error| error.to_string())?;
    remember(app, None)?;
    let mut removal_error = None;
    if state
        .db
        .get_provider_by_id(&provider_id, app.as_str())
        .map_err(|error| error.to_string())?
        .is_some()
    {
        if let Err(error) = ProviderService::delete(state, app.clone(), &provider_id) {
            log::warn!(
                "[GATEWAY] {} 退出路由后移除 PHI 供应商失败: {error}",
                app.as_str()
            );
            removal_error = Some(format!(
                "已退出路由，但应用仍引用 PHI 供应商，未删除该行: {error}"
            ));
        }
    }
    log::info!(
        "[GATEWAY] {} 退出路由{}",
        app.as_str(),
        restored
            .as_deref()
            .map(|id| format!("，已切回 {id}"))
            .unwrap_or_default()
    );
    match removal_error {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

fn local_plan(
    spec: &local_apps::LocalApp,
    proxy_url: &str,
    models: &[String],
) -> Result<local_apps::LocalPlan, String> {
    let base = format!("{}{}/v1", proxy_url.trim_end_matches('/'), spec.ingress);
    let key = crate::proxy::ingress::token(spec.id);
    local_apps::plan(spec.id, &base, key, models).map_err(|error| error.to_string())
}

/// 路由专用应用接入：写应用原生配置指向本地网关，并在 PHI 的库里记一行供应商。
pub async fn connect_local(
    state: &AppState,
    app_id: &str,
    group_id: &str,
    revision: Option<u64>,
) -> Result<(), String> {
    let spec = local_apps::spec(app_id).ok_or_else(|| format!("{app_id} 不是路由专用应用"))?;
    if !state.proxy_service.is_running().await {
        state.proxy_service.start().await?;
    }
    let previous_connection = state
        .db
        .select_gateway_group(spec.id, group_id, revision)
        .map_err(|error| error.to_string())?;
    // 已经接入时，本次尝试失败要把原来的 PHI 供应商行恢复出来，不能删掉——
    // 应用原生配置仍在指向它。首连接才需要清理失败时新建的行。
    let had_provider = state
        .db
        .get_provider_by_id(&local_apps::provider_id(spec.id), spec.id)
        .map_err(|error| error.to_string())?
        .is_some();
    let result = connect_local_selected(state, spec, group_id).await;
    if result.is_err() {
        if !had_provider {
            let _ = state
                .db
                .delete_provider(spec.id, &local_apps::provider_id(spec.id));
        }
        state
            .db
            .restore_gateway_group_connection(spec.id, group_id, previous_connection)
            .map_err(|error| format!("{}; {error}", result.as_ref().unwrap_err()))?;
    }
    result
}

async fn connect_local_selected(
    state: &AppState,
    spec: &local_apps::LocalApp,
    group_id: &str,
) -> Result<(), String> {
    let models = models_for_id(state, spec.id)?;
    if models.is_empty() {
        return Err("gateway.emptyGroup".into());
    }
    let (proxy_url, _) = state.proxy_service.build_proxy_urls().await?;
    let plan = local_plan(spec, &proxy_url, &models)?;
    // 两次快照用途不同：current_values 用于本次失败回滚（恢复到尝试前的原生配置），
    // saved 是退出路由时要放回的用户原值，重连时不能被 PHI 自己写的值覆盖。
    let current_values = local_apps::stash(&plan).map_err(|error| error.to_string())?;
    let record = record_of_id(spec.id);
    let saved = if record.previous_values.is_empty() {
        current_values.clone()
    } else {
        record.previous_values.clone()
    };
    let provider_id = local_apps::provider_id(spec.id);
    let previous_provider = state
        .db
        .get_provider_by_id(&provider_id, spec.id)
        .map_err(|error| error.to_string())?;
    let previous_current = crate::mode::current::in_use_pointer(&state.db, spec.id)
        .map_err(|error| error.to_string())?;
    let mut provider = Provider::with_id(
        provider_id.clone(),
        "PHI".into(),
        plan.settings.clone(),
        None,
    );
    provider.category = Some("gateway".into());
    state
        .db
        .save_provider(spec.id, &provider)
        .map_err(|error| error.to_string())?;
    // 文件写入或指针更新失败时不要留下半个接入：把已写进去的键退回，并把
    // 供应商行恢复成尝试前的样子。
    let rollback = |state: &AppState| {
        let _ = local_apps::restore(&current_values);
        match &previous_provider {
            Some(previous) => {
                let _ = state.db.save_provider(spec.id, previous);
            }
            None => {
                let _ = state.db.delete_provider(spec.id, &provider_id);
            }
        }
        // 当前指针也要退回尝试前：首连接失败时清掉，重连失败时指回恢复后的行。
        match &previous_current {
            Some(id) => {
                let _ = state.db.set_current_provider(spec.id, id);
            }
            None => {
                let _ = state.db.clear_current_provider(spec.id);
            }
        }
    };
    if let Err(error) = local_apps::apply(&plan) {
        rollback(state);
        return Err(format!("写入 {} 路由配置失败: {error}", spec.label));
    }
    if let Err(error) = state.db.set_current_provider(spec.id, &provider_id) {
        rollback(state);
        return Err(format!("更新 {} 当前供应商失败: {error}", spec.label));
    }
    if let Err(error) = remember_id(
        spec.id,
        Some(AttachmentRecord {
            previous_provider_id: None,
            previous_values: saved.clone(),
        }),
    ) {
        rollback(state);
        return Err(format!("保存 {} 接入状态失败: {error}", spec.label));
    }
    log::info!(
        "[GATEWAY] {} 接入路由组 {}，发布模型 {:?}",
        spec.id,
        group_id,
        models
    );
    Ok(())
}

/// 路由专用应用退出：删掉供应商块，把激活键放回接入前的值。
pub async fn disconnect_local(state: &AppState, app_id: &str) -> Result<(), String> {
    let spec = local_apps::spec(app_id).ok_or_else(|| format!("{app_id} 不是路由专用应用"))?;
    let provider_id = local_apps::provider_id(spec.id);
    let record = record_of_id(spec.id);
    let removal = local_apps::plan(spec.id, "", "", &[]).map_err(|error| error.to_string())?;
    let remove_error = local_apps::remove(&removal)
        .err()
        .map(|error| error.to_string());
    local_apps::restore(&record.previous_values)
        .map_err(|error| format!("恢复 {} 原配置失败: {error}", spec.label))?;
    state
        .db
        .clear_gateway_group_connection(spec.id)
        .map_err(|error| error.to_string())?;
    remember_id(spec.id, None)?;
    let mut removal_error = None;
    if state
        .db
        .get_provider_by_id(&provider_id, spec.id)
        .map_err(|error| error.to_string())?
        .is_some()
    {
        if let Err(error) = state.db.delete_provider(spec.id, &provider_id) {
            removal_error = Some(format!("已退出路由，但 PHI 供应商行未能删除: {error}"));
        }
    }
    log::info!("[GATEWAY] {} 退出路由", spec.id);
    if let Some(error) = remove_error.or(removal_error) {
        return Err(error);
    }
    Ok(())
}

/// 路由专用应用的接入状态。
pub fn status_local(state: &AppState, app_id: &str) -> Result<Option<AttachmentStatus>, String> {
    let Some(spec) = local_apps::spec(app_id) else {
        return Ok(None);
    };
    let provider_id = local_apps::provider_id(spec.id);
    let provider_exists = state
        .db
        .get_provider_by_id(&provider_id, spec.id)
        .map_err(|error| error.to_string())?
        .is_some();
    let catalog = state
        .db
        .gateway_catalog()
        .map_err(|error| error.to_string())?;
    let group_id = super::routing::app_connection(&catalog, spec.id)
        .filter(|policy| policy.enabled)
        .and_then(|policy| policy.group_id.clone())
        .filter(|id| {
            catalog
                .groups
                .iter()
                .any(|group| &group.id == id && group.enabled)
        });
    Ok(Some(AttachmentStatus {
        app_id: spec.id.to_string(),
        attached: provider_exists && group_id.is_some(),
        provider_id,
        group_id,
        previous_provider_id: None,
        ingress: format!("{}/v1", spec.ingress),
    }))
}

/// 启动时刷新一个路由专用应用的写入（令牌随进程变化）。
async fn refresh_local(state: &AppState, spec: &local_apps::LocalApp) -> Result<(), String> {
    let record = record_of_id(spec.id);
    if record.previous_values.is_empty() {
        return Ok(());
    }
    let provider_id = local_apps::provider_id(spec.id);
    if state
        .db
        .get_provider_by_id(&provider_id, spec.id)
        .map_err(|error| error.to_string())?
        .is_none()
    {
        return Ok(());
    }
    let models = models_for_id(state, spec.id)?;
    if models.is_empty() {
        return Ok(());
    }
    let (proxy_url, _) = state.proxy_service.build_proxy_urls().await?;
    let plan = local_plan(spec, &proxy_url, &models)?;
    local_apps::apply(&plan).map_err(|error| error.to_string())?;
    let mut provider = Provider::with_id(provider_id, "PHI".into(), plan.settings.clone(), None);
    provider.category = Some("gateway".into());
    state
        .db
        .save_provider(spec.id, &provider)
        .map_err(|error| error.to_string())?;
    log::info!("[GATEWAY] 已刷新 {} 的路由接入配置", spec.id);
    Ok(())
}

pub fn status(state: &AppState, app: &AppType) -> Result<Option<AttachmentStatus>, String> {
    let Some(spec) = apps::spec(app) else {
        return Ok(None);
    };
    if spec.attachment != Attachment::Provider {
        return Ok(None);
    }
    let provider_id = apps::provider_id(app);
    let provider_exists = state
        .db
        .get_provider_by_id(&provider_id, app.as_str())
        .map_err(|error| error.to_string())?
        .is_some();
    let catalog = state
        .db
        .gateway_catalog()
        .map_err(|error| error.to_string())?;
    let group_id = super::routing::app_connection(&catalog, app.as_str())
        .filter(|policy| policy.enabled)
        .and_then(|policy| policy.group_id.clone())
        .filter(|id| {
            catalog
                .groups
                .iter()
                .any(|group| &group.id == id && group.enabled)
        });
    // 组被删或连接被清掉时不再算接入：界面上应回到「原生配置」而不是停在半接入状态。
    let attached = provider_exists && group_id.is_some();
    Ok(Some(AttachmentStatus {
        app_id: app.as_str().to_string(),
        attached,
        provider_id,
        group_id,
        previous_provider_id: record_of(app).previous_provider_id,
        ingress: ingress_base("", app).unwrap_or_default(),
    }))
}

/// 启动时刷新每个已接入应用：令牌和网关地址都随进程变化，旧配置一定失效。
pub async fn refresh_all(state: &AppState) -> Vec<String> {
    let mut failures = Vec::new();
    for spec in apps::ROUTING_APPS
        .iter()
        .filter(|spec| spec.attachment == Attachment::Provider)
    {
        if let Err(error) = refresh(state, &spec.app).await {
            log::warn!(
                "[GATEWAY] 刷新 {} 的路由配置失败: {error}",
                spec.app.as_str()
            );
            failures.push(format!("{}: {error}", spec.app.as_str()));
        }
    }
    for spec in local_apps::LOCAL_APPS.iter() {
        if let Err(error) = refresh_local(state, spec).await {
            log::warn!("[GATEWAY] 刷新 {} 的路由配置失败: {error}", spec.id);
            failures.push(format!("{}: {error}", spec.id));
        }
    }
    failures
}

async fn refresh(state: &AppState, app: &AppType) -> Result<(), String> {
    let provider_id = apps::provider_id(app);
    let Some(existing) = state
        .db
        .get_provider_by_id(&provider_id, app.as_str())
        .map_err(|error| error.to_string())?
    else {
        return Ok(());
    };
    if record_of(app).previous_provider_id.is_none()
        && existing.category.as_deref() != Some("gateway")
    {
        return Ok(());
    }
    let models = models_for(state, app)?;
    if models.is_empty() {
        // 组被删或被停用：保持原配置不动，连接状态在界面上显示为不可用。
        return Ok(());
    }
    let (proxy_url, _) = state.proxy_service.build_proxy_urls().await?;
    let provider = build_provider(app, &proxy_url, &models)?;
    state
        .db
        .save_provider(app.as_str(), &provider)
        .map_err(|error| error.to_string())?;
    // Pi 的 switch 只合并原生配置、不重写 models.json；先把新令牌写回文件。
    if *app == AppType::Pi {
        crate::pi_config::replace_pi_provider_if_present(&provider.id, &provider.settings_config)
            .map_err(|error| error.to_string())?;
    }
    ProviderService::switch(state, app.clone(), &provider.id).map_err(|error| error.to_string())?;
    log::info!("[GATEWAY] 已刷新 {} 的路由接入配置", app.as_str());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    const MODELS: [&str; 2] = ["glm-5", "kimi-k3"];

    #[test]
    fn additive_apps_get_one_gateway_provider_row_with_published_models() {
        let models: Vec<String> = MODELS.iter().map(|model| model.to_string()).collect();
        for app in [
            AppType::OpenCode,
            AppType::OpenClaw,
            AppType::Hermes,
            AppType::Pi,
            AppType::Mcode,
        ] {
            let provider = build_provider(&app, "http://127.0.0.1:15721", &models).unwrap();
            assert_eq!(provider.id, apps::provider_id(&app));
            assert_eq!(provider.category.as_deref(), Some("gateway"));
            let base = format!(
                "http://127.0.0.1:15721{}/v1",
                apps::spec(&app).unwrap().ingress
            );
            let credentials = apps::provider_credentials(&app, &provider.settings_config)
                .expect("gateway credentials");
            assert_eq!(credentials.0, base, "{:?}", app);
            assert_eq!(
                credentials.1,
                crate::proxy::ingress::token(app.as_str()),
                "{:?}",
                app
            );
        }
    }

    #[test]
    fn claude_desktop_route_provider_maps_every_published_model() {
        let models: Vec<String> = MODELS.iter().map(|model| model.to_string()).collect();
        let provider =
            build_provider(&AppType::ClaudeDesktop, "http://127.0.0.1:15721", &models).unwrap();
        let meta = provider.meta.as_ref().unwrap();
        assert_eq!(meta.claude_desktop_mode, Some(ClaudeDesktopMode::Proxy));
        assert_eq!(meta.claude_desktop_model_routes.len(), 2);
        for model in MODELS {
            let route = meta
                .claude_desktop_model_routes
                .get(model)
                .expect("route mapping");
            assert_eq!(route.model, model);
        }
        let routes = crate::claude_desktop_config::proxy_model_routes(&provider).unwrap();
        assert_eq!(routes.len(), 2);
    }

    /// 审计复现：首连接记录不到“上一家”，之后的失败重连不能删除已存在的
    /// PHI 行。这个测试放在 attach 模块下，`cargo test gateway::attach` 即可覆盖。
    #[cfg(unix)]
    #[tokio::test]
    #[serial]
    async fn a_failed_reconnect_keeps_the_existing_provider_row() {
        use crate::mode::controller::mode_tests::{
            seed_gateway_group, state_without_providers, Home,
        };
        use std::fs;
        let _home = Home::new();
        let state = state_without_providers().await;
        seed_gateway_group(&state, "openclaw", "m").await;
        connect(&state, &AppType::OpenClaw, "root", None)
            .await
            .expect("first connect");
        let attached = status(&state, &AppType::OpenClaw)
            .expect("status")
            .expect("attached");
        assert!(attached.previous_provider_id.is_none());

        let id = apps::provider_id(&AppType::OpenClaw);
        let before = state
            .db
            .get_provider_by_id(&id, "openclaw")
            .expect("fetch")
            .expect("row");
        // 写原生配置失败（配置路径变成目录）。
        let path = crate::openclaw_config::get_openclaw_config_path();
        fs::remove_file(&path).expect("remove openclaw config");
        fs::create_dir(&path).expect("config path as directory");

        let error = connect(&state, &AppType::OpenClaw, "root", None)
            .await
            .expect_err("reconnect must fail");
        assert!(error.contains("写入"), "unexpected error: {error}");
        let after = state
            .db
            .get_provider_by_id(&id, "openclaw")
            .expect("fetch")
            .expect("row survives a failed reconnect");
        assert_eq!(after.settings_config, before.settings_config);
    }
}
