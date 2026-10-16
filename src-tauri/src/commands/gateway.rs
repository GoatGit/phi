use crate::{
    gateway::{Catalog, CredentialRef, ImportPreview, RequestTrace, SupplierUpsert},
    store::AppState,
};
use tauri::State;

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
    let app = crate::AppType::from_str(&app_id).map_err(|e| e.to_string())?;
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
