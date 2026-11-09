//! MCP 路由中心的配置（`mcp-router.json`）。
//!
//! 路由中心解决的是「同一个 MCP 服务器在多个客户端里名字/可见性不一致」这件事：
//! - **别名/命名空间**：把 `github` 暴露成 `work-github`，避免不同来源的同名服务器打架；
//! - **按客户端放行**：一条服务器只投影给部分客户端；
//! - **优先级**：别名撞名时谁赢。
//!
//! 配置是纯声明，不执行代码；非法配置在保存时就被拒，读取时退回「全部直通」，
//! 绝不让一份坏配置把已经能用的 MCP 同步弄坏。

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use std::str::FromStr;

use crate::app_config::AppType;
use crate::error::AppError;

/// 配置文件名（位于配置目录）。
pub const CONFIG_FILE: &str = "mcp-router.json";

const CURRENT_VERSION: u32 = 1;
const MAX_ROUTES: usize = 128;
const MAX_ID_CHARS: usize = 128;
const MAX_NAME_CHARS: usize = 64;
const MAX_SEPARATOR_CHARS: usize = 4;
const MAX_APPS_PER_ROUTE: usize = 16;
const MAX_TAGS_PER_ROUTE: usize = 16;

fn default_version() -> u32 {
    CURRENT_VERSION
}

fn default_true() -> bool {
    true
}

fn default_separator() -> String {
    "-".to_string()
}

/// 一条路由规则，按 `server_id` 索引。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpRoute {
    /// 被路由的服务器 id（`McpServer::id`）。
    pub server_id: String,
    /// 暴露给客户端的名字；给了就忽略 `namespace`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alias: Option<String>,
    /// 命名空间前缀：暴露名 = `<namespace><separator><server_id>`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,
    /// 只投影给这些客户端；空数组 = 全部客户端。
    #[serde(default)]
    pub apps: Vec<String>,
    /// 关闭后该服务器对所有客户端隐藏（并从 live 配置里移除）。
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// 别名撞名时的胜出权重：数值大的赢，同权重按 `server_id` 字典序。
    #[serde(default)]
    pub priority: i32,
    /// 自由标签，只用于展示与检索。
    #[serde(default)]
    pub tags: Vec<String>,
}

impl McpRoute {
    fn validate(&self, index: usize) -> Result<(), String> {
        validate_token("serverId", &self.server_id, MAX_ID_CHARS)
            .map_err(|err| format!("第 {index} 条路由的 {err}"))?;
        if self.alias.is_none() && self.namespace.is_none() {
            // 允许：直通路由只用来控制可见性/优先级。
        }
        for (field, value) in [("alias", &self.alias), ("namespace", &self.namespace)] {
            if let Some(value) = value {
                validate_token(field, value, MAX_NAME_CHARS)
                    .map_err(|err| format!("第 {index} 条路由的 {err}"))?;
            }
        }
        if self.apps.len() > MAX_APPS_PER_ROUTE {
            return Err(format!(
                "第 {index} 条路由的 apps 超过 {MAX_APPS_PER_ROUTE} 项上限"
            ));
        }
        for app in &self.apps {
            AppType::from_str(app)
                .map_err(|err| format!("第 {index} 条路由的 apps 含未知客户端 '{app}': {err}"))?;
        }
        if self.tags.len() > MAX_TAGS_PER_ROUTE {
            return Err(format!(
                "第 {index} 条路由的 tags 超过 {MAX_TAGS_PER_ROUTE} 项上限"
            ));
        }
        for tag in &self.tags {
            if tag.chars().count() > MAX_NAME_CHARS {
                return Err(format!("第 {index} 条路由的标签过长: {tag}"));
            }
        }
        Ok(())
    }

    /// 这条路由算出的暴露名（未配置别名/命名空间时等于 server id）。
    pub fn exposed_id(&self, separator: &str) -> String {
        if let Some(alias) = &self.alias {
            return alias.clone();
        }
        match &self.namespace {
            Some(namespace) => format!("{namespace}{separator}{}", self.server_id),
            None => self.server_id.clone(),
        }
    }
}

/// 路由中心配置。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct McpRouterConfig {
    #[serde(default = "default_version")]
    pub version: u32,
    /// 总开关：关闭时所有服务器按原名直通。
    pub enabled: bool,
    /// 命名空间分隔符。
    #[serde(default = "default_separator")]
    pub namespace_separator: String,
    pub routes: Vec<McpRoute>,
}

impl Default for McpRouterConfig {
    fn default() -> Self {
        Self {
            version: CURRENT_VERSION,
            enabled: true,
            namespace_separator: default_separator(),
            routes: Vec::new(),
        }
    }
}

/// 单个服务器在路由中心下的投影。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Exposure {
    /// 暴露给客户端的名字。
    pub exposed_id: String,
    /// 路由是否放行（`false` = 全部隐藏）。
    pub enabled: bool,
    /// 允许的客户端；空数组 = 全部。
    pub apps: Vec<String>,
    /// 是否命中显式路由。
    pub routed: bool,
}

impl Exposure {
    /// 这个客户端能否看到该服务器。
    pub fn allows(&self, app: &str) -> bool {
        self.enabled
            && (self.apps.is_empty()
                || self
                    .apps
                    .iter()
                    .any(|allowed| allowed.eq_ignore_ascii_case(app)))
    }
}

impl McpRouterConfig {
    /// 读取配置；缺失/损坏/版本不认识都退回「全部直通」。
    pub fn load(path: &Path) -> Self {
        let Ok(raw) = fs::read_to_string(path) else {
            return Self::default();
        };
        match serde_json::from_str::<Self>(&raw) {
            Ok(config) if config.version == CURRENT_VERSION => match config.validate() {
                Ok(()) => config,
                Err(err) => {
                    log::warn!("MCP 路由配置校验失败，按直通处理: {err}");
                    Self::default()
                }
            },
            Ok(config) => {
                log::warn!(
                    "MCP 路由配置版本为 {}，当前支持 {CURRENT_VERSION}，按直通处理",
                    config.version
                );
                Self::default()
            }
            Err(err) => {
                log::warn!("MCP 路由配置无法解析，按直通处理: {err}");
                Self::default()
            }
        }
    }

    /// 校验并原子写盘。
    pub fn save(&self, path: &Path) -> Result<(), AppError> {
        self.validate()
            .map_err(|err| AppError::InvalidInput(format!("MCP 路由配置非法: {err}")))?;
        if self.version != CURRENT_VERSION {
            return Err(AppError::InvalidInput(format!(
                "MCP 路由配置版本必须为 {CURRENT_VERSION}"
            )));
        }
        let serialized = serde_json::to_string_pretty(self)
            .map_err(|source| AppError::JsonSerialize { source })?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|err| AppError::io(parent, err))?;
        }
        crate::config::atomic_write(path, format!("{serialized}\n").as_bytes())
    }

    /// 校验：路由数量、id/别名形状、客户端名、重复 serverId。
    pub fn validate(&self) -> Result<(), String> {
        if !matches!(
            self.namespace_separator.as_str(),
            "-" | "_" | "." | ":" | "/"
        ) {
            return Err(format!(
                "namespaceSeparator 只支持 '-', '_', '.', ':', '/'，收到 '{}'",
                self.namespace_separator
            ));
        }
        if self.namespace_separator.chars().count() > MAX_SEPARATOR_CHARS {
            return Err(format!(
                "namespaceSeparator 超过 {MAX_SEPARATOR_CHARS} 字符上限"
            ));
        }
        if self.routes.len() > MAX_ROUTES {
            return Err(format!("路由数超过 {MAX_ROUTES} 条上限"));
        }
        let mut seen = std::collections::HashSet::new();
        for (index, route) in self.routes.iter().enumerate() {
            route.validate(index)?;
            if !seen.insert(route.server_id.as_str()) {
                return Err(format!("serverId '{}' 出现了多条路由", route.server_id));
            }
        }
        Ok(())
    }

    /// 某个服务器的投影；未配置路由时按原名直通。
    pub fn exposure(&self, server_id: &str) -> Exposure {
        let route = self.enabled.then(|| {
            self.routes
                .iter()
                .find(|route| route.server_id == server_id)
        });
        match route.flatten() {
            Some(route) => Exposure {
                exposed_id: route.exposed_id(&self.namespace_separator),
                enabled: route.enabled,
                apps: route
                    .apps
                    .iter()
                    .map(|app| app.to_ascii_lowercase())
                    .collect(),
                routed: true,
            },
            None => Exposure {
                exposed_id: server_id.to_string(),
                enabled: true,
                apps: Vec::new(),
                routed: false,
            },
        }
    }

    /// 曾经配置过的暴露名（忽略总开关与单条路由的 `enabled`）。
    ///
    /// 删除/停用时用它清理 live 配置里的旧名字：路由已经关掉时，
    /// 按当前投影算出来的名字是原名，旧别名就会永久留在客户端配置里。
    pub fn configured_exposed_id(&self, server_id: &str) -> Option<String> {
        self.routes
            .iter()
            .find(|route| route.server_id == server_id)
            .map(|route| route.exposed_id(&self.namespace_separator))
            .filter(|exposed| exposed != server_id)
    }

    /// 路由优先级（未配置时为 0），用于别名撞名时的胜出判定。
    pub fn priority_of(&self, server_id: &str) -> i32 {
        self.enabled
            .then(|| {
                self.routes
                    .iter()
                    .find(|route| route.server_id == server_id)
                    .map(|route| route.priority)
            })
            .flatten()
            .unwrap_or(0)
    }
}

fn validate_token(field: &str, value: &str, max_chars: usize) -> Result<(), String> {
    let chars = value.chars().count();
    if chars == 0 || chars > max_chars {
        return Err(format!("{field} 长度必须在 1..={max_chars} 字符之间"));
    }
    if !value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return Err(format!(
            "{field} 只允许字母、数字、'-'、'_'、'.'，收到 '{value}'"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn passthrough_when_no_route_matches() {
        let config = McpRouterConfig::default();
        let exposure = config.exposure("github");
        assert_eq!(exposure.exposed_id, "github");
        assert!(exposure.enabled);
        assert!(exposure.allows("claude"));
        assert!(!exposure.routed);
    }

    #[test]
    fn alias_wins_over_namespace() {
        let mut config = McpRouterConfig::default();
        let mut entry = route("github");
        entry.alias = Some("gh".to_string());
        entry.namespace = Some("work".to_string());
        config.routes = vec![entry];
        assert_eq!(config.exposure("github").exposed_id, "gh");
    }

    #[test]
    fn namespace_prefixes_with_configured_separator() {
        let mut entry = route("github");
        entry.namespace = Some("work".to_string());
        let config = McpRouterConfig {
            namespace_separator: "_".to_string(),
            routes: vec![entry],
            ..McpRouterConfig::default()
        };
        assert_eq!(config.exposure("github").exposed_id, "work_github");
    }

    #[test]
    fn disabled_route_hides_the_server_for_every_app() {
        let mut config = McpRouterConfig::default();
        let mut entry = route("github");
        entry.enabled = false;
        config.routes = vec![entry];
        let exposure = config.exposure("github");
        assert!(!exposure.enabled);
        assert!(!exposure.allows("claude"));
    }

    #[test]
    fn app_allowlist_is_case_insensitive() {
        let mut config = McpRouterConfig::default();
        let mut entry = route("github");
        entry.apps = vec!["Claude".to_string()];
        config.routes = vec![entry];
        let exposure = config.exposure("github");
        assert!(exposure.allows("claude"));
        assert!(!exposure.allows("codex"));
    }

    #[test]
    fn master_switch_disables_all_routing() {
        let mut entry = route("github");
        entry.alias = Some("gh".to_string());
        entry.enabled = false;
        let config = McpRouterConfig {
            enabled: false,
            routes: vec![entry],
            ..McpRouterConfig::default()
        };
        let exposure = config.exposure("github");
        assert_eq!(exposure.exposed_id, "github");
        assert!(exposure.allows("claude"));
    }

    #[test]
    fn invalid_configs_are_rejected() {
        let config = McpRouterConfig {
            namespace_separator: "|".to_string(),
            ..McpRouterConfig::default()
        };
        assert!(config.validate().is_err());

        let config = McpRouterConfig {
            routes: vec![route("a"), route("a")],
            ..McpRouterConfig::default()
        };
        assert!(config.validate().is_err());

        let mut config = McpRouterConfig::default();
        let mut entry = route("a");
        entry.alias = Some("bad name".to_string());
        config.routes = vec![entry];
        assert!(config.validate().is_err());

        let mut config = McpRouterConfig::default();
        let mut entry = route("a");
        entry.apps = vec!["nope".to_string()];
        config.routes = vec![entry];
        assert!(config.validate().is_err());
    }

    #[test]
    fn roundtrips_through_disk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(CONFIG_FILE);
        let mut config = McpRouterConfig::default();
        let mut entry = route("github");
        entry.namespace = Some("work".to_string());
        entry.apps = vec!["claude".to_string()];
        entry.tags = vec!["vcs".to_string()];
        config.routes = vec![entry];
        config.save(&path).unwrap();
        assert_eq!(McpRouterConfig::load(&path), config);
    }

    #[test]
    fn broken_file_falls_back_to_passthrough() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(CONFIG_FILE);
        fs::write(&path, "{nope").unwrap();
        assert_eq!(McpRouterConfig::load(&path), McpRouterConfig::default());
    }
}
