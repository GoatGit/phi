//! Observe the client response without buffering delivery or persisting content.
use super::{
    server::ProxyState,
    usage::{calculator::CostCalculator, logger::UsageLogger, parser::TokenUsage},
};
use crate::gateway::RequestTrace;
use axum::{
    body::Body,
    extract::{Request, State},
    middleware::Next,
    response::Response,
};
use futures::StreamExt;
use serde_json::Value;
use std::sync::{Arc, Mutex};

pub type Trace = Arc<Mutex<RequestTrace>>;
tokio::task_local! { static SLOT: Arc<Mutex<Option<Trace>>>; }

pub fn register(trace: &Trace) {
    let _ = SLOT.try_with(|slot| {
        if let Ok(mut slot) = slot.lock() {
            *slot = Some(trace.clone());
        }
    });
}

struct Completion {
    db: Arc<crate::Database>,
    trace: Trace,
    started: std::time::Instant,
    done: bool,
}
impl Completion {
    fn finish(&mut self, outcome: &str, usage: Option<TokenUsage>) {
        if self.done {
            return;
        }
        self.done = true;
        if let Ok(mut trace) = self.trace.lock() {
            // A transport failure before any successful upstream retains its cause.
            if matches!(trace.outcome.as_str(), "pending" | "upstream_accepted") {
                trace.outcome = outcome.into();
            }
            trace.latency_ms = self.started.elapsed().as_millis() as u64;
            if let Some(usage) = usage {
                trace.input_tokens = Some(usage.input_tokens);
                trace.output_tokens = Some(usage.output_tokens);
                let model = trace
                    .events
                    .last()
                    .map(|event| event.model.as_str())
                    .unwrap_or_default();
                let pricing = UsageLogger::new(&self.db)
                    .get_model_pricing(model)
                    .ok()
                    .flatten();
                trace.estimated_cost = CostCalculator::try_calculate_for_app(
                    &trace.app_id,
                    &usage,
                    pricing.as_ref(),
                    rust_decimal::Decimal::ONE,
                )
                .map(|cost| cost.total_cost.to_string());
            }
            self.db.gateway_runtime.complete(&trace);
            let snapshot = trace.clone();
            let db = self.db.clone();
            tokio::task::spawn_blocking(move || {
                if let Err(error) = db.write_gateway_trace(&snapshot) {
                    log::warn!("Gateway completion write failed: {error}");
                }
            });
        }
    }
}
impl Drop for Completion {
    fn drop(&mut self) {
        self.finish("interrupted", None);
    }
}

/// Also cover disconnects while the handler is still waiting for upstream headers.
struct PendingObservation {
    slot: Arc<Mutex<Option<Trace>>>,
    db: Arc<crate::Database>,
    started: std::time::Instant,
    transferred: bool,
}
impl Drop for PendingObservation {
    fn drop(&mut self) {
        if self.transferred {
            return;
        }
        if let Some(trace) = self.slot.lock().ok().and_then(|slot| slot.clone()) {
            Completion {
                db: self.db.clone(),
                trace,
                started: self.started,
                done: false,
            }
            .finish("interrupted", None);
        }
    }
}

pub async fn observe(State(state): State<ProxyState>, request: Request, next: Next) -> Response {
    let slot = Arc::new(Mutex::new(None));
    let started = std::time::Instant::now();
    let mut pending = PendingObservation {
        slot: slot.clone(),
        db: state.db.clone(),
        started,
        transferred: false,
    };
    let response = SLOT.scope(slot.clone(), next.run(request)).await;
    pending.transferred = true;
    let trace = slot.lock().ok().and_then(|slot| slot.clone());
    let Some(trace) = trace else {
        return response;
    };
    let app = trace
        .lock()
        .map(|trace| trace.app_id.clone())
        .unwrap_or_default();
    let streaming = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.contains("text/event-stream"));
    let successful = response.status().is_success();
    let (parts, body) = response.into_parts();
    // 非流式响应带 content-length 时，客户端读满这个长度就可能不再轮询流，
    // 生成器收不到结尾的 `None`。按长度提前收尾，避免成功请求被记成 interrupted。
    let expected_len = parts
        .headers
        .get(axum::http::header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok());
    let mut stream = body.into_data_stream();
    let mut completion = Completion {
        db: state.db,
        trace,
        started,
        done: false,
    };
    let output = async_stream::stream! {
        let mut buffer = String::new();
        let mut remainder = Vec::new();
        let mut events = Vec::new();
        let mut terminal = false;
        let mut oversized = false;
        let mut upstream_error = false;
        let mut delivered = 0usize;
        while let Some(item) = stream.next().await {
            match item {
                Ok(bytes) => {
                    if !oversized {
                        if buffer.len() + bytes.len() > 2 * 1024 * 1024 { oversized = true; buffer.clear(); }
                        else {
                            super::sse::append_utf8_safe(&mut buffer, &mut remainder, &bytes);
                            if streaming {
                                while let Some(block) = super::sse::take_sse_block(&mut buffer) {
                                    let data = block.lines().filter_map(|line| line.strip_prefix("data:").map(str::trim)).collect::<Vec<_>>().join("\n");
                                    if data == "[DONE]" { terminal = true; }
                                    if let Ok(value) = serde_json::from_str::<Value>(&data) {
                                        let kind = value.get("type").and_then(Value::as_str).unwrap_or_default();
                                        if matches!(kind, "message_stop" | "response.completed" | "image_generation.completed") || value.pointer("/candidates/0/finishReason").is_some() { terminal = true; }
                                        if matches!(kind, "error" | "response.failed" | "response.incomplete") || value.get("error").is_some() { upstream_error = true; }
                                        // Keep only usage envelopes, never accumulate ordinary text deltas.
                                        if value.get("usage").is_some() || value.get("usageMetadata").is_some() || value.pointer("/message/usage").is_some() || value.pointer("/response/usage").is_some() {
                                            if events.len() == 128 { events.remove(0); }
                                            // Retain only metadata needed by the usage parser, not content.
                                            events.push(serde_json::json!({
                                                "type": value.get("type"), "usage": value.get("usage"),
                                                "usageMetadata": value.get("usageMetadata"),
                                                "message": { "usage": value.pointer("/message/usage"), "model": value.pointer("/message/model") },
                                                "response": { "usage": value.pointer("/response/usage"), "model": value.pointer("/response/model") },
                                            }));
                                        }
                                    }
                                }
                            }
                        }
                    }
                    delivered += bytes.len();
                    // 带 content-length 的整包响应：读满后立即按完整响应收尾。
                    if !streaming
                        && !oversized
                        && expected_len.is_some_and(|expected| delivered >= expected)
                    {
                        let json = serde_json::from_str::<Value>(&buffer).ok();
                        let complete_error = json.as_ref().is_some_and(|value| {
                            value.get("error").is_some()
                                || matches!(
                                    value.get("status").and_then(Value::as_str),
                                    Some("failed" | "incomplete")
                                )
                        });
                        let usage = json.as_ref().and_then(|value| match app.as_str() {
                            "claude" => TokenUsage::from_claude_response(value),
                            "gemini" => TokenUsage::from_gemini_response(value),
                            _ => TokenUsage::from_codex_response_auto(value),
                        });
                        completion.finish(
                            if !successful || complete_error {
                                "response_error"
                            } else {
                                "completed"
                            },
                            usage,
                        );
                        yield Ok::<_, axum::Error>(bytes);
                        return;
                    }
                    yield Ok::<_, axum::Error>(bytes);
                }
                Err(error) => { completion.finish("transport", None); yield Err(error); return; }
            }
        }
        let json = if streaming || oversized { None } else { serde_json::from_str::<Value>(&buffer).ok() };
        if json.as_ref().is_some_and(|value| value.get("error").is_some() || matches!(value.get("status").and_then(Value::as_str), Some("failed" | "incomplete"))) { upstream_error = true; }
        let usage = if oversized || (streaming && !terminal) { None } else if streaming {
            match app.as_str() {
                "claude" => TokenUsage::from_claude_stream_events(&events),
                "gemini" => TokenUsage::from_gemini_stream_chunks(&events),
                _ => TokenUsage::from_codex_stream_events_auto(&events),
            }
        } else { json.and_then(|value| match app.as_str() {
            "claude" => TokenUsage::from_claude_response(&value),
            "gemini" => TokenUsage::from_gemini_response(&value),
            _ => TokenUsage::from_codex_response_auto(&value),
        }) };
        let outcome = if !successful || upstream_error { "response_error" } else if streaming && !terminal { "interrupted" } else { "completed" };
        completion.finish(outcome, usage);
    };
    Response::from_parts(parts, Body::from_stream(output))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{http::Request as HttpRequest, routing::get, Router};
    use tower::Service;

    fn trace() -> Trace {
        Arc::new(Mutex::new(RequestTrace {
            decision: None,
            persist: true,
            id: uuid::Uuid::new_v4().to_string(),
            created_at: chrono::Utc::now().timestamp_millis(),
            app_id: "claude".into(),
            app_type: None,
            binding_id: None,
            binding_name: None,
            request_model: "alias".into(),
            catalog_revision: 1,
            policy: crate::gateway::RoutePolicy {
                group_id: None,
                id: "p".into(),
                name: "Snapshot".into(),
                app_id: "claude".into(),
                enabled: true,
                match_model: "alias".into(),
                request_model: String::new(),
                priority: 1,
                failover: false,
                candidates: vec![],
            },
            events: vec![],
            outcome: "upstream_accepted".into(),
            latency_ms: 0,
            input_tokens: None,
            output_tokens: None,
            estimated_cost: None,
        }))
    }

    #[tokio::test]
    async fn response_delivery_records_completion_late_errors_and_unknown_usage() {
        for (streaming, body, outcome, tokens) in [
            (false, r#"{"content":[{"text":"private text"}],"usage":{"input_tokens":12,"output_tokens":4}}"#, "completed", Some((12, 4))),
            (false, r#"{"content":[{"text":"private text"}]}"#, "completed", None),
            (true, "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":12}}}\n\nevent: message_delta\ndata: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":4}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n", "completed", Some((12, 4))),
            (true, "data: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"private text\"}}\n\n", "interrupted", None),
            (true, "data: {\"type\":\"error\",\"error\":{\"message\":\"private text\"}}\n\n", "response_error", None),
        ] {
            let db = Arc::new(crate::Database::memory().unwrap());
            let trace = trace();
            let captured = trace.clone();
            let mut app = Router::new().route("/", get(move || {
                let trace = captured.clone();
                async move {
                    register(&trace);
                    let chunks = body.as_bytes().chunks(7).map(|chunk| Ok::<_, std::io::Error>(bytes::Bytes::copy_from_slice(chunk))).collect::<Vec<_>>();
                    Response::builder().header("content-type", if streaming { "text/event-stream" } else { "application/json" }).body(Body::from_stream(futures::stream::iter(chunks))).unwrap()
                }
            })).layer(axum::middleware::from_fn_with_state(ProxyState::for_test(db.clone()), observe));
            let response = app.call(HttpRequest::builder().uri("/").body(Body::empty()).unwrap()).await.unwrap();
            let delivered = axum::body::to_bytes(response.into_body(), 4096).await.unwrap();
            assert_eq!(delivered.as_ref(), body.as_bytes());
            let snapshot = trace.lock().unwrap().clone();
            assert_eq!(snapshot.outcome, outcome);
            assert_eq!(snapshot.input_tokens.zip(snapshot.output_tokens), tokens);
            assert!(!serde_json::to_string(&snapshot).unwrap().contains("private text"));
            tokio::time::timeout(std::time::Duration::from_secs(2), async {
                loop {
                    if !db.gateway_traces().unwrap().is_empty() { break; }
                    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                }
            }).await.unwrap();
            assert_eq!(db.gateway_traces().unwrap()[0].outcome, outcome);
        }
    }

    #[tokio::test]
    async fn content_length_response_completes_without_a_final_poll() {
        let db = Arc::new(crate::Database::memory().unwrap());
        let trace = trace();
        trace.lock().unwrap().app_id = "opencode".into();
        let captured = trace.clone();
        let body = r#"{"usage":{"prompt_tokens":6,"completion_tokens":3}}"#;
        let mut app = Router::new()
            .route(
                "/",
                get(move || {
                    let trace = captured.clone();
                    async move {
                        register(&trace);
                        Response::builder()
                            .header("content-type", "application/json")
                            .header(axum::http::header::CONTENT_LENGTH, body.len())
                            .body(Body::from(body))
                            .unwrap()
                    }
                }),
            )
            .layer(axum::middleware::from_fn_with_state(
                ProxyState::for_test(db.clone()),
                observe,
            ));
        let response = app
            .call(HttpRequest::builder().uri("/").body(Body::empty()).unwrap())
            .await
            .unwrap();
        // 客户端读满 content-length 就停，不再轮询到 None。
        let mut stream = response.into_body().into_data_stream();
        let delivered = stream.next().await.unwrap().unwrap();
        assert_eq!(delivered.as_ref(), body.as_bytes());
        drop(stream);
        let snapshot = trace.lock().unwrap().clone();
        assert_eq!(snapshot.outcome, "completed");
        assert_eq!(
            snapshot.input_tokens.zip(snapshot.output_tokens),
            Some((6, 3))
        );
    }

    #[tokio::test]
    async fn dropped_client_body_is_interrupted() {
        let db = Arc::new(crate::Database::memory().unwrap());
        let trace = trace();
        let captured = trace.clone();
        let mut app = Router::new()
            .route(
                "/",
                get(move || {
                    let trace = captured.clone();
                    async move {
                        register(&trace);
                        Body::from_stream(futures::stream::pending::<
                            Result<bytes::Bytes, std::io::Error>,
                        >())
                    }
                }),
            )
            .layer(axum::middleware::from_fn_with_state(
                ProxyState::for_test(db),
                observe,
            ));
        let response = app
            .call(HttpRequest::builder().uri("/").body(Body::empty()).unwrap())
            .await
            .unwrap();
        drop(response);
        assert_eq!(trace.lock().unwrap().outcome, "interrupted");
    }
}
