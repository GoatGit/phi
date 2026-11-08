//! OpenAI Responses 协议的 WebSocket 传输。
//!
//! Codex CLI 的内置 `openai` 提供商默认先走 WebSocket。这里把一条 WS 连接上的
//! `response.create` 帧聚合成一次普通的 Responses HTTP 请求，交给
//! [`super::handlers::responses_http_response`]——和 HTTP 入口共用同一套路由栈、
//! 故障转移、协议桥接与记账——再把返回的 HTTP/SSE 响应拆成帧推回连接。
//!
//! 上游出口保持 HTTP：第三方供应商基本只有 HTTP/SSE 端点，WS 只在客户端这一段生效。

use super::handlers::responses_http_response;
use super::server::ProxyState;
use crate::app_config::AppType;
use axum::{
    body::Body,
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    extract::{Query, State},
    http::{header, header::HeaderName, HeaderMap, Method, StatusCode, Uri},
    response::{IntoResponse, Response},
};
use futures::StreamExt;
use serde_json::{json, Value};
use std::collections::HashMap;

/// 连接级请求头里可以带进每一轮请求的那些。
///
/// 一部分由客户端在建立连接时给出（认证、会话归属），其余按 HTTP 入口的语义逐轮补齐；
/// hop-by-hop 头（`upgrade`/`connection`/`sec-websocket-*`）不能带过去。
const CONNECTION_FORWARDED_HEADERS: &[&str] = &[
    "authorization",
    "x-phi-token",
    "x-api-key",
    "user-agent",
    "openai-beta",
    "openai-organization",
    "openai-project",
    "originator",
    "session_id",
    "conversation_id",
    "x-session-id",
    "chatgpt-account-id",
    "x-phi-app",
];

/// 对外声称支持的 Responses WS 子类型（HTTP 入口的 endpoint 也用它）。
const RESPONSES_WEBSOCKET_ENDPOINT: &str = "/responses";

/// 本地网关的 Responses WebSocket 入口。
///
/// 路由层把 GET 交给它：符合升级条件就切成 WS；否则自己回 426，而不是让 axum 的提取器
/// 回 400——Codex 只把 426 当成「服务端不支持 WS」的确定信号，当场退到 HTTP，其它状态码
/// 会先把重试预算耗光。
pub async fn handle(
    State(state): State<ProxyState>,
    Query(params): Query<HashMap<String, String>>,
    request: axum::extract::Request,
) -> Response {
    if !is_websocket_upgrade(request.headers()) {
        return upgrade_required().into_response();
    }

    let (mut parts, body) = request.into_parts();
    let connection_headers = collect_connection_headers(&parts.headers);
    let uri = responses_uri(&parts.uri);
    let ws =
        match <WebSocketUpgrade as axum::extract::FromRequestParts<ProxyState>>::from_request_parts(
            &mut parts, &state,
        )
        .await
        {
            Ok(ws) => ws,
            Err(rejection) => {
                log::debug!("[WebSocket] 升级被拒: {rejection}");
                return upgrade_required().into_response();
            }
        };
    // 升级信息在请求扩展里，请求体用不上。
    drop(body);

    let app_type = app_type_from_query(&params);
    ws.on_upgrade(move |socket| async move {
        if let Err(err) = serve(socket, state, app_type, connection_headers, uri).await {
            log::debug!("[WebSocket] Responses 连接结束: {err}");
        }
    })
}

/// 客户端是否真的在请求升级（axum 的提取器要求这三项齐全）。
fn is_websocket_upgrade(headers: &HeaderMap) -> bool {
    let has = |name: header::HeaderName, needle: &str| {
        headers
            .get_all(name)
            .iter()
            .filter_map(|value| value.to_str().ok())
            .flat_map(|value| value.split(','))
            .any(|token| token.trim().eq_ignore_ascii_case(needle))
    };
    has(header::CONNECTION, "upgrade")
        && has(header::UPGRADE, "websocket")
        && headers
            .get(header::SEC_WEBSOCKET_VERSION)
            .and_then(|value| value.to_str().ok())
            == Some("13")
        && headers.contains_key(header::SEC_WEBSOCKET_KEY)
}

/// 未升级时回给客户端的固定回复：426 让 Codex 当场改走 HTTP/SSE。
pub(crate) fn upgrade_required() -> (StatusCode, axum::Json<Value>) {
    (
        StatusCode::UPGRADE_REQUIRED,
        axum::Json(json!({
            "error": {
                "type": "invalid_request_error",
                "code": "websocket_not_supported",
                "message": "Responses WebSocket requires an Upgrade: websocket handshake",
            }
        })),
    )
}

/// 查询参数可以指定应用归属，缺省按 Codex 处理。
fn app_type_from_query(params: &HashMap<String, String>) -> AppType {
    match params.get("app").map(String::as_str) {
        Some("grokbuild" | "grok-build" | "grok_build") => AppType::GrokBuild,
        _ => AppType::Codex,
    }
}

async fn serve(
    socket: WebSocket,
    state: ProxyState,
    app_type: AppType,
    connection_headers: HeaderMap,
    uri: Uri,
) -> Result<(), String> {
    let (tag, app_type_str) = match app_type {
        AppType::GrokBuild => ("Grok Build", "grokbuild"),
        _ => ("Codex", "codex"),
    };
    let mut session = WsSession::new(socket, connection_headers, uri);

    while let Some(message) = session.next_message().await? {
        let Message::Text(text) = message else {
            // 二进制帧和 Responses WS 协议无关，ping/pong 由 axum 自己应答。
            continue;
        };
        let Some(payload) = parse_client_frame(&text) else {
            continue;
        };
        match payload.kind {
            ClientFrame::Ping => session.send_json(&json!({ "type": "pong" })).await?,
            ClientFrame::Create => match payload.response {
                Some(response) => {
                    session
                        .relay_once(&state, app_type.clone(), tag, app_type_str, response)
                        .await?;
                }
                None => {
                    session
                        .send_json(&protocol_error(
                            "response.create 缺少 response 字段",
                            "invalid_request_error",
                        ))
                        .await?;
                }
            },
        }
    }

    Ok(())
}

/// 只保留连接级需要的请求头，其它（含升级握手用的头）逐轮重新构造。
fn collect_connection_headers(headers: &HeaderMap) -> HeaderMap {
    let mut kept = HeaderMap::new();
    for name in CONNECTION_FORWARDED_HEADERS {
        if let Ok(name) = HeaderName::from_bytes(name.as_bytes()) {
            for value in headers.get_all(&name) {
                kept.append(name.clone(), value.clone());
            }
        }
    }
    // 白名单本身已经排除了升级头；再走一遍 hop-by-hop 剔除，`Connection` 里点名的
    // 扩展头（客户端有时会把它们跟认证头一起挂在握手请求上）也不会带进每一轮请求。
    super::response_processor::strip_hop_by_hop_request_headers(&mut kept);
    kept
}

/// 沿用连接上的路径（`/v1/responses` 等），只把查询串削掉。
fn responses_uri(uri: &Uri) -> Uri {
    let path = uri.path();
    let path = if path.is_empty() {
        RESPONSES_WEBSOCKET_ENDPOINT
    } else {
        path
    };
    path.parse()
        .unwrap_or_else(|_| Uri::from_static(RESPONSES_WEBSOCKET_ENDPOINT))
}

/// 客户端推上来的一帧。
enum ClientFrame {
    /// `{"type":"response.create","response":{...}}`
    Create,
    /// 心跳：回一帧 `{"type":"pong"}`。
    Ping,
}

struct ClientPayload {
    kind: ClientFrame,
    response: Option<Value>,
}

/// 解析一帧客户端消息。未知类型直接忽略，避免一帧不认识的消息打断整条连接。
fn parse_client_frame(text: &str) -> Option<ClientPayload> {
    let value: Value = serde_json::from_str(text).ok()?;
    let head = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let kind = match head {
        "response.create" => ClientFrame::Create,
        "ping" => ClientFrame::Ping,
        // 事件编号类消息（`event_id`/`response.processed`）不改变会话状态。
        _ => return None,
    };
    let response = value
        .get("response")
        .cloned()
        .or_else(|| value.get("request").cloned());
    Some(ClientPayload { kind, response })
}

fn protocol_error(message: &str, error_type: &str) -> Value {
    json!({
        "type": "error",
        "error": {
            "type": error_type,
            "code": "invalid_request_error",
            "message": message,
        }
    })
}

async fn send_proxy_error(session: &mut WsSession, err: &super::ProxyError) -> Result<(), String> {
    session
        .send_json(&json!({
            "type": "error",
            "error": {
                "type": "api_error",
                "code": "proxy_error",
                "message": err.to_string(),
            }
        }))
        .await
}

struct WsSession {
    socket: WebSocket,
    headers: HeaderMap,
    uri: Uri,
    sequence: usize,
}

impl WsSession {
    fn new(socket: WebSocket, headers: HeaderMap, uri: Uri) -> Self {
        Self {
            socket,
            headers,
            uri,
            sequence: 0,
        }
    }

    async fn next_message(&mut self) -> Result<Option<Message>, String> {
        self.socket
            .next()
            .await
            .transpose()
            .map_err(|err| format!("读取 WebSocket 帧失败: {err}"))
    }

    async fn send_json(&mut self, value: &Value) -> Result<(), String> {
        self.send_text(value.to_string()).await
    }

    async fn send_text(&mut self, text: String) -> Result<(), String> {
        self.socket
            .send(Message::Text(text))
            .await
            .map_err(|err| format!("写入 WebSocket 帧失败: {err}"))
    }

    /// 把 `event: X\ndata: {...}` 还原成帧里的那个 JSON 事件。
    async fn relay_event(&mut self, event: Value) -> Result<(), String> {
        self.send_json(&event).await
    }

    /// 跑完一轮：聚合请求 → 走 HTTP/SSE 语义 → 逐帧推回。
    async fn relay_once(
        &mut self,
        state: &ProxyState,
        app_type: AppType,
        tag: &'static str,
        app_type_str: &'static str,
        mut response: Value,
    ) -> Result<(), String> {
        self.sequence += 1;

        if let Some(object) = response.as_object_mut() {
            // WS 通道本身就在流式传输；上游 HTTP/SSE 入口按 stream=true 走流式管线。
            object.insert("stream".to_string(), Value::Bool(true));
            object
                .entry("generate".to_string())
                .or_insert_with(|| Value::Bool(true));
        }

        let body = serde_json::to_vec(&response)
            .map_err(|err| format!("序列化 response.create 请求体失败: {err}"))?;

        let mut headers = self.headers.clone();
        // 每轮都当成一次新的 HTTP 请求：握手用的头已剔除，实体头重新构造。
        headers.remove("content-length");
        headers.remove("accept");
        headers.insert(
            "content-type",
            "application/json".parse().expect("static header"),
        );

        let result = responses_http_response(
            state.clone(),
            Method::POST,
            self.uri.clone(),
            headers,
            axum::http::Extensions::new(),
            axum::body::Bytes::from(body),
            app_type,
            tag,
            app_type_str,
        )
        .await;

        let http_response = match result {
            Ok(response) => response,
            Err(err) => return send_proxy_error(self, &err).await,
        };
        self.relay_http_response(http_response).await
    }

    /// HTTP/SSE 响应 → WebSocket 帧。
    ///
    /// 上游的 4xx/5xx 通常是完整 JSON 错误体，整包读出来包成 `event: error` 推回，Codex
    /// 按 Responses 的错误事件处理；成功响应则把 SSE 里每个 `data:` 事件原样推成一帧。
    async fn relay_http_response(&mut self, response: Response) -> Result<(), String> {
        let status = response.status();
        let is_sse = response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.starts_with("text/event-stream"));

        if !is_sse {
            let body = read_body_bytes(response.into_body()).await?;
            let payload = serde_json::from_slice::<Value>(&body).unwrap_or_else(|_| {
                json!({
                    "type": "error",
                    "error": {
                        "type": "api_error",
                        "code": "upstream_error",
                        "message": String::from_utf8_lossy(&body),
                    }
                })
            });
            let payload = if status.is_success()
                || payload.get("type").and_then(Value::as_str) == Some("error")
            {
                payload
            } else {
                json!({
                    "type": "error",
                    "error": {
                        "type": "api_error",
                        "code": format!("http_{}", status.as_u16()),
                        "message": payload,
                    }
                })
            };
            return self.relay_event(payload).await;
        }

        let mut body = response.into_body().into_data_stream();
        let mut buffer = String::new();
        let mut utf8_remainder: Vec<u8> = Vec::new();
        while let Some(chunk) = body.next().await {
            let chunk = chunk.map_err(|err| format!("读取上游 SSE 失败: {err}"))?;
            super::sse::append_utf8_safe(&mut buffer, &mut utf8_remainder, &chunk);
            while let Some(block) = super::sse::take_sse_block(&mut buffer) {
                if let Some(event) = sse_block_event(&block) {
                    self.relay_event(event).await?;
                }
            }
        }
        if !buffer.trim().is_empty() {
            if let Some(event) = sse_block_event(&buffer) {
                self.relay_event(event).await?;
            }
        }
        Ok(())
    }
}

async fn read_body_bytes(body: Body) -> Result<Vec<u8>, String> {
    let mut stream = body.into_data_stream();
    let mut collected: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|err| format!("读取响应体失败: {err}"))?;
        collected.extend_from_slice(&chunk);
    }
    Ok(collected)
}

/// 从一段 SSE 里取出 `data:` 并解析成 JSON。注释行、空块和 `[DONE]` 都不产生帧。
fn sse_block_event(block: &str) -> Option<Value> {
    let mut data = String::new();
    for line in block.lines() {
        let Some(value) = super::sse::strip_sse_field(line, "data") else {
            continue;
        };
        if !data.is_empty() {
            data.push('\n');
        }
        data.push_str(value);
    }
    let data = data.trim();
    if data.is_empty() || data == "[DONE]" {
        return None;
    }
    serde_json::from_str(data).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_create_frames_extract_the_response_body() {
        let payload = parse_client_frame(
            r#"{"type":"response.create","response":{"model":"gpt-5.5","input":[]}}"#,
        )
        .expect("frame parses");
        assert!(matches!(payload.kind, ClientFrame::Create));
        let response = payload.response.expect("response body");
        assert_eq!(response["model"], "gpt-5.5");
    }

    #[test]
    fn unknown_client_frames_are_ignored() {
        assert!(parse_client_frame(r#"{"type":"response.cancel"}"#).is_none());
        assert!(parse_client_frame("not json").is_none());
    }

    #[test]
    fn ping_frames_are_recognised() {
        let payload = parse_client_frame(r#"{"type":"ping","event_id":"1"}"#).expect("ping");
        assert!(matches!(payload.kind, ClientFrame::Ping));
    }

    #[test]
    fn sse_blocks_become_single_event_frames() {
        let event = sse_block_event(
            "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"hi\"}\n\n",
        )
        .expect("event");
        assert_eq!(event["type"], "response.output_text.delta");
        assert!(sse_block_event(": keepalive\n\n").is_none());
        assert!(sse_block_event("data: [DONE]\n\n").is_none());
    }

    #[test]
    fn connection_headers_keep_only_protocol_relevant_ones() {
        let mut headers = HeaderMap::new();
        headers.insert("authorization", "Bearer sk-test".parse().unwrap());
        headers.insert("upgrade", "websocket".parse().unwrap());
        headers.insert("sec-websocket-key", "abc".parse().unwrap());
        headers.insert("user-agent", "codex_cli".parse().unwrap());
        let kept = collect_connection_headers(&headers);
        assert_eq!(
            kept.get("authorization").and_then(|v| v.to_str().ok()),
            Some("Bearer sk-test")
        );
        assert_eq!(
            kept.get("user-agent").and_then(|v| v.to_str().ok()),
            Some("codex_cli")
        );
        assert!(kept.get("upgrade").is_none());
        assert!(kept.get("sec-websocket-key").is_none());
    }

    #[test]
    fn query_selects_the_grokbuild_app_type() {
        let mut params = HashMap::new();
        params.insert("app".to_string(), "grokbuild".to_string());
        assert!(matches!(app_type_from_query(&params), AppType::GrokBuild));
        assert!(matches!(
            app_type_from_query(&HashMap::new()),
            AppType::Codex
        ));
    }
}
