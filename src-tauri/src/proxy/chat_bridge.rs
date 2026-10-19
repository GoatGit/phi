//! Generic Chat clients use the established Responses forwarding paths. The
//! adapter is explicit in both directions; unsupported fields fail before routing.
use super::{server::ProxyState, ProxyError};
use axum::{
    body::Body,
    extract::{Request, State},
    response::Response,
};
use futures::StreamExt;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

fn invalid(field: &str) -> ProxyError {
    ProxyError::InvalidRequest(format!("Unsupported or invalid Chat field: {field}"))
}
fn fields(value: &Value, allowed: &[&str], field: &str) -> Result<(), ProxyError> {
    let object = value.as_object().ok_or_else(|| invalid(field))?;
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(invalid(field));
    }
    Ok(())
}
pub(crate) fn request_to_responses(body: &Value) -> Result<Value, ProxyError> {
    let object = body.as_object().ok_or_else(|| invalid("body"))?;
    for key in object.keys() {
        if !matches!(
            key.as_str(),
            "model"
                | "messages"
                | "stream"
                | "stream_options"
                | "tools"
                | "tool_choice"
                | "parallel_tool_calls"
                | "max_tokens"
                | "max_completion_tokens"
                | "temperature"
                | "top_p"
                | "reasoning_effort"
                | "response_format"
                | "metadata"
                | "store"
                | "user"
                | "n"
        ) {
            return Err(invalid(key));
        }
    }
    let model = body["model"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| invalid("model"))?;
    if body.get("n").is_some_and(|v| v.as_u64() != Some(1)) {
        return Err(invalid("n (only 1 is supported)"));
    }
    if body.get("stream").is_some_and(|v| !v.is_boolean()) {
        return Err(invalid("stream"));
    }
    if let Some(options) = body.get("stream_options") {
        let options = options
            .as_object()
            .ok_or_else(|| invalid("stream_options"))?;
        if options
            .iter()
            .any(|(key, v)| key != "include_usage" || !v.is_boolean())
        {
            return Err(invalid("stream_options"));
        }
    }
    let messages = body["messages"]
        .as_array()
        .filter(|m| !m.is_empty())
        .ok_or_else(|| invalid("messages"))?;
    let mut input = vec![];
    for message in messages {
        fields(
            message,
            &["role", "content", "tool_calls", "tool_call_id"],
            "messages",
        )?;
        let role = message["role"]
            .as_str()
            .ok_or_else(|| invalid("messages.role"))?;
        if role == "tool" {
            if message.get("tool_calls").is_some() {
                return Err(invalid("tool.tool_calls"));
            }
            let id = message["tool_call_id"]
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or_else(|| invalid("tool_call_id"))?;
            let text = message["content"]
                .as_str()
                .ok_or_else(|| invalid("tool.content"))?;
            input.push(json!({"type":"function_call_output","call_id":id,"output":text}));
            continue;
        }
        if !matches!(role, "system" | "developer" | "user" | "assistant") {
            return Err(invalid("messages.role"));
        }
        if message.get("tool_call_id").is_some() {
            return Err(invalid("messages.tool_call_id"));
        }
        let mut content = vec![];
        let text_type = if role == "assistant" {
            "output_text"
        } else {
            "input_text"
        };
        match &message["content"] {
            Value::String(text) => content.push(json!({"type":text_type,"text":text})),
            Value::Array(parts) => {
                for part in parts {
                    fields(part, &["type", "text", "image_url"], "messages.content")?;
                    match part["type"].as_str() {
                        Some("text") => {
                            fields(part, &["type", "text"], "content.text")?;
                            content.push(json!({"type":text_type,"text":part["text"].as_str().ok_or_else(||invalid("content.text"))?}));
                        }
                        Some("image_url") if role == "user" => {
                            fields(part, &["type", "image_url"], "content.image_url")?;
                            let image = &part["image_url"];
                            fields(image, &["url", "detail"], "image_url")?;
                            let url = image["url"]
                                .as_str()
                                .ok_or_else(|| invalid("image_url.url"))?;
                            if url.is_empty()
                                || image.get("detail").is_some_and(|d| {
                                    !matches!(d.as_str(), Some("auto" | "low" | "high"))
                                })
                            {
                                return Err(invalid("image_url"));
                            }
                            content.push(json!({"type":"input_image","image_url":url,"detail":image.get("detail").cloned().unwrap_or(json!("auto"))}));
                        }
                        _ => return Err(invalid("messages.content.type")),
                    }
                }
            }
            Value::Null if role == "assistant" && message["tool_calls"].is_array() => {}
            _ => return Err(invalid("messages.content")),
        }
        if !content.is_empty() {
            input.push(json!({"type":"message","role":role,"content":content}));
        }
        if let Some(calls) = message.get("tool_calls") {
            if role != "assistant" {
                return Err(invalid("tool_calls role"));
            }
            for call in calls.as_array().ok_or_else(|| invalid("tool_calls"))? {
                fields(call, &["id", "type", "function"], "tool_calls")?;
                if call["type"] != "function" {
                    return Err(invalid("tool_calls.type"));
                }
                let function = &call["function"];
                fields(function, &["name", "arguments"], "tool_calls.function")?;
                input.push(json!({"type":"function_call","call_id":call["id"].as_str().filter(|s|!s.is_empty()).ok_or_else(||invalid("tool_calls.id"))?,"name":function["name"].as_str().filter(|s|!s.is_empty()).ok_or_else(||invalid("tool_calls.name"))?,"arguments":function["arguments"].as_str().ok_or_else(||invalid("tool_calls.arguments"))?}));
            }
        }
    }
    let mut output =
        json!({"model":model,"input":input,"stream":body["stream"].as_bool().unwrap_or(false)});
    for (field, max) in [("temperature", 2.0), ("top_p", 1.0)] {
        if body
            .get(field)
            .is_some_and(|v| v.as_f64().is_none_or(|n| !(0.0..=max).contains(&n)))
        {
            return Err(invalid(field));
        }
    }
    for field in ["parallel_tool_calls", "store"] {
        if body.get(field).is_some_and(|v| !v.is_boolean()) {
            return Err(invalid(field));
        }
    }
    if body.get("user").is_some_and(|v| !v.is_string()) {
        return Err(invalid("user"));
    }
    if body.get("metadata").is_some_and(|v| {
        v.as_object().is_none_or(|m| {
            m.len() > 16
                || m.iter()
                    .any(|(k, v)| k.len() > 64 || v.as_str().is_none_or(|s| s.len() > 512))
        })
    }) {
        return Err(invalid("metadata"));
    }
    if body
        .get("max_tokens")
        .zip(body.get("max_completion_tokens"))
        .is_some_and(|(a, b)| a != b)
    {
        return Err(invalid("conflicting token limits"));
    }
    for key in [
        "temperature",
        "top_p",
        "parallel_tool_calls",
        "metadata",
        "store",
    ] {
        if let Some(v) = body.get(key) {
            output[key] = v.clone();
        }
    }
    if let Some(v) = body.get("user") {
        output["safety_identifier"] = v.clone();
    }
    if let Some(limit) = body
        .get("max_completion_tokens")
        .or_else(|| body.get("max_tokens"))
    {
        if limit.as_u64().is_none_or(|v| v == 0) {
            return Err(invalid("max_tokens"));
        }
        output["max_output_tokens"] = limit.clone();
    }
    if let Some(effort) = body.get("reasoning_effort") {
        if !matches!(
            effort.as_str(),
            Some("none" | "minimal" | "low" | "medium" | "high" | "xhigh")
        ) {
            return Err(invalid("reasoning_effort"));
        }
        output["reasoning"] = json!({"effort":effort});
    }
    if let Some(tools) = body.get("tools") {
        let mut converted = vec![];
        for tool in tools.as_array().ok_or_else(|| invalid("tools"))? {
            fields(tool, &["type", "function"], "tools")?;
            if tool["type"] != "function" {
                return Err(invalid("tools.type"));
            }
            let mut function = tool["function"]
                .as_object()
                .cloned()
                .ok_or_else(|| invalid("tools.function"))?;
            fields(
                &tool["function"],
                &["name", "description", "parameters", "strict"],
                "tools.function",
            )?;
            if function.get("description").is_some_and(|v| !v.is_string())
                || function.get("parameters").is_some_and(|v| !v.is_object())
                || function.get("strict").is_some_and(|v| !v.is_boolean())
            {
                return Err(invalid("tools.function"));
            }
            if function
                .get("name")
                .and_then(Value::as_str)
                .is_none_or(str::is_empty)
            {
                return Err(invalid("tools.function.name"));
            }
            function.insert("type".into(), json!("function"));
            converted.push(Value::Object(function));
        }
        output["tools"] = json!(converted);
    }
    if let Some(choice) = body.get("tool_choice") {
        output["tool_choice"] = if choice.is_string() {
            if !matches!(choice.as_str(), Some("none" | "auto" | "required")) {
                return Err(invalid("tool_choice"));
            }
            choice.clone()
        } else if choice["type"] == "function" {
            fields(choice, &["type", "function"], "tool_choice")?;
            fields(&choice["function"], &["name"], "tool_choice.function")?;
            json!({"type":"function","name":choice["function"]["name"].as_str().ok_or_else(||invalid("tool_choice.name"))?})
        } else {
            return Err(invalid("tool_choice"));
        };
    }
    if let Some(format) = body.get("response_format") {
        fields(format, &["type", "json_schema"], "response_format")?;
        if format["type"] == "json_schema" {
            let schema = &format["json_schema"];
            fields(
                schema,
                &["name", "schema", "description", "strict"],
                "response_format.json_schema",
            )?;
            if schema["name"].as_str().is_none_or(str::is_empty)
                || !schema["schema"].is_object()
                || schema.get("strict").is_some_and(|v| !v.is_boolean())
                || schema.get("description").is_some_and(|v| !v.is_string())
            {
                return Err(invalid("response_format.json_schema"));
            }
        } else if format.get("json_schema").is_some() {
            return Err(invalid("response_format"));
        }
        output["text"] = json!({"format":match format["type"].as_str() {
            Some("text"|"json_object")=>format.clone(),
            Some("json_schema")=>{let mut schema=format["json_schema"].as_object().cloned().ok_or_else(||invalid("response_format.json_schema"))?;schema.insert("type".into(),json!("json_schema"));Value::Object(schema)},
            _=>return Err(invalid("response_format")),
        }});
    }
    Ok(output)
}

fn usage(response: &Value) -> Value {
    let Some(u) = response.get("usage").filter(|v| v.is_object()) else {
        return Value::Null;
    };
    let mut result = json!({"prompt_tokens":u["input_tokens"],"completion_tokens":u["output_tokens"],"total_tokens":u["total_tokens"]});
    if let Some(details) = u.get("input_tokens_details") {
        result["prompt_tokens_details"] = details.clone();
    }
    if let Some(details) = u.get("output_tokens_details") {
        result["completion_tokens_details"] = details.clone();
    }
    result
}
fn finish(response: &Value, tools: bool) -> &'static str {
    if response
        .pointer("/incomplete_details/reason")
        .and_then(Value::as_str)
        == Some("content_filter")
    {
        "content_filter"
    } else if response["status"] == "incomplete" {
        "length"
    } else if tools {
        "tool_calls"
    } else {
        "stop"
    }
}
fn validate_output(value: &Value) -> Result<(), ProxyError> {
    let malformed = || {
        ProxyError::TransformError(
            "Unsupported or malformed Responses output for Chat client".into(),
        )
    };
    let items = value["output"].as_array().ok_or_else(malformed)?;
    if items.len() > 1024 {
        return Err(malformed());
    }
    for item in items {
        match item["type"].as_str() {
            Some("message") => {
                for part in item["content"].as_array().ok_or_else(malformed)? {
                    let field = match part["type"].as_str() {
                        Some("output_text") => "text",
                        Some("refusal") => "refusal",
                        _ => return Err(malformed()),
                    };
                    if !part[field].is_string() {
                        return Err(malformed());
                    }
                }
            }
            Some("function_call") => {
                for field in ["call_id", "name"] {
                    if item[field].as_str().is_none_or(str::is_empty) {
                        return Err(malformed());
                    }
                }
                if !item["arguments"].is_string() {
                    return Err(malformed());
                }
            }
            Some("reasoning") => {}
            _ => return Err(malformed()),
        }
    }
    Ok(())
}
pub(crate) fn response_to_chat(value: &Value) -> Result<Value, ProxyError> {
    if value.get("error").is_some_and(|v| !v.is_null()) {
        return Ok(json!({"error":value["error"]}));
    }
    validate_output(value)?;
    let output = value["output"]
        .as_array()
        .ok_or_else(|| ProxyError::TransformError("Missing Responses output".into()))?;
    let mut text = String::new();
    let mut refusal = String::new();
    let mut tools = vec![];
    for item in output {
        match item["type"].as_str() {
            Some("message")=>for part in item["content"].as_array().into_iter().flatten(){
                if let Some(part)=part["text"].as_str(){text.push_str(part);}
                if let Some(part)=part["refusal"].as_str(){refusal.push_str(part);}
            },
            Some("function_call")=>tools.push(json!({"id":item["call_id"],"type":"function","function":{"name":item["name"],"arguments":item["arguments"]}})),
            Some("reasoning")=>{},
            _=>return Err(ProxyError::TransformError("Unsupported Responses output item for Chat client".into())),
        }
    }
    let mut message =
        json!({"role":"assistant","content":if text.is_empty(){Value::Null}else{json!(text)}});
    if !tools.is_empty() {
        message["tool_calls"] = json!(tools);
    }
    if !refusal.is_empty() {
        message["refusal"] = json!(refusal);
    }
    Ok(
        json!({"id":value["id"],"object":"chat.completion","created":value["created_at"],"model":value["model"],"choices":[{"index":0,"message":message,"finish_reason":finish(value,!tools.is_empty())}],"usage":usage(value)}),
    )
}

/// Chat 顶层字段白名单。与 `request_to_responses` 接受的范围一致。
const CHAT_FIELDS: [&str; 17] = [
    "model",
    "messages",
    "stream",
    "stream_options",
    "tools",
    "tool_choice",
    "parallel_tool_calls",
    "max_tokens",
    "max_completion_tokens",
    "temperature",
    "top_p",
    "reasoning_effort",
    "response_format",
    "metadata",
    "store",
    "user",
    "n",
];

fn chat_text(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// 把一条 Chat 消息的 content 归一成 `request_to_responses` 接受的形状。
fn chat_content(role: &str, content: Option<&Value>) -> Option<Value> {
    match content {
        Some(Value::String(text)) => Some(json!(text)),
        Some(Value::Array(parts)) => {
            let mut kept = vec![];
            for part in parts {
                match part.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        if let Some(text) = chat_text(part.get("text")) {
                            kept.push(json!({"type":"text","text":text}));
                        }
                    }
                    Some("image_url") if role == "user" => {
                        let image = part.get("image_url");
                        let Some(url) = chat_text(image.and_then(|i| i.get("url"))) else {
                            continue;
                        };
                        let detail = image
                            .and_then(|i| i.get("detail"))
                            .and_then(Value::as_str)
                            .filter(|detail| matches!(*detail, "auto" | "low" | "high"))
                            .unwrap_or("auto");
                        kept.push(
                            json!({"type":"image_url","image_url":{"url":url,"detail":detail}}),
                        );
                    }
                    _ => {}
                }
            }
            (!kept.is_empty()).then(|| Value::Array(kept))
        }
        _ => None,
    }
}

/// 工具结果的文本：非字符串内容（多段文字或结构化结果）展开成字符串。
fn chat_tool_output(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => {
            let joined = parts
                .iter()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n");
            if joined.is_empty() {
                Value::Array(parts.clone()).to_string()
            } else {
                joined
            }
        }
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

fn chat_arguments(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) | None => "{}".into(),
        Some(other) => other.to_string(),
    }
}

/// 真实客户端的 Chat 请求可能带网关不认识的字段。这里把它们收敛成
/// `request_to_responses` 能接受的形状：能表达的保留，表达不了的具体字段丢弃
/// （而不是让整次路由请求以 400 失败）。
fn normalize_chat_request(body: &Value) -> Value {
    let mut out = Map::new();
    let source = body.as_object();
    if let Some(model) = chat_text(body.get("model")) {
        out.insert("model".into(), json!(model));
    }
    out.insert(
        "stream".into(),
        json!(body.get("stream").and_then(Value::as_bool).unwrap_or(false)),
    );
    if let Some(include_usage) = body
        .pointer("/stream_options/include_usage")
        .and_then(Value::as_bool)
    {
        out.insert(
            "stream_options".into(),
            json!({"include_usage": include_usage}),
        );
    }
    if let Some(messages) = body.get("messages").and_then(Value::as_array) {
        let mut kept = vec![];
        for message in messages {
            let Some(role) = message.get("role").and_then(Value::as_str) else {
                continue;
            };
            if role == "tool" {
                let Some(call_id) = chat_text(message.get("tool_call_id")) else {
                    continue;
                };
                kept.push(json!({
                    "role": "tool",
                    "tool_call_id": call_id,
                    "content": chat_tool_output(message.get("content")),
                }));
                continue;
            }
            if !matches!(role, "system" | "developer" | "user" | "assistant") {
                continue;
            }
            let mut row = Map::new();
            row.insert("role".into(), json!(role));
            let content = chat_content(role, message.get("content"));
            let calls = message
                .get("tool_calls")
                .and_then(Value::as_array)
                .map(|calls| {
                    calls
                        .iter()
                        .filter_map(|call| {
                            if call.get("type").and_then(Value::as_str) != Some("function") {
                                return None;
                            }
                            let function = call.get("function")?;
                            let name = chat_text(function.get("name"))?;
                            Some(json!({
                                "id": chat_text(call.get("id")).unwrap_or_default(),
                                "type": "function",
                                "function": {
                                    "name": name,
                                    "arguments": chat_arguments(function.get("arguments")),
                                },
                            }))
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let has_calls = role == "assistant" && !calls.is_empty();
            match content {
                Some(content) => row.insert("content".into(), content),
                // 只有带 tool_calls 的 assistant 允许 content 为 null。
                None if has_calls => row.insert("content".into(), Value::Null),
                None => row.insert("content".into(), json!("")),
            };
            if has_calls {
                row.insert("tool_calls".into(), Value::Array(calls));
            }
            kept.push(Value::Object(row));
        }
        out.insert("messages".into(), Value::Array(kept));
    }
    if let Some(tools) = body.get("tools").and_then(Value::as_array) {
        let mut kept = vec![];
        for tool in tools {
            let Some(function) = tool.get("function") else {
                continue;
            };
            let Some(name) = chat_text(function.get("name")) else {
                continue;
            };
            let mut row = Map::new();
            row.insert("type".into(), json!("function"));
            let mut native = Map::new();
            native.insert("name".into(), json!(name));
            if let Some(description) = function.get("description").and_then(Value::as_str) {
                native.insert("description".into(), json!(description));
            }
            let parameters = function
                .get("parameters")
                .filter(|value| value.is_object())
                .cloned()
                .unwrap_or_else(|| json!({"type":"object","properties":{}}));
            native.insert("parameters".into(), parameters);
            if let Some(strict) = function.get("strict").and_then(Value::as_bool) {
                native.insert("strict".into(), json!(strict));
            }
            row.insert("function".into(), Value::Object(native));
            kept.push(Value::Object(row));
        }
        // 空工具列表对上游没有意义（有的会因此拒收 tool_choice），整段不发。
        if !kept.is_empty() {
            out.insert("tools".into(), Value::Array(kept));
        }
    }
    // 没有可用的工具时 tool_choice 也没有意义。
    if out.contains_key("tools") {
        if let Some(choice) = body.get("tool_choice") {
            let normalized = match choice {
                Value::String(option)
                    if matches!(option.as_str(), "none" | "auto" | "required") =>
                {
                    Some(choice.clone())
                }
                Value::Object(_)
                    if choice.get("type").and_then(Value::as_str) == Some("function") =>
                {
                    chat_text(choice.pointer("/function/name"))
                        .map(|name| json!({"type":"function","function":{"name":name}}))
                }
                _ => None,
            };
            if let Some(normalized) = normalized {
                out.insert("tool_choice".into(), normalized);
            }
        }
    }
    if let Some(format) = body.get("response_format") {
        let normalized = match format.get("type").and_then(Value::as_str) {
            Some(kind @ ("text" | "json_object")) => Some(json!({"type": kind})),
            Some("json_schema") => format.get("json_schema").and_then(|schema| {
                let name = chat_text(schema.get("name"))?;
                let body = schema.get("schema").filter(|value| value.is_object())?;
                let mut row = Map::new();
                row.insert("name".into(), json!(name));
                row.insert("schema".into(), body.clone());
                if let Some(text) = schema.get("description").and_then(Value::as_str) {
                    row.insert("description".into(), json!(text));
                }
                if let Some(strict) = schema.get("strict").and_then(Value::as_bool) {
                    row.insert("strict".into(), json!(strict));
                }
                Some(json!({"type":"json_schema","json_schema":Value::Object(row)}))
            }),
            _ => None,
        };
        if let Some(normalized) = normalized {
            out.insert("response_format".into(), normalized);
        }
    }
    if let Some(effort) = body.get("reasoning_effort").and_then(Value::as_str) {
        if matches!(
            effort,
            "none" | "minimal" | "low" | "medium" | "high" | "xhigh"
        ) {
            out.insert("reasoning_effort".into(), json!(effort));
        }
    }
    for (field, max) in [("temperature", 2.0), ("top_p", 1.0)] {
        if let Some(value) = body.get(field).and_then(Value::as_f64) {
            if (0.0..=max).contains(&value) {
                out.insert(field.into(), json!(value));
            }
        }
    }
    for field in ["parallel_tool_calls", "store"] {
        if let Some(value) = body.get(field).and_then(Value::as_bool) {
            out.insert(field.into(), json!(value));
        }
    }
    let limit = body
        .get("max_completion_tokens")
        .or_else(|| body.get("max_tokens"))
        .and_then(Value::as_u64)
        .filter(|value| *value > 0);
    if let Some(limit) = limit {
        out.insert("max_completion_tokens".into(), json!(limit));
    }
    if body.get("n").and_then(Value::as_u64) == Some(1) {
        out.insert("n".into(), json!(1));
    }
    if let Some(user) = body.get("user").and_then(Value::as_str) {
        out.insert("user".into(), json!(user));
    }
    if let Some(metadata) = body.get("metadata").and_then(Value::as_object) {
        let kept = metadata
            .iter()
            .filter(|(key, value)| {
                key.len() <= 64 && value.as_str().is_some_and(|value| value.len() <= 512)
            })
            .take(16)
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect::<Map<String, Value>>();
        out.insert("metadata".into(), Value::Object(kept));
    }
    if let Some(source) = source {
        let dropped = source
            .keys()
            .filter(|key| !CHAT_FIELDS.contains(&key.as_str()))
            .collect::<Vec<_>>();
        if !dropped.is_empty() {
            log::debug!("[ChatBridge] Dropped Chat fields without a Responses shape: {dropped:?}");
        }
    }
    Value::Object(out)
}

/// Chat → Responses，用于真实客户端（OpenCode / Pi 等）：先归一化再走严格转换器。
pub(crate) fn gateway_request_to_responses(body: &Value) -> Result<Value, ProxyError> {
    request_to_responses(&normalize_chat_request(body))
}

struct StreamBridge {
    id: String,
    model: String,
    created: i64,
    tools: BTreeMap<u64, (usize, String, String, String)>,
    texts: BTreeMap<(u64, u64), String>,
    refusals: BTreeMap<(u64, u64), String>,
    done: bool,
    include_usage: bool,
    retained_bytes: usize,
    reporter: Option<super::ledger_observer::UsageReporter>,
    /// 网关请求的轨迹：回包里的 usage 同时写进去，客户端没要 usage 时
    /// 路由页的 token 统计仍然完整。
    trace: Option<super::gateway_observer::Trace>,
}
fn reserve(
    total: &mut usize,
    present: usize,
    added: usize,
    slot_limit: usize,
) -> Result<(), ProxyError> {
    if present.saturating_add(added) > slot_limit || total.saturating_add(added) > 16 * 1024 * 1024
    {
        return Err(ProxyError::TransformError(
            "Responses stream content exceeds limit".into(),
        ));
    }
    *total += added;
    Ok(())
}
impl StreamBridge {
    fn chunk(&self, delta: Value, reason: Option<&str>) -> Value {
        json!({"id":self.id,"object":"chat.completion.chunk","created":self.created,"model":self.model,"choices":[{"index":0,"delta":delta,"finish_reason":reason}]})
    }
    fn tool_item(&mut self, index: u64, item: &Value) -> Result<Vec<Value>, ProxyError> {
        let arguments = item["arguments"].as_str().unwrap_or_default();
        let next = self.tools.len();
        if let Some((tool_index, seen, id, name)) = self.tools.get_mut(&index) {
            if item["call_id"].as_str() != Some(id.as_str())
                || item["name"].as_str() != Some(name.as_str())
            {
                return Err(invalid("stream.tool_identity_changed"));
            }
            let suffix = arguments
                .strip_prefix(seen.as_str())
                .ok_or_else(|| invalid("stream.tool_arguments_changed"))?
                .to_string();
            reserve(
                &mut self.retained_bytes,
                seen.len(),
                suffix.len(),
                2 * 1024 * 1024,
            )?;
            seen.push_str(&suffix);
            let tool_index = *tool_index;
            if suffix.is_empty() {
                return Ok(vec![]);
            }
            return Ok(vec![self.chunk(
                json!({"tool_calls":[{"index":tool_index,"function":{"arguments":suffix}}]}),
                None,
            )]);
        }
        let id = item["call_id"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| invalid("stream.tool_call_id"))?;
        let name = item["name"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| invalid("stream.tool_name"))?;
        if self.tools.len() >= 128 {
            return Err(invalid("stream.tool_limit"));
        }
        reserve(
            &mut self.retained_bytes,
            0,
            arguments.len(),
            2 * 1024 * 1024,
        )?;
        self.tools
            .insert(index, (next, arguments.into(), id.into(), name.into()));
        Ok(vec![self.chunk(json!({"tool_calls":[{"index":next,"id":id,"type":"function","function":{"name":name,"arguments":arguments}}]}),None)])
    }
    fn event(&mut self, value: Value) -> Result<Vec<Value>, ProxyError> {
        let mut chunks = vec![];
        match value["type"].as_str().unwrap_or_default() {
            "response.created" => {
                if let Some(id) = value["response"]["id"].as_str() {
                    self.id = id.into();
                }
                if let Some(model) = value["response"]["model"].as_str() {
                    self.model = model.into();
                }
                chunks.push(self.chunk(json!({"role":"assistant"}), None));
            }
            "response.output_text.delta" | "response.refusal.delta" => {
                let key = (
                    value["output_index"].as_u64().unwrap_or(0),
                    value["content_index"].as_u64().unwrap_or(0),
                );
                let delta = value["delta"]
                    .as_str()
                    .ok_or_else(|| invalid("stream.delta"))?;
                let refusal = value["type"] == "response.refusal.delta";
                let map = if refusal {
                    &mut self.refusals
                } else {
                    &mut self.texts
                };
                if map.len() >= 1024 && !map.contains_key(&key) {
                    return Err(invalid("stream.content_count"));
                }
                let seen = map.entry(key).or_default();
                reserve(
                    &mut self.retained_bytes,
                    seen.len(),
                    delta.len(),
                    16 * 1024 * 1024,
                )?;
                seen.push_str(delta);
                chunks.push(self.chunk(
                    if refusal {
                        json!({"refusal":delta})
                    } else {
                        json!({"content":delta})
                    },
                    None,
                ));
            }
            "response.output_item.added" | "response.output_item.done"
                if value["item"]["type"] == "function_call" =>
            {
                let index = value["output_index"]
                    .as_u64()
                    .ok_or_else(|| invalid("stream.output_index"))?;
                chunks.extend(self.tool_item(index, &value["item"])?);
            }
            "response.function_call_arguments.delta" => {
                let index = value["output_index"]
                    .as_u64()
                    .ok_or_else(|| invalid("stream.output_index"))?;
                let delta = value["delta"]
                    .as_str()
                    .ok_or_else(|| invalid("stream.arguments"))?;
                let (tool_index, seen, _, _) = self
                    .tools
                    .get_mut(&index)
                    .ok_or_else(|| invalid("stream.tool_before_item"))?;
                reserve(
                    &mut self.retained_bytes,
                    seen.len(),
                    delta.len(),
                    2 * 1024 * 1024,
                )?;
                seen.push_str(delta);
                let tool_index = *tool_index;
                chunks.push(self.chunk(
                    json!({"tool_calls":[{"index":tool_index,"function":{"arguments":delta}}]}),
                    None,
                ));
            }
            "response.function_call_arguments.done" => {
                let index = value["output_index"]
                    .as_u64()
                    .ok_or_else(|| invalid("stream.output_index"))?;
                if let Some((tool_index, seen, _, _)) = self.tools.get_mut(&index) {
                    let arguments = value["arguments"]
                        .as_str()
                        .ok_or_else(|| invalid("stream.arguments"))?;
                    let suffix = arguments
                        .strip_prefix(seen.as_str())
                        .ok_or_else(|| invalid("stream.tool_arguments_changed"))?
                        .to_string();
                    reserve(
                        &mut self.retained_bytes,
                        seen.len(),
                        suffix.len(),
                        2 * 1024 * 1024,
                    )?;
                    seen.push_str(&suffix);
                    let tool_index = *tool_index;
                    if !suffix.is_empty() {
                        chunks.push(self.chunk(json!({"tool_calls":[{"index":tool_index,"function":{"arguments":suffix}}]}),None));
                    }
                } else {
                    return Err(invalid("stream.tool_before_item"));
                }
            }
            "response.completed" | "response.incomplete" => {
                let response = &value["response"];
                // Settle authoritative usage even if output validation fails afterwards.
                if let Some(tokens) =
                    super::usage::parser::TokenUsage::from_codex_response_auto(response)
                {
                    if let Some(reporter) = &self.reporter {
                        reporter.report(
                            tokens.clone(),
                            if response["status"] == "incomplete" {
                                "interrupted"
                            } else {
                                "completed"
                            },
                        )?;
                    }
                    if let Some(trace) = &self.trace {
                        if let Ok(mut trace) = trace.lock() {
                            trace.input_tokens = Some(tokens.input_tokens);
                            trace.output_tokens = Some(tokens.output_tokens);
                        }
                    }
                }
                validate_output(response)?;
                for (index, item) in response["output"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .enumerate()
                {
                    if item["type"] == "function_call" {
                        chunks.extend(self.tool_item(index as u64, item)?);
                    } else if item["type"] == "message" {
                        for (part_index, part) in
                            item["content"].as_array().into_iter().flatten().enumerate()
                        {
                            let refusal = part["type"] == "refusal";
                            let text = part[if refusal { "refusal" } else { "text" }]
                                .as_str()
                                .unwrap_or_default();
                            let seen = if refusal { &self.refusals } else { &self.texts }
                                .get(&(index as u64, part_index as u64))
                                .map(String::as_str)
                                .unwrap_or_default();
                            let suffix = text
                                .strip_prefix(seen)
                                .ok_or_else(|| invalid("stream.content_changed"))?;
                            if !suffix.is_empty() {
                                reserve(
                                    &mut self.retained_bytes,
                                    seen.len(),
                                    suffix.len(),
                                    16 * 1024 * 1024,
                                )?;
                                chunks.push(self.chunk(
                                    if refusal {
                                        json!({"refusal":suffix})
                                    } else {
                                        json!({"content":suffix})
                                    },
                                    None,
                                ));
                            }
                        }
                    }
                }
                let has_tools = !self.tools.is_empty()
                    || response["output"]
                        .as_array()
                        .is_some_and(|a| a.iter().any(|i| i["type"] == "function_call"));
                chunks.push(self.chunk(json!({}), Some(finish(response, has_tools))));
                if self.include_usage {
                    chunks.push(json!({"id":self.id,"object":"chat.completion.chunk","created":self.created,"model":self.model,"choices":[],"usage":usage(response)}));
                }
                self.done = true;
            }
            "response.failed" | "error" => {
                if let Some(tokens) =
                    super::usage::parser::TokenUsage::from_codex_response_auto(&value["response"])
                {
                    if let Some(reporter) = &self.reporter {
                        reporter.report(tokens, "failed")?;
                    }
                }
                chunks.push(json!({"error":value.get("error").or_else(||value.pointer("/response/error")).cloned().unwrap_or(json!({"type":"upstream_error","message":"Upstream response failed"}))}));
                self.done = true;
            }
            _ => {}
        }
        Ok(chunks)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn bridge() -> StreamBridge {
        StreamBridge {
            id: "fixture".into(),
            model: "m".into(),
            created: 1,
            tools: BTreeMap::new(),
            texts: BTreeMap::new(),
            refusals: BTreeMap::new(),
            done: false,
            include_usage: false,
            retained_bytes: 0,
            reporter: None,
            trace: None,
        }
    }
    #[test]
    fn unsupported_nested_fields_and_invalid_scalars_never_silently_disappear() {
        let base = json!({"model":"m","messages":[{"role":"user","content":"hello"}]});
        for (key, value) in [
            (
                "messages",
                json!([{"role":"user","content":"hello","name":"person"}]),
            ),
            (
                "messages",
                json!([{"role":"user","content":[{"type":"text","text":"hello","cache_control":{"type":"ephemeral"}}]}]),
            ),
            (
                "messages",
                json!([{"role":"user","content":[{"type":"image_url","image_url":{"url":"https://example.invalid/image","detail":"invalid"}}]}]),
            ),
            (
                "messages",
                json!([{"role":"assistant","content":null,"tool_calls":[{"id":"a","type":"function","function":{"name":"f","arguments":"{}","extra":true}}]}]),
            ),
            (
                "tools",
                json!([{"type":"function","function":{"name":"f","parameters":{},"cache_control":true}}]),
            ),
            (
                "tools",
                json!([{"type":"function","function":{"name":"f","parameters":[],"strict":"true"}}]),
            ),
            ("tool_choice", json!("something")),
            (
                "tool_choice",
                json!({"type":"function","function":{"name":"f","extra":1}}),
            ),
            (
                "response_format",
                json!({"type":"json_schema","json_schema":{"name":"x","schema":{},"extra":1}}),
            ),
            ("temperature", json!("1")),
            ("temperature", json!(2.1)),
            ("top_p", json!(-0.1)),
            ("store", json!("false")),
            ("parallel_tool_calls", json!(0)),
            ("metadata", json!({"x":1})),
            ("reasoning_effort", json!({"effort":"high"})),
        ] {
            let mut request = base.clone();
            request[key] = value;
            assert!(request_to_responses(&request).is_err(), "{key}");
        }
        let mut request = base;
        request["max_tokens"] = json!(10);
        request["max_completion_tokens"] = json!(20);
        assert!(request_to_responses(&request).is_err());
    }
    #[test]
    fn streamed_mixed_text_tools_and_final_suffixes_are_emitted_exactly_once() {
        let mut bridge = bridge();
        let mut chunks = vec![];
        chunks.extend(bridge.event(json!({"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"Hello"})).unwrap());
        let item =
            json!({"type":"function_call","call_id":"call-1","name":"read_file","arguments":""});
        chunks.extend(
            bridge
                .event(json!({"type":"response.output_item.added","output_index":1,"item":item}))
                .unwrap(),
        );
        chunks.extend(bridge.event(json!({"type":"response.function_call_arguments.delta","output_index":1,"delta":"{\"path\":"})).unwrap());
        let args = "{\"path\":\"test\"}";
        chunks.extend(bridge.event(json!({"type":"response.function_call_arguments.done","output_index":1,"arguments":args})).unwrap());
        let final_item =
            json!({"type":"function_call","call_id":"call-1","name":"read_file","arguments":args});
        chunks.extend(
            bridge
                .event(
                    json!({"type":"response.output_item.done","output_index":1,"item":final_item}),
                )
                .unwrap(),
        );
        chunks.extend(bridge.event(json!({"type":"response.completed","response":{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"Hello!"}]},final_item]}})).unwrap());
        let text = chunks
            .iter()
            .filter_map(|v| {
                v.pointer("/choices/0/delta/content")
                    .and_then(Value::as_str)
            })
            .collect::<String>();
        let arguments = chunks
            .iter()
            .filter_map(|v| {
                v.pointer("/choices/0/delta/tool_calls/0/function/arguments")
                    .and_then(Value::as_str)
            })
            .collect::<String>();
        assert_eq!(text, "Hello!");
        assert_eq!(arguments, args);
        assert_eq!(
            chunks
                .iter()
                .filter(|v| v
                    .pointer("/choices/0/delta/tool_calls/0/function/name")
                    .is_some())
                .count(),
            1
        );
        assert_eq!(
            chunks.last().unwrap()["choices"][0]["finish_reason"],
            "tool_calls"
        );
        assert!(bridge.done);
    }
    #[test]
    fn aggregate_stream_limit_applies_across_distinct_parts_and_final_only_tools() {
        let mut bridge = bridge();
        bridge.retained_bytes = 16 * 1024 * 1024 - 1;
        assert!(bridge.event(json!({"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"a"})).is_ok());
        assert!(bridge.event(json!({"type":"response.output_text.delta","output_index":1,"content_index":0,"delta":"b"})).is_err());
        let item = json!({"type":"function_call","call_id":"c","name":"f","arguments":"{}"});
        assert!(bridge.tool_item(0, &item).is_err());
    }
    #[test]
    fn malformed_output_and_changed_tool_identity_fail_instead_of_becoming_empty_success() {
        for output in [
            json!([{"type":"unknown"}]),
            json!([{"type":"message","content":[{"type":"audio"}]}]),
            json!([{"type":"function_call","call_id":"x","arguments":"{}"}]),
            Value::Null,
        ] {
            let response = json!({"status":"completed","output":output});
            assert!(response_to_chat(&response).is_err());
            assert!(bridge()
                .event(json!({"type":"response.completed","response":response}))
                .is_err());
        }
        let mut bridge = bridge();
        bridge
            .tool_item(
                0,
                &json!({"type":"function_call","call_id":"c","name":"f","arguments":""}),
            )
            .unwrap();
        assert!(bridge
            .tool_item(
                0,
                &json!({"type":"function_call","call_id":"different","name":"f","arguments":"{}"})
            )
            .is_err());
    }
    #[test]
    fn content_filter_refusal_keeps_its_finish_reason_and_text() {
        let response = json!({"id":"r","status":"incomplete","incomplete_details":{"reason":"content_filter"},"output":[{"type":"message","content":[{"type":"refusal","refusal":"Cannot help with this"}]}]});
        let chat = response_to_chat(&response).unwrap();
        assert_eq!(chat["choices"][0]["finish_reason"], "content_filter");
        assert_eq!(
            chat["choices"][0]["message"]["refusal"],
            "Cannot help with this"
        );
    }

    #[test]
    fn real_client_chat_fields_are_normalized_instead_of_rejected() {
        // 真实客户端（OpenCode / Pi 等）会带 Chat 特有字段：能表达的要保留，
        // 表达不了的只丢那个字段，不能让整次路由请求 400。
        let request = json!({
            "model": "glm-5",
            "stream": true,
            "stream_options": {"include_usage": true, "exclude": true},
            "stop": ["\n"],
            "presence_penalty": 0.1,
            "service_tier": "auto",
            "max_tokens": 64,
            "max_completion_tokens": 128,
            "messages": [
                {"role": "system", "content": "be brief", "name": "policy"},
                {"role": "user", "content": [
                    {"type": "text", "text": "hi"},
                    {"type": "image_url", "image_url": {"url": "https://example.invalid/i.png"}},
                    {"type": "input_audio", "input_audio": {"data": "..."}}
                ]},
                {"role": "assistant", "content": null, "reasoning_content": "thinking",
                 "tool_calls": [
                    {"id": "c1", "type": "function", "function": {"name": "list", "arguments": "{\"path\":\"/\"}"}},
                    {"id": "c2", "type": "custom", "custom": {"name": "x"}}
                 ]},
                {"role": "tool", "tool_call_id": "c1", "content": [{"type": "text", "text": "a"}, {"type": "text", "text": "b"}]}
            ],
            "tools": [
                {"type": "function", "function": {"name": "list"}},
                {"type": "web_search"},
                {"type": "function", "function": {"name": ""}}
            ],
            "tool_choice": {"type": "function", "function": {"name": "list", "extra": 1}},
            "response_format": {"type": "json_object", "extra": 1}
        });
        let responses = gateway_request_to_responses(&request).expect("normalizes");
        assert_eq!(responses["model"], "glm-5");
        assert_eq!(responses["stream"], true);
        // 客户端没写 max_tokens 的部分由 max_completion_tokens 接管；两边冲突时以前者为准。
        assert_eq!(responses["max_output_tokens"], 128);
        // 里表达不了的字段整条丢掉，但不影响其余内容。
        assert!(responses.get("stop").is_none());
        assert!(responses.get("stream_options").is_none());
        let input = responses["input"].as_array().expect("input items");
        assert_eq!(input.len(), 4);
        assert_eq!(input[0]["role"], "system");
        assert_eq!(input[1]["content"][1]["type"], "input_image");
        // 只有 function 类型的工具调用留下来，arguments 原样带过去。
        assert_eq!(input[2]["type"], "function_call");
        assert_eq!(input[2]["name"], "list");
        // 多段工具结果拼成文本。
        assert_eq!(input[3]["output"], "a\nb");
        // 没有 parameters 的工具补默认对象；非 function 和空名字的工具丢掉。
        assert_eq!(responses["tools"].as_array().unwrap().len(), 1);
        assert_eq!(responses["tools"][0]["parameters"]["type"], "object");
        assert_eq!(responses["tool_choice"]["name"], "list");
        assert_eq!(responses["text"]["format"]["type"], "json_object");

        // 空工具列表（很多客户端默认带）整段不发，连带 tool_choice 一起丢掉。
        let empty = gateway_request_to_responses(&json!({
            "model": "glm-5",
            "messages": [{"role": "user", "content": "hi"}],
            "tools": [],
            "tool_choice": "auto"
        }))
        .unwrap();
        assert!(empty.get("tools").is_none());
        assert!(empty.get("tool_choice").is_none());
    }

    #[test]
    fn a_stream_bridge_reports_usage_to_the_trace_without_emitting_it() {
        let trace = std::sync::Arc::new(std::sync::Mutex::new(crate::gateway::RequestTrace {
            id: "t".into(),
            created_at: 0,
            app_id: "pi".into(),
            request_model: "glm-5".into(),
            catalog_revision: 0,
            policy: crate::gateway::RoutePolicy {
                group_id: None,
                id: "p".into(),
                name: "Snapshot".into(),
                app_id: "pi".into(),
                enabled: true,
                match_model: "glm-5".into(),
                request_model: String::new(),
                priority: 1,
                failover: false,
                candidates: vec![],
            },
            events: vec![],
            outcome: "pending".into(),
            latency_ms: 0,
            input_tokens: None,
            output_tokens: None,
            estimated_cost: None,
            decision: None,
            persist: false,
        }));
        let mut bridge = StreamBridge {
            include_usage: false,
            trace: Some(trace.clone()),
            ..bridge()
        };
        let chunks = bridge
            .event(json!({
                "type": "response.completed",
                "response": {
                    "status": "completed",
                    "output": [{"type":"message","content":[{"type":"output_text","text":"hi"}]}],
                    "usage": {"input_tokens": 7, "output_tokens": 2, "total_tokens": 9}
                }
            }))
            .unwrap();
        assert!(
            !chunks
                .iter()
                .any(|chunk| chunk.get("usage").is_some_and(|value| !value.is_null())),
            "客户端没要 usage，流里就不能带 usage chunk"
        );
        let trace = trace.lock().unwrap();
        assert_eq!(trace.input_tokens, Some(7));
        assert_eq!(trace.output_tokens, Some(2));
    }
}

pub async fn handle(state: ProxyState, request: Request) -> Result<Response, ProxyError> {
    let (mut parts, body) = request.into_parts();
    let bytes = axum::body::to_bytes(body, 16 * 1024 * 1024)
        .await
        .map_err(|_| invalid("request body too large"))?;
    let bytes = super::handlers::decode_codex_request_body(&mut parts.headers, bytes)?;
    let chat: Value = serde_json::from_slice(&bytes).map_err(|_| invalid("JSON"))?;
    let converted = request_to_responses(&chat)?;
    let include_usage = chat
        .pointer("/stream_options/include_usage")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    parts.uri = "/v1/responses".parse().unwrap();
    parts.headers.remove("content-length");
    parts.headers.remove("content-encoding");
    let response = super::handlers::handle_responses(
        State(state),
        Request::from_parts(parts, Body::from(converted.to_string())),
    )
    .await?;
    if !response.status().is_success() {
        return Ok(response);
    }
    let streaming = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|s| s.contains("text/event-stream"));
    let (mut parts, body) = response.into_parts();
    parts.headers.remove("content-length");
    parts.headers.remove("content-encoding");
    if !streaming {
        let bytes = axum::body::to_bytes(body, 16 * 1024 * 1024)
            .await
            .map_err(|_| ProxyError::TransformError("Responses body unreadable".into()))?;
        let response: Value = serde_json::from_slice(&bytes)
            .map_err(|_| ProxyError::TransformError("Responses body is not JSON".into()))?;
        if let Some(tokens) = super::usage::parser::TokenUsage::from_codex_response_auto(&response)
        {
            if let Some(reporter) = super::ledger_observer::usage_reporter() {
                reporter.report(
                    tokens,
                    if response["status"] == "incomplete" {
                        "interrupted"
                    } else {
                        "completed"
                    },
                )?;
            }
        }
        return Ok(Response::from_parts(
            parts,
            Body::from(response_to_chat(&response)?.to_string()),
        ));
    }
    let reporter = super::ledger_observer::usage_reporter();
    let output = responses_sse_to_chat_stream(
        body.into_data_stream(),
        chat["model"].as_str().unwrap_or_default(),
        include_usage,
        reporter,
        None,
    );
    Ok(Response::from_parts(parts, Body::from_stream(output)))
}

/// Responses SSE → Chat SSE。网关把 Chat 入口接到的请求归一成 Responses 之后，
/// 上游回包也要按同一形状转回客户端。
pub(crate) fn responses_sse_to_chat_stream<E>(
    stream: impl futures::Stream<Item = Result<bytes::Bytes, E>> + Send + 'static,
    model: &str,
    include_usage: bool,
    reporter: Option<super::ledger_observer::UsageReporter>,
    trace: Option<super::gateway_observer::Trace>,
) -> impl futures::Stream<Item = Result<bytes::Bytes, std::io::Error>> + Send
where
    E: std::fmt::Display + Send + 'static,
{
    let model = model.to_string();
    async_stream::try_stream! {
        let mut buffer=String::new();let mut remainder=vec![];
        let mut bridge=StreamBridge{id:format!("chatcmpl-{}",uuid::Uuid::new_v4()),model,created:chrono::Utc::now().timestamp(),tools:BTreeMap::new(),texts:BTreeMap::new(),refusals:BTreeMap::new(),done:false,retained_bytes:0,include_usage,reporter,trace};
        tokio::pin!(stream);
        while let Some(chunk)=stream.next().await {
            let chunk=chunk.map_err(|e|std::io::Error::other(e.to_string()))?;
            if buffer.len()+chunk.len()>2*1024*1024 {Err(std::io::Error::other("Responses event exceeds limit"))?;}
            super::sse::append_utf8_safe(&mut buffer,&mut remainder,&chunk);
            while let Some(block)=super::sse::take_sse_block(&mut buffer) {
                let data=block.lines().filter_map(|s|s.strip_prefix("data:").map(str::trim)).collect::<Vec<_>>().join("\n");
                if data.is_empty()||data=="[DONE]" {continue;}
                let value=serde_json::from_str(&data).map_err(|_|std::io::Error::other("Invalid Responses event"))?;
                for chunk in bridge.event(value).map_err(|e|std::io::Error::other(e.to_string()))? {yield bytes::Bytes::from(format!("data: {chunk}\n\n"));}
                if bridge.done {yield bytes::Bytes::from_static(b"data: [DONE]\n\n");return;}
            }
        }
        Err(std::io::Error::other("Responses stream ended without a terminal event"))?;
    }
}
