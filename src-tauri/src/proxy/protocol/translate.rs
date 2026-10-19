//! 协议之间的中转：源协议 → IR → 目标协议。
//!
//! 目前接入 Anthropic 与 Gemini 的 codec；Chat / Responses 的 codec 在下一
//! 步补齐后，调用方不需要改这里的选择逻辑。

use serde_json::Value;

use crate::proxy::error::ProxyError;
use crate::proxy::protocol::codec::{anthropic, gemini, openai_chat, openai_responses, system_one};
use crate::proxy::protocol::ir::{Request, Response};
use crate::proxy::protocol::Protocol;

pub(crate) fn translate_request(
    from: Protocol,
    to: Protocol,
    body: Value,
) -> Result<Value, ProxyError> {
    if from == to {
        return Ok(body);
    }
    if from == Protocol::SystemOne || to == Protocol::SystemOne {
        return Err(decision_mismatch());
    }
    let request = parse_request(from, body)?;
    build_request(to, &request)
}

pub(crate) fn translate_response(
    from: Protocol,
    to: Protocol,
    body: Value,
) -> Result<Value, ProxyError> {
    if from == to {
        return Ok(body);
    }
    if from == Protocol::SystemOne || to == Protocol::SystemOne {
        return Err(decision_mismatch());
    }
    let response = parse_response(from, body)?;
    build_response(to, &response)
}

pub(crate) fn parse_request(protocol: Protocol, body: Value) -> Result<Request, ProxyError> {
    match protocol {
        Protocol::Anthropic => anthropic::parse_request(body),
        Protocol::Gemini => gemini::parse_request(body),
        Protocol::OpenAiChat => openai_chat::parse_request(body),
        Protocol::OpenAiResponses => openai_responses::parse_request(body),
        Protocol::SystemOne => Err(decision_mismatch()),
    }
}

pub(crate) fn build_request(protocol: Protocol, request: &Request) -> Result<Value, ProxyError> {
    match protocol {
        Protocol::Anthropic => anthropic::build_request(request),
        Protocol::Gemini => gemini::build_request(request),
        Protocol::OpenAiChat => openai_chat::build_request(request),
        Protocol::OpenAiResponses => openai_responses::build_request(request),
        Protocol::SystemOne => Err(decision_mismatch()),
    }
}

pub(crate) fn parse_response(protocol: Protocol, body: Value) -> Result<Response, ProxyError> {
    match protocol {
        Protocol::Anthropic => anthropic::parse_response(body),
        Protocol::Gemini => gemini::parse_response(body),
        Protocol::OpenAiChat => openai_chat::parse_response(body),
        Protocol::OpenAiResponses => openai_responses::parse_response(body),
        Protocol::SystemOne => Err(decision_mismatch()),
    }
}

pub(crate) fn build_response(protocol: Protocol, response: &Response) -> Result<Value, ProxyError> {
    match protocol {
        Protocol::Anthropic => anthropic::build_response(response),
        Protocol::Gemini => gemini::build_response(response),
        Protocol::OpenAiChat => openai_chat::build_response(response),
        Protocol::OpenAiResponses => openai_responses::build_response(response),
        Protocol::SystemOne => Err(decision_mismatch()),
    }
}

pub(crate) fn translate_decision_request(
    from: Protocol,
    to: Protocol,
    body: Value,
) -> Result<Value, ProxyError> {
    if from != Protocol::SystemOne || to != Protocol::SystemOne {
        return Err(decision_mismatch());
    }
    system_one::build_request(&system_one::parse_request(body)?)
}

pub(crate) fn translate_decision_response(
    from: Protocol,
    to: Protocol,
    body: Value,
) -> Result<Value, ProxyError> {
    if from != Protocol::SystemOne || to != Protocol::SystemOne {
        return Err(decision_mismatch());
    }
    system_one::build_response(&system_one::parse_response(body)?)
}

fn decision_mismatch() -> ProxyError {
    ProxyError::InvalidRequest(
        "System One is a typed decision protocol; it cannot be converted to or from chat protocols"
            .into(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proxy::protocol::ir::{Block, StopReason};

    #[test]
    fn gemini_request_translates_to_anthropic_with_thought_signature() {
        let body = serde_json::json!({
            "contents": [
                {"role":"user","parts":[{"text":"read a.txt"}]},
                {"role":"model","parts":[{
                    "functionCall":{"id":"call_1","name":"read","args":{"path":"a.txt"},"thoughtSignature":"sig-1"}
                }]}
            ],
            "tools": [{"functionDeclarations":[{"name":"read","parameters":{"type":"object"}}]}]
        });
        let translated = translate_request(Protocol::Gemini, Protocol::Anthropic, body).unwrap();
        assert_eq!(translated["messages"][1]["content"][0]["type"], "tool_use");
        assert_eq!(translated["messages"][1]["content"][0]["id"], "call_1");
        assert_eq!(translated["tools"][0]["name"], "read");
        // 签名在 IR 里；Anthropic 没有 thoughtSignature 承载点，不能伪造。
        assert!(translated["messages"][1]["content"][0]
            .get("thoughtSignature")
            .is_none());
    }

    #[test]
    fn gemini_response_translates_to_anthropic_and_keeps_usage() {
        let body = serde_json::json!({
            "responseId": "resp-1",
            "modelVersion": "gemini-3-pro",
            "candidates": [{
                "content": {"role":"model","parts":[
                    {"text":"hello"},
                    {"functionCall":{"id":"call_2","name":"search","args":{"q":"x"}}}
                ]},
                "finishReason": "STOP"
            }],
            "usageMetadata": {"promptTokenCount":10,"candidatesTokenCount":3}
        });
        let translated = translate_response(Protocol::Gemini, Protocol::Anthropic, body).unwrap();
        assert_eq!(translated["stop_reason"], "tool_use");
        assert_eq!(translated["content"][0]["text"], "hello");
        assert_eq!(translated["content"][1]["type"], "tool_use");
        assert_eq!(translated["usage"]["input_tokens"], 10);
    }

    #[test]
    fn anthropic_response_translates_to_gemini() {
        let body = serde_json::json!({
            "id": "msg_1",
            "type": "message",
            "model": "claude-sonnet-4-5",
            "content": [{"type":"text","text":"hello"}],
            "stop_reason": "end_turn",
            "usage": {"input_tokens":4,"output_tokens":2}
        });
        let translated = translate_response(Protocol::Anthropic, Protocol::Gemini, body).unwrap();
        assert_eq!(
            translated["candidates"][0]["content"]["parts"][0]["text"],
            "hello"
        );
        assert_eq!(translated["usageMetadata"]["promptTokenCount"], 4);
        assert_eq!(translated["usageMetadata"]["candidatesTokenCount"], 2);
        assert_eq!(translated["candidates"][0]["finishReason"], "STOP");
    }

    #[test]
    fn chat_request_translates_to_gemini_with_tools() {
        let body = serde_json::json!({
            "model": "gpt-6.1-sol",
            "messages": [
                {"role":"system","content":"be terse"},
                {"role":"user","content":"read a.txt"}
            ],
            "tools": [{"type":"function","function":{"name":"read","parameters":{"type":"object"}}}],
            "max_tokens": 64
        });
        let translated = translate_request(Protocol::OpenAiChat, Protocol::Gemini, body).unwrap();
        assert_eq!(
            translated["systemInstruction"]["parts"][0]["text"],
            "be terse"
        );
        assert_eq!(translated["contents"][0]["parts"][0]["text"], "read a.txt");
        assert_eq!(
            translated["tools"][0]["functionDeclarations"][0]["name"],
            "read"
        );
        assert_eq!(translated["generationConfig"]["maxOutputTokens"], 64);
    }

    #[test]
    fn gemini_response_translates_to_chat() {
        let body = serde_json::json!({
            "responseId": "resp-1",
            "modelVersion": "gemini-3-pro",
            "candidates": [{
                "content": {"role":"model","parts":[{"text":"hello"}]},
                "finishReason": "STOP"
            }],
            "usageMetadata": {"promptTokenCount":5,"candidatesTokenCount":2}
        });
        let translated = translate_response(Protocol::Gemini, Protocol::OpenAiChat, body).unwrap();
        assert_eq!(translated["choices"][0]["message"]["content"], "hello");
        assert_eq!(translated["choices"][0]["finish_reason"], "stop");
        assert_eq!(translated["usage"]["prompt_tokens"], 5);
    }

    #[test]
    fn system_one_is_passthrough_only_and_never_faked_as_chat() {
        let body = serde_json::json!({
            "model":"jev-latest",
            "state":{"message":"refund please"},
            "questions":{"refund":{"type":"noul","instructions":"Refund?"}}
        });
        let same =
            translate_decision_request(Protocol::SystemOne, Protocol::SystemOne, body.clone())
                .unwrap();
        assert_eq!(same["model"], "jev-latest");
        assert_eq!(same["questions"]["refund"]["type"], "noul");
        assert!(
            translate_request(Protocol::SystemOne, Protocol::OpenAiChat, body.clone()).is_err()
        );
        assert!(translate_request(
            Protocol::OpenAiChat,
            Protocol::SystemOne,
            serde_json::json!({"model":"gpt","messages":[{"role":"user","content":"hi"}]})
        )
        .is_err());
    }

    #[test]
    fn ir_keeps_gemini_extensions_across_a_gemini_round_trip() {
        let request = parse_request(
            Protocol::Gemini,
            serde_json::json!({
                "contents":[{"role":"user","parts":[{"text":"hi"}]}],
                "generationConfig":{"maxOutputTokens":32,"responseMimeType":"application/json"}
            }),
        )
        .unwrap();
        assert_eq!(request.max_tokens, Some(32));
        assert!(request
            .extensions
            .gemini_generation_config
            .as_ref()
            .is_some_and(|value| value.get("responseMimeType").is_some()));
        let rebuilt = build_request(Protocol::Gemini, &request).unwrap();
        assert_eq!(
            rebuilt["generationConfig"]["responseMimeType"],
            "application/json"
        );
        assert_eq!(rebuilt["generationConfig"]["maxOutputTokens"], 32);

        let response = Response::new("resp-1", "gemini-3-pro");
        let mut response = response;
        response.blocks = vec![Block::Text("ok".into())];
        response.stop_reason = StopReason::EndTurn;
        let built = build_response(Protocol::Gemini, &response).unwrap();
        assert_eq!(built["candidates"][0]["content"]["parts"][0]["text"], "ok");
    }
}
