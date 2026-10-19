//! Chat 入口接非 Chat 上游。
//!
//! OpenCode / OpenClaw / Hermes / Pi / MCode 的原生入口是 OpenAI Chat
//! （`/<app>/v1/chat/completions`），但路由组成员可以是 Anthropic Messages 或
//! OpenAI Responses 供应商。这里负责这条桥：
//!
//! - 请求：转发前把 Chat 归一成 Responses（[`super::chat_bridge`]），再由既有的
//!   Responses → Anthropic 转换发出去（见 `forwarder::forward_resolved`）；
//! - 回包：上游的 Anthropic / Responses 结果先补成 Responses，再转回 Chat。
//!
//! 之所以绕 Responses 而不是直接写 Chat ↔ Anthropic 两套转换器：Responses 已经
//! 是 Codex 入口的中间层，Anthropic / Chat 两侧的转换和流式收尾都在那里验证过。

use bytes::Bytes;
use futures::Stream;
use http::{header, HeaderMap, StatusCode};
use serde_json::Value;

use super::{
    chat_bridge,
    forwarder::ActiveConnectionGuard,
    handler_config::{CODEX_PARSER_CONFIG, OPENAI_PARSER_CONFIG},
    handler_context::RequestContext,
    hyper_client::ProxyResponse,
    protocol,
    providers::responses_to_chat::CodexToolContext,
    response_processor::{
        create_logged_passthrough_stream, create_usage_collector, process_response,
        read_decoded_body, strip_entity_headers_for_rebuilt_body,
        strip_hop_by_hop_response_headers,
    },
    server::ProxyState,
    ProxyError,
};

/// 上游实际讲的协议。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Upstream {
    /// OpenAI Chat：与客户端同协议，直接透传。
    Chat,
    /// OpenAI Responses：请求经 [`super::chat_bridge`] 归一成 Responses 后透传。
    Responses,
    /// Anthropic Messages：请求再经 Responses → Anthropic 转换。
    Anthropic,
}

/// 这次尝试要发往哪种上游。网关路由的供应商在 `meta.api_format` 里带上供应商
/// 协议；应用自己的供应商行没有这个字段，按 Chat 处理（那就是它的原生协议）。
pub(crate) fn upstream_for(provider: &crate::provider::Provider) -> Upstream {
    let format = provider
        .meta
        .as_ref()
        .and_then(|meta| meta.api_format.as_deref())
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    match protocol::Protocol::from_api_format(&format) {
        Some(protocol::Protocol::Anthropic) => Upstream::Anthropic,
        Some(protocol::Protocol::OpenAiResponses) => Upstream::Responses,
        _ => Upstream::Chat,
    }
}

/// 上游 Responses 回包 → 客户端要的 Chat。
///
/// 非流式（含上游忽略 `stream` 直接回 JSON 的情况）走缓冲转换；流式在转发路径上
/// 解析 Responses SSE，转成 Chat SSE 再交给客户端。
#[allow(clippy::too_many_arguments)]
pub(crate) async fn convert_response(
    response: ProxyResponse,
    ctx: &RequestContext,
    state: &ProxyState,
    upstream: Upstream,
    request_is_stream: bool,
    include_usage: bool,
    tool_context: CodexToolContext,
    connection_guard: Option<ActiveConnectionGuard>,
) -> Result<axum::response::Response, ProxyError> {
    debug_assert_ne!(upstream, Upstream::Chat);
    if response.is_sse() || (request_is_stream && !response.is_json()) {
        return convert_stream(
            response,
            ctx,
            state,
            upstream,
            include_usage,
            tool_context,
            connection_guard,
        )
        .await;
    }
    let body_timeout =
        if ctx.app_config.auto_failover_enabled && ctx.app_config.non_streaming_timeout > 0 {
            std::time::Duration::from_secs(ctx.app_config.non_streaming_timeout as u64)
        } else {
            std::time::Duration::ZERO
        };
    let (headers, status, bytes) = read_decoded_body(response, ctx.tag, body_timeout).await?;
    let chat = match upstream {
        // Chat → Anthropic 一跳：回包直接从 Anthropic 映射回 Chat，不再经过 Responses。
        Upstream::Anthropic => {
            let anthropic = match serde_json::from_slice::<Value>(&bytes) {
                Ok(value) => value,
                Err(_) => {
                    protocol::anthropic_sse_to_message_value(&String::from_utf8_lossy(&bytes))?
                }
            };
            protocol::anthropic_response_to_chat(anthropic)?
        }
        Upstream::Responses => {
            let responses_value = responses_value_from_body(upstream, &bytes, &tool_context)?;
            chat_bridge::response_to_chat(&responses_value)?
        }
        Upstream::Chat => unreachable!("Chat upstreams are forwarded without this bridge"),
    };
    let model = chat
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if request_is_stream {
        // 客户端要的是流，上游却回了整包：补成一次 Chat SSE，客户端才不会把
        // JSON 当成流解析失败。usage 一并带上，记账和路由页的 token 统计都不丢。
        let body = chat_completion_sse(&chat, model, true);
        let once =
            futures::stream::once(async move { Ok::<Bytes, std::io::Error>(Bytes::from(body)) });
        let usage_collector =
            create_usage_collector(ctx, state, status.as_u16(), &OPENAI_PARSER_CONFIG);
        let tapped = create_logged_passthrough_stream(
            once,
            ctx.tag,
            usage_collector,
            ctx.streaming_timeout_config(),
            connection_guard,
        );
        return Ok(sse_stream_response(status, headers, tapped));
    }
    let mut headers = headers;
    strip_entity_headers_for_rebuilt_body(&mut headers);
    strip_hop_by_hop_response_headers(&mut headers);
    headers.remove(header::CONTENT_TYPE);
    headers.insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static("application/json"),
    );
    let body = Bytes::from(serde_json::to_vec(&chat).map_err(|error| {
        ProxyError::TransformError(format!("Failed to serialize Chat response: {error}"))
    })?);
    process_response(
        ProxyResponse::buffered(status, headers, body),
        ctx,
        state,
        &OPENAI_PARSER_CONFIG,
        false,
        connection_guard,
    )
    .await
}

async fn convert_stream(
    response: ProxyResponse,
    ctx: &RequestContext,
    state: &ProxyState,
    upstream: Upstream,
    include_usage: bool,
    _tool_context: CodexToolContext,
    connection_guard: Option<ActiveConnectionGuard>,
) -> Result<axum::response::Response, ProxyError> {
    let status = response.status();
    let headers = response.headers().clone();
    let raw = response.bytes_stream();
    let model = ctx
        .outbound_model
        .clone()
        .unwrap_or_else(|| ctx.request_model.clone());

    // Chat → Anthropic 一跳：Anthropic SSE 直接变成 Chat chunk，不再经过 Responses。
    if upstream == Upstream::Anthropic {
        let chat = protocol::create_chat_sse_stream_from_anthropic(raw, model, include_usage);
        let usage_collector =
            create_usage_collector(ctx, state, status.as_u16(), &OPENAI_PARSER_CONFIG);
        let tapped = create_logged_passthrough_stream(
            chat,
            ctx.tag,
            usage_collector,
            ctx.streaming_timeout_config(),
            connection_guard,
        );
        let mut builder = axum::response::Response::builder().status(status);
        for (key, value) in &rebuilt_sse_headers(headers) {
            builder = builder.header(key, value);
        }
        return builder
            .body(axum::body::Body::from_stream(tapped))
            .map_err(|error| {
                log::error!("[ChatBridge] Failed to build streaming Chat response: {error}");
                ProxyError::Internal(format!("Failed to build streaming response: {error}"))
            });
    }

    let responses: std::pin::Pin<Box<dyn Stream<Item = Result<Bytes, std::io::Error>> + Send>> =
        Box::pin(raw);
    // 用法按 Responses 事件收：Responses 成员的事件形状在这里保持不变。
    let usage_collector = create_usage_collector(ctx, state, status.as_u16(), &CODEX_PARSER_CONFIG);
    let tapped = create_logged_passthrough_stream(
        responses,
        ctx.tag,
        usage_collector,
        ctx.streaming_timeout_config(),
        connection_guard,
    );
    let chat = chat_bridge::responses_sse_to_chat_stream(
        tapped,
        &model,
        include_usage,
        None,
        ctx.gateway_trace.clone(),
    );
    let mut builder = axum::response::Response::builder().status(status);
    for (key, value) in &rebuilt_sse_headers(headers) {
        builder = builder.header(key, value);
    }
    builder
        .body(axum::body::Body::from_stream(chat))
        .map_err(|error| {
            log::error!("[ChatBridge] Failed to build streaming Chat response: {error}");
            ProxyError::Internal(format!("Failed to build streaming response: {error}"))
        })
}

/// 上游整包 → Responses 值。
fn responses_value_from_body(
    upstream: Upstream,
    bytes: &[u8],
    tool_context: &CodexToolContext,
) -> Result<Value, ProxyError> {
    match upstream {
        Upstream::Anthropic => {
            let anthropic = match serde_json::from_slice::<Value>(bytes) {
                Ok(value) => value,
                Err(_) => {
                    protocol::anthropic_sse_to_message_value(&String::from_utf8_lossy(bytes))?
                }
            };
            protocol::anthropic_response_to_responses_with_context(anthropic, tool_context)
        }
        Upstream::Responses => match serde_json::from_slice::<Value>(bytes) {
            Ok(value) => Ok(value),
            // 上游标了 JSON 却回 SSE：用最后一个终态事件里的 response 对象收尾。
            Err(_) => aggregate_responses_sse(&String::from_utf8_lossy(bytes)),
        },
        Upstream::Chat => unreachable!("Chat upstreams are forwarded without this bridge"),
    }
}

/// 从 Responses SSE 文本里取出终态 `response` 对象。只在「非流式请求、上游却回
/// 了 SSE」时兜底，不参与正常流式路径。
fn aggregate_responses_sse(text: &str) -> Result<Value, ProxyError> {
    let mut completed = None;
    for line in text.lines() {
        let Some(data) = line.strip_prefix("data:") else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(data.trim()) else {
            continue;
        };
        match value.get("type").and_then(Value::as_str) {
            Some("response.completed" | "response.incomplete" | "response.failed") => {
                completed = value.get("response").cloned();
            }
            Some("error") => {
                return Err(ProxyError::TransformError(
                    "Upstream Responses stream reported an error".into(),
                ));
            }
            _ => {}
        }
    }
    completed.ok_or_else(|| {
        ProxyError::TransformError(
            "Upstream returned an unmarked SSE body without a Responses terminal event".into(),
        )
    })
}

/// 把一整条 Chat completion 补成 SSE：客户端要流、上游却回了 JSON 时用。
fn chat_completion_sse(chat: &Value, model: &str, include_usage: bool) -> String {
    let id = chat
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("chatcmpl-{}", uuid::Uuid::new_v4()));
    let created = chat
        .get("created")
        .and_then(Value::as_i64)
        .unwrap_or_else(|| chrono::Utc::now().timestamp());
    let model = chat
        .get("model")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or(model);
    let chunk = |delta: Value, reason: Option<&str>| {
        serde_json::json!({
            "id": id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model,
            "choices": [{ "index": 0, "delta": delta, "finish_reason": reason }],
        })
    };
    let choice = chat.pointer("/choices/0");
    let message = choice
        .and_then(|choice| choice.get("message"))
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    let mut deltas = vec![chunk(serde_json::json!({"role":"assistant"}), None)];
    let mut delta = serde_json::Map::new();
    if let Some(content) = message.get("content").filter(|value| !value.is_null()) {
        delta.insert("content".into(), content.clone());
    }
    if let Some(tools) = message.get("tool_calls").and_then(Value::as_array) {
        let calls = tools
            .iter()
            .enumerate()
            .map(|(index, call)| {
                serde_json::json!({
                    "index": index,
                    "id": call.get("id"),
                    "type": "function",
                    "function": {
                        "name": call.pointer("/function/name"),
                        "arguments": call.pointer("/function/arguments"),
                    },
                })
            })
            .collect::<Vec<_>>();
        delta.insert("tool_calls".into(), Value::Array(calls));
    }
    if let Some(refusal) = message.get("refusal").filter(|value| !value.is_null()) {
        delta.insert("refusal".into(), refusal.clone());
    }
    deltas.push(chunk(Value::Object(delta), None));
    let reason = choice
        .and_then(|choice| choice.get("finish_reason"))
        .and_then(Value::as_str)
        .unwrap_or("stop");
    deltas.push(chunk(serde_json::json!({}), Some(reason)));
    let mut out = deltas
        .into_iter()
        .map(|chunk| format!("data: {chunk}\n\n"))
        .collect::<String>();
    if include_usage {
        if let Some(usage) = chat.get("usage").filter(|value| value.is_object()) {
            let usage_chunk = serde_json::json!({
                "id": id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": model,
                "choices": [],
                "usage": usage,
            });
            out.push_str(&format!("data: {usage_chunk}\n\n"));
        }
    }
    out.push_str("data: [DONE]\n\n");
    out
}

fn sse_stream_response(
    status: StatusCode,
    headers: HeaderMap,
    stream: impl Stream<Item = Result<Bytes, std::io::Error>> + Send + 'static,
) -> axum::response::Response {
    let mut builder = axum::response::Response::builder().status(status);
    for (key, value) in &rebuilt_sse_headers(headers) {
        builder = builder.header(key, value);
    }
    builder
        .body(axum::body::Body::from_stream(stream))
        .unwrap_or_else(|_| {
            axum::response::Response::builder()
                .status(StatusCode::INTERNAL_SERVER_ERROR)
                .body(axum::body::Body::empty())
                .expect("empty response")
        })
}

/// 重建响应体时要去掉上游的实体头，再把 content-type 换回 SSE。
fn rebuilt_sse_headers(headers: HeaderMap) -> HeaderMap {
    let mut headers = headers;
    strip_entity_headers_for_rebuilt_body(&mut headers);
    strip_hop_by_hop_response_headers(&mut headers);
    headers.remove(header::CONTENT_TYPE);
    headers.insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static("text/event-stream"),
    );
    headers
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::{Provider, ProviderMeta};
    use serde_json::json;

    fn provider(format: Option<&str>) -> Provider {
        let mut provider = Provider {
            id: "gateway:probe".into(),
            name: "Probe".into(),
            settings_config: json!({}),
            website_url: None,
            category: None,
            created_at: None,
            sort_index: None,
            notes: None,
            meta: None,
            icon: None,
            icon_color: None,
            in_failover_queue: false,
        };
        provider.meta = Some(ProviderMeta {
            api_format: format.map(str::to_string),
            ..Default::default()
        });
        provider
    }

    #[test]
    fn upstream_follows_the_supplier_protocol() {
        assert_eq!(upstream_for(&provider(Some("openai_chat"))), Upstream::Chat);
        assert_eq!(
            upstream_for(&provider(Some("openai_responses"))),
            Upstream::Responses
        );
        assert_eq!(
            upstream_for(&provider(Some("anthropic"))),
            Upstream::Anthropic
        );
        // 应用自己的供应商行没有协议标记，按 Chat 处理。
        assert_eq!(upstream_for(&provider(None)), Upstream::Chat);
        // 网关只放行这三种协议；其它一律不误判成需要转换。
        assert_eq!(
            upstream_for(&provider(Some("gemini_native"))),
            Upstream::Chat
        );
    }

    #[test]
    fn responses_terminal_events_are_recovered_from_an_unmarked_stream() {
        let text = concat!(
            "event: response.created\n",
            "data: {\"type\":\"response.created\",\"response\":{\"id\":\"r1\",\"status\":\"in_progress\"}}\n\n",
            "event: response.completed\n",
            "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"r1\",\"status\":\"completed\",\"output\":[]}}\n\n",
        );
        let value = aggregate_responses_sse(text).expect("terminal event");
        assert_eq!(value["status"], "completed");
        assert!(aggregate_responses_sse("data: {\"type\":\"response.created\"}\n\n").is_err());
        assert!(aggregate_responses_sse("data: {\"type\":\"error\"}\n\n").is_err());
    }

    #[test]
    fn a_buffered_completion_becomes_a_well_formed_chat_stream() {
        let chat = json!({
            "id": "chatcmpl-1",
            "object": "chat.completion",
            "created": 7,
            "model": "glm-5",
            "choices": [{
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": "hi",
                    "tool_calls": [
                        {"id":"call-1","type":"function","function":{"name":"read","arguments":"{}"}}
                    ]
                },
                "finish_reason": "tool_calls"
            }],
            "usage": {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5}
        });
        let sse = chat_completion_sse(&chat, "glm-5", true);
        assert!(sse.contains("\"content\":\"hi\""));
        assert!(sse.contains("\"tool_calls\""));
        assert!(sse.contains("\"finish_reason\":\"tool_calls\""));
        assert!(sse.contains("\"usage\""));
        assert!(sse.trim_end().ends_with("data: [DONE]"));
        let without_usage = chat_completion_sse(&chat, "glm-5", false);
        assert!(!without_usage.contains("\"usage\""));
    }
}
