//! 代理服务器模块
//!
//! 提供本地HTTP代理服务，支持多Provider故障转移和请求透传

pub mod body_filter;
pub mod cache_injector;
pub mod circuit_breaker;
pub(crate) mod content_encoding;
pub mod copilot_optimizer;
pub mod error;
pub mod error_mapper;
pub(crate) mod failover_switch;
mod forwarder;
pub(crate) mod gateway_observer;
pub mod gemini_url;
pub mod handler_config;
pub mod handler_context;
mod handlers;
pub mod http_client;
pub mod hyper_client;
pub(crate) mod ingress;
pub(crate) mod json_canonical;
pub(crate) mod ledger_observer;
pub mod log_codes;
pub mod media_sanitizer;
pub mod model_mapper;
pub mod opaque_state_rectifier;
pub mod protocol;
pub mod provider_router;
pub mod providers;
pub mod response_processor;
pub(crate) mod responses_websocket;
pub(crate) mod server;
pub mod session;
pub(crate) mod sse;
pub(crate) mod switch_lock;
pub mod thinking_budget_rectifier;
pub mod thinking_optimizer;
pub mod thinking_rectifier;
pub(crate) mod tool_media;
pub(crate) mod types;
pub mod usage;

// 公开导出给外部使用（commands, services等模块需要）
#[allow(unused_imports)]
pub use circuit_breaker::{
    CircuitBreaker, CircuitBreakerConfig, CircuitBreakerStats, CircuitState,
};
#[allow(unused_imports)]
pub use error::ProxyError;
#[allow(unused_imports)]
pub use provider_router::ProviderRouter;
#[allow(unused_imports)]
pub use session::{extract_session_id, SessionIdResult, SessionIdSource};
#[allow(unused_imports)]
pub use types::{ProxyConfig, ProxyServerInfo, ProxyStatus};

// 内部模块间共享（供子模块使用）
// 注意：这个导出用于模块内部，编译器可能警告未使用但实际被子模块使用
#[allow(unused_imports)]
pub(crate) use types::*;

pub(crate) mod supervisor;

pub(crate) mod chat_bridge;
pub(crate) mod chat_upstream;

#[cfg(test)]
mod golden;

/// 测试专用：直连 loopback 的 HTTP 客户端。
///
/// 本机开着系统代理（Clash 等）时，`reqwest::Client::new()` 会继承代理，把发往
/// 127.0.0.1 的请求交给代理软件；代理对 loopback 的处置各不相同，常见表现是
/// 502 空响应体——看起来像被测代码坏了，而且只在部分机器上复现。测试一律用
/// 这个客户端发请求，结果只取决于被测代码。
#[cfg(test)]
pub(crate) fn loopback_test_client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .build()
        .expect("build loopback test client")
}
