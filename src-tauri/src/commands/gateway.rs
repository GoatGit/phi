use crate::{
    gateway::{Catalog, CredentialRef, ImportPreview, RequestTrace, SupplierUpsert},
    store::AppState,
};
use tauri::State;

#[tauri::command]
pub async fn gateway_subscription_action(
    action: String,
    input: serde_json::Value,
) -> Result<serde_json::Value, String> {
    crate::gateway::subscriptions::action(&action, input).await
}

#[tauri::command]
pub async fn connect_gateway_subscription(
    state: State<'_, AppState>,
    id: String,
    revision: u64,
) -> Result<Catalog, String> {
    crate::gateway::subscriptions::connect(&state.db, &id, revision).await
}

#[tauri::command]
pub async fn create_gateway_supplier_from_template(
    state: State<'_, AppState>,
    app_id: String,
    provider: crate::provider::Provider,
    revision: u64,
) -> Result<Catalog, String> {
    state
        .db
        .create_gateway_supplier_from_template(&app_id, &provider, revision)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_gateway_suppliers_from_universal(
    state: State<'_, AppState>,
    provider: crate::provider::UniversalProvider,
    revision: u64,
) -> Result<Catalog, String> {
    state
        .db
        .create_gateway_suppliers_from_universal(&provider, revision)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_gateway_catalog(state: State<'_, AppState>) -> Result<Catalog, String> {
    state.db.gateway_catalog().map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn save_gateway_catalog(
    state: State<'_, AppState>,
    catalog: Catalog,
) -> Result<Catalog, String> {
    state
        .db
        .save_gateway_catalog(catalog)
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn create_gateway_supplier(
    state: State<'_, AppState>,
    input: SupplierUpsert,
) -> Result<Catalog, String> {
    state
        .db
        .create_gateway_supplier(input)
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn update_gateway_supplier(
    state: State<'_, AppState>,
    supplierId: String,
    input: SupplierUpsert,
) -> Result<Catalog, String> {
    state
        .db
        .update_gateway_supplier(&supplierId, input)
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn preview_gateway_import(
    state: State<'_, AppState>,
    source: CredentialRef,
) -> Result<ImportPreview, String> {
    state
        .db
        .preview_gateway_import(source)
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn apply_gateway_import(
    state: State<'_, AppState>,
    preview: ImportPreview,
    revision: u64,
) -> Result<Catalog, String> {
    state
        .db
        .apply_gateway_import(preview, revision)
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn get_gateway_traces(state: State<'_, AppState>) -> Result<Vec<RequestTrace>, String> {
    state.db.gateway_traces().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn fetch_gateway_models(
    state: State<'_, AppState>,
    supplier_id: String,
) -> Result<Vec<String>, String> {
    state
        .db
        .fetch_gateway_models(&supplier_id)
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn preview_gateway_route(
    state: State<'_, AppState>,
    app_id: String,
    model: String,
) -> Result<crate::gateway::RoutePreview, String> {
    state
        .db
        .preview_gateway_route(&app_id, &model)
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn connect_gateway_app(
    state: State<'_, AppState>,
    app_id: String,
    group_id: Option<String>,
    revision: Option<u64>,
) -> Result<(), String> {
    use std::str::FromStr;
    // 路由专用应用只写原生配置，不进模式控制器，也不做供应商直连。
    if crate::gateway::local_apps::spec(&app_id).is_some() {
        let group_id = group_id.ok_or_else(|| "gateway.unavailableGroup".to_string())?;
        return crate::gateway::attach::connect_local(&state, &app_id, &group_id, revision).await;
    }
    let app = crate::AppType::from_str(&app_id).map_err(|e| e.to_string())?;
    // 没有代理模式的应用以一行「PHI」供应商接入，接入和还原都走 attach。
    if crate::gateway::apps::spec(&app)
        .is_some_and(|spec| spec.attachment == crate::gateway::apps::Attachment::Provider)
    {
        let group_id = group_id.ok_or_else(|| "gateway.unavailableGroup".to_string())?;
        return crate::gateway::attach::connect(&state, &app, &group_id, revision).await;
    }
    if let Some(group_id) = group_id {
        return crate::mode::controller::enter_gateway_group(&state, &app, &group_id, revision)
            .await;
    }
    let provider = state
        .db
        .gateway_entry_provider(&app_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "gateway.noPolicy".to_string())?;
    crate::mode::controller::enter_with_route(&state, &app, false, Some(&provider.id)).await
}

#[tauri::command]
pub async fn get_gateway_trace_page(
    state: State<'_, AppState>,
    query: crate::gateway::analytics::TraceQuery,
) -> Result<crate::gateway::analytics::TracePage, String> {
    state
        .db
        .gateway_trace_page(query)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_gateway_app_status(
    state: State<'_, AppState>,
    app_id: String,
) -> Result<Option<crate::gateway::attach::AttachmentStatus>, String> {
    use std::str::FromStr;
    if crate::gateway::local_apps::spec(&app_id).is_some() {
        return crate::gateway::attach::status_local(&state, &app_id);
    }
    let app = crate::AppType::from_str(&app_id).map_err(|e| e.to_string())?;
    crate::gateway::attach::status(&state, &app)
}

#[tauri::command]
pub async fn disconnect_gateway_app(
    state: State<'_, AppState>,
    app_id: String,
) -> Result<(), String> {
    use std::str::FromStr;
    if crate::gateway::local_apps::spec(&app_id).is_some() {
        return crate::gateway::attach::disconnect_local(&state, &app_id).await;
    }
    let app = crate::AppType::from_str(&app_id).map_err(|e| e.to_string())?;
    crate::gateway::attach::disconnect(&state, &app).await
}

/// 把资源池供应商落成指定应用的直连供应商行，返回 provider id。
/// 调用方随后仍需走常规 switch（含退出本地路由）流程。
#[tauri::command]
pub async fn materialize_gateway_supplier_provider(
    state: State<'_, AppState>,
    app_id: String,
    supplier_id: String,
) -> Result<String, String> {
    state
        .db
        .materialize_supplier_provider(&app_id, &supplier_id)
        .map_err(|e| e.to_string())
}
