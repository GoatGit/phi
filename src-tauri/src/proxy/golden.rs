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
                    let events: Vec<Value> = body.lines().filter_map(|line| line.strip_prefix("data: ")).filter(|line| *line != "[DONE]").map(|line|serde_json::from_str(line).unwrap()).collect();
                    if tools {
                        let calls: Vec<&Value> = events.iter().filter_map(|event|event.pointer("/choices/0/delta/tool_calls").and_then(Value::as_array)).flatten().collect();
                        let arguments: String = calls.iter().filter_map(|call|call.pointer("/function/arguments").and_then(Value::as_str)).collect();
                        assert_eq!(serde_json::from_str::<Value>(&arguments).unwrap(),json!({"path":"sample.txt"}));
                        assert_eq!(calls.iter().filter(|call|call.pointer("/function/name").and_then(Value::as_str)==Some("read_file")).count(),1);
                    } else {
                        let text: String = events.iter().filter_map(|event|event.pointer("/choices/0/delta/content").and_then(Value::as_str)).collect();
                        assert_eq!(text,"Synthetic reply.");
                    }
                } else {
                    let value: Value = serde_json::from_str(&body).unwrap();
                    assert_eq!(value["object"], "chat.completion");
                    assert_eq!(value["usage"]["prompt_tokens"], 12);
                    if tools { assert_eq!(serde_json::from_str::<Value>(value["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"].as_str().unwrap()).unwrap(),json!({"path":"sample.txt"})); }
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
