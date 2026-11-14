//! 进程内调用 System One 入口。
//!
//! 调度器（super-agent）要问 Jev 时不再起一条本机 HTTP 连接、也不带访问令牌：
//! 直接复用代理的 handler。这样路由分组、故障转移、成本记账、trace 与其它协议
//! 完全同一条路径，不会因为「内部调用」漏记账。
//!
//! 唯一刻意不做的事：不监听端口。这只是把请求喂给同一个 handler。

use std::sync::Arc;

use axum::extract::State;
use serde_json::Value;

use crate::Database;

/// 一次判断题调用。返回上游原始 JSON（含 `answers` 与 `usage`）。
pub(crate) async fn ask_system_one(db: Arc<Database>, body: Value) -> Result<Value, String> {
    let state = crate::proxy::server::in_process_state(db);
    let request = axum::http::Request::builder()
        .method("POST")
        .uri("/typesafe/v1/systemone")
        .header("content-type", "application/json")
        .body(axum::body::Body::from(body.to_string()))
        .map_err(|error| format!("invalid-request: {error}"))?;
    let response = crate::proxy::handlers::handle_typesafe_systemone(State(state), request)
        .await
        .map_err(|error| error.to_string())?;
    let bytes = axum::body::to_bytes(response.into_body(), 4 * 1024 * 1024)
        .await
        .map_err(|error| format!("read-body: {error}"))?;
    serde_json::from_slice(&bytes).map_err(|error| format!("invalid-json: {error}"))
}
