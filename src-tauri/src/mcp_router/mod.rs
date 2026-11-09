//! MCP 路由中心：统一的 MCP 服务器出口视图。
//!
//! phi 把同一个 MCP 服务器同步到多个客户端（Claude / Codex / Gemini / …）。
//! 当用户在不同来源里装了同名服务器、或者希望某个客户端只看到一部分服务器时，
//! 「每个客户端各自看到什么」就成了一层需要显式建模的路由。
//!
//! - 定义：`mcp-router.json`（[`config`]）
//! - 预览：把数据库服务器 + 路由聚合成一份目录（[`catalog`]）
//! - 执行：MCP 同步投影时按路由给出的暴露名与放行清单写入各客户端
//!
//! 默认配置是「全部直通」：没有路由规则时行为与没有这个模块完全一致。

pub mod catalog;
pub mod config;
pub mod state;

use std::path::PathBuf;
use std::sync::{Arc, LazyLock, RwLock};
use std::time::{Duration, Instant};

pub use catalog::{
    build_catalog, shadowed_server_ids, visible_server_ids, CatalogConflict, CatalogEntry,
    RouterCatalog,
};
pub use config::{Exposure, McpRoute, McpRouterConfig, CONFIG_FILE};
pub use state::{AppliedExposures, STATE_FILE as APPLIED_STATE_FILE};

/// 配置缓存复用时间。
pub const CONFIG_CACHE_TTL: Duration = Duration::from_secs(2);

struct CachedConfig {
    loaded_at: Option<Instant>,
    config: Arc<McpRouterConfig>,
}

static CACHE: LazyLock<RwLock<CachedConfig>> = LazyLock::new(|| {
    RwLock::new(CachedConfig {
        loaded_at: None,
        config: Arc::new(McpRouterConfig::default()),
    })
});

/// 配置文件路径：`<config>/mcp-router.json`。
pub fn config_path() -> PathBuf {
    crate::config::get_app_config_dir().join(CONFIG_FILE)
}

/// 已应用名字账本的路径：`<config>/mcp-router-state.json`。
pub fn applied_state_path() -> PathBuf {
    crate::config::get_app_config_dir().join(APPLIED_STATE_FILE)
}

/// 读取配置（不走缓存；命令与保存流程用）。
pub fn load_config() -> McpRouterConfig {
    McpRouterConfig::load(&config_path())
}

/// 保存配置并立即让缓存失效。
pub fn save_config(config: &McpRouterConfig) -> Result<(), crate::error::AppError> {
    config.save(&config_path())?;
    invalidate_cache();
    Ok(())
}

/// 强制下一次读取重新加载配置。
pub fn invalidate_cache() {
    let mut cache = CACHE
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    cache.loaded_at = None;
}

/// 当前生效的配置（短 TTL 缓存）。
pub fn active_config() -> Arc<McpRouterConfig> {
    let fresh = {
        let cache = CACHE
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        cache
            .loaded_at
            .is_some_and(|loaded_at| loaded_at.elapsed() < CONFIG_CACHE_TTL)
    };
    if fresh {
        return CACHE
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .config
            .clone();
    }

    let config = Arc::new(load_config());
    let mut cache = CACHE
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    cache.loaded_at = Some(Instant::now());
    cache.config = config.clone();
    config
}

/// 某个服务器在某个客户端上的暴露名与放行结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppExposure {
    pub exposed_id: String,
    pub allowed: bool,
}

/// 求一个服务器在指定客户端的投影（同步路径的唯一入口）。
pub fn exposure_for_app(server_id: &str, app: &str) -> AppExposure {
    let config = active_config();
    let exposure = config.exposure(server_id);
    let allowed = exposure.allows(app);
    AppExposure {
        exposed_id: exposure.exposed_id,
        allowed,
    }
}
