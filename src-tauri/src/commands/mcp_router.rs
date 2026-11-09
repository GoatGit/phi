#![allow(non_snake_case)]

use serde::Serialize;
use tauri::State;

use crate::mcp_router::{
    build_catalog, config_path, load_config, save_config, McpRouterConfig, RouterCatalog,
};
use crate::services::McpService;
use crate::store::AppState;

/// 路由配置 + 文件位置 + 本次是否已经重投影到客户端。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpRouterResponse {
    pub path: String,
    pub config: McpRouterConfig,
    /// 配置是否已成功应用到客户端 live 配置。
    pub applied: bool,
    /// 应用失败的原因（配置本身已保存）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub apply_error: Option<String>,
}

fn response(config: McpRouterConfig, applied: bool) -> McpRouterResponse {
    McpRouterResponse {
        path: config_path().to_string_lossy().to_string(),
        config,
        applied,
        apply_error: None,
    }
}

/// 读取 MCP 路由配置（缺失时返回「全部直通」的默认值）。
#[tauri::command]
pub async fn get_mcp_router_config() -> Result<McpRouterResponse, String> {
    Ok(response(load_config(), false))
}

/// 保存 MCP 路由配置，并立刻重投影到受管客户端。
///
/// 只写文件不投影的话，用户改完别名要等下一次无关的 MCP 同步才看到效果。
/// 投影失败不推翻保存结果：配置已落盘，错误单独回报，调用方可以重试同步。
#[tauri::command]
pub async fn save_mcp_router_config(
    state: State<'_, AppState>,
    config: McpRouterConfig,
) -> Result<McpRouterResponse, String> {
    save_config(&config).map_err(|err| err.to_string())?;
    let state = state.inner().clone();
    // 投影要读数据库并写各客户端的 live 文件，挪到阻塞线程池，别卡 tokio worker。
    let apply = tokio::task::spawn_blocking(move || McpService::apply_router_config(&state))
        .await
        .map_err(|err| format!("应用 MCP 路由任务失败: {err}"))?;
    match apply {
        Ok(()) => Ok(response(load_config(), true)),
        Err(err) => {
            log::warn!("MCP 路由配置已保存，但重投影失败: {err}");
            let mut body = response(load_config(), false);
            body.apply_error = Some(err.to_string());
            Ok(body)
        }
    }
}

/// 预览：数据库里的服务器经过路由后会以什么名字出现在哪个客户端，以及撞名。
#[tauri::command]
pub async fn preview_mcp_router_catalog(
    state: State<'_, AppState>,
) -> Result<RouterCatalog, String> {
    let servers = McpService::get_all_servers(&state).map_err(|err| err.to_string())?;
    let config = load_config();
    Ok(build_catalog(servers.values(), &config))
}
