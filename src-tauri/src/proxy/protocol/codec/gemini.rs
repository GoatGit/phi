//! Gemini generateContent ↔ 中性 IR。
//!
//! 这一层负责两件别的协议装不下的事：
//! - 请求/响应里的 `thoughtSignature` 跟随工具调用一起保留；
//! - 响应的 `groundingMetadata`、`safetyRatings`、`citationMetadata`、
//!   `promptFeedback` 原样留在 IR 的扩展位。

use serde_json::{json, Map, Value};

use crate::proxy::error::ProxyError;
use crate::proxy::protocol::ir::{
    Block, ImageSource, Message, Request, Response, ResponseExtensions, Role, StopReason, Tool,
    ToolChoice, Usage,
};

pub(crate) fn parse_request(body: Value) -> Result<Request, ProxyError> {
    let object = body.as_object().ok_or_else(|| invalid("body"))?;
    let model = object
        .get("model")
        .and_then(Value::as_str)
        .or_else(|| object.get("modelVersion").and_then(Value::as_str))
        .unwrap_or_default()
        .to_string();
    let mut request = Request::new(model);

    if let Some(system) = object.get("systemInstruction") {
        request.system = parts_text(system);
    }
    if let Some(contents) = object.get("contents").and_then(Value::as_array) {
        for content in contents {
            let role = match content.get("role").and_then(Value::as_str) {
                Some("model" | "assistant") => Role::Assistant,
                _ => Role::User,
            };
            let blocks = content
                .get("parts")
                .and_then(Value::as_array)
                .map(|parts| parse_parts(parts))
                .transpose()?
                .unwrap_or_default();
            if !blocks.is_empty() {
                request.messages.push(Message { role, blocks });
            }
        }
    }
    if let Some(declarations) = object
        .get("tools")
        .and_then(Value::as_array)
        .and_then(|tools| tools.first())
        .and_then(|tool| tool.get("functionDeclarations"))
        .and_then(Value::as_array)
    {
        for declaration in declarations {
            let Some(name) = declaration.get("name").and_then(Value::as_str) else {
                continue;
            };
            request.tools.push(Tool {
                name: name.to_string(),
                description: declaration
                    .get("description")
                    .and_then(Value::as_str)
                    .map(ToString::to_string),
                input_schema: declaration
                    .get("parameters")
                    .cloned()
                    .unwrap_or_else(|| json!({"type":"object","properties":{}})),
            });
        }
    }
    request.tool_choice = parse_tool_choice(object.get("toolConfig"));

    if let Some(config) = object.get("generationConfig").and_then(Value::as_object) {
        request.max_tokens = config.get("maxOutputTokens").and_then(Value::as_u64);
        request.temperature = config.get("temperature").and_then(Value::as_f64);
        request.top_p = config.get("topP").and_then(Value::as_f64);
        request.stop = config
            .get("stopSequences")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(ToString::to_string)
                    .collect()
            })
            .unwrap_or_default();
        let mut extras = config.clone();
        for key in ["maxOutputTokens", "temperature", "topP", "stopSequences"] {
            extras.remove(key);
        }
        if !extras.is_empty() {
            request.extensions.gemini_generation_config = Some(Value::Object(extras));
        }
    }
    Ok(request)
}

pub(crate) fn build_request(request: &Request) -> Result<Value, ProxyError> {
    let mut result = Map::new();
    if !request.system.is_empty() {
        result.insert(
            "systemInstruction".into(),
            json!({"parts": request.system.iter().map(|text| json!({"text":text})).collect::<Vec<_>>()}),
        );
    }
    let contents: Vec<Value> = request
        .messages
        .iter()
        .map(|message| {
            json!({
                "role": match message.role { Role::User => "user", Role::Assistant => "model" },
                "parts": message.blocks.iter().filter_map(build_part).collect::<Vec<_>>()
            })
        })
        .filter(|content| {
            content
                .get("parts")
                .and_then(Value::as_array)
                .is_some_and(|parts| !parts.is_empty())
        })
        .collect();
    if !contents.is_empty() {
        result.insert("contents".into(), Value::Array(contents));
    }
    if !request.tools.is_empty() {
        result.insert(
            "tools".into(),
            json!([{
                "functionDeclarations": request.tools.iter().map(|tool| {
                    let mut declaration = json!({
                        "name": tool.name.as_str(),
                        "parameters": tool.input_schema.clone(),
                    });
                    if let Some(description) = &tool.description {
                        declaration["description"] = json!(description);
                    }
                    declaration
                }).collect::<Vec<_>>()
            }]),
        );
    }
    if let Some(tool_config) = build_tool_choice(&request.tool_choice) {
        result.insert("toolConfig".into(), tool_config);
    }
    let mut generation = request
        .extensions
        .gemini_generation_config
        .as_ref()
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if let Some(max_tokens) = request.max_tokens {
        generation.insert("maxOutputTokens".into(), json!(max_tokens));
    }
    if let Some(temperature) = request.temperature {
        generation.insert("temperature".into(), json!(temperature));
    }
    if let Some(top_p) = request.top_p {
        generation.insert("topP".into(), json!(top_p));
    }
    if !request.stop.is_empty() {
        generation.insert("stopSequences".into(), json!(request.stop.clone()));
    }
    if !generation.is_empty() {
        result.insert("generationConfig".into(), Value::Object(generation));
    }
    Ok(Value::Object(result))
}

pub(crate) fn parse_response(body: Value) -> Result<Response, ProxyError> {
    let response_id = body
        .get("responseId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let model = body
        .get("modelVersion")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let prompt_feedback = body.get("promptFeedback").cloned();
    let candidate = body
        .get("candidates")
        .and_then(Value::as_array)
        .and_then(|candidates| candidates.first());
    let blocks = candidate
        .and_then(|candidate| candidate.pointer("/content/parts"))
        .and_then(Value::as_array)
        .map(|parts| parse_parts(parts))
        .transpose()?
        .unwrap_or_default();
    let has_tool_use = blocks
        .iter()
        .any(|block| matches!(block, Block::ToolUse { .. }));
    let mut stop_reason = candidate
        .and_then(|candidate| candidate.get("finishReason"))
        .and_then(Value::as_str)
        .map(stop_reason_from_gemini)
        .unwrap_or(StopReason::EndTurn);
    if has_tool_use && stop_reason == StopReason::EndTurn {
        stop_reason = StopReason::ToolUse;
    }
    let usage = body
        .get("usageMetadata")
        .map(parse_usage)
        .unwrap_or_default();
    let mut response = Response::new(response_id, model);
    response.blocks = blocks;
    response.stop_reason = stop_reason;
    response.usage = usage;
    response.extensions = ResponseExtensions {
        gemini_grounding_metadata: candidate
            .and_then(|candidate| candidate.get("groundingMetadata"))
            .cloned(),
        gemini_safety_ratings: candidate
            .and_then(|candidate| candidate.get("safetyRatings"))
            .cloned(),
        gemini_citation_metadata: candidate
            .and_then(|candidate| candidate.get("citationMetadata"))
            .cloned(),
        gemini_prompt_feedback: prompt_feedback,
    };
    Ok(response)
}

pub(crate) fn build_response(response: &Response) -> Result<Value, ProxyError> {
    let parts: Vec<Value> = response.blocks.iter().filter_map(build_part).collect();
    let mut candidate = Map::new();
    candidate.insert("content".into(), json!({"role":"model","parts":parts}));
    if let Some(reason) = gemini_finish_reason(&response.stop_reason) {
        candidate.insert("finishReason".into(), json!(reason));
    }
    for (key, value) in [
        (
            "groundingMetadata",
            response.extensions.gemini_grounding_metadata.clone(),
        ),
        (
            "safetyRatings",
            response.extensions.gemini_safety_ratings.clone(),
        ),
        (
            "citationMetadata",
            response.extensions.gemini_citation_metadata.clone(),
        ),
    ] {
        if let Some(value) = value {
            candidate.insert(key.into(), value);
        }
    }
    let mut result = Map::new();
    if !response.id.is_empty() {
        result.insert("responseId".into(), json!(response.id.as_str()));
    }
    if !response.model.is_empty() {
        result.insert("modelVersion".into(), json!(response.model.as_str()));
    }
    result.insert("candidates".into(), json!([Value::Object(candidate)]));
    if response.usage != Usage::default() {
        result.insert("usageMetadata".into(), usage_to_gemini(&response.usage));
    }
    if let Some(feedback) = &response.extensions.gemini_prompt_feedback {
        result.insert("promptFeedback".into(), feedback.clone());
    }
    Ok(Value::Object(result))
}

fn parse_parts(parts: &[Value]) -> Result<Vec<Block>, ProxyError> {
    let mut blocks = Vec::new();
    for part in parts {
        if let Some(text) = part.get("text").and_then(Value::as_str) {
            let signature = part
                .get("thoughtSignature")
                .or_else(|| part.get("thought_signature"))
                .and_then(Value::as_str)
                .map(ToString::to_string);
            if part.get("thought").and_then(Value::as_bool) == Some(true) {
                blocks.push(Block::Thinking {
                    text: text.to_string(),
                    signature,
                });
            } else {
                blocks.push(Block::Text(text.to_string()));
                if let Some(signature) = signature {
                    blocks.push(Block::Thinking {
                        text: String::new(),
                        signature: Some(signature),
                    });
                }
            }
            continue;
        }
        if let Some(inline) = part.get("inlineData") {
            let media_type = inline
                .get("mimeType")
                .and_then(Value::as_str)
                .unwrap_or("application/octet-stream");
            let data = inline
                .get("data")
                .and_then(Value::as_str)
                .ok_or_else(|| invalid("inlineData.data"))?;
            blocks.push(Block::Image(ImageSource::Base64 {
                media_type: media_type.to_string(),
                data: data.to_string(),
            }));
            continue;
        }
        if let Some(file) = part.get("fileData") {
            if let Some(uri) = file.get("fileUri").and_then(Value::as_str) {
                blocks.push(Block::Image(ImageSource::Url(uri.to_string())));
                continue;
            }
        }
        if let Some(call) = part.get("functionCall") {
            let name = call
                .get("name")
                .and_then(Value::as_str)
                .ok_or_else(|| invalid("functionCall.name"))?;
            let id = call
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .unwrap_or(name);
            blocks.push(Block::ToolUse {
                id: id.to_string(),
                name: name.to_string(),
                input: call.get("args").cloned().unwrap_or_else(|| json!({})),
                thought_signature: call
                    .get("thoughtSignature")
                    .or_else(|| call.get("thought_signature"))
                    .and_then(Value::as_str)
                    .map(ToString::to_string),
            });
            continue;
        }
        if let Some(result) = part.get("functionResponse") {
            let name = result
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let id = result
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .unwrap_or(name);
            blocks.push(Block::ToolResult {
                tool_use_id: id.to_string(),
                name: (!name.is_empty()).then(|| name.to_string()),
                content: result.get("response").cloned().unwrap_or(Value::Null),
                is_error: false,
            });
        }
    }
    Ok(blocks)
}

fn build_part(block: &Block) -> Option<Value> {
    match block {
        Block::Text(text) => Some(json!({"text": text})),
        Block::Image(ImageSource::Base64 { media_type, data }) => {
            Some(json!({"inlineData":{"mimeType":media_type,"data":data}}))
        }
        Block::Image(ImageSource::Url(url)) => Some(json!({"fileData":{"fileUri":url}})),
        Block::ToolUse {
            id,
            name,
            input,
            thought_signature,
        } => {
            let mut call = json!({"id":id,"name":name,"args":input});
            if let Some(signature) = thought_signature {
                call["thoughtSignature"] = json!(signature);
            }
            Some(json!({"functionCall":call}))
        }
        Block::ToolResult {
            tool_use_id,
            name,
            content,
            ..
        } => {
            let mut response = json!({
                "id": tool_use_id,
                "response": content
            });
            if let Some(name) = name {
                response["name"] = json!(name);
            }
            Some(json!({"functionResponse":response}))
        }
        Block::Thinking { text, signature } => {
            let mut part = json!({"text":text,"thought":true});
            if let Some(signature) = signature {
                part["thoughtSignature"] = json!(signature);
            }
            Some(part)
        }
    }
}

fn parts_text(value: &Value) -> Vec<String> {
    value
        .get("parts")
        .and_then(Value::as_array)
        .map(|parts| {
            parts
                .iter()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .filter(|text| !text.trim().is_empty())
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn parse_tool_choice(value: Option<&Value>) -> ToolChoice {
    let Some(config) = value
        .and_then(|value| value.get("functionCallingConfig"))
        .and_then(Value::as_object)
    else {
        return ToolChoice::Auto;
    };
    match config.get("mode").and_then(Value::as_str) {
        Some("ANY") => config
            .get("allowedFunctionNames")
            .and_then(Value::as_array)
            .and_then(|names| names.first())
            .and_then(Value::as_str)
            .map(|name| ToolChoice::Tool(name.to_string()))
            .unwrap_or(ToolChoice::Required),
        Some("NONE") => ToolChoice::None,
        _ => ToolChoice::Auto,
    }
}

fn build_tool_choice(choice: &ToolChoice) -> Option<Value> {
    let config = match choice {
        ToolChoice::Auto => json!({"mode":"AUTO"}),
        ToolChoice::Required => json!({"mode":"ANY"}),
        ToolChoice::None => json!({"mode":"NONE"}),
        ToolChoice::Tool(name) => {
            json!({"mode":"ANY","allowedFunctionNames":[name]})
        }
    };
    Some(json!({"functionCallingConfig": config}))
}

fn parse_usage(value: &Value) -> Usage {
    Usage {
        input_tokens: value
            .get("promptTokenCount")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        output_tokens: value
            .get("candidatesTokenCount")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        cache_read_input_tokens: value
            .get("cachedContentTokenCount")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        cache_creation_input_tokens: 0,
    }
}

fn usage_to_gemini(usage: &Usage) -> Value {
    let mut result = json!({
        "promptTokenCount": usage.input_tokens,
        "candidatesTokenCount": usage.output_tokens,
        "totalTokenCount": usage.input_tokens + usage.output_tokens,
    });
    if usage.cache_read_input_tokens > 0 {
        result["cachedContentTokenCount"] = json!(usage.cache_read_input_tokens);
    }
    result
}

fn stop_reason_from_gemini(reason: &str) -> StopReason {
    match reason {
        "MAX_TOKENS" => StopReason::MaxTokens,
        "SAFETY" | "RECITATION" | "BLOCKLIST" | "PROHIBITED_CONTENT" => StopReason::ContentFilter,
        "STOP" => StopReason::EndTurn,
        other => StopReason::Other(other.to_string()),
    }
}

fn gemini_finish_reason(reason: &StopReason) -> Option<&str> {
    match reason {
        StopReason::EndTurn | StopReason::ToolUse => Some("STOP"),
        StopReason::MaxTokens => Some("MAX_TOKENS"),
        StopReason::StopSequence => Some("STOP"),
        StopReason::ContentFilter => Some("SAFETY"),
        StopReason::Other(_) => None,
    }
}

fn invalid(field: &str) -> ProxyError {
    ProxyError::InvalidRequest(format!("invalid Gemini {field}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_round_trip_keeps_thought_signature_and_tool_shapes() {
        let body = json!({
            "model": "gemini-3-pro",
            "systemInstruction": {"parts":[{"text":"be terse"}]},
            "contents": [
                {"role":"user","parts":[{"text":"read a.txt"}]},
                {"role":"model","parts":[{
                    "functionCall":{"id":"call_1","name":"read","args":{"path":"a.txt"},"thoughtSignature":"sig-1"}
                }]},
                {"role":"user","parts":[{
                    "functionResponse":{"id":"call_1","name":"read","response":{"content":"file body"}}
                }]}
            ],
            "tools": [{"functionDeclarations":[{
                "name":"read","description":"read a file",
                "parameters":{"type":"object","properties":{"path":{"type":"string"}}}
            }]}],
            "toolConfig": {"functionCallingConfig":{"mode":"ANY","allowedFunctionNames":["read"]}},
            "generationConfig": {"maxOutputTokens":128,"temperature":0.2,"responseMimeType":"application/json"}
        });
        let request = parse_request(body).unwrap();
        assert_eq!(request.model, "gemini-3-pro");
        assert_eq!(request.system, vec!["be terse"]);
        assert_eq!(request.max_tokens, Some(128));
        assert_eq!(request.tool_choice, ToolChoice::Tool("read".into()));
        assert!(matches!(
            request.messages[1].blocks[0],
            Block::ToolUse { ref id, thought_signature: Some(ref signature), .. }
                if id == "call_1" && signature == "sig-1"
        ));
        assert!(matches!(
            request.messages[2].blocks[0],
            Block::ToolResult { ref tool_use_id, .. } if tool_use_id == "call_1"
        ));

        let rebuilt = build_request(&request).unwrap();
        assert_eq!(
            rebuilt["contents"][1]["parts"][0]["functionCall"]["thoughtSignature"],
            "sig-1"
        );
        assert_eq!(
            rebuilt["generationConfig"]["responseMimeType"],
            "application/json"
        );
        assert_eq!(
            rebuilt["tools"][0]["functionDeclarations"][0]["name"],
            "read"
        );
    }

    #[test]
    fn response_round_trip_keeps_grounding_safety_and_citations() {
        let body = json!({
            "responseId": "resp-1",
            "modelVersion": "gemini-3-pro",
            "candidates": [{
                "content": {"role":"model","parts":[
                    {"text":"answer"},
                    {"functionCall":{"id":"call_2","name":"search","args":{"q":"x"},"thoughtSignature":"sig-2"}}
                ]},
                "finishReason": "STOP",
                "groundingMetadata": {"webSearchQueries":["x"]},
                "safetyRatings": [{"category":"HARM_CATEGORY_HATE_SPEECH","probability":"LOW"}],
                "citationMetadata": {"citationSources":[{"uri":"https://example.com"}]}
            }],
            "usageMetadata": {"promptTokenCount":10,"candidatesTokenCount":3,"totalTokenCount":13}
        });
        let response = parse_response(body).unwrap();
        assert_eq!(response.id, "resp-1");
        assert_eq!(response.usage.input_tokens, 10);
        assert!(matches!(
            response.blocks[1],
            Block::ToolUse { ref thought_signature, .. } if thought_signature.as_deref() == Some("sig-2")
        ));
        assert_eq!(
            response
                .extensions
                .gemini_grounding_metadata
                .as_ref()
                .unwrap()["webSearchQueries"][0],
            "x"
        );

        let rebuilt = build_response(&response).unwrap();
        assert_eq!(
            rebuilt["candidates"][0]["groundingMetadata"]["webSearchQueries"][0],
            "x"
        );
        assert_eq!(
            rebuilt["candidates"][0]["safetyRatings"][0]["category"],
            "HARM_CATEGORY_HATE_SPEECH"
        );
        assert_eq!(
            rebuilt["candidates"][0]["citationMetadata"]["citationSources"][0]["uri"],
            "https://example.com"
        );
        assert_eq!(
            rebuilt["candidates"][0]["content"]["parts"][1]["functionCall"]["thoughtSignature"],
            "sig-2"
        );
    }
}
