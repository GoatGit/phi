//! Anthropic Messages ↔ 中性 IR。
//!
//! 重点保留 thinking block 的 `signature`，以及 tool_use / tool_result 的
//! 关联 id；`cache_control` 这类纯 Anthropic 优化字段暂不进入 IR。

use serde_json::{json, Value};

use crate::proxy::error::ProxyError;
use crate::proxy::protocol::ir::{
    Block, ImageSource, Message, Request, Response, Role, StopReason, Tool, ToolChoice, Usage,
};

pub(crate) fn parse_request(body: Value) -> Result<Request, ProxyError> {
    let object = body.as_object().ok_or_else(|| invalid("body"))?;
    let model = object
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let mut request = Request::new(model);
    request.system = parse_system(object.get("system"))?;
    if let Some(messages) = object.get("messages").and_then(Value::as_array) {
        for message in messages {
            let role = match message.get("role").and_then(Value::as_str) {
                Some("assistant") => Role::Assistant,
                _ => Role::User,
            };
            let blocks = parse_content(message.get("content"))?;
            if !blocks.is_empty() {
                request.messages.push(Message { role, blocks });
            }
        }
    }
    if let Some(tools) = object.get("tools").and_then(Value::as_array) {
        for tool in tools {
            let Some(name) = tool.get("name").and_then(Value::as_str) else {
                continue;
            };
            request.tools.push(Tool {
                name: name.to_string(),
                description: tool
                    .get("description")
                    .and_then(Value::as_str)
                    .map(ToString::to_string),
                input_schema: tool
                    .get("input_schema")
                    .cloned()
                    .unwrap_or_else(|| json!({"type":"object","properties":{}})),
            });
        }
    }
    request.tool_choice = match object.get("tool_choice") {
        Some(Value::String(value)) => match value.as_str() {
            "any" | "required" => ToolChoice::Required,
            "none" => ToolChoice::None,
            _ => ToolChoice::Auto,
        },
        Some(value) => match value.get("type").and_then(Value::as_str) {
            Some("any") => ToolChoice::Required,
            Some("none") => ToolChoice::None,
            Some("tool") => value
                .get("name")
                .and_then(Value::as_str)
                .map(|name| ToolChoice::Tool(name.to_string()))
                .unwrap_or(ToolChoice::Auto),
            _ => ToolChoice::Auto,
        },
        None => ToolChoice::Auto,
    };
    request.max_tokens = object.get("max_tokens").and_then(Value::as_u64);
    request.temperature = object.get("temperature").and_then(Value::as_f64);
    request.top_p = object.get("top_p").and_then(Value::as_f64);
    request.stream = object
        .get("stream")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    request.stop = object
        .get("stop_sequences")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default();
    request.extensions.anthropic_thinking = object.get("thinking").cloned();
    request.extensions.anthropic_output_config = object.get("output_config").cloned();
    Ok(request)
}

pub(crate) fn build_request(request: &Request) -> Result<Value, ProxyError> {
    let mut result = json!({
        "model": request.model.as_str(),
        "messages": request
            .messages
            .iter()
            .map(|message| {
                json!({
                    "role": match message.role { Role::User => "user", Role::Assistant => "assistant" },
                    "content": build_blocks(&message.blocks)
                })
            })
            .collect::<Vec<_>>(),
    });
    if !request.system.is_empty() {
        result["system"] = json!(request.system.join("\n\n"));
    }
    if let Some(max_tokens) = request.max_tokens {
        result["max_tokens"] = json!(max_tokens);
    }
    if let Some(temperature) = request.temperature {
        result["temperature"] = json!(temperature);
    }
    if let Some(top_p) = request.top_p {
        result["top_p"] = json!(top_p);
    }
    if request.stream {
        result["stream"] = json!(true);
    }
    if !request.stop.is_empty() {
        result["stop_sequences"] = json!(request.stop.clone());
    }
    if !request.tools.is_empty() {
        result["tools"] = json!(request
            .tools
            .iter()
            .map(|tool| {
                let mut value = json!({
                    "name": tool.name.as_str(),
                    "input_schema": tool.input_schema.clone(),
                });
                if let Some(description) = &tool.description {
                    value["description"] = json!(description);
                }
                value
            })
            .collect::<Vec<_>>());
    }
    if !request.tools.is_empty() {
        result["tool_choice"] = match &request.tool_choice {
            ToolChoice::Auto => json!({"type":"auto"}),
            ToolChoice::Required => json!({"type":"any"}),
            ToolChoice::None => json!({"type":"none"}),
            ToolChoice::Tool(name) => json!({"type":"tool","name":name}),
        };
    }
    if let Some(thinking) = &request.extensions.anthropic_thinking {
        result["thinking"] = thinking.clone();
    }
    if let Some(output) = &request.extensions.anthropic_output_config {
        result["output_config"] = output.clone();
    }
    Ok(result)
}

pub(crate) fn parse_response(body: Value) -> Result<Response, ProxyError> {
    if body.get("type").and_then(Value::as_str) == Some("error") || body.get("error").is_some() {
        let error = body.get("error").unwrap_or(&body);
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .or_else(|| error.as_str())
            .unwrap_or("Anthropic upstream returned an error envelope");
        return Err(ProxyError::TransformError(format!(
            "Anthropic upstream error: {message}"
        )));
    }
    let mut response = Response::new(
        body.get("id").and_then(Value::as_str).unwrap_or_default(),
        body.get("model")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    );
    response.blocks = parse_content(body.get("content"))?;
    response.stop_reason = match body.get("stop_reason").and_then(Value::as_str) {
        Some("max_tokens") => StopReason::MaxTokens,
        Some("tool_use") => StopReason::ToolUse,
        Some("stop_sequence") => StopReason::StopSequence,
        Some("refusal") => StopReason::ContentFilter,
        Some("end_turn") | None => StopReason::EndTurn,
        Some(other) => StopReason::Other(other.to_string()),
    };
    response.usage = parse_usage(body.get("usage"));
    Ok(response)
}

pub(crate) fn build_response(response: &Response) -> Result<Value, ProxyError> {
    let mut result = json!({
        "id": response.id.as_str(),
        "type": "message",
        "role": "assistant",
        "model": response.model.as_str(),
        "content": build_blocks(&response.blocks),
        "stop_reason": match response.stop_reason {
            StopReason::EndTurn => "end_turn",
            StopReason::MaxTokens => "max_tokens",
            StopReason::ToolUse => "tool_use",
            StopReason::StopSequence => "stop_sequence",
            StopReason::ContentFilter => "refusal",
            StopReason::Other(_) => "end_turn",
        },
        "stop_sequence": Value::Null,
        "usage": {
            "input_tokens": response.usage.input_tokens,
            "output_tokens": response.usage.output_tokens,
            "cache_read_input_tokens": response.usage.cache_read_input_tokens,
            "cache_creation_input_tokens": response.usage.cache_creation_input_tokens
        }
    });
    if response.id.is_empty() {
        result.as_object_mut().unwrap().remove("id");
    }
    Ok(result)
}

fn parse_system(value: Option<&Value>) -> Result<Vec<String>, ProxyError> {
    match value {
        Some(Value::String(text)) => Ok(vec![text.clone()]),
        Some(Value::Array(blocks)) => {
            let mut parts = Vec::new();
            for block in blocks {
                if let Some(text) = block.get("text").and_then(Value::as_str) {
                    if !text.trim().is_empty() {
                        parts.push(text.to_string());
                    }
                }
            }
            Ok(parts)
        }
        Some(Value::Null) | None => Ok(Vec::new()),
        _ => Err(invalid("system")),
    }
}

fn parse_content(value: Option<&Value>) -> Result<Vec<Block>, ProxyError> {
    match value {
        Some(Value::String(text)) => Ok(vec![Block::Text(text.clone())]),
        Some(Value::Array(blocks)) => {
            let mut result = Vec::new();
            for block in blocks {
                result.extend(parse_block(block)?);
            }
            Ok(result)
        }
        Some(Value::Null) | None => Ok(Vec::new()),
        _ => Err(invalid("content")),
    }
}

fn parse_block(block: &Value) -> Result<Vec<Block>, ProxyError> {
    let mut result = Vec::new();
    match block.get("type").and_then(Value::as_str).unwrap_or("") {
        "text" => {
            if let Some(text) = block.get("text").and_then(Value::as_str) {
                result.push(Block::Text(text.to_string()));
            }
        }
        "thinking" => {
            result.push(Block::Thinking {
                text: block
                    .get("thinking")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                signature: block
                    .get("signature")
                    .and_then(Value::as_str)
                    .map(ToString::to_string),
            });
        }
        "redacted_thinking" => {
            result.push(Block::Thinking {
                text: String::new(),
                signature: block
                    .get("data")
                    .and_then(Value::as_str)
                    .map(ToString::to_string),
            });
        }
        "image" => {
            if let Some(source) = block.get("source") {
                match source.get("type").and_then(Value::as_str) {
                    Some("base64") => {
                        if let (Some(media_type), Some(data)) = (
                            source.get("media_type").and_then(Value::as_str),
                            source.get("data").and_then(Value::as_str),
                        ) {
                            result.push(Block::Image(ImageSource::Base64 {
                                media_type: media_type.to_string(),
                                data: data.to_string(),
                            }));
                        }
                    }
                    Some("url") => {
                        if let Some(url) = source.get("url").and_then(Value::as_str) {
                            result.push(Block::Image(ImageSource::Url(url.to_string())));
                        }
                    }
                    _ => {}
                }
            }
        }
        "tool_use" => {
            if let Some(name) = block.get("name").and_then(Value::as_str) {
                result.push(Block::ToolUse {
                    id: block
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    name: name.to_string(),
                    input: block.get("input").cloned().unwrap_or_else(|| json!({})),
                    thought_signature: None,
                });
            }
        }
        "tool_result" => {
            if let Some(tool_use_id) = block.get("tool_use_id").and_then(Value::as_str) {
                result.push(Block::ToolResult {
                    tool_use_id: tool_use_id.to_string(),
                    name: block
                        .get("name")
                        .and_then(Value::as_str)
                        .map(ToString::to_string),
                    content: block.get("content").cloned().unwrap_or(Value::Null),
                    is_error: block
                        .get("is_error")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                });
            }
        }
        _ => {}
    }
    Ok(result)
}

fn build_blocks(blocks: &[Block]) -> Value {
    Value::Array(
        blocks
            .iter()
            .flat_map(|block| match block {
                Block::Text(text) => vec![json!({"type":"text","text":text})],
                Block::Thinking { text, signature } => {
                    let mut value = json!({"type":"thinking","thinking":text});
                    if let Some(signature) = signature {
                        value["signature"] = json!(signature);
                    }
                    vec![value]
                }
                Block::Image(ImageSource::Base64 { media_type, data }) => vec![json!({
                    "type":"image",
                    "source":{"type":"base64","media_type":media_type,"data":data}
                })],
                Block::Image(ImageSource::Url(url)) => vec![json!({
                    "type":"image",
                    "source":{"type":"url","url":url}
                })],
                Block::ToolUse {
                    id, name, input, ..
                } => vec![json!({
                    "type":"tool_use","id":id,"name":name,"input":input
                })],
                Block::ToolResult {
                    tool_use_id,
                    content,
                    is_error,
                    ..
                } => {
                    let mut value = json!({
                        "type":"tool_result",
                        "tool_use_id":tool_use_id,
                        "content":content
                    });
                    if *is_error {
                        value["is_error"] = json!(true);
                    }
                    vec![value]
                }
            })
            .collect::<Vec<_>>(),
    )
}

fn parse_usage(value: Option<&Value>) -> Usage {
    let Some(value) = value.filter(|value| value.is_object()) else {
        return Usage::default();
    };
    Usage {
        input_tokens: value
            .get("input_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        output_tokens: value
            .get("output_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        cache_read_input_tokens: value
            .get("cache_read_input_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        cache_creation_input_tokens: value
            .get("cache_creation_input_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0),
    }
}

fn invalid(field: &str) -> ProxyError {
    ProxyError::InvalidRequest(format!("invalid Anthropic {field}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_round_trip_keeps_thinking_signature_and_tools() {
        let body = json!({
            "model": "claude-sonnet-4-5",
            "system": "be terse",
            "messages": [
                {"role":"user","content":"read a.txt"},
                {"role":"assistant","content":[
                    {"type":"thinking","thinking":"need the file","signature":"sig-1"},
                    {"type":"tool_use","id":"call_1","name":"read","input":{"path":"a.txt"}}
                ]},
                {"role":"user","content":[
                    {"type":"tool_result","tool_use_id":"call_1","content":"file body"}
                ]}
            ],
            "tools": [{"name":"read","input_schema":{"type":"object","properties":{"path":{"type":"string"}}}}],
            "tool_choice": {"type":"tool","name":"read"},
            "max_tokens": 128,
            "thinking": {"type":"enabled","budget_tokens":1024}
        });
        let request = parse_request(body).unwrap();
        assert_eq!(request.model, "claude-sonnet-4-5");
        assert_eq!(request.system, vec!["be terse"]);
        assert_eq!(request.max_tokens, Some(128));
        assert_eq!(request.tool_choice, ToolChoice::Tool("read".into()));
        assert!(matches!(
            request.messages[1].blocks[0],
            Block::Thinking { ref signature, .. } if signature.as_deref() == Some("sig-1")
        ));

        let rebuilt = build_request(&request).unwrap();
        assert_eq!(rebuilt["messages"][1]["content"][0]["signature"], "sig-1");
        assert_eq!(rebuilt["messages"][2]["content"][0]["type"], "tool_result");
        assert_eq!(rebuilt["thinking"]["type"], "enabled");
    }

    #[test]
    fn response_round_trip_maps_usage_and_stop_reason() {
        let body = json!({
            "id": "msg_1",
            "type": "message",
            "role": "assistant",
            "model": "claude-sonnet-4-5",
            "content": [
                {"type":"text","text":"hello"},
                {"type":"tool_use","id":"call_1","name":"read","input":{"path":"a.txt"}}
            ],
            "stop_reason": "tool_use",
            "usage": {"input_tokens":10,"output_tokens":3,"cache_read_input_tokens":2}
        });
        let response = parse_response(body).unwrap();
        assert_eq!(response.stop_reason, StopReason::ToolUse);
        assert_eq!(response.usage.input_tokens, 10);
        assert_eq!(response.usage.cache_read_input_tokens, 2);
        let rebuilt = build_response(&response).unwrap();
        assert_eq!(rebuilt["stop_reason"], "tool_use");
        assert_eq!(rebuilt["content"][1]["type"], "tool_use");
        assert_eq!(rebuilt["usage"]["cache_read_input_tokens"], 2);
    }
}
