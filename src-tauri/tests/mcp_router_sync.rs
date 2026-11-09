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

/// 回归：服务器先以 canonical id 同步过，之后才加别名。
/// 只写新名字不清理旧名字的话，客户端会同时出现 `github` 和 `work-github`。
#[test]
fn alias_added_after_a_canonical_sync_replaces_the_canonical_entry() {
    let _guard = test_mutex().lock().unwrap();
    reset_test_fs();
    let state = create_test_state().unwrap();
    fs::create_dir_all(ensure_test_home().join(".claude")).unwrap();
    state
        .db
        .save_mcp_server(&server("github", claude_only()))
        .unwrap();

    // 1. 没有任何路由：按 canonical id 写入。
    McpService::sync_enabled_for_app(&state, &phi_lib::AppType::Claude).unwrap();
    let live = read_claude_servers();
    assert!(live.contains_key("github"), "{live:?}");

    // 2. 之后才加命名空间，再同步：canonical 条目必须一起消失。
    let mut config = McpRouterConfig::default();
    let mut github = route("github");
    github.namespace = Some("work".to_string());
    config.routes = vec![github];
    mcp_router::save_config(&config).unwrap();
    McpService::sync_enabled_for_app(&state, &phi_lib::AppType::Claude).unwrap();

    let live = read_claude_servers();
    assert!(live.contains_key("work-github"), "{live:?}");
    assert!(!live.contains_key("github"), "旧条目没被清理: {live:?}");
}

/// 回归：别名改名后，上一轮的旧名字也必须清掉（配置里已经推不出它了）。
#[test]
fn renaming_an_alias_removes_the_previous_name() {
    let _guard = test_mutex().lock().unwrap();
    reset_test_fs();
    let state = create_test_state().unwrap();
    fs::create_dir_all(ensure_test_home().join(".claude")).unwrap();
    state
        .db
        .save_mcp_server(&server("github", claude_only()))
        .unwrap();

    let mut config = McpRouterConfig::default();
    let mut github = route("github");
    github.alias = Some("work-github".to_string());
    config.routes = vec![github];
    mcp_router::save_config(&config).unwrap();
    McpService::sync_enabled_for_app(&state, &phi_lib::AppType::Claude).unwrap();
    assert!(read_claude_servers().contains_key("work-github"));

    // 改名：旧别名从配置里消失了，只能靠账本清。
    config.routes[0].alias = Some("gh".to_string());
    mcp_router::save_config(&config).unwrap();
    McpService::sync_enabled_for_app(&state, &phi_lib::AppType::Claude).unwrap();

    let live = read_claude_servers();
    assert!(live.contains_key("gh"), "{live:?}");
    assert!(!live.contains_key("work-github"), "旧别名残留: {live:?}");
    assert!(!live.contains_key("github"), "{live:?}");
}

/// 回归：删掉整条路由后回到 canonical 名字，旧别名不能留。
#[test]
fn deleting_a_route_restores_the_canonical_entry() {
    let _guard = test_mutex().lock().unwrap();
    reset_test_fs();
    let state = create_test_state().unwrap();
    fs::create_dir_all(ensure_test_home().join(".claude")).unwrap();
    state
        .db
        .save_mcp_server(&server("github", claude_only()))
        .unwrap();

    let mut config = McpRouterConfig::default();
    let mut github = route("github");
    github.alias = Some("gh".to_string());
    config.routes = vec![github];
    mcp_router::save_config(&config).unwrap();
    McpService::sync_enabled_for_app(&state, &phi_lib::AppType::Claude).unwrap();
    assert!(read_claude_servers().contains_key("gh"));

    config.routes.clear();
    mcp_router::save_config(&config).unwrap();
    McpService::sync_enabled_for_app(&state, &phi_lib::AppType::Claude).unwrap();

    let live = read_claude_servers();
    assert!(live.contains_key("github"), "{live:?}");
    assert!(!live.contains_key("gh"), "旧别名残留: {live:?}");
}

/// 别名撞上另一个服务器的 canonical id：必须报冲突，且 live 里只留胜出者。
#[test]
fn alias_colliding_with_another_server_is_reported_and_not_silently_overwritten() {
    let _guard = test_mutex().lock().unwrap();
    reset_test_fs();
    let state = create_test_state().unwrap();
    fs::create_dir_all(ensure_test_home().join(".claude")).unwrap();
    state
        .db
        .save_mcp_server(&server("github", claude_only()))
        .unwrap();
    state
        .db
        .save_mcp_server(&server("gh", claude_only()))
        .unwrap();

    let mut config = McpRouterConfig::default();
    let mut aliased = route("github");
    aliased.alias = Some("gh".to_string());
    config.routes = vec![aliased];
    mcp_router::save_config(&config).unwrap();

    let servers = state.db.get_all_mcp_servers().unwrap();
    let catalog = mcp_router::build_catalog(servers.values(), &mcp_router::load_config());
    assert_eq!(catalog.conflicts.len(), 1);
    assert_eq!(catalog.conflicts[0].exposed_id, "gh");
    // 同权重时显式路由赢：`github` 的别名压过直通的 `gh`。
    assert_eq!(catalog.conflicts[0].winner, "github");

    McpService::sync_enabled_for_app(&state, &phi_lib::AppType::Claude).unwrap();
    let live = read_claude_servers();
    let entry = live
        .get("gh")
        .unwrap_or_else(|| panic!("missing gh: {live:?}"));
    assert_eq!(
        entry["args"][1], "github-server",
        "撞名后写入的是被遮挡方: {entry:?}"
    );
    assert!(!live.contains_key("github"), "{live:?}");
}

/// 保存路由后由服务层立刻重投影：不需要调用方再手动同步一次。
#[test]
fn applying_the_router_config_projects_without_a_manual_resync() {
    let _guard = test_mutex().lock().unwrap();
    reset_test_fs();
    let state = create_test_state().unwrap();
    fs::create_dir_all(ensure_test_home().join(".claude")).unwrap();
    state
        .db
        .save_mcp_server(&server("github", claude_only()))
        .unwrap();
    McpService::sync_enabled_for_app(&state, &phi_lib::AppType::Claude).unwrap();
    assert!(read_claude_servers().contains_key("github"));

    let mut config = McpRouterConfig::default();
    let mut github = route("github");
    github.namespace = Some("work".to_string());
    config.routes = vec![github];
    // 保存命令做的就是这两步：写配置 + 调这个服务方法。
    mcp_router::save_config(&config).unwrap();
    McpService::apply_router_config(&state).unwrap();

    let live = read_claude_servers();
    assert!(live.contains_key("work-github"), "{live:?}");
    assert!(!live.contains_key("github"), "{live:?}");
}

/// 回归：老版本先写过 canonical、本地还没有名字账本（升级场景）时，
/// 加别名后的清理不能依赖账本，canonical 条目同样要消失。
#[test]
fn alias_added_without_a_ledger_still_cleans_the_canonical_entry() {
    let _guard = test_mutex().lock().unwrap();
    reset_test_fs();
    let state = create_test_state().unwrap();
    fs::create_dir_all(ensure_test_home().join(".claude")).unwrap();
    state
        .db
        .save_mcp_server(&server("github", claude_only()))
        .unwrap();

    McpService::sync_enabled_for_app(&state, &phi_lib::AppType::Claude).unwrap();
    assert!(read_claude_servers().contains_key("github"));

    // 模拟升级：账本还不存在，但 live 里已经有 canonical 条目。
    let ledger = mcp_router::applied_state_path();
    if ledger.exists() {
        fs::remove_file(&ledger).unwrap();
    }

    let mut config = McpRouterConfig::default();
    let mut github = route("github");
    github.namespace = Some("work".to_string());
    config.routes = vec![github];
    mcp_router::save_config(&config).unwrap();
    McpService::sync_enabled_for_app(&state, &phi_lib::AppType::Claude).unwrap();

    let live = read_claude_servers();
    assert!(live.contains_key("work-github"), "{live:?}");
    assert!(!live.contains_key("github"), "canonical 残留: {live:?}");
}
