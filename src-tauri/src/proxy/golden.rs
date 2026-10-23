//! Crafted, full-wire regression cases. All upstreams bind ephemeral loopback ports.
use super::*;
use axum::{body::Body, extract::Request, response::Response, routing::post, Router};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

fn upstream_response(protocol: &str, tools: bool) -> Value {
    let content = if tools {
        json!({"type":"function_call","id":"item-1","call_id":"call-1","name":"read_file","arguments":"{\"path\":\"sample.txt\"}"})
    } else {
        json!({"type":"message","id":"msg-1","role":"assistant","content":[{"type":"output_text","text":"Synthetic reply."}]})
    };
    match protocol {
        "anthropic" => {
            json!({"id":"msg-1","type":"message","role":"assistant","model":"fixture-model","content":if tools {json!([{"type":"tool_use","id":"call-1","name":"read_file","input":{"path":"sample.txt"}}])} else {json!([{"type":"text","text":"Synthetic reply."}])},"stop_reason":if tools {"tool_use"} else {"end_turn"},"usage":{"input_tokens":12,"output_tokens":4}})
        }
        "openai_chat" => {
            json!({"id":"chat-1","object":"chat.completion","created":1,"model":"fixture-model","choices":[{"index":0,"message":if tools {json!({"role":"assistant","content":null,"tool_calls":[{"id":"call-1","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"sample.txt\"}"}}]})}else{json!({"role":"assistant","content":"Synthetic reply."})},"finish_reason":if tools {"tool_calls"}else{"stop"}}],"usage":{"prompt_tokens":12,"completion_tokens":4,"total_tokens":16}})
        }
        _ => {
            json!({"id":"resp-1","object":"response","created_at":1,"status":"completed","model":"fixture-model","output":[content],"usage":{"input_tokens":12,"output_tokens":4,"total_tokens":16}})
        }
    }
}
fn event(value: Value) -> String {
    format!("data: {value}\n\n")
}
fn upstream_stream(protocol: &str, tools: bool, response: &Value) -> String {
    match protocol {
        "anthropic" => {
            let mut result = event(
                json!({"type":"message_start","message":{"id":"msg-1","role":"assistant","model":"fixture-model","content":[],"usage":{"input_tokens":12,"output_tokens":0}}}),
            );
            result += &event(
                json!({"type":"content_block_start","index":0,"content_block":if tools {json!({"type":"tool_use","id":"call-1","name":"read_file","input":{}})}else{json!({"type":"text","text":""})}}),
            );
            result += &event(
                json!({"type":"content_block_delta","index":0,"delta":if tools {json!({"type":"input_json_delta","partial_json":"{\"path\":\"sample.txt\"}"})}else{json!({"type":"text_delta","text":"Synthetic reply."})}}),
            );
            result += &event(json!({"type":"content_block_stop","index":0}));
            result += &event(
                json!({"type":"message_delta","delta":{"stop_reason":if tools {"tool_use"}else{"end_turn"}},"usage":{"output_tokens":4}}),
            );
            result + &event(json!({"type":"message_stop"}))
        }
        "openai_chat" => {
            let mut delta = response["choices"][0]["message"].clone();
            if tools {
                delta["tool_calls"][0]["index"] = json!(0);
            }
            event(
                json!({"id":"chat-1","object":"chat.completion.chunk","model":"fixture-model","choices":[{"index":0,"delta":delta,"finish_reason":null}]}),
            ) + &event(
                json!({"id":"chat-1","object":"chat.completion.chunk","model":"fixture-model","choices":[{"index":0,"delta":{},"finish_reason":if tools {"tool_calls"}else{"stop"}}],"usage":{"prompt_tokens":12,"completion_tokens":4,"total_tokens":16}}),
            ) + "data: [DONE]\n\n"
        }
        _ => {
            // Final-only output is valid; the Chat adapter must not discard it.
            event(
                json!({"type":"response.created","response":{"id":"resp-1","model":"fixture-model"}}),
            ) + &event(json!({"type":"response.completed","response":response}))
        }
    }
}

#[tokio::test]
#[serial_test::serial]
async fn golden_generic_chat_three_outbounds_text_tools_stream_usage_and_auth() {
    for protocol in ["anthropic", "openai_chat", "openai_responses"] {
        for tools in [false, true] {
            for streaming in [false, true] {
                let calls = Arc::new(AtomicUsize::new(0));
                let observed = calls.clone();
                let upstream = Router::new().fallback(post(move |request: Request| {
                    let calls = calls.clone();
                    async move {
                        calls.fetch_add(1, Ordering::SeqCst);
                        assert!(!request.headers().contains_key("x-phi-token"));
                        let auth = if protocol == "anthropic" {
                            "x-api-key"
                        } else {
                            "authorization"
                        };
                        assert!(request.headers()[auth]
                            .to_str()
                            .unwrap()
                            .contains("fixture-key"));
                        assert!(!request.headers()[auth]
                            .to_str()
                            .unwrap()
                            .contains("phi-binding"));
                        let expected = match protocol {
                            "anthropic" => "/messages",
                            "openai_chat" => "/chat/completions",
                            _ => "/responses",
                        };
                        assert!(request.uri().path().ends_with(expected));
                        let bytes = axum::body::to_bytes(request.into_body(), 100_000)
                            .await
                            .unwrap();
                        let body: Value = serde_json::from_slice(&bytes).unwrap();
                        assert_eq!(body["model"], "fixture-model");
                        assert!(body.to_string().contains("Synthetic prompt."));
                        if tools {
                            assert!(body.to_string().contains("read_file"));
                        }
                        let response = upstream_response(protocol, tools);
                        if body["stream"] == true {
                            Response::builder()
                                .header("content-type", "text/event-stream")
                                .body(Body::from(upstream_stream(protocol, tools, &response)))
                                .unwrap()
                        } else {
                            Response::builder()
                                .header("content-type", "application/json")
                                .body(Body::from(response.to_string()))
                                .unwrap()
                        }
                    }
                }));
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                let address = listener.local_addr().unwrap();
                let upstream_task = tokio::spawn(async move {
                    axum::serve(listener, upstream).await.unwrap();
                });
                let db = Arc::new(crate::Database::memory().unwrap());
                let mut catalog = db
                    .create_gateway_supplier(crate::gateway::SupplierUpsert {
                        name: Some("Fixture".into()),
                        endpoint: Some(crate::gateway::Endpoint {
                            protocol: protocol.into(),
                            base_url: format!("http://{address}"),
                        }),
                        models: Some(vec!["fixture-model".into()]),
                        api_key: Some("fixture-key".into()),
                        auth_field: Some(
                            if protocol == "anthropic" {
                                "ANTHROPIC_API_KEY"
                            } else {
                                "OPENAI_API_KEY"
                            }
                            .into(),
                        ),
                        ..Default::default()
                    })
                    .unwrap();
                catalog.groups.push(serde_json::from_value(json!({"id":"fixture","name":"Fixture","appIds":["codex"],"members":[{"id":"member","supplierId":catalog.suppliers[0].id,"model":"fixture-model"}]})).unwrap());
                db.save_gateway_catalog(catalog).unwrap();
                let binding = db
                    .issue_access_binding(crate::access::Binding {
                        id: "".into(),
                        name: "Generic client".into(),
                        agent: "cline".into(),
                        tool: "codex".into(),
                        project_id: None,
                        allowed_groups: vec!["fixture".into()],
                        enabled: true,
                    })
                    .unwrap();
                let proxy = server::ProxyServer::new(
                    ProxyConfig {
                        listen_port: 0,
                        enable_logging: false,
                        ..Default::default()
                    },
                    db.clone(),
                    None,
                );
                let info = proxy.start().await.unwrap();
                let mut body = json!({"model":"group/fixture","messages":[{"role":"user","content":"Synthetic prompt."}],"stream":streaming});
                if tools {
                    body["tools"] = json!([{"type":"function","function":{"name":"read_file","parameters":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}}}]);
                }
                // No stream_options.include_usage: ledger must still capture final usage.
                let response = reqwest::Client::new()
                    .post(format!(
                        "http://127.0.0.1:{}/v1/chat/completions",
                        info.port
                    ))
                    .bearer_auth(binding.token)
                    .json(&body)
                    .timeout(std::time::Duration::from_secs(5))
                    .send()
                    .await
                    .unwrap();
                let status = response.status();
                let body = response.text().await.unwrap();
                assert!(
                    status.is_success(),
                    "{protocol} stream={streaming} tools={tools}: {body}"
                );
                assert!(
                    body.contains(if tools {
                        "read_file"
                    } else {
                        "Synthetic reply."
                    }),
                    "{protocol} stream={streaming} tools={tools}: {body}"
                );
                if streaming {
                    assert!(body.ends_with("data: [DONE]\n\n"));
                    assert!(body.contains("chat.completion.chunk"));
                    let events: Vec<Value> = body
                        .lines()
                        .filter_map(|line| line.strip_prefix("data: "))
                        .filter(|line| *line != "[DONE]")
                        .map(|line| serde_json::from_str(line).unwrap())
                        .collect();
                    if tools {
                        let calls: Vec<&Value> = events
                            .iter()
                            .filter_map(|event| {
                                event
                                    .pointer("/choices/0/delta/tool_calls")
                                    .and_then(Value::as_array)
                            })
                            .flatten()
                            .collect();
                        let arguments: String = calls
                            .iter()
                            .filter_map(|call| {
                                call.pointer("/function/arguments").and_then(Value::as_str)
                            })
                            .collect();
                        assert_eq!(
                            serde_json::from_str::<Value>(&arguments).unwrap(),
                            json!({"path":"sample.txt"})
                        );
                        assert_eq!(
                            calls
                                .iter()
                                .filter(|call| call
                                    .pointer("/function/name")
                                    .and_then(Value::as_str)
                                    == Some("read_file"))
                                .count(),
                            1
                        );
                    } else {
                        let text: String = events
                            .iter()
                            .filter_map(|event| {
                                event
                                    .pointer("/choices/0/delta/content")
                                    .and_then(Value::as_str)
                            })
                            .collect();
                        assert_eq!(text, "Synthetic reply.");
                    }
                } else {
                    let value: Value = serde_json::from_str(&body).unwrap();
                    assert_eq!(value["object"], "chat.completion");
                    assert_eq!(value["usage"]["prompt_tokens"], 12);
                    if tools {
                        assert_eq!(
                            serde_json::from_str::<Value>(
                                value["choices"][0]["message"]["tool_calls"][0]["function"]
                                    ["arguments"]
                                    .as_str()
                                    .unwrap()
                            )
                            .unwrap(),
                            json!({"path":"sample.txt"})
                        );
                    }
                }
                let ledger = db
                    .ledger_page(crate::ledger::LedgerQuery::default())
                    .unwrap();
                assert_eq!(
                    ledger.totals.tokens, 16,
                    "{protocol} stream={streaming} tools={tools}"
                );
                assert_eq!(ledger.totals.unknown_usage, 0);
                assert_eq!(observed.load(Ordering::SeqCst), 1);
                proxy.stop().await.unwrap();
                upstream_task.abort();
                let _ = upstream_task.await;
            }
        }
    }
}

#[test]
fn golden_chat_rejects_unsupported_features_and_keeps_tool_history_and_images() {
    for field in ["audio", "logprobs", "stop", "seed"] {
        let mut body = json!({"model":"m","messages":[{"role":"user","content":"test"}]});
        body[field] = json!(true);
        assert!(chat_bridge::request_to_responses(&body).is_err());
    }
    let body = json!({"model":"m","messages":[{"role":"user","content":[{"type":"text","text":"look"},{"type":"image_url","image_url":{"url":"data:image/png;base64,AA=="}}]},{"role":"assistant","content":null,"tool_calls":[{"id":"call","type":"function","function":{"name":"f","arguments":"{}"}}]},{"role":"tool","tool_call_id":"call","content":"result"}]});
    let value = chat_bridge::request_to_responses(&body).unwrap();
    assert_eq!(value["input"][0]["content"][1]["type"], "input_image");
    assert_eq!(value["input"][1]["call_id"], "call");
    assert_eq!(value["input"][2]["output"], "result");
}

/// 外部接入：一个令牌按入口协议切换路由身份。协议一致时直通，不一致时按既有转换。
async fn fixture_upstream(protocol: &'static str) -> (String, tokio::task::JoinHandle<()>) {
    let upstream = Router::new().fallback(post(move |request: Request| async move {
        let expected = match protocol {
            "anthropic" => "/messages",
            "openai_chat" => "/chat/completions",
            "gemini_native" => ":generateContent",
            _ => "/responses",
        };
        assert!(
            request.uri().path().ends_with(expected),
            "{protocol}: {}",
            request.uri().path()
        );
        let auth = match protocol {
            "anthropic" => "x-api-key",
            "gemini_native" => "x-goog-api-key",
            _ => "authorization",
        };
        let supplied = request.headers()[auth].to_str().unwrap();
        assert!(supplied.contains("fixture-key"), "{protocol}: {supplied}");
        assert!(!supplied.contains("phi-binding"), "{protocol}: {supplied}");
        let bytes = axum::body::to_bytes(request.into_body(), 100_000)
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert!(
            body.to_string().contains("Synthetic prompt."),
            "{protocol}: {body}"
        );
        let response = if protocol == "gemini_native" {
            json!({
                "candidates": [{"content": {"role": "model", "parts": [{"text": "Synthetic reply."}]}, "finishReason": "STOP"}],
                "usageMetadata": {"promptTokenCount": 12, "candidatesTokenCount": 4, "totalTokenCount": 16}
            })
        } else {
            upstream_response(protocol, false)
        };
        Response::builder()
            .header("content-type", "application/json")
            .body(Body::from(response.to_string()))
            .unwrap()
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        axum::serve(listener, upstream).await.unwrap();
    });
    (format!("http://{address}"), task)
}

#[tokio::test]
#[serial_test::serial]
async fn golden_external_token_serves_every_protocol_entry() {
    let fixtures = [
        ("anthropic", "fixture-anthropic", "ANTHROPIC_API_KEY"),
        ("openai_chat", "fixture-chat", "OPENAI_API_KEY"),
        ("openai_responses", "fixture-responses", "OPENAI_API_KEY"),
        ("gemini_native", "fixture-gemini", "GEMINI_API_KEY"),
    ];
    let mut endpoints = Vec::new();
    for (protocol, model, field) in fixtures {
        let (base_url, task) = fixture_upstream(protocol).await;
        endpoints.push((protocol, model, field, base_url, task));
    }
    let db = Arc::new(crate::Database::memory().unwrap());
    let mut catalog = db.gateway_catalog().unwrap();
    let mut supplier_ids = Vec::new();
    for (protocol, model, field, base_url, _) in &endpoints {
        catalog = db
            .create_gateway_supplier(crate::gateway::SupplierUpsert {
                name: Some(format!("External {protocol}")),
                endpoint: Some(crate::gateway::Endpoint {
                    protocol: (*protocol).into(),
                    base_url: base_url.clone(),
                }),
                models: Some(vec![(*model).into()]),
                api_key: Some("fixture-key".into()),
                auth_field: Some((*field).into()),
                ..Default::default()
            })
            .unwrap();
        supplier_ids.push(catalog.suppliers.last().unwrap().id.clone());
    }
    let groups = [
        (
            "external-anthropic",
            "claude",
            &supplier_ids[0],
            "fixture-anthropic",
        ),
        (
            "external-chat",
            "opencode",
            &supplier_ids[1],
            "fixture-chat",
        ),
        (
            "external-responses",
            "codex",
            &supplier_ids[2],
            "fixture-responses",
        ),
        (
            "external-gemini",
            "gemini",
            &supplier_ids[3],
            "fixture-gemini",
        ),
    ];
    for (id, app, supplier, model) in groups {
        catalog.groups.push(
            serde_json::from_value(json!({
                "id": id,
                "name": id,
                "appIds": [app],
                "members": [{"id": "member", "supplierId": supplier, "model": model}]
            }))
            .unwrap(),
        );
    }
    db.save_gateway_catalog(catalog).unwrap();
    let binding = db
        .issue_access_binding(crate::access::Binding {
            id: "".into(),
            name: "Cursor".into(),
            agent: "cursor".into(),
            tool: crate::access::EXTERNAL_TOOL.into(),
            project_id: None,
            allowed_groups: vec![],
            enabled: true,
        })
        .unwrap();
    let proxy = server::ProxyServer::new(
        ProxyConfig {
            listen_port: 0,
            // 本轮验证外部密钥的用量明细，需要打开「记录请求用量」。
            enable_logging: true,
            ..Default::default()
        },
        db.clone(),
        None,
    );
    let info = proxy.start().await.unwrap();
    let base = format!("http://127.0.0.1:{}", info.port);
    let client = reqwest::Client::new();
    let prompt = "Synthetic prompt.";
    let request = |path: &str| format!("{base}{path}");

    // Anthropic 入口 → Anthropic 供应商：直通。
    let response = client
        .post(request("/v1/messages"))
        .header("x-api-key", &binding.token)
        .json(&json!({"model":"group/external-anthropic","max_tokens":64,"messages":[{"role":"user","content":prompt}]}))
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
        .unwrap();
    let status = response.status();
    let body: Value = response.json().await.unwrap();
    assert!(status.is_success(), "messages: {body}");
    assert_eq!(body["type"], "message", "messages: {body}");
    assert!(body.to_string().contains("Synthetic reply."));

    // Chat 入口 → Anthropic 供应商：一跳转换，不再经 Responses 中转。
    let response = client
        .post(request("/v1/chat/completions"))
        .bearer_auth(&binding.token)
        .json(&json!({"model":"group/external-anthropic","messages":[{"role":"user","content":prompt}]}))
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
        .unwrap();
    let status = response.status();
    let body: Value = response.json().await.unwrap();
    assert!(status.is_success(), "chat→anthropic: {body}");
    assert_eq!(body["object"], "chat.completion", "chat→anthropic: {body}");
    assert!(body.to_string().contains("Synthetic reply."));

    // Responses 入口 → Responses 供应商。
    let response = client
        .post(request("/v1/responses"))
        .bearer_auth(&binding.token)
        .json(&json!({"model":"group/external-responses","input":[{"role":"user","content":[{"type":"input_text","text":prompt}]}]}))
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
        .unwrap();
    let status = response.status();
    let body: Value = response.json().await.unwrap();
    assert!(status.is_success(), "responses: {body}");
    assert_eq!(body["object"], "response", "responses: {body}");
    assert!(body.to_string().contains("Synthetic reply."));

    // Gemini 入口 → Gemini 供应商：模型名在路径里，组别名带斜杠也成立。
    let response = client
        .post(request(
            "/v1beta/models/group/external-gemini:generateContent",
        ))
        .header("x-goog-api-key", &binding.token)
        .json(&json!({"contents":[{"role":"user","parts":[{"text":prompt}]}]}))
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
        .unwrap();
    let status = response.status();
    let body: Value = response.json().await.unwrap();
    assert!(status.is_success(), "gemini: {body}");
    assert_eq!(
        body["candidates"][0]["content"]["parts"][0]["text"], "Synthetic reply.",
        "gemini: {body}"
    );

    // 外部密钥的模型清单：第三方客户端只能填真实模型名，清单里必须同时给出
    // 组别名与组内成员模型名，否则「拉取模型」拿到的只有一个组别名。
    let response = client
        .get(request("/v1/models"))
        .bearer_auth(&binding.token)
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
        .unwrap();
    let status = response.status();
    let body: Value = response.json().await.unwrap();
    assert!(status.is_success(), "models: {body}");
    let ids: Vec<&str> = body["data"]
        .as_array()
        .expect("models data")
        .iter()
        .filter_map(|entry| entry["id"].as_str())
        .collect();
    for model in [
        "fixture-anthropic",
        "fixture-chat",
        "fixture-gemini",
        "fixture-responses",
    ] {
        assert!(ids.contains(&model), "models missing {model}: {body}");
    }
    for group in [
        "group/external-anthropic",
        "group/external-chat",
        "group/external-gemini",
        "group/external-responses",
    ] {
        assert!(ids.contains(&group), "models missing {group}: {body}");
    }

    // 真实模型名也能路由：Chat 入口用成员模型名 fixture-chat，不必先知道组别名。
    let response = client
        .post(request("/v1/chat/completions"))
        .bearer_auth(&binding.token)
        .json(&json!({"model":"fixture-chat","messages":[{"role":"user","content":prompt}]}))
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
        .unwrap();
    let status = response.status();
    let body: Value = response.json().await.unwrap();
    assert!(status.is_success(), "chat by model name: {body}");
    assert!(body.to_string().contains("Synthetic reply."));

    let ledger = db
        .ledger_page(crate::ledger::LedgerQuery::default())
        .unwrap();
    assert_eq!(ledger.totals.requests, 5);
    assert!(ledger.totals.tokens > 0);
    // 展示用的用量明细也带上了密钥归属，用量页才能按密钥筛选。
    let usage_rows: i64 = db
        .conn
        .lock()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM proxy_request_logs
             WHERE binding_id = ?1 AND data_source = 'gateway'",
            [&binding.binding.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(usage_rows, 5);
    // `app_type` 记的是这次请求实际使用的入口应用身份，不是三方应用自己：
    // Messages → claude、Chat ×2 → opencode、Responses → codex、Gemini → gemini。
    for (app_type, rows) in [
        ("claude", 1),
        ("opencode", 2),
        ("codex", 1),
        ("gemini", 1),
        ("external", 0),
    ] {
        let count: i64 = db
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM proxy_request_logs
                 WHERE binding_id = ?1 AND data_source = 'gateway' AND app_type = ?2",
                rusqlite::params![&binding.binding.id, app_type],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, rows, "{app_type}");
    }
    proxy.stop().await.unwrap();
    for (_, _, _, _, task) in endpoints {
        task.abort();
        let _ = task.await;
    }
}
