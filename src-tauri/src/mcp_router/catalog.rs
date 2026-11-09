//! MCP 路由目录：把「数据库里的服务器 + 路由配置」聚合成一份可预览的投影。
//!
//! 预览是路由中心对用户的主要可见面：在真正写任何客户端配置之前，先看
//! 「每个服务器最终以什么名字、出现在哪些客户端、和谁撞名」。撞名不静默吞掉，
//! 而是列在 `conflicts` 里——静默覆盖是这类系统最难排查的一类故障。

use std::collections::BTreeMap;

use serde::Serialize;

use super::config::McpRouterConfig;
use crate::app_config::{AppType, McpServer};

/// 一个服务器在某次预览中的投影。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry {
    pub server_id: String,
    pub name: String,
    /// 最终暴露给客户端的名字。
    pub exposed_id: String,
    /// 是否会被投影（路由关闭时为 `false`）。
    pub enabled: bool,
    /// 路由放行的客户端；空 = 全部。
    pub routed_apps: Vec<String>,
    /// 数据库里当前勾选的客户端。
    pub source_apps: Vec<String>,
    /// 是否命中显式路由。
    pub route_configured: bool,
    /// 撞名时被谁遮蔽（同名字段以胜出者的配置为准）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shadowed_by: Option<String>,
}

/// 一次撞名。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogConflict {
    pub exposed_id: String,
    /// 撞名的服务器 id（按字典序）。
    pub server_ids: Vec<String>,
    /// 实际生效的服务器 id。
    pub winner: String,
}

/// 预览结果。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouterCatalog {
    pub entries: Vec<CatalogEntry>,
    pub conflicts: Vec<CatalogConflict>,
}

/// 由服务器集合与路由配置构建预览。
///
/// `servers` 用 `BTreeMap` 保证输出顺序稳定（便于快照测试与 UI diff）。
pub fn build_catalog<'a, I>(servers: I, config: &McpRouterConfig) -> RouterCatalog
where
    I: IntoIterator<Item = &'a McpServer>,
{
    let mut entries: Vec<CatalogEntry> = Vec::new();
    for server in servers {
        let exposure = config.exposure(&server.id);
        entries.push(CatalogEntry {
            server_id: server.id.clone(),
            name: server.name.clone(),
            exposed_id: exposure.exposed_id,
            enabled: exposure.enabled,
            routed_apps: exposure.apps,
            source_apps: server
                .apps
                .enabled_apps()
                .iter()
                .map(|app| app.as_str().to_string())
                .collect(),
            route_configured: exposure.routed,
            shadowed_by: None,
        });
    }
    entries.sort_by(|left, right| {
        left.exposed_id
            .cmp(&right.exposed_id)
            .then(left.server_id.cmp(&right.server_id))
    });

    // 只在「两条都是显式路由」时判遮挡：直通服务器的 id 天然唯一，
    // 不因为别名撞上它们就改变现有同步行为。
    let mut grouped: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    for (index, entry) in entries.iter().enumerate() {
        if entry.route_configured {
            grouped
                .entry(entry.exposed_id.clone())
                .or_default()
                .push(index);
        }
    }

    let mut conflicts = Vec::new();
    for (exposed_id, indexes) in grouped {
        if indexes.len() < 2 {
            continue;
        }
        let winner_index = *indexes
            .iter()
            .max_by(|left, right| {
                let left_priority = config.priority_of(&entries[**left].server_id);
                let right_priority = config.priority_of(&entries[**right].server_id);
                left_priority
                    .cmp(&right_priority)
                    // 同权重时 id 字典序小的赢，保证跨机器可复现。
                    .then(entries[**right].server_id.cmp(&entries[**left].server_id))
            })
            .expect("non-empty group");
        let winner = entries[winner_index].server_id.clone();
        let mut server_ids: Vec<String> = indexes
            .iter()
            .map(|index| entries[*index].server_id.clone())
            .collect();
        server_ids.sort();
        for index in indexes {
            if entries[index].server_id != winner {
                entries[index].shadowed_by = Some(winner.clone());
            }
        }
        conflicts.push(CatalogConflict {
            exposed_id,
            server_ids,
            winner,
        });
    }
    conflicts.sort_by(|left, right| left.exposed_id.cmp(&right.exposed_id));

    RouterCatalog { entries, conflicts }
}

/// 该客户端实际能看到的服务器 id（已应用路由放行与遮挡）。
pub fn visible_server_ids<'a, I>(servers: I, config: &McpRouterConfig, app: &AppType) -> Vec<String>
where
    I: IntoIterator<Item = &'a McpServer>,
{
    let catalog = build_catalog(servers, config);
    let app = app.as_str();
    let shadowed: std::collections::HashSet<String> = catalog
        .entries
        .iter()
        .filter(|entry| entry.shadowed_by.is_some())
        .map(|entry| entry.server_id.clone())
        .collect();
    catalog
        .entries
        .into_iter()
        .filter(|entry| entry.enabled)
        .filter(|entry| entry.source_apps.iter().any(|source| source == app))
        .filter(|entry| {
            entry.routed_apps.is_empty() || entry.routed_apps.iter().any(|allowed| allowed == app)
        })
        .filter(|entry| !shadowed.contains(&entry.server_id))
        .map(|entry| entry.exposed_id)
        .collect()
}

/// 被别名撞名遮挡的服务器 id（同步投影时要跳过它们）。
pub fn shadowed_server_ids<'a, I>(
    servers: I,
    config: &McpRouterConfig,
) -> std::collections::HashSet<String>
where
    I: IntoIterator<Item = &'a McpServer>,
{
    build_catalog(servers, config)
        .entries
        .into_iter()
        .filter(|entry| entry.shadowed_by.is_some())
        .map(|entry| entry.server_id)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_config::McpApps;
    use crate::mcp_router::config::McpRoute;
    use serde_json::json;

    fn server(id: &str) -> McpServer {
        McpServer {
            id: id.to_string(),
            name: id.to_string(),
            server: json!({"command":"npx"}),
            apps: McpApps {
                claude: true,
                codex: true,
                ..McpApps::default()
            },
            description: None,
            homepage: None,
            docs: None,
            tags: Vec::new(),
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

    #[test]
    fn passthrough_entries_are_unchanged() {
        let servers = vec![server("github"), server("fs")];
        let catalog = build_catalog(&servers, &McpRouterConfig::default());
        let ids: Vec<&str> = catalog
            .entries
            .iter()
            .map(|entry| entry.exposed_id.as_str())
            .collect();
        assert_eq!(ids, ["fs", "github"]);
        assert!(catalog.conflicts.is_empty());
    }

    #[test]
    fn namespace_and_alias_are_applied() {
        let mut config = McpRouterConfig::default();
        let mut namespaced = route("github");
        namespaced.namespace = Some("work".to_string());
        let mut aliased = route("fs");
        aliased.alias = Some("filesystem".to_string());
        config.routes = vec![namespaced, aliased];
        let servers = vec![server("github"), server("fs")];
        let catalog = build_catalog(&servers, &config);
        let exposed: Vec<&str> = catalog
            .entries
            .iter()
            .map(|entry| entry.exposed_id.as_str())
            .collect();
        assert_eq!(exposed, ["filesystem", "work-github"]);
    }

    #[test]
    fn alias_collision_reports_winner_and_shadow() {
        let mut config = McpRouterConfig::default();
        let mut first = route("a");
        first.alias = Some("shared".to_string());
        first.priority = 1;
        let mut second = route("b");
        second.alias = Some("shared".to_string());
        second.priority = 9;
        config.routes = vec![first, second];
        let servers = vec![server("a"), server("b")];
        let catalog = build_catalog(&servers, &config);
        assert_eq!(catalog.conflicts.len(), 1);
        let conflict = &catalog.conflicts[0];
        assert_eq!(conflict.exposed_id, "shared");
        assert_eq!(conflict.winner, "b");
        assert_eq!(conflict.server_ids, ["a", "b"]);
        let entry_a = catalog
            .entries
            .iter()
            .find(|entry| entry.server_id == "a")
            .unwrap();
        assert_eq!(entry_a.shadowed_by.as_deref(), Some("b"));
    }

    #[test]
    fn passthrough_does_not_collide_with_aliases() {
        let mut config = McpRouterConfig::default();
        let mut aliased = route("a");
        aliased.alias = Some("b".to_string());
        config.routes = vec![aliased];
        let servers = vec![server("a"), server("b")];
        let catalog = build_catalog(&servers, &config);
        assert!(catalog.conflicts.is_empty());
    }

    #[test]
    fn disabled_route_and_app_allowlist_filter_visibility() {
        let mut config = McpRouterConfig::default();
        let mut hidden = route("hidden");
        hidden.enabled = false;
        let mut claude_only = route("claude-only");
        claude_only.apps = vec!["claude".to_string()];
        config.routes = vec![hidden, claude_only];
        let servers = vec![server("hidden"), server("claude-only"), server("open")];

        let visible = visible_server_ids(&servers, &config, &AppType::Claude);
        assert_eq!(visible, ["claude-only", "open"]);

        let visible = visible_server_ids(&servers, &config, &AppType::Codex);
        assert_eq!(visible, ["open"]);
    }
}
