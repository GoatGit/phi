use crate::{
    ledger::{Attempt, Budget, BudgetStatus, LedgerPage, LedgerQuery},
    store::AppState,
};
use tauri::State;
use tauri_plugin_notification::{NotificationExt, PermissionState};

#[tauri::command]
pub async fn get_access_bindings(
    state: State<'_, AppState>,
) -> Result<Vec<crate::access::Binding>, String> {
    state.db.access_bindings().map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn issue_access_binding(
    state: State<'_, AppState>,
    binding: crate::access::Binding,
) -> Result<crate::access::IssuedBinding, String> {
    state
        .db
        .issue_access_binding(binding)
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn delete_access_binding(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state
        .db
        .delete_access_binding(&id)
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn set_access_binding_enabled(
    state: State<'_, AppState>,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    state
        .db
        .set_access_binding_enabled(&id, enabled)
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn get_access_projects(
    state: State<'_, AppState>,
) -> Result<Vec<crate::access::Project>, String> {
    state.db.access_projects().map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn create_access_project(
    state: State<'_, AppState>,
    path: String,
) -> Result<crate::access::Project, String> {
    state
        .db
        .save_access_project(path)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_access_binding_usage(
    state: State<'_, AppState>,
    since: i64,
    until: i64,
) -> Result<std::collections::BTreeMap<String, crate::ledger::Totals>, String> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || db.ledger_binding_totals(since, until))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_ledger_page(
    state: State<'_, AppState>,
    query: LedgerQuery,
) -> Result<LedgerPage, String> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || db.ledger_page(query))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn get_ledger_attempts(
    state: State<'_, AppState>,
    request_id: String,
) -> Result<Vec<Attempt>, String> {
    state
        .db
        .ledger_attempts(&request_id)
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn get_budget_status(state: State<'_, AppState>) -> Result<Vec<BudgetStatus>, String> {
    state.db.budget_status().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_budget_system_notifications(state: State<'_, AppState>) -> Result<bool, String> {
    state
        .db
        .budget_system_notifications()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_budget_system_notifications(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<(), String> {
    if enabled
        && app
            .notification()
            .request_permission()
            .map_err(|_| "notification service unavailable")?
            != PermissionState::Granted
    {
        return Err("system notification permission denied".into());
    }
    state
        .db
        .set_budget_system_notifications(enabled)
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn save_budget(state: State<'_, AppState>, budget: Budget) -> Result<Budget, String> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || db.save_budget(budget))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_ledger_request(
    state: State<'_, AppState>,
    request_id: String,
) -> Result<crate::ledger::RequestRecord, String> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || db.ledger_request(&request_id))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_billing_comparisons(
    state: State<'_, AppState>,
) -> Result<Vec<crate::ledger::billing::BillingComparison>, String> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || db.billing_comparisons())
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_reporting_project(
    state: State<'_, AppState>,
    request_id: String,
    project_id: Option<String>,
) -> Result<(), String> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || db.set_reporting_project(&request_id, project_id))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn save_billing_adjustment(
    state: State<'_, AppState>,
    statement: crate::ledger::billing::BillingAdjustment,
) -> Result<(), String> {
    state
        .db
        .save_billing_adjustment(statement)
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn delete_billing_adjustment(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    state
        .db
        .delete_billing_adjustment(&id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn diagnose_gateway(
    state: State<'_, AppState>,
    include_upstreams: bool,
) -> Result<crate::diagnostics::Report, String> {
    crate::diagnostics::gateway(&state, include_upstreams).await
}
#[tauri::command]
pub async fn diagnose_adapters(
    state: State<'_, AppState>,
) -> Result<crate::diagnostics::Report, String> {
    let catalog = state
        .db
        .gateway_catalog_snapshot()
        .map_err(|_| "routing catalog unavailable")?;
    let proxy_url = state
        .proxy_service
        .build_proxy_urls()
        .await
        .ok()
        .map(|urls| urls.0);
    tokio::task::spawn_blocking(move || {
        crate::diagnostics::adapters(&catalog, proxy_url.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|_| "adapter state unavailable".into())
}
