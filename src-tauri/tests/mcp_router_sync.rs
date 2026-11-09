//! MCP 路由中心的端到端验证：别名真的落进客户端 live 配置，
//! 关闭路由后旧别名被清理，按客户端放行只投影到名单里的客户端。

use std::fs;

use serde_json::{json, Value};

use phi_lib::mcp_router::{self, McpRoute, McpRouterConfig};
use phi_lib::{McpApps, McpServer, McpService};

#[path = "support.rs"]
mod support;
use support::{create_test_state, ensure_test_home, reset_test_fs, test_mutex};

fn server(id: &str, apps: McpApps) -> McpServer {
    McpServer {
        id: id.to_string(),
        name: id.to_string(),
        server: json!({"command": "npx", "args": ["-y", format!("{id}-server")]}),
        apps,
        description: None,
        homepage: None,
        docs: None,
        tags: Vec::new(),
    }
}

fn claude_only() -> McpApps {
    McpApps {
        claude: true,
        ..McpApps::default()
    }
}

fn route(server_id: &str) -> McpRoute {
    McpRoute {
        server_id: server_id.to_string(),
        alias: None,
        namespace: None,
        apps: Vec::new(),
        enabled: true,
        priority: 0,
        tags: Vec::new(),
    }
}

fn read_claude_servers() -> serde_json::Map<String, Value> {
    let path = phi_lib::get_claude_mcp_path();
    let raw = fs::read_to_string(&path).unwrap_or_else(|_| "{}".to_string());
    serde_json::from_str::<Value>(&raw)
        .unwrap()
        .get("mcpServers")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

#[test]
fn router_aliases_land_in_the_claude_live_config_and_are_cleaned_up() {
    let _guard = test_mutex().lock().unwrap();
    reset_test_fs();
    let state = create_test_state().unwrap();

    // Claude 的同步只在 ~/.claude 存在时才写，先建出来。
    fs::create_dir_all(ensure_test_home().join(".claude")).unwrap();
    state
        .db
        .save_mcp_server(&server("github", claude_only()))
        .unwrap();
    state
        .db
        .save_mcp_server(&server("fs", claude_only()))
        .unwrap();

    let mut config = McpRouterConfig::default();
    let mut github = route("github");
    github.namespace = Some("work".to_string());
    config.routes = vec![github];
    mcp_router::save_config(&config).unwrap();

    McpService::sync_enabled_for_app(&state, &phi_lib::AppType::Claude).unwrap();
    let live = read_claude_servers();
    assert!(live.contains_key("work-github"), "{live:?}");
    assert!(live.contains_key("fs"), "{live:?}");
    assert!(!live.contains_key("github"), "{live:?}");

    // 关掉路由后重新同步：旧别名必须一起消失，不能留幽灵条目。
    config.routes[0].enabled = false;
    mcp_router::save_config(&config).unwrap();
    McpService::sync_enabled_for_app(&state, &phi_lib::AppType::Claude).unwrap();
    let live = read_claude_servers();
    assert!(!live.contains_key("work-github"), "{live:?}");
    assert!(!live.contains_key("github"), "{live:?}");
    assert!(live.contains_key("fs"), "{live:?}");
}

#[test]
fn router_app_allowlist_only_projects_to_listed_clients() {
    let _guard = test_mutex().lock().unwrap();
    reset_test_fs();
    let state = create_test_state().unwrap();
    fs::create_dir_all(ensure_test_home().join(".claude")).unwrap();

    state
        .db
        .save_mcp_server(&server(
            "shared",
            McpApps {
                claude: true,
                codex: true,
                ..McpApps::default()
            },
        ))
        .unwrap();

    let mut config = McpRouterConfig::default();
    let mut shared = route("shared");
    shared.apps = vec!["codex".to_string()];
    config.routes = vec![shared];
    mcp_router::save_config(&config).unwrap();

    McpService::sync_enabled_for_app(&state, &phi_lib::AppType::Claude).unwrap();
    assert!(read_claude_servers().is_empty());
}
