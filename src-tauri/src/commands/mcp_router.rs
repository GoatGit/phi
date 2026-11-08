#![allow(non_snake_case)]

use serde::Serialize;
use tauri::State;

use crate::mcp_router::{
    build_catalog, config_path, load_config, save_config, McpRouterConfig, RouterCatalog,
};
use crate::services::McpService;
use crate::store::AppState;

/// 路由配置 + 文件位置。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpRouterResponse {
    pub path: String,
    pub config: McpRouterConfig,
}

fn response(config: McpRouterConfig) -> McpRouterResponse {
    McpRouterResponse {
        path: config_path().to_string_lossy().to_string(),
        config,
    }
}

/// 读取 MCP 路由配置（缺失时返回「全部直通」的默认值）。
#[tauri::command]
pub async fn get_mcp_router_config() -> Result<McpRouterResponse, String> {
    Ok(response(load_config()))
}

/// 保存 MCP 路由配置；非法配置在写盘前被拒。
#[tauri::command]
pub async fn save_mcp_router_config(config: McpRouterConfig) -> Result<McpRouterResponse, String> {
    save_config(&config).map_err(|err| err.to_string())?;
    Ok(response(load_config()))
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
