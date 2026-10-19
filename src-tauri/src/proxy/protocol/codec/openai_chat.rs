//! OpenAI Chat Completions ↔ 中性 IR。

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
    if let Some(messages) = object.get("messages").and_then(Value::as_array) {
        for message in messages {
            let role = message
                .get("role")
                .and_then(Value::as_str)
                .ok_or_else(|| invalid("messages.role"))?;
            match role {
                "system" | "developer" => {
                    collect_text(message.get("content"), &mut request.system)?;
                }
                "tool" => {
                    let tool_use_id = message
                        .get("tool_call_id")
                        .and_then(Value::as_str)
                        .filter(|id| !id.is_empty())
                        .ok_or_else(|| invalid("tool_call_id"))?;
                    let content = match message.get("content") {
                        Some(Value::String(text)) => Value::String(text.clone()),
                        Some(value) => value.clone(),
                        None => Value::Null,
                    };
                    request.messages.push(Message {
                        role: Role::User,
                        blocks: vec![Block::ToolResult {
                            tool_use_id: tool_use_id.to_string(),
                            name: None,
                            content,
                            is_error: false,
                        }],
                    });
                }
                "user" | "assistant" => {
                    let ir_role = if role == "assistant" {
                        Role::Assistant
                    } else {
                        Role::User
                    };
                    let mut blocks = parse_content(message.get("content"), &ir_role)?;
                    if let Some(calls) = message.get("tool_calls").and_then(Value::as_array) {
                        for call in calls {
                            let function = call
                                .get("function")
                                .and_then(Value::as_object)
                                .ok_or_else(|| invalid("tool_calls.function"))?;
                            let id = call
                                .get("id")
                                .and_then(Value::as_str)
                                .filter(|id| !id.is_empty())
                                .ok_or_else(|| invalid("tool_calls.id"))?;
                            let name = function
                                .get("name")
                                .and_then(Value::as_str)
                                .filter(|name| !name.is_empty())
                                .ok_or_else(|| invalid("tool_calls.name"))?;
                            let arguments = function
                                .get("arguments")
                                .and_then(Value::as_str)
                                .unwrap_or("{}");
                            let input = serde_json::from_str(arguments)
                                .unwrap_or_else(|_| json!({"input": arguments}));
                            blocks.push(Block::ToolUse {
                                id: id.to_string(),
                                name: name.to_string(),
                                input,
                                thought_signature: None,
                            });
                        }
                    }
                    if let Some(reasoning) =
                        message.get("reasoning_content").and_then(Value::as_str)
                    {
                        if !reasoning.is_empty() {
                            blocks.push(Block::Thinking {
                                text: reasoning.to_string(),
                                signature: None,
                            });
                        }
                    }
                    if !blocks.is_empty() {
                        request.messages.push(Message {
                            role: ir_role,
                            blocks,
                        });
                    }
                }
                _ => return Err(invalid("messages.role")),
            }
        }
    }
    if let Some(tools) = object.get("tools").and_then(Value::as_array) {
        for tool in tools {
            if tool.get("type").and_then(Value::as_str) != Some("function") {
                continue;
            }
            let function = tool
                .get("function")
                .and_then(Value::as_object)
                .ok_or_else(|| invalid("tools.function"))?;
            let Some(name) = function.get("name").and_then(Value::as_str) else {
                continue;
            };
            request.tools.push(Tool {
                name: name.to_string(),
                description: function
                    .get("description")
                    .and_then(Value::as_str)
                    .map(ToString::to_string),
                input_schema: function
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
                .pointer("/function/name")
                .and_then(Value::as_str)
                .map(|name| ToolChoice::Tool(name.to_string()))
                .unwrap_or(ToolChoice::Auto),
            _ => ToolChoice::Auto,
        },
        None => ToolChoice::Auto,
    };
    request.max_tokens = object
        .get("max_completion_tokens")
        .or_else(|| object.get("max_tokens"))
        .and_then(Value::as_u64);
    request.temperature = object.get("temperature").and_then(Value::as_f64);
    request.top_p = object.get("top_p").and_then(Value::as_f64);
    request.stream = object
        .get("stream")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    request.stop = match object.get("stop") {
        Some(Value::String(value)) => vec![value.clone()],
        Some(Value::Array(values)) => values
            .iter()
            .filter_map(Value::as_str)
            .map(ToString::to_string)
            .collect(),
        _ => Vec::new(),
    };
    request.reasoning_effort = object
        .get("reasoning_effort")
        .and_then(Value::as_str)
        .map(ToString::to_string);
    Ok(request)
}

pub(crate) fn build_request(request: &Request) -> Result<Value, ProxyError> {
    let mut messages = Vec::new();
    if !request.system.is_empty() {
        messages.push(json!({"role":"system","content":request.system.join("\n\n")}));
    }
    for message in &request.messages {
        if message
            .blocks
            .iter()
            .all(|block| matches!(block, Block::ToolResult { .. }))
        {
            for block in &message.blocks {
                if let Block::ToolResult {
                    tool_use_id,
                    content: result,
                    ..
                } = block
                {
                    messages.push(json!({
                        "role":"tool",
                        "tool_call_id": tool_use_id,
                        "content": match result {
                            Value::String(text) => text.clone(),
                            value => canonical_json_string(value)
                        }
                    }));
                }
            }
            continue;
        }
        let mut content = Vec::new();
        let mut tool_calls = Vec::new();
        let mut reasoning = String::new();
        for block in &message.blocks {
            match block {
                Block::Text(text) => content.push(json!({"type":"text","text":text})),
                Block::Image(ImageSource::Base64 { media_type, data }) => content.push(json!({
                    "type":"image_url",
                    "image_url":{"url":format!("data:{media_type};base64,{data}")}
                })),
                Block::Image(ImageSource::Url(url)) => content.push(json!({
                    "type":"image_url","image_url":{"url":url}
                })),
                Block::ToolUse {
                    id, name, input, ..
                } => tool_calls.push(json!({
                    "id": id,
                    "type": "function",
                    "function": {"name": name, "arguments": canonical_json_string(input)}
                })),
                Block::ToolResult { .. } => {}
                Block::Thinking { text, .. } => reasoning.push_str(text),
            }
        }
        let content = if content.len() == 1
            && content[0].get("type").and_then(Value::as_str) == Some("text")
        {
            content[0]["text"].clone()
        } else if content.is_empty() {
            Value::Null
        } else {
            Value::Array(content)
        };
        let mut value = json!({
            "role": match message.role { Role::User => "user", Role::Assistant => "assistant" },
            "content": content
        });
        if !tool_calls.is_empty() {
            value["tool_calls"] = json!(tool_calls);
        }
        if !reasoning.is_empty() {
            // Chat 的非标准扩展字段，OpenCode/Pi 系客户端会原样回传。
            value["reasoning_content"] = json!(reasoning);
        }
        messages.push(value);
    }

    let mut result = json!({
        "model": request.model.as_str(),
        "messages": messages,
    });
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
        result["stop"] = json!(request.stop.clone());
    }
    if !request.tools.is_empty() {
        result["tools"] = json!(request
            .tools
            .iter()
            .map(|tool| {
                let mut function = json!({
                    "name": tool.name.as_str(),
                    "parameters": tool.input_schema.clone(),
                });
                if let Some(description) = &tool.description {
                    function["description"] = json!(description);
                }
                json!({"type":"function","function":function})
            })
            .collect::<Vec<_>>());
    }
    if !request.tools.is_empty() {
        result["tool_choice"] = match &request.tool_choice {
            ToolChoice::Auto => json!("auto"),
            ToolChoice::Required => json!("required"),
            ToolChoice::None => json!("none"),
            ToolChoice::Tool(name) => json!({"type":"function","function":{"name":name}}),
        };
    }
    if let Some(effort) = &request.reasoning_effort {
        result["reasoning_effort"] = json!(effort);
    }
    Ok(result)
}

pub(crate) fn parse_response(body: Value) -> Result<Response, ProxyError> {
    let choice = body
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .ok_or_else(|| ProxyError::TransformError("Chat response has no choices".into()))?;
    let message = choice.get("message").cloned().unwrap_or(Value::Null);
    let mut response = Response::new(
        body.get("id").and_then(Value::as_str).unwrap_or_default(),
        body.get("model")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    );
    if let Some(content) = message.get("content").and_then(Value::as_str) {
        if !content.is_empty() {
            response.blocks.push(Block::Text(content.to_string()));
        }
    }
    if let Some(reasoning) = message.get("reasoning_content").and_then(Value::as_str) {
        if !reasoning.is_empty() {
            response.blocks.push(Block::Thinking {
                text: reasoning.to_string(),
                signature: None,
            });
        }
    }
    if let Some(calls) = message.get("tool_calls").and_then(Value::as_array) {
        for call in calls {
            let function = call.get("function").unwrap_or(&Value::Null);
            response.blocks.push(Block::ToolUse {
                id: call
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                name: function
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                input: function
                    .get("arguments")
                    .and_then(Value::as_str)
                    .and_then(|arguments| serde_json::from_str(arguments).ok())
                    .unwrap_or_else(|| json!({})),
                thought_signature: None,
            });
        }
    }
    response.stop_reason = match choice.get("finish_reason").and_then(Value::as_str) {
        Some("length") => StopReason::MaxTokens,
        Some("tool_calls") => StopReason::ToolUse,
        Some("content_filter") => StopReason::ContentFilter,
        Some("stop") | None => StopReason::EndTurn,
        Some(other) => StopReason::Other(other.to_string()),
    };
    response.usage = parse_usage(body.get("usage"));
    Ok(response)
}

pub(crate) fn build_response(response: &Response) -> Result<Value, ProxyError> {
    let mut text = String::new();
    let mut reasoning = String::new();
    let mut tool_calls = Vec::new();
    for block in &response.blocks {
        match block {
            Block::Text(value) => text.push_str(value),
            Block::Thinking { text: value, .. } => reasoning.push_str(value),
            Block::ToolUse {
                id, name, input, ..
            } => tool_calls.push(json!({
                "id": id,
                "type": "function",
                "function": {"name": name, "arguments": canonical_json_string(input)}
            })),
            _ => {}
        }
    }
    let mut message = json!({
        "role": "assistant",
        "content": if text.is_empty() { Value::Null } else { json!(text) }
    });
    if !tool_calls.is_empty() {
        message["tool_calls"] = json!(tool_calls);
    }
    if !reasoning.is_empty() {
        message["reasoning_content"] = json!(reasoning);
    }
    Ok(json!({
        "id": if response.id.is_empty() { "chatcmpl_phi" } else { response.id.as_str() },
        "object": "chat.completion",
        "created": 0,
        "model": response.model.as_str(),
        "choices": [{
            "index": 0,
            "message": message,
            "finish_reason": match response.stop_reason {
                StopReason::EndTurn => "stop",
                StopReason::MaxTokens => "length",
                StopReason::ToolUse => "tool_calls",
                StopReason::ContentFilter => "content_filter",
                StopReason::StopSequence => "stop",
                StopReason::Other(_) => "stop",
            }
        }],
        "usage": {
            "prompt_tokens": response.usage.input_tokens,
            "completion_tokens": response.usage.output_tokens,
            "total_tokens": response.usage.input_tokens + response.usage.output_tokens
        }
    }))
}

fn parse_content(value: Option<&Value>, role: &Role) -> Result<Vec<Block>, ProxyError> {
    let mut blocks = Vec::new();
    match value {
        Some(Value::String(text)) if !text.is_empty() => blocks.push(Block::Text(text.clone())),
        Some(Value::Array(parts)) => {
            for part in parts {
                match part.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        if let Some(text) = part.get("text").and_then(Value::as_str) {
                            if !text.is_empty() {
                                blocks.push(Block::Text(text.to_string()));
                            }
                        }
                    }
                    Some("image_url") if matches!(role, Role::User) => {
                        if let Some(block) = image_block(part) {
                            blocks.push(block);
                        }
                    }
                    _ => {}
                }
            }
        }
        Some(Value::Null) | None => {}
        _ => return Err(invalid("messages.content")),
    }
    Ok(blocks)
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
            .get("prompt_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        output_tokens: value
            .get("completion_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        cache_read_input_tokens: value
            .pointer("/prompt_tokens_details/cached_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        cache_creation_input_tokens: 0,
    }
}

fn collect_text(value: Option<&Value>, parts: &mut Vec<String>) -> Result<(), ProxyError> {
    match value {
        Some(Value::String(text)) if !text.trim().is_empty() => parts.push(text.clone()),
        Some(Value::Array(items)) => {
            for item in items {
                if let Some(text) = item.get("text").and_then(Value::as_str) {
                    if !text.trim().is_empty() {
                        parts.push(text.to_string());
                    }
                }
            }
        }
        Some(Value::Null) | None => {}
        _ => return Err(invalid("messages.content")),
    }
    Ok(())
}

fn invalid(field: &str) -> ProxyError {
    ProxyError::InvalidRequest(format!("invalid Chat {field}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_round_trip_maps_tools_and_images() {
        let body = json!({
            "model": "gpt-6.1-sol",
            "messages": [
                {"role":"system","content":"be terse"},
                {"role":"user","content":[
                    {"type":"text","text":"look"},
                    {"type":"image_url","image_url":{"url":"data:image/png;base64,AAAA"}}
                ]},
                {"role":"assistant","content":null,"tool_calls":[{
                    "id":"call_1","type":"function",
                    "function":{"name":"read","arguments":"{\"path\":\"a.txt\"}"}
                }]},
                {"role":"tool","tool_call_id":"call_1","content":"file body"}
            ],
            "tools":[{"type":"function","function":{"name":"read","parameters":{"type":"object"}}}],
            "max_tokens":64
        });
        let request = parse_request(body).unwrap();
        assert_eq!(request.system, vec!["be terse"]);
        assert_eq!(request.max_tokens, Some(64));
        assert!(matches!(request.messages[0].blocks[1], Block::Image(_)));
        assert!(matches!(
            request.messages[1].blocks[0],
            Block::ToolUse { .. }
        ));
        assert!(matches!(
            request.messages[2].blocks[0],
            Block::ToolResult { .. }
        ));

        let rebuilt = build_request(&request).unwrap();
        assert_eq!(rebuilt["messages"][0]["role"], "system");
        assert_eq!(rebuilt["messages"][1]["content"][1]["type"], "image_url");
        assert_eq!(rebuilt["messages"][2]["tool_calls"][0]["id"], "call_1");
        assert_eq!(rebuilt["messages"][3]["role"], "tool");
        assert_eq!(rebuilt["tools"][0]["function"]["name"], "read");
    }

    #[test]
    fn response_round_trip_maps_tools_and_usage() {
        let body = json!({
            "id": "chatcmpl_1",
            "object": "chat.completion",
            "model": "gpt-6.1-sol",
            "choices": [{
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": "hello",
                    "tool_calls": [{
                        "id": "call_1","type": "function",
                        "function": {"name": "read", "arguments": "{\"path\":\"a.txt\"}"}
                    }]
                },
                "finish_reason": "tool_calls"
            }],
            "usage": {"prompt_tokens":10,"completion_tokens":3,"total_tokens":13}
        });
        let response = parse_response(body).unwrap();
        assert_eq!(response.stop_reason, StopReason::ToolUse);
        assert_eq!(response.usage.input_tokens, 10);
        assert!(matches!(response.blocks[1], Block::ToolUse { .. }));
        let rebuilt = build_response(&response).unwrap();
        assert_eq!(rebuilt["choices"][0]["finish_reason"], "tool_calls");
        assert_eq!(rebuilt["choices"][0]["message"]["content"], "hello");
        assert_eq!(
            rebuilt["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
            "read"
        );
    }
}
