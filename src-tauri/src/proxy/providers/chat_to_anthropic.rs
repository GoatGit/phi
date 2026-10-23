//! OpenAI Chat Completions ↔ Anthropic Messages，直接一跳。
//!
//! 这条路径替代原先的 Chat → Responses → Anthropic 两跳：Chat 入口的消息、
//! 工具、图片直接映射成 Anthropic Messages，回包也直接从 Anthropic 映射成
//! Chat completions。Responses 只保留给 Codex 入口。

use serde_json::{json, Value};

use crate::proxy::error::ProxyError;
use crate::proxy::json_canonical::canonical_json_string;

const CHAT_FIELDS: [&str; 33] = [
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
    // OpenAI 的提示词缓存亲和键。它没有 Anthropic 对应字段，转成 Messages 时
    // 丢弃即可；在这里报 400 会让客户端以为上游拒绝该参数，从而去掉参数重试。
    "prompt_cache_key",
    // 以下都是 Chat 协议里合法的可选字段，Anthropic Messages 没有对应概念。
    // 它们只影响 OpenAI 侧的采样、推理、限流或统计行为，丢给上游既不改变语义
    // 也不影响正确性；若统一按「未知字段」回 400，客户端看到的只是笼统的
    // invalid messages，根本看不出是哪个字段，也无从修正。
    "prompt_cache_retention",
    "stop",
    "reasoning",
    "service_tier",
    "safety_identifier",
    "frequency_penalty",
    "presence_penalty",
    "logprobs",
    "top_logprobs",
    "logit_bias",
    "seed",
    "modalities",
    "audio",
    "prediction",
    "verbosity",
];

fn invalid(field: &str) -> ProxyError {
    ProxyError::InvalidRequest(format!("invalid {field}"))
}

/// Chat Completions 请求 → Anthropic Messages 请求。
pub(crate) fn chat_request_to_anthropic(
    body: Value,
    default_max_tokens: u64,
) -> Result<Value, ProxyError> {
    let object = body.as_object().ok_or_else(|| invalid("body"))?;
    // 白名单只用来挡住这条一跳转换表达不了、又不能静默猜的字段；列进白名单但
    // 没有 Anthropic 对应概念的（store、metadata、prompt_cache_key 等）由下面
    // 按字段取值的代码决定去向，取不到就不写进结果，等价于丢弃。
    for key in object.keys() {
        if !CHAT_FIELDS.contains(&key.as_str()) {
            return Err(invalid(key));
        }
    }
    let model = body["model"]
        .as_str()
        .filter(|model| !model.is_empty())
        .ok_or_else(|| invalid("model"))?;
    if body.get("n").is_some_and(|n| n.as_u64() != Some(1)) {
        return Err(invalid("n (only 1 is supported)"));
    }
    if body
        .get("stream")
        .is_some_and(|stream| !stream.is_boolean())
    {
        return Err(invalid("stream"));
    }
    if let Some(options) = body.get("stream_options") {
        let options = options
            .as_object()
            .ok_or_else(|| invalid("stream_options"))?;
        if options
            .iter()
            .any(|(key, value)| key != "include_usage" || !value.is_boolean())
        {
            return Err(invalid("stream_options"));
        }
    }
    if body
        .get("max_tokens")
        .zip(body.get("max_completion_tokens"))
        .is_some_and(|(a, b)| a != b)
    {
        return Err(invalid("conflicting token limits"));
    }
    for (field, max) in [("temperature", 2.0), ("top_p", 1.0)] {
        if body
            .get(field)
            .is_some_and(|value| value.as_f64().is_none_or(|n| !(0.0..=max).contains(&n)))
        {
            return Err(invalid(field));
        }
    }

    let messages = body["messages"]
        .as_array()
        .filter(|messages| !messages.is_empty())
        .ok_or_else(|| invalid("messages"))?;
    let mut system_parts = Vec::new();
    let mut anthropic_messages: Vec<Value> = Vec::new();

    for message in messages {
        let message = message.as_object().ok_or_else(|| invalid("messages"))?;
        if message.keys().any(|key| {
            !matches!(
                key.as_str(),
                "role" | "content" | "tool_calls" | "tool_call_id"
            )
        }) {
            return Err(invalid("messages"));
        }
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("messages.role"))?;

        if matches!(role, "system" | "developer") {
            if message.get("tool_calls").is_some() || message.get("tool_call_id").is_some() {
                return Err(invalid("system.tool_calls"));
            }
            collect_text(message.get("content"), &mut system_parts)?;
            continue;
        }

        if role == "tool" {
            if message.get("tool_calls").is_some() {
                return Err(invalid("tool.tool_calls"));
            }
            let call_id = message
                .get("tool_call_id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .ok_or_else(|| invalid("tool_call_id"))?;
            let content = message
                .get("content")
                .and_then(Value::as_str)
                .ok_or_else(|| invalid("tool.content"))?;
            push_block(
                &mut anthropic_messages,
                "user",
                json!({
                    "type": "tool_result",
                    "tool_use_id": call_id,
                    "content": content
                }),
            );
            continue;
        }

        if !matches!(role, "user" | "assistant") {
            return Err(invalid("messages.role"));
        }
        if message.get("tool_call_id").is_some() {
            return Err(invalid("messages.tool_call_id"));
        }

        let blocks = chat_content_blocks(role, message.get("content"))?;
        for block in blocks {
            push_block(&mut anthropic_messages, role, block);
        }

        if let Some(calls) = message.get("tool_calls") {
            if role != "assistant" {
                return Err(invalid("tool_calls role"));
            }
            for call in calls.as_array().ok_or_else(|| invalid("tool_calls"))? {
                let call = call.as_object().ok_or_else(|| invalid("tool_calls"))?;
                if call.get("type").and_then(Value::as_str) != Some("function") {
                    return Err(invalid("tool_calls.type"));
                }
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
                    .ok_or_else(|| invalid("tool_calls.arguments"))?;
                let input = serde_json::from_str::<Value>(arguments)
                    .unwrap_or_else(|_| json!({ "input": arguments }));
                push_block(
                    &mut anthropic_messages,
                    "assistant",
                    json!({
                        "type": "tool_use",
                        "id": id,
                        "name": name,
                        "input": input
                    }),
                );
            }
        }
    }

    // Anthropic 要求首条是 user；Chat 历史可能以 assistant 开头（例如续写）。
    if anthropic_messages
        .first()
        .and_then(|message| message.get("role"))
        .and_then(Value::as_str)
        != Some("user")
    {
        anthropic_messages.insert(
            0,
            json!({"role":"user","content":[{"type":"text","text":"Continue."}]}),
        );
    }
    if anthropic_messages.is_empty() {
        return Err(ProxyError::InvalidRequest(
            "cannot convert Chat request: empty messages".into(),
        ));
    }

    let max_tokens = body
        .get("max_completion_tokens")
        .or_else(|| body.get("max_tokens"))
        .and_then(Value::as_u64)
        .filter(|tokens| *tokens > 0)
        .unwrap_or(default_max_tokens);

    let mut result = json!({
        "model": model,
        "max_tokens": max_tokens,
        "messages": anthropic_messages,
    });
    if !system_parts.is_empty() {
        result["system"] = json!(system_parts.join("\n\n"));
    }
    if let Some(stream) = body.get("stream") {
        result["stream"] = stream.clone();
    }
    if let Some(temperature) = body.get("temperature") {
        result["temperature"] = temperature.clone();
    }
    if let Some(top_p) = body.get("top_p") {
        result["top_p"] = top_p.clone();
    }
    if let Some(tools) = body.get("tools") {
        let mut converted = Vec::new();
        for tool in tools.as_array().ok_or_else(|| invalid("tools"))? {
            let tool = tool.as_object().ok_or_else(|| invalid("tools"))?;
            if tool.get("type").and_then(Value::as_str) != Some("function") {
                return Err(invalid("tools.type"));
            }
            let function = tool
                .get("function")
                .and_then(Value::as_object)
                .ok_or_else(|| invalid("tools.function"))?;
            let name = function
                .get("name")
                .and_then(Value::as_str)
                .filter(|name| !name.is_empty())
                .ok_or_else(|| invalid("tools.function.name"))?;
            let mut anthropic_tool = json!({
                "name": name,
                "input_schema": function
                    .get("parameters")
                    .cloned()
                    .filter(Value::is_object)
                    .unwrap_or_else(|| json!({"type":"object","properties":{}})),
            });
            if let Some(description) = function.get("description").and_then(Value::as_str) {
                anthropic_tool["description"] = json!(description);
            }
            converted.push(anthropic_tool);
        }
        if !converted.is_empty() {
            result["tools"] = json!(converted);
        }
    }

    if result.get("tools").is_some() {
        if let Some(choice) = body.get("tool_choice") {
            let mapped = match choice {
                Value::String(value) => match value.as_str() {
                    "required" => json!({"type":"any"}),
                    "none" => json!({"type":"none"}),
                    _ => json!({"type":"auto"}),
                },
                Value::Object(object) => match object.get("type").and_then(Value::as_str) {
                    Some("function") => {
                        let name = object
                            .get("function")
                            .and_then(Value::as_object)
                            .and_then(|function| function.get("name"))
                            .and_then(Value::as_str)
                            .ok_or_else(|| invalid("tool_choice.name"))?;
                        json!({"type":"tool","name":name})
                    }
                    _ => json!({"type":"auto"}),
                },
                _ => return Err(invalid("tool_choice")),
            };
            result["tool_choice"] = mapped;
        }
        if body.get("parallel_tool_calls").and_then(Value::as_bool) == Some(false) {
            if let Some(choice) = result.get_mut("tool_choice").and_then(Value::as_object_mut) {
                choice.insert("disable_parallel_tool_use".into(), json!(true));
            }
        }
    }

    // Chat 入口的 reasoning_effort 与 Codex 的 reasoning.effort 同一语义，
    // 直接映射成 Anthropic thinking；旧两跳正是这么做的。
    let thinking_enabled = apply_reasoning_effort(
        &mut result,
        model,
        max_tokens,
        body.get("reasoning_effort").and_then(Value::as_str),
    );
    if thinking_enabled {
        if let Some(object) = result.as_object_mut() {
            // Anthropic 在 thinking 开启时不接受自定义采样参数。
            object.remove("temperature");
            object.remove("top_p");
        }
    }

    Ok(result)
}

fn apply_reasoning_effort(
    result: &mut Value,
    model: &str,
    max_tokens: u64,
    effort: Option<&str>,
) -> bool {
    let Some(effort) = effort.map(str::trim).filter(|effort| !effort.is_empty()) else {
        return false;
    };
    let effort = effort.to_ascii_lowercase();
    let adaptive = crate::proxy::thinking_optimizer::uses_adaptive_thinking(model);
    let cannot_disable = crate::proxy::thinking_optimizer::thinking_cannot_be_disabled(model);

    if matches!(effort.as_str(), "none" | "off" | "disabled") {
        if !cannot_disable {
            result["thinking"] = json!({"type":"disabled"});
        }
        return false;
    }
    if adaptive {
        result["thinking"] = json!({"type":"adaptive"});
        if let Some(level) = effort_level(&effort) {
            result["output_config"] = json!({"effort":level});
        }
        return true;
    }
    let Some(budget) =
        crate::proxy::providers::responses_to_anthropic::effort_to_thinking_budget(&effort)
    else {
        return false;
    };
    let budget = budget.min(max_tokens / 2);
    if budget < 1024 {
        return false;
    }
    result["thinking"] = json!({"type":"enabled","budget_tokens":budget});
    true
}

fn effort_level(effort: &str) -> Option<&'static str> {
    match effort {
        "minimal" | "low" => Some("low"),
        "medium" => Some("medium"),
        "high" => Some("high"),
        "xhigh" | "max" | "ultra" => Some("max"),
        _ => None,
    }
}

/// Anthropic Messages 响应 → Chat Completions 响应。
pub(crate) fn anthropic_response_to_chat(body: Value) -> Result<Value, ProxyError> {
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

    let mut text = String::new();
    let mut reasoning = String::new();
    let mut tool_calls = Vec::new();
    if let Some(blocks) = body.get("content").and_then(Value::as_array) {
        for block in blocks {
            match block.get("type").and_then(Value::as_str).unwrap_or("") {
                "text" => {
                    if let Some(value) = block.get("text").and_then(Value::as_str) {
                        text.push_str(value);
                    }
                }
                // Anthropic 判定安全策略拦截时返回 stop_reason=refusal，content
                // 里可能只有一个 refusal 块。保留它的文案，否则客户端收到的是
                // 一个没有任何内容的空回复，看起来像上游异常。
                "refusal" => {
                    if let Some(value) = block.get("refusal").and_then(Value::as_str) {
                        text.push_str(value);
                    }
                }
                "thinking" => {
                    if let Some(value) = block.get("thinking").and_then(Value::as_str) {
                        reasoning.push_str(value);
                    }
                }
                "tool_use" => {
                    let id = block.get("id").and_then(Value::as_str).unwrap_or("");
                    let name = block.get("name").and_then(Value::as_str).unwrap_or("");
                    let input = block.get("input").cloned().unwrap_or_else(|| json!({}));
                    tool_calls.push(json!({
                        "id": id,
                        "type": "function",
                        "function": {
                            "name": name,
                            "arguments": canonical_json_string(&input)
                        }
                    }));
                }
                _ => {}
            }
        }
    }

    let finish_reason = match body.get("stop_reason").and_then(Value::as_str) {
        Some("max_tokens") => "length",
        Some("tool_use") => "tool_calls",
        Some("refusal") => "content_filter",
        _ => "stop",
    };
    let usage = anthropic_usage_to_chat(body.get("usage"));
    let mut message = json!({
        "role": "assistant",
        "content": if text.is_empty() { Value::Null } else { json!(text) },
    });
    if !tool_calls.is_empty() {
        message["tool_calls"] = json!(tool_calls);
    }
    if !reasoning.is_empty() {
        message["reasoning_content"] = json!(reasoning);
    }

    Ok(json!({
        "id": body.get("id").cloned().unwrap_or_else(|| json!("chatcmpl_phi")),
        "object": "chat.completion",
        "created": 0,
        "model": body.get("model").cloned().unwrap_or(Value::Null),
        "choices": [{
            "index": 0,
            "message": message,
            "finish_reason": finish_reason
        }],
        "usage": usage
    }))
}

fn chat_content_blocks(role: &str, content: Option<&Value>) -> Result<Vec<Value>, ProxyError> {
    let mut blocks = Vec::new();
    match content {
        Some(Value::String(text)) => blocks.push(json!({"type":"text","text":text})),
        Some(Value::Array(parts)) => {
            for part in parts {
                match part.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        let text = part
                            .get("text")
                            .and_then(Value::as_str)
                            .ok_or_else(|| invalid("content.text"))?;
                        blocks.push(json!({"type":"text","text":text}));
                    }
                    Some("image_url") if role == "user" => {
                        let block = image_block(part)
                            .ok_or_else(|| invalid("messages.content.image_url"))?;
                        blocks.push(block);
                    }
                    _ => return Err(invalid("messages.content.type")),
                }
            }
        }
        Some(Value::Null) if role == "assistant" => {}
        None if role == "assistant" => {}
        _ => return Err(invalid("messages.content")),
    }
    Ok(blocks)
}

fn image_block(part: &Value) -> Option<Value> {
    let url = part.get("image_url").and_then(|value| {
        value
            .as_str()
            .map(str::to_string)
            .or_else(|| value.get("url").and_then(Value::as_str).map(str::to_string))
    })?;
    if let Some(rest) = url.strip_prefix("data:") {
        let (meta, data) = rest.split_once(',')?;
        let media_type = meta.split(';').next().unwrap_or("image/png");
        Some(json!({
            "type": "image",
            "source": {"type":"base64","media_type":media_type,"data":data}
        }))
    } else if url.starts_with("http://") || url.starts_with("https://") {
        Some(json!({
            "type": "image",
            "source": {"type":"url","url":url}
        }))
    } else {
        None
    }
}

fn collect_text(content: Option<&Value>, parts: &mut Vec<String>) -> Result<(), ProxyError> {
    match content {
        Some(Value::String(text)) if !text.trim().is_empty() => parts.push(text.clone()),
        Some(Value::Array(items)) => {
            for item in items {
                let text = item
                    .get("text")
                    .and_then(Value::as_str)
                    .ok_or_else(|| invalid("messages.content.text"))?;
                if !text.trim().is_empty() {
                    parts.push(text.to_string());
                }
            }
        }
        Some(Value::Null) | None => {}
        _ => return Err(invalid("messages.content")),
    }
    Ok(())
}

fn push_block(messages: &mut Vec<Value>, role: &str, block: Value) {
    if let Some(last) = messages.last_mut() {
        if last.get("role").and_then(Value::as_str) == Some(role) {
            if let Some(content) = last.get_mut("content").and_then(Value::as_array_mut) {
                content.push(block);
                return;
            }
        }
    }
    messages.push(json!({"role": role, "content": [block]}));
}

fn anthropic_usage_to_chat(usage: Option<&Value>) -> Value {
    let Some(usage) = usage.filter(|value| value.is_object()) else {
        return Value::Null;
    };
    let input = usage
        .get("input_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let output = usage
        .get("output_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let mut result = json!({
        "prompt_tokens": input,
        "completion_tokens": output,
        "total_tokens": input + output
    });
    let mut details = serde_json::Map::new();
    if let Some(cached) = usage.get("cache_read_input_tokens").and_then(Value::as_u64) {
        details.insert("cached_tokens".into(), json!(cached));
    }
    if let Some(created) = usage
        .get("cache_creation_input_tokens")
        .and_then(Value::as_u64)
    {
        details.insert("cache_creation_tokens".into(), json!(created));
    }
    if !details.is_empty() {
        result["prompt_tokens_details"] = Value::Object(details);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chat_request_maps_system_messages_and_tools() {
        let body = json!({
            "model": "claude-sonnet-4-5",
            "messages": [
                {"role":"system","content":"be terse"},
                {"role":"user","content":"hello"},
                {"role":"assistant","content":null,"tool_calls":[{
                    "id":"call_1","type":"function",
                    "function":{"name":"read","arguments":"{\"path\":\"a.txt\"}"}
                }]},
                {"role":"tool","tool_call_id":"call_1","content":"file body"}
            ],
            "tools": [{
                "type":"function",
                "function":{"name":"read","description":"read a file","parameters":{"type":"object","properties":{"path":{"type":"string"}}}}
            }],
            "tool_choice":"required",
            "max_tokens": 64,
            "stream": true
        });
        let result = chat_request_to_anthropic(body, 8192).unwrap();
        assert_eq!(result["model"], "claude-sonnet-4-5");
        assert_eq!(result["system"], "be terse");
        assert_eq!(result["max_tokens"], 64);
        assert_eq!(result["stream"], true);
        assert_eq!(result["messages"][0]["role"], "user");
        assert_eq!(result["messages"][0]["content"][0]["text"], "hello");
        assert_eq!(result["messages"][1]["content"][0]["type"], "tool_use");
        assert_eq!(result["messages"][2]["content"][0]["type"], "tool_result");
        assert_eq!(result["tools"][0]["name"], "read");
        assert_eq!(result["tools"][0]["input_schema"]["type"], "object");
        assert_eq!(result["tool_choice"]["type"], "any");
    }

    /// OpenAI 客户端（如 Semibot）会在 Chat 请求里带提示词缓存亲和键。Anthropic
    /// 没有对应字段，这里只能丢弃；早点报 invalid prompt_cache_key 会让客户端
    /// 以为上游拒绝该参数，进而去掉参数重试（「正在使用兼容格式重试」）。
    #[test]
    fn chat_request_drops_prompt_cache_key_instead_of_rejecting_it() {
        let body = json!({
            "model": "deepseek-v4-pro",
            "messages": [{ "role": "user", "content": "hi" }],
            "max_tokens": 64,
            "prompt_cache_key": "sess-abc-123"
        });
        let result = chat_request_to_anthropic(body, 8192).unwrap();
        assert_eq!(result["max_tokens"], 64);
        assert!(result.get("prompt_cache_key").is_none());
    }

    /// Chat 协议里合法的可选字段（采样、限流、推理、统计类）在 Anthropic 没有
    /// 对应概念。它们必须被丢弃而不是让整轮请求 400：客户端只会拿到
    /// 「invalid messages」，无法定位是哪个字段。
    #[test]
    fn chat_request_drops_portable_optional_fields() {
        let body = json!({
            "model": "deepseek-v4-pro",
            "messages": [{ "role": "user", "content": "hi" }],
            "prompt_cache_retention": "24h",
            "stop": "\n\n",
            "reasoning": { "effort": "low" },
            "service_tier": "auto",
            "safety_identifier": "user-1",
            "frequency_penalty": 0.0,
            "presence_penalty": 0.0,
            "logprobs": false,
            "top_logprobs": 0,
            "logit_bias": {},
            "seed": 7,
            "modalities": ["text"],
            "prediction": null,
            "verbosity": "high"
        });
        let result = chat_request_to_anthropic(body, 8192).unwrap();
        assert_eq!(result["messages"][0]["content"][0]["text"], "hi");
        for field in [
            "prompt_cache_retention",
            "stop",
            "reasoning",
            "service_tier",
            "safety_identifier",
            "frequency_penalty",
            "presence_penalty",
            "logprobs",
            "top_logprobs",
            "logit_bias",
            "seed",
            "modalities",
            "prediction",
            "verbosity",
        ] {
            assert!(result.get(field).is_none(), "{field} must be dropped");
        }
    }

    /// 安全策略拦截时 Anthropic 返回 refusal 块。文案要透传给 Chat 客户端，
    /// 否则用户看到的是一个没有内容的空回复。
    #[test]
    fn anthropic_refusal_block_is_surfaced_to_chat() {
        let body = json!({
            "id": "msg_2",
            "type": "message",
            "role": "assistant",
            "model": "deepseek-v4-pro",
            "content": [{"type": "refusal", "refusal": "policy violation"}],
            "stop_reason": "refusal",
            "usage": {"input_tokens": 3, "output_tokens": 2}
        });
        let result = anthropic_response_to_chat(body).unwrap();
        assert_eq!(
            result["choices"][0]["message"]["content"],
            "policy violation"
        );
        assert_eq!(result["choices"][0]["finish_reason"], "content_filter");
    }

    /// OpenAI 拒绝空的 developer/system 消息，但这里不能用整个请求失败来回应。
    #[test]
    fn chat_request_skips_empty_developer_message() {
        let body = json!({
            "model": "deepseek-v4-pro",
            "messages": [
                { "role": "developer", "content": [] },
                { "role": "user", "content": "hi" }
            ]
        });
        let result = chat_request_to_anthropic(body, 8192).unwrap();
        assert!(result.get("system").is_none());
        assert_eq!(result["messages"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn chat_request_still_rejects_unknown_fields() {
        let body = json!({
            "model": "deepseek-v4-pro",
            "messages": [{ "role": "user", "content": "hi" }],
            "definitely_not_a_chat_field": true
        });
        let error = chat_request_to_anthropic(body, 8192).unwrap_err();
        assert!(format!("{error:?}").contains("definitely_not_a_chat_field"));
    }

    #[test]
    fn chat_request_accepts_data_url_images() {
        let body = json!({
            "model": "claude-sonnet-4-5",
            "messages": [{
                "role":"user",
                "content":[
                    {"type":"text","text":"what is this"},
                    {"type":"image_url","image_url":{"url":"data:image/png;base64,AAAA"}}
                ]
            }]
        });
        let result = chat_request_to_anthropic(body, 8192).unwrap();
        assert_eq!(result["messages"][0]["content"][1]["type"], "image");
        assert_eq!(
            result["messages"][0]["content"][1]["source"]["media_type"],
            "image/png"
        );
    }

    #[test]
    fn reasoning_effort_maps_to_thinking_and_drops_sampling() {
        let body = json!({
            "model": "claude-sonnet-4-5",
            "messages": [{"role":"user","content":"hi"}],
            "reasoning_effort": "high",
            "temperature": 0.7,
            "max_tokens": 8192
        });
        let result = chat_request_to_anthropic(body, 8192).unwrap();
        assert_eq!(result["thinking"]["type"], "enabled");
        assert_eq!(result["thinking"]["budget_tokens"], 4096);
        assert!(result.get("temperature").is_none());
    }

    #[test]
    fn anthropic_response_maps_text_tools_usage_and_finish_reason() {
        let body = json!({
            "id": "msg_1",
            "type": "message",
            "role": "assistant",
            "model": "claude-sonnet-4-5",
            "content": [
                {"type":"thinking","thinking":"let me read it"},
                {"type":"text","text":"Here you go."},
                {"type":"tool_use","id":"call_1","name":"read","input":{"path":"a.txt"}}
            ],
            "stop_reason": "tool_use",
            "usage": {"input_tokens": 12, "output_tokens": 5, "cache_read_input_tokens": 3}
        });
        let result = anthropic_response_to_chat(body).unwrap();
        assert_eq!(result["choices"][0]["message"]["content"], "Here you go.");
        assert_eq!(
            result["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
            "read"
        );
        assert_eq!(result["choices"][0]["finish_reason"], "tool_calls");
        assert_eq!(result["usage"]["prompt_tokens"], 12);
        assert_eq!(result["usage"]["completion_tokens"], 5);
        assert_eq!(result["usage"]["total_tokens"], 17);
        assert_eq!(result["usage"]["prompt_tokens_details"]["cached_tokens"], 3);
        assert_eq!(
            result["choices"][0]["message"]["reasoning_content"],
            "let me read it"
        );
    }
}
