//! OpenAI Responses ↔ 中性 IR。
//!
//! 覆盖 Codex 常用的 Responses 形状：instructions、input 消息、
//! function_call / function_call_output、function tools、reasoning effort。

use serde_json::{json, Value};

use crate::proxy::error::ProxyError;
use crate::proxy::json_canonical::canonical_json_string;
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
    if let Some(instructions) = object.get("instructions").and_then(Value::as_str) {
        if !instructions.trim().is_empty() {
            request.system.push(instructions.to_string());
        }
    }
    match object.get("input") {
        Some(Value::String(text)) if !text.is_empty() => {
            request.messages.push(Message {
                role: Role::User,
                blocks: vec![Block::Text(text.clone())],
            });
        }
        Some(Value::Array(items)) => {
            for item in items {
                parse_input_item(item, &mut request)?;
            }
        }
        Some(Value::Null) | None => {}
        _ => return Err(invalid("input")),
    }
    if let Some(tools) = object.get("tools").and_then(Value::as_array) {
        for tool in tools {
            if tool.get("type").and_then(Value::as_str) != Some("function") {
                continue;
            }
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
                    .get("parameters")
                    .cloned()
                    .unwrap_or_else(|| json!({"type":"object","properties":{}})),
            });
        }
    }
    request.tool_choice = match object.get("tool_choice") {
        Some(Value::String(value)) => match value.as_str() {
            "required" => ToolChoice::Required,
            "none" => ToolChoice::None,
            _ => ToolChoice::Auto,
        },
        Some(value) => match value.get("type").and_then(Value::as_str) {
            Some("function") => value
                .get("name")
                .and_then(Value::as_str)
                .map(|name| ToolChoice::Tool(name.to_string()))
                .unwrap_or(ToolChoice::Auto),
            _ => ToolChoice::Auto,
        },
        None => ToolChoice::Auto,
    };
    request.max_tokens = object.get("max_output_tokens").and_then(Value::as_u64);
    request.temperature = object.get("temperature").and_then(Value::as_f64);
    request.top_p = object.get("top_p").and_then(Value::as_f64);
    request.stream = object
        .get("stream")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    request.reasoning_effort = object
        .get("reasoning")
        .and_then(|reasoning| reasoning.get("effort"))
        .and_then(Value::as_str)
        .map(ToString::to_string);
    Ok(request)
}

pub(crate) fn build_request(request: &Request) -> Result<Value, ProxyError> {
    let mut items = Vec::new();
    for message in &request.messages {
        match message.role {
            Role::User => {
                let content: Vec<Value> = message
                    .blocks
                    .iter()
                    .filter_map(|block| match block {
                        Block::Text(text) => Some(json!({"type":"input_text","text":text})),
                        Block::Image(ImageSource::Base64 { media_type, data }) => Some(json!({
                            "type":"input_image",
                            "image_url":format!("data:{media_type};base64,{data}")
                        })),
                        Block::Image(ImageSource::Url(url)) => {
                            Some(json!({"type":"input_image","image_url":url}))
                        }
                        _ => None,
                    })
                    .collect();
                if !content.is_empty() {
                    items.push(json!({"type":"message","role":"user","content":content}));
                }
                for block in &message.blocks {
                    if let Block::ToolResult {
                        tool_use_id,
                        content,
                        ..
                    } = block
                    {
                        items.push(json!({
                            "type":"function_call_output",
                            "call_id":tool_use_id,
                            "output":match content {
                                Value::String(text) => text.clone(),
                                value => canonical_json_string(value)
                            }
                        }));
                    }
                }
            }
            Role::Assistant => {
                let content: Vec<Value> = message
                    .blocks
                    .iter()
                    .filter_map(|block| match block {
                        Block::Text(text) => Some(json!({"type":"output_text","text":text})),
                        _ => None,
                    })
                    .collect();
                if !content.is_empty() {
                    items.push(json!({"type":"message","role":"assistant","content":content}));
                }
                for block in &message.blocks {
                    match block {
                        Block::ToolUse {
                            id, name, input, ..
                        } => items.push(json!({
                            "type":"function_call",
                            "call_id":id,
                            "name":name,
                            "arguments":canonical_json_string(input)
                        })),
                        Block::Thinking { text, signature } => {
                            let mut item = json!({
                                "type":"reasoning",
                                "summary":[{"type":"summary_text","text":text}]
                            });
                            if let Some(signature) = signature {
                                item["encrypted_content"] = json!(signature);
                            }
                            items.push(item);
                        }
                        _ => {}
                    }
                }
            }
        }
    }

    let mut result = json!({"model": request.model.as_str(), "input": items});
    if !request.system.is_empty() {
        result["instructions"] = json!(request.system.join("\n\n"));
    }
    if !request.tools.is_empty() {
        result["tools"] = json!(request
            .tools
            .iter()
            .map(|tool| {
                let mut value = json!({
                    "type":"function",
                    "name": tool.name.as_str(),
                    "parameters": tool.input_schema.clone(),
                });
                if let Some(description) = &tool.description {
                    value["description"] = json!(description);
                }
                value
            })
            .collect::<Vec<_>>());
        result["tool_choice"] = match &request.tool_choice {
            ToolChoice::Auto => json!("auto"),
            ToolChoice::Required => json!("required"),
            ToolChoice::None => json!("none"),
            ToolChoice::Tool(name) => json!({"type":"function","name":name}),
        };
    }
    if let Some(max_tokens) = request.max_tokens {
        result["max_output_tokens"] = json!(max_tokens);
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
    if let Some(effort) = &request.reasoning_effort {
        result["reasoning"] = json!({"effort":effort});
    }
    Ok(result)
}

pub(crate) fn parse_response(body: Value) -> Result<Response, ProxyError> {
    let mut response = Response::new(
        body.get("id").and_then(Value::as_str).unwrap_or_default(),
        body.get("model")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    );
    if let Some(output) = body.get("output").and_then(Value::as_array) {
        for item in output {
            match item.get("type").and_then(Value::as_str) {
                Some("message") => {
                    if let Some(content) = item.get("content").and_then(Value::as_array) {
                        for part in content {
                            if let Some(text) = part.get("text").and_then(Value::as_str) {
                                if !text.is_empty() {
                                    response.blocks.push(Block::Text(text.to_string()));
                                }
                            }
                        }
                    }
                }
                Some("function_call") => {
                    response.blocks.push(Block::ToolUse {
                        id: item
                            .get("call_id")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        name: item
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        input: item
                            .get("arguments")
                            .and_then(Value::as_str)
                            .and_then(|arguments| serde_json::from_str(arguments).ok())
                            .unwrap_or_else(|| json!({})),
                        thought_signature: None,
                    });
                }
                Some("reasoning") => {
                    let text = item
                        .pointer("/summary/0/text")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    response.blocks.push(Block::Thinking {
                        text,
                        signature: item
                            .get("encrypted_content")
                            .and_then(Value::as_str)
                            .map(ToString::to_string),
                    });
                }
                _ => {}
            }
        }
    }
    response.usage = parse_usage(body.get("usage"));
    response.stop_reason = match body
        .pointer("/incomplete_details/reason")
        .and_then(Value::as_str)
    {
        Some("max_output_tokens") => StopReason::MaxTokens,
        Some("content_filter") => StopReason::ContentFilter,
        _ if response
            .blocks
            .iter()
            .any(|block| matches!(block, Block::ToolUse { .. })) =>
        {
            StopReason::ToolUse
        }
        _ => StopReason::EndTurn,
    };
    Ok(response)
}

pub(crate) fn build_response(response: &Response) -> Result<Value, ProxyError> {
    let mut output = Vec::new();
    let mut text = String::new();
    for block in &response.blocks {
        match block {
            Block::Text(value) => text.push_str(value),
            Block::ToolUse {
                id, name, input, ..
            } => output.push(json!({
                "type":"function_call",
                "call_id":id,
                "name":name,
                "arguments":canonical_json_string(input)
            })),
            Block::Thinking { text, signature } => {
                let mut item = json!({
                    "type":"reasoning",
                    "summary":[{"type":"summary_text","text":text}]
                });
                if let Some(signature) = signature {
                    item["encrypted_content"] = json!(signature);
                }
                output.push(item);
            }
            _ => {}
        }
    }
    if !text.is_empty() {
        output.insert(
            0,
            json!({
                "type":"message",
                "role":"assistant",
                "content":[{"type":"output_text","text":text}]
            }),
        );
    }
    let status = match response.stop_reason {
        StopReason::MaxTokens | StopReason::ContentFilter => "incomplete",
        _ => "completed",
    };
    let mut result = json!({
        "id": response.id.as_str(),
        "object": "response",
        "status": status,
        "model": response.model.as_str(),
        "output": output,
        "usage": {
            "input_tokens": response.usage.input_tokens,
            "output_tokens": response.usage.output_tokens,
            "total_tokens": response.usage.input_tokens + response.usage.output_tokens,
            "input_tokens_details": {
                "cached_tokens": response.usage.cache_read_input_tokens
            }
        }
    });
    if response.stop_reason == StopReason::MaxTokens {
        result["incomplete_details"] = json!({"reason":"max_output_tokens"});
    }
    Ok(result)
}

fn parse_input_item(item: &Value, request: &mut Request) -> Result<(), ProxyError> {
    match item.get("type").and_then(Value::as_str) {
        Some("message") => {
            let role = match item.get("role").and_then(Value::as_str) {
                Some("assistant") => Role::Assistant,
                Some("system" | "developer") => {
                    if let Some(content) = item.get("content").and_then(Value::as_array) {
                        for part in content {
                            if let Some(text) = part.get("text").and_then(Value::as_str) {
                                if !text.trim().is_empty() {
                                    request.system.push(text.to_string());
                                }
                            }
                        }
                    }
                    return Ok(());
                }
                _ => Role::User,
            };
            let mut blocks = Vec::new();
            if let Some(Value::String(text)) = item.get("content") {
                if !text.is_empty() {
                    blocks.push(Block::Text(text.clone()));
                }
            } else if let Some(content) = item.get("content").and_then(Value::as_array) {
                for part in content {
                    match part.get("type").and_then(Value::as_str) {
                        Some("input_text" | "output_text") => {
                            if let Some(text) = part.get("text").and_then(Value::as_str) {
                                if !text.is_empty() {
                                    blocks.push(Block::Text(text.to_string()));
                                }
                            }
                        }
                        Some("input_image") => {
                            if let Some(block) = image_block(part) {
                                blocks.push(block);
                            }
                        }
                        _ => {}
                    }
                }
            }
            if !blocks.is_empty() {
                request.messages.push(Message { role, blocks });
            }
        }
        Some("function_call") => {
            request.messages.push(Message {
                role: Role::Assistant,
                blocks: vec![Block::ToolUse {
                    id: item
                        .get("call_id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    name: item
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    input: item
                        .get("arguments")
                        .and_then(Value::as_str)
                        .and_then(|arguments| serde_json::from_str(arguments).ok())
                        .unwrap_or_else(|| json!({})),
                    thought_signature: None,
                }],
            });
        }
        Some("function_call_output") => {
            request.messages.push(Message {
                role: Role::User,
                blocks: vec![Block::ToolResult {
                    tool_use_id: item
                        .get("call_id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    name: None,
                    content: item.get("output").cloned().unwrap_or(Value::Null),
                    is_error: false,
                }],
            });
        }
        Some("reasoning") => {
            request.messages.push(Message {
                role: Role::Assistant,
                blocks: vec![Block::Thinking {
                    text: item
                        .pointer("/summary/0/text")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    signature: item
                        .get("encrypted_content")
                        .and_then(Value::as_str)
                        .map(ToString::to_string),
                }],
            });
        }
        _ => {}
    }
    Ok(())
}

fn image_block(part: &Value) -> Option<Block> {
    let url = part.get("image_url").and_then(|value| {
        value.as_str().map(ToString::to_string).or_else(|| {
            value
                .get("url")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
    })?;
    if let Some(rest) = url.strip_prefix("data:") {
        let (meta, data) = rest.split_once(',')?;
        let media_type = meta.split(';').next().unwrap_or("image/png");
        Some(Block::Image(ImageSource::Base64 {
            media_type: media_type.to_string(),
            data: data.to_string(),
        }))
    } else if url.starts_with("http://") || url.starts_with("https://") {
        Some(Block::Image(ImageSource::Url(url)))
    } else {
        None
    }
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
            .pointer("/input_tokens_details/cached_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        cache_creation_input_tokens: 0,
    }
}

fn invalid(field: &str) -> ProxyError {
    ProxyError::InvalidRequest(format!("invalid Responses {field}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_round_trip_keeps_function_calls_and_tools() {
        let body = json!({
            "model":"gpt-6.1-sol",
            "instructions":"be terse",
            "input":[
                {"type":"message","role":"user","content":[{"type":"input_text","text":"read a.txt"}]},
                {"type":"function_call","call_id":"call_1","name":"read","arguments":"{\"path\":\"a.txt\"}"},
                {"type":"function_call_output","call_id":"call_1","output":"file body"},
                {"type":"reasoning","summary":[{"type":"summary_text","text":"need the file"}],"encrypted_content":"sig-1"}
            ],
            "tools":[{"type":"function","name":"read","parameters":{"type":"object"}}],
            "max_output_tokens":64,
            "reasoning":{"effort":"high"}
        });
        let request = parse_request(body).unwrap();
        assert_eq!(request.system, vec!["be terse"]);
        assert_eq!(request.max_tokens, Some(64));
        assert_eq!(request.reasoning_effort.as_deref(), Some("high"));
        assert!(matches!(
            request.messages[1].blocks[0],
            Block::ToolUse { .. }
        ));
        assert!(matches!(
            request.messages[2].blocks[0],
            Block::ToolResult { .. }
        ));
        assert!(
            matches!(request.messages[3].blocks[0], Block::Thinking { ref signature, .. } if signature.as_deref() == Some("sig-1"))
        );
        let rebuilt = build_request(&request).unwrap();
        assert_eq!(rebuilt["instructions"], "be terse");
        assert_eq!(rebuilt["input"][1]["type"], "function_call");
        assert_eq!(rebuilt["input"][2]["type"], "function_call_output");
        assert_eq!(rebuilt["tools"][0]["name"], "read");
        assert_eq!(rebuilt["reasoning"]["effort"], "high");
    }

    #[test]
    fn response_round_trip_maps_function_call_and_usage() {
        let body = json!({
            "id":"resp_1",
            "object":"response",
            "status":"completed",
            "model":"gpt-6.1-sol",
            "output":[
                {"type":"message","role":"assistant","content":[{"type":"output_text","text":"hello"}]},
                {"type":"function_call","call_id":"call_1","name":"read","arguments":"{\"path\":\"a.txt\"}"}
            ],
            "usage":{"input_tokens":10,"output_tokens":3,"total_tokens":13,"input_tokens_details":{"cached_tokens":2}}
        });
        let response = parse_response(body).unwrap();
        assert_eq!(response.stop_reason, StopReason::ToolUse);
        assert_eq!(response.usage.input_tokens, 10);
        assert_eq!(response.usage.cache_read_input_tokens, 2);
        let rebuilt = build_response(&response).unwrap();
        assert_eq!(rebuilt["status"], "completed");
        assert_eq!(rebuilt["output"][0]["content"][0]["text"], "hello");
        assert_eq!(rebuilt["output"][1]["type"], "function_call");
        assert_eq!(rebuilt["usage"]["input_tokens_details"]["cached_tokens"], 2);
    }
}
