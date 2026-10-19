//! Persist admission before forwarding, settle every attempt, and finalize even
//! when a client drops the response body. Only usage envelopes stay in memory.
use super::{
    ingress::Identity,
    server::ProxyState,
    usage::{logger::UsageLogger, parser::TokenUsage},
    ProxyError,
};
use crate::{
    ledger::{PriceSnapshot, RequestRecord, Usage},
    provider::Provider,
    Database,
};
use axum::{
    body::Body,
    extract::{Request, State},
    http::StatusCode,
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use futures::StreamExt;
use serde_json::Value;
use std::sync::{atomic::Ordering, Arc, Mutex};

struct Active {
    db: Arc<Database>,
    id: String,
    app: String,
    app_handle: Option<tauri::AppHandle>,
    binding: Option<crate::access::Binding>,
    attempt: Mutex<Option<u64>>,
}
tokio::task_local! { static ACTIVE: Arc<Active>; }

fn storage_error() -> ProxyError {
    ProxyError::DatabaseError("PHI ledger unavailable; upstream request refused".into())
}
pub fn is_local_refusal(error: &ProxyError) -> bool {
    match error {
        ProxyError::DatabaseError(_) => true,
        ProxyError::UpstreamError {
            status: 429,
            body: Some(body),
        } => serde_json::from_str::<Value>(body).ok().is_some_and(|v| {
            v.pointer("/error/type").and_then(Value::as_str) == Some("budget_error")
        }),
        _ => false,
    }
}
fn persist<T>(db: &Database, result: Result<T, crate::error::AppError>) -> Result<T, ProxyError> {
    result.map_err(|e| {
        db.ledger_available.store(false, Ordering::Release);
        log::error!("Ledger persistence failed: {e}");
        storage_error()
    })
}
pub fn context(model: &str, session: &str) -> Result<(), ProxyError> {
    ACTIVE
        .try_with(|active| {
            use sha2::{Digest, Sha256};
            // Namespaced opaque session identifier; no client paths or message text.
            let namespace = active
                .binding
                .as_ref()
                .map(|b| b.session_namespace())
                .unwrap_or_else(|| active.app.clone());
            let session = format!("{:x}", Sha256::digest(format!("{namespace}:{session}")));
            persist(
                &active.db,
                active.db.ledger_context(&active.id, model, Some(session)),
            )
        })
        .unwrap_or(Ok(()))
}
pub fn begin(provider: &Provider, model: &str) -> Result<Option<u64>, ProxyError> {
    ACTIVE.try_with(|active|{
        if !active.db.ledger_available.load(Ordering::Acquire){return Err(storage_error());}
        let pricing=persist(&active.db,UsageLogger::new(&active.db).get_model_pricing(model))?;
        let multiplier=provider.meta.as_ref().and_then(|m|m.cost_multiplier.clone()).unwrap_or_else(||"1".into());
        let price=pricing.map(|p|PriceSnapshot{input:p.input_cost_per_million.to_string(),output:p.output_cost_per_million.to_string(),cache_read:p.cache_read_cost_per_million.to_string(),cache_creation:p.cache_creation_cost_per_million.to_string(),multiplier});
        let admitted=persist(&active.db,active.db.ledger_admit(&active.id,&format!("{}:{}",active.app,provider.id),provider.meta.as_ref().and_then(|m|m.auth_binding.as_ref()).and_then(|b|b.account_id.clone()),model,price))?;
        if let Some(handle)=&active.app_handle { crate::ledger::notifications::publish(active.db.clone(),handle.clone()); }
        if let Some(reason)=admitted.blocked{return Err(ProxyError::UpstreamError{status:429,body:Some(serde_json::json!({"error":{"type":"budget_error","code":reason,"message":"PHI budget refused this upstream attempt. Check settled usage, pricing and project binding."}}).to_string())});}
        let no=admitted.attempt.map(|a|a.attempt_no);
        *active.attempt.lock().map_err(|_|storage_error())?=no;
        Ok(no)
    }).unwrap_or(Ok(None))
}
/// Carries the admission context across response-body polling outside task-local scope.
pub struct UsageReporter {
    active: Arc<Active>,
    no: u64,
}
impl UsageReporter {
    pub fn report(&self, usage: TokenUsage, state: &str) -> Result<(), ProxyError> {
        persist(
            &self.active.db,
            self.active.db.ledger_settle(
                &self.active.id,
                self.no,
                state,
                None,
                Some(normalized(&self.active.app, usage)),
                false, // The outer body observer records actual downstream commitment.
            ),
        )
    }
}
pub fn usage_reporter() -> Option<UsageReporter> {
    ACTIVE
        .try_with(|active| {
            active.attempt.lock().ok().and_then(|no| {
                no.map(|no| UsageReporter {
                    active: active.clone(),
                    no,
                })
            })
        })
        .ok()
        .flatten()
}
pub fn current_attempt() -> Option<u64> {
    ACTIVE
        .try_with(|active| active.attempt.lock().ok().and_then(|no| *no))
        .ok()
        .flatten()
}
pub fn request_id() -> Option<String> {
    ACTIVE.try_with(|active| active.id.clone()).ok()
}
pub fn session_namespace() -> Option<String> {
    ACTIVE
        .try_with(|active| active.binding.as_ref().map(|b| b.session_namespace()))
        .ok()
        .flatten()
}
pub fn has_access_binding() -> bool {
    ACTIVE
        .try_with(|active| active.binding.is_some())
        .unwrap_or(false)
}
pub fn authorize_group(group: Option<&str>) -> Result<(), crate::error::AppError> {
    ACTIVE
        .try_with(|active| {
            if let Some(binding) = &active.binding {
                if !binding.allowed_groups.is_empty()
                    && !group.is_some_and(|g| binding.allowed_groups.iter().any(|id| id == g))
                {
                    return Err(crate::error::AppError::Config(
                        "ACCESS_SCOPE_DENIED: group is outside this binding".into(),
                    ));
                }
            }
            Ok(())
        })
        .unwrap_or(Ok(()))
}

pub struct AuxiliaryAttempt {
    active: Arc<Active>,
    no: u64,
    protocol: String,
    done: bool,
}
impl AuxiliaryAttempt {
    pub fn finish(&mut self, usage: Option<TokenUsage>, success: bool) -> Result<(), ProxyError> {
        if self.done {
            return Ok(());
        }
        self.done = true;
        let app = match self.protocol.as_str() {
            "anthropic" => "claude",
            "gemini_native" => "gemini",
            _ => "codex",
        };
        persist(
            &self.active.db,
            self.active.db.ledger_settle(
                &self.active.id,
                self.no,
                if success { "completed" } else { "interrupted" },
                Some("intent_classifier"),
                usage.map(|u| normalized(app, u)),
                false,
            ),
        )?;
        let mut active = self.active.attempt.lock().map_err(|_| storage_error())?;
        if *active == Some(self.no) {
            *active = None;
        }
        Ok(())
    }
}
impl Drop for AuxiliaryAttempt {
    fn drop(&mut self) {
        let _ = self.finish(None, false);
    }
}
pub fn auxiliary(
    provider_id: &str,
    model: &str,
    protocol: &str,
) -> Result<Option<AuxiliaryAttempt>, ProxyError> {
    let provider = Provider::with_id(
        format!("pool:{provider_id}"),
        "Classifier".into(),
        Value::Null,
        None,
    );
    let no = begin(&provider, model)?;
    Ok(no.and_then(|no| {
        ACTIVE
            .try_with(|active| AuxiliaryAttempt {
                active: active.clone(),
                no,
                protocol: protocol.into(),
                done: false,
            })
            .ok()
    }))
}
fn normalized(app: &str, u: TokenUsage) -> Usage {
    let fresh = if matches!(app, "claude" | "claude-desktop") {
        u.input_tokens
    } else {
        u.input_tokens
            .saturating_sub(u.cache_read_tokens)
            .saturating_sub(u.cache_creation_tokens)
    };
    Usage {
        input: u64::from(fresh),
        output: u64::from(u.output_tokens),
        cache_read: u64::from(u.cache_read_tokens),
        cache_creation: u64::from(u.cache_creation_tokens),
        cache_creation_1h: u64::from(u.cache_creation_1h_tokens),
    }
}
fn parse_json(app: &str, value: &Value) -> Option<TokenUsage> {
    match app {
        "claude" | "claude-desktop" => TokenUsage::from_claude_response(value),
        "gemini" => TokenUsage::from_gemini_response(value),
        _ => TokenUsage::from_codex_response_auto(value),
    }
}
fn stream_usage(app: &str, events: &[Value]) -> Option<TokenUsage> {
    match app {
        "claude" | "claude-desktop" => TokenUsage::from_claude_stream_events(events),
        "gemini" => TokenUsage::from_gemini_stream_chunks(events),
        _ => TokenUsage::from_codex_stream_events_auto(events),
    }
}
pub fn failed(no: Option<u64>, error: &ProxyError) -> Result<(), ProxyError> {
    let Some(no) = no else {
        return Ok(());
    };
    ACTIVE
        .try_with(|active| {
            let usage = match error {
                ProxyError::UpstreamError {
                    body: Some(body), ..
                } => serde_json::from_str(body)
                    .ok()
                    .and_then(|v| parse_json(&active.app, &v)),
                _ => None,
            };
            persist(
                &active.db,
                active.db.ledger_settle(
                    &active.id,
                    no,
                    "failed",
                    Some(crate::gateway::error_category(error)),
                    usage.map(|u| normalized(&active.app, u)),
                    false,
                ),
            )?;
            *active.attempt.lock().map_err(|_| storage_error())? = None;
            Ok(())
        })
        .unwrap_or(Ok(()))
}
struct Completion {
    active: Arc<Active>,
    done: bool,
    committed: bool,
    observed: Option<TokenUsage>,
    usage_complete: bool,
}
impl Completion {
    fn finish(&mut self, state: &str, usage: Option<TokenUsage>) -> Result<(), ProxyError> {
        if self.done {
            return Ok(());
        }
        self.done = true;
        if usage.is_some() {
            self.observed = usage;
        }
        let active = &self.active;
        let no = *active.attempt.lock().map_err(|_| storage_error())?;
        if let Some(no) = no {
            persist(
                &active.db,
                active.db.ledger_settle_observed(
                    &active.id,
                    no,
                    state,
                    None,
                    self.observed.take().map(|u| normalized(&active.app, u)),
                    self.committed,
                    self.usage_complete,
                ),
            )?;
        }
        persist(&active.db, active.db.ledger_finish(&active.id, state))?;
        if let Some(handle) = &active.app_handle {
            crate::ledger::notifications::publish(active.db.clone(), handle.clone());
        }
        Ok(())
    }
}
impl Drop for Completion {
    fn drop(&mut self) {
        let _ = self.finish("interrupted", None);
    }
}

pub async fn observe(State(state): State<ProxyState>, request: Request, next: Next) -> Response {
    if request.method() != http::Method::POST {
        return next.run(request).await;
    }
    let Some(identity) = request.extensions().get::<Identity>() else {
        return next.run(request).await;
    };
    if !state.db.ledger_available.load(Ordering::Acquire) {
        return storage_error().into_response();
    }
    let record = if let Some(binding) = &identity.binding {
        let mut record =
            RequestRecord::new(&binding.agent, &binding.id, binding.project_id.clone());
        record.tool = identity.app.into();
        record
    } else {
        RequestRecord::new(identity.app, &format!("local:{}", identity.app), None)
    };
    if persist(&state.db, state.db.ledger_start(&record)).is_err() {
        return (StatusCode::SERVICE_UNAVAILABLE,Json(serde_json::json!({"error":{"type":"ledger_unavailable","message":"PHI could not persist request admission; no upstream call was made."}}))).into_response();
    }
    let active = Arc::new(Active {
        db: state.db,
        id: record.id,
        app: identity.app.into(),
        app_handle: state.app_handle,
        binding: identity.binding.clone(),
        attempt: Mutex::new(None),
    });
    let mut completion = Completion {
        active: active.clone(),
        done: false,
        committed: false,
        observed: None,
        usage_complete: false,
    };
    let response = ACTIVE.scope(active.clone(), next.run(request)).await;
    let streaming = response
        .headers()
        .get("content-type")
        .and_then(|h| h.to_str().ok())
        .is_some_and(|h| h.contains("text/event-stream"));
    let success = response.status().is_success();
    let (mut parts, body) = response.into_parts();
    if let Ok(id) = active.id.parse() {
        parts.headers.insert("x-phi-request-id", id);
    }
    let mut stream = body.into_data_stream();
    let output = async_stream::stream! {
        let mut buffer=String::new();let mut remainder=vec![];let mut events=vec![];
        let mut terminal=false;let mut oversized=false;let mut failed=false;
        while let Some(item)=stream.next().await{
            match item{
                Ok(bytes)=>{
                    completion.committed=true;
                    if !oversized{
                        if buffer.len()+bytes.len()>2*1024*1024{oversized=true;buffer.clear();}
                        else{
                            super::sse::append_utf8_safe(&mut buffer,&mut remainder,&bytes);
                            if streaming{while let Some(block)=super::sse::take_sse_block(&mut buffer){
                                let data=block.lines().filter_map(|l|l.strip_prefix("data:").map(str::trim)).collect::<Vec<_>>().join("\n");
                                if data=="[DONE]"{terminal=true;}
                                if let Ok(v)=serde_json::from_str::<Value>(&data){
                                    let kind=v.get("type").and_then(Value::as_str).unwrap_or_default();
                                    if matches!(kind,"message_stop"|"response.completed"|"image_generation.completed")||v.pointer("/candidates/0/finishReason").is_some(){terminal=true;}
                                    if matches!(kind,"error"|"response.failed"|"response.incomplete")||v.get("error").is_some(){failed=true;}
                                    if v.get("usage").is_some()||v.get("usageMetadata").is_some()||v.pointer("/message/usage").is_some()||v.pointer("/response/usage").is_some(){
                                        if events.len()==128{events.remove(0);}
                                        events.push(serde_json::json!({"type":v.get("type"),"usage":v.get("usage"),"usageMetadata":v.get("usageMetadata"),"message":{"usage":v.pointer("/message/usage"),"model":v.pointer("/message/model")},"response":{"usage":v.pointer("/response/usage"),"model":v.pointer("/response/model")}}));
                                    }
                                }
                            }}
                        }
                    }
                    if streaming {
                        if let Some(usage) = stream_usage(&active.app, &events) { completion.observed = Some(usage); }
                    }
                    yield Ok::<_,std::io::Error>(bytes);
                }
                Err(error)=>{let _=completion.finish("interrupted",None);yield Err(std::io::Error::other(error.to_string()));return;}
            }
        }
        let usage=if oversized{None}else if streaming{match active.app.as_str(){"claude"|"claude-desktop"=>TokenUsage::from_claude_stream_events(&events),"gemini"=>TokenUsage::from_gemini_stream_chunks(&events),_=>TokenUsage::from_codex_stream_events_auto(&events)}}else{
            serde_json::from_str::<Value>(&buffer).ok().and_then(|v|{failed|=v.get("error").is_some();parse_json(&active.app,&v)})
        };
        let state=if !success||failed{"failed"}else if streaming&&!terminal{"interrupted"}else{"completed"};
        completion.usage_complete = !oversized && (!streaming || (terminal && !failed));
        if let Err(error)=completion.finish(state,usage){yield Err(std::io::Error::other(error.to_string()));}
    };
    Response::from_parts(parts, Body::from_stream(output))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{http::Request as HttpRequest, routing::post, Router};
    use tower::Service;

    #[tokio::test]
    async fn authenticated_binding_controls_attribution_and_scope_before_upstream() {
        let db = Arc::new(Database::memory().unwrap());
        let project = db.save_access_project("/work/owned".into()).unwrap();
        let issued = db
            .issue_access_binding(crate::access::Binding {
                id: "".into(),
                name: "Client".into(),
                agent: "cline".into(),
                tool: "codex".into(),
                project_id: Some(project.id.clone()),
                allowed_groups: vec![],
                enabled: true,
            })
            .unwrap();
        let state = ProxyState::for_test(db.clone());
        let mut router=Router::new().route("/v1/chat/completions",post(||async {
            context("m","untrusted-session").unwrap();
            begin(&Provider::with_id("p".into(),"Provider".into(),Value::Null,None),"m").unwrap();
            Json(serde_json::json!({"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}))
        })).layer(axum::middleware::from_fn_with_state(state.clone(),observe))
            .layer(axum::middleware::from_fn_with_state(state,super::super::ingress::authenticate_bound));
        let response = router
            .call(
                HttpRequest::builder()
                    .method("POST")
                    .uri("/v1/chat/completions")
                    .header("authorization", format!("Bearer {}", issued.token))
                    .header("x-project-id", "forged")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap();
        let page = db
            .ledger_page(crate::ledger::LedgerQuery::default())
            .unwrap();
        assert_eq!(page.records[0].agent, "cline");
        assert_eq!(page.records[0].project_id, Some(project.id));
        assert_eq!(page.totals.tokens, 15);
        assert_eq!(page.records[0].binding_id, issued.binding.id);
        assert_ne!(
            page.records[0].session_id.as_deref(),
            Some("untrusted-session")
        );
        db.set_access_binding_enabled(&issued.binding.id, false)
            .unwrap();
        let response = router
            .call(
                HttpRequest::builder()
                    .method("POST")
                    .uri("/v1/chat/completions")
                    .header("authorization", format!("Bearer {}", issued.token))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            db.ledger_page(crate::ledger::LedgerQuery::default())
                .unwrap()
                .total,
            1
        );
    }

    #[tokio::test]
    async fn admission_storage_failure_does_not_read_body_or_call_handler() {
        let db = Arc::new(Database::memory().unwrap());
        db.conn
            .lock()
            .unwrap()
            .execute("DROP TABLE route_decisions", [])
            .unwrap();
        let state = ProxyState::for_test(db.clone());
        let mut router = Router::new()
            .route(
                "/v1/messages",
                post(|| async {
                    panic!("must not call upstream");
                    #[allow(unreachable_code)]
                    Json(Value::Null)
                }),
            )
            .layer(axum::middleware::from_fn_with_state(state.clone(), observe))
            .layer(axum::middleware::from_fn_with_state(
                state,
                super::super::ingress::authenticate_bound,
            ));
        let body = futures::stream::poll_fn(
            |_| -> std::task::Poll<Option<Result<bytes::Bytes, std::io::Error>>> {
                panic!("must not read body");
            },
        );
        let response = router
            .call(
                HttpRequest::builder()
                    .method("POST")
                    .uri("/v1/messages")
                    .header("x-api-key", super::super::ingress::token("claude"))
                    .body(Body::from_stream(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert!(!db.ledger_available.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn dropping_an_unpolled_stream_marks_its_attempt_interrupted() {
        let db = Arc::new(Database::memory().unwrap());
        let state = ProxyState::for_test(db.clone());
        let mut router = Router::new()
            .route(
                "/v1/messages",
                post(|| async {
                    begin(
                        &Provider::with_id("p".into(), "Provider".into(), Value::Null, None),
                        "m",
                    )
                    .unwrap();
                    Response::builder()
                        .header("content-type", "text/event-stream")
                        .body(Body::from_stream(futures::stream::pending::<
                            Result<bytes::Bytes, std::io::Error>,
                        >()))
                        .unwrap()
                }),
            )
            .layer(axum::middleware::from_fn_with_state(state.clone(), observe))
            .layer(axum::middleware::from_fn_with_state(
                state,
                super::super::ingress::authenticate_bound,
            ));
        let response = router
            .call(
                HttpRequest::builder()
                    .method("POST")
                    .uri("/v1/messages")
                    .header("x-api-key", super::super::ingress::token("claude"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        drop(response);
        let page = db
            .ledger_page(crate::ledger::LedgerQuery::default())
            .unwrap();
        assert_eq!(page.records[0].state, "interrupted");
        assert_eq!(page.totals.unknown_usage, 1);
    }
    #[tokio::test]
    async fn cancellation_preserves_reported_partial_usage_and_marks_the_gap() {
        let db = Arc::new(Database::memory().unwrap());
        let state = ProxyState::for_test(db.clone());
        let mut router = Router::new().route("/v1/messages", post(|| async {
            begin(&Provider::with_id("p".into(), "Provider".into(), Value::Null, None), "m").unwrap();
            let data = "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":12}}}\n\n";
            let stream = futures::stream::iter([Ok::<_, std::io::Error>(bytes::Bytes::from(data))]).chain(futures::stream::pending());
            Response::builder().header("content-type", "text/event-stream").body(Body::from_stream(stream)).unwrap()
        })).layer(axum::middleware::from_fn_with_state(state.clone(), observe)).layer(axum::middleware::from_fn_with_state(state, super::super::ingress::authenticate_bound));
        let response = router
            .call(
                HttpRequest::builder()
                    .method("POST")
                    .uri("/v1/messages")
                    .header("x-api-key", super::super::ingress::token("claude"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let mut stream = response.into_body().into_data_stream();
        assert!(stream.next().await.unwrap().is_ok());
        drop(stream);
        let page = db
            .ledger_page(crate::ledger::LedgerQuery::default())
            .unwrap();
        assert_eq!(page.records[0].state, "interrupted");
        assert_eq!(page.totals.tokens, 12);
        assert_eq!(page.totals.unknown_usage, 1);
        assert!(!db.ledger_attempts(&page.records[0].id).unwrap()[0].usage_complete);
    }
    #[tokio::test]
    async fn binding_scope_filters_discovery_and_refuses_unapproved_routes() {
        let db = Arc::new(Database::memory().unwrap());
        let catalog: crate::gateway::Catalog = serde_json::from_value(
            serde_json::json!({"revision":1,"suppliers":[],"policies":[],"groups":[
                {"id":"allowed","name":"Allowed","appIds":["codex"]},
                {"id":"private","name":"Private","appIds":["codex"]}
            ]}),
        )
        .unwrap();
        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT OR REPLACE INTO gateway_catalog(id,payload) VALUES(1,?1)",
                [serde_json::to_string(&catalog).unwrap()],
            )
            .unwrap();
        let issued = db
            .issue_access_binding(crate::access::Binding {
                id: "".into(),
                name: "Scoped".into(),
                agent: "cline".into(),
                tool: "codex".into(),
                project_id: None,
                allowed_groups: vec!["allowed".into()],
                enabled: true,
            })
            .unwrap();
        let state = ProxyState::for_test(db.clone());
        let mut router = Router::new()
            .route(
                "/v1/models",
                axum::routing::get(super::super::handlers::handle_models),
            )
            .route(
                "/v1/chat/completions",
                post(|Json(body): Json<Value>| async move {
                    if authorize_group(body["group"].as_str()).is_err() {
                        return StatusCode::FORBIDDEN;
                    }
                    begin(
                        &Provider::with_id("p".into(), "Provider".into(), Value::Null, None),
                        "m",
                    )
                    .unwrap();
                    StatusCode::OK
                }),
            )
            .with_state(state.clone())
            .layer(axum::middleware::from_fn_with_state(state.clone(), observe))
            .layer(axum::middleware::from_fn_with_state(
                state,
                super::super::ingress::authenticate_bound,
            ));
        let response = router
            .call(
                HttpRequest::builder()
                    .uri("/v1/models")
                    .header("authorization", format!("Bearer {}", issued.token))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let value: Value = serde_json::from_slice(
            &axum::body::to_bytes(response.into_body(), 4096)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(value["data"].as_array().unwrap().len(), 1);
        assert_eq!(value["data"][0]["id"], "group/allowed");
        for group in [Some("private"), None] {
            let response = router
                .call(
                    HttpRequest::builder()
                        .method("POST")
                        .uri("/v1/chat/completions")
                        .header("authorization", format!("Bearer {}", issued.token))
                        .header("content-type", "application/json")
                        .body(Body::from(serde_json::json!({"group":group}).to_string()))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::FORBIDDEN);
            axum::body::to_bytes(response.into_body(), 4096)
                .await
                .unwrap();
        }
        assert_eq!(
            db.ledger_page(crate::ledger::LedgerQuery::default())
                .unwrap()
                .totals
                .attempts,
            0
        );
    }
}
