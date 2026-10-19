//! 协议转换的稳定入口。
//!
//! 转换器按「协议 A → 协议 B」命名，不再以应用入口命名：
//! `responses_to_anthropic`、`responses_to_chat`、`anthropic_to_gemini` …
//! 本模块集中定义四协议的方向类型，并导出各方向的请求、响应与流式函数；
//! 调用方只依赖这里的协议名，不需要知道具体实现文件。
//!
//! 第五种协议 System One（TypeSafe / Jev）是 typed decision 协议，
//! 与聊天协议不同族：它走 `decision` IR 与 `codec::system_one`，
//! 只做 System One 自身的中转，不会伪装成 Chat/Anthropic 文本生成。
//!
//! 聊天协议之间统一走 `ir` + `codec`；同协议直通，异协议经 IR 翻译。

use serde_json::Value;

use crate::proxy::error::ProxyError;

pub mod codec;
pub mod decision;
pub mod ir;
pub(crate) mod translate;

/// 网关认识的四种线协议。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Protocol {
    OpenAiChat,
    OpenAiResponses,
    Anthropic,
    Gemini,
    /// TypeSafe System One（`POST /v1/systemone`），typed decision 协议。
    SystemOne,
}

impl Protocol {
    /// PHI 内部与供应商 `api_format` 使用的协议名。
    #[allow(dead_code)]
    pub const fn as_api_format(self) -> &'static str {
        match self {
            Self::OpenAiChat => "openai_chat",
            Self::OpenAiResponses => "openai_responses",
            Self::Anthropic => "anthropic",
            Self::Gemini => "gemini_native",
            Self::SystemOne => "systemone",
        }
    }

    /// 把供应商配置或路由里出现的协议名归一成协议枚举。
    pub fn from_api_format(format: &str) -> Option<Self> {
        match format.trim().to_ascii_lowercase().as_str() {
            "openai_chat" | "chat" | "openai" => Some(Self::OpenAiChat),
            "openai_responses" | "responses" => Some(Self::OpenAiResponses),
            "anthropic" | "anthropic_messages" | "anthropic-messages" | "claude" | "messages" => {
                Some(Self::Anthropic)
            }
            "gemini_native" | "gemini" | "google" => Some(Self::Gemini),
            "systemone" | "system_one" | "system-one" | "typesafe" | "typesafe_systemone" => {
                Some(Self::SystemOne)
            }
            _ => None,
        }
    }
}

/// 一次转换的方向。阶段 4 的 codec 会以它作为选择键。
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Conversion {
    pub from: Protocol,
    pub to: Protocol,
}

#[allow(dead_code)]
impl Conversion {
    pub const fn new(from: Protocol, to: Protocol) -> Self {
        Self { from, to }
    }

    /// 两端协议相同，转发层应当逐字节直通。
    pub fn is_passthrough(self) -> bool {
        self.from == self.to
    }
}

/// 请求体转换：源协议请求 → 目标协议请求。
#[allow(dead_code)]
pub type RequestTransform = fn(Value) -> Result<Value, ProxyError>;

/// 响应体转换：目标协议响应 → 源协议响应。
#[allow(dead_code)]
pub type ResponseTransform = fn(Value) -> Result<Value, ProxyError>;

/// 现有方向实现的统一导出。
///
/// 保留各转换器原有的上下文参数重载；`RequestTransform`/`ResponseTransform`
/// 只覆盖不需要额外上下文的简单形状，供后续 IR 迁移时替换。
#[allow(unused_imports)]
pub(crate) mod conversions {
    pub(crate) use crate::proxy::providers::chat_to_anthropic::{
        anthropic_response_to_chat, chat_request_to_anthropic,
    };
    pub(crate) use crate::proxy::providers::responses_to_anthropic::{
        anthropic_response_to_responses, anthropic_response_to_responses_with_context,
        anthropic_sse_to_message_value, build_responses_usage_from_anthropic,
        decode_anthropic_thinking_block, encode_anthropic_thinking_block,
        map_anthropic_stop_reason_to_status, responses_request_to_anthropic,
    };
    pub(crate) use crate::proxy::providers::responses_to_chat::{
        build_codex_tool_context_from_request, chat_completion_to_response,
        chat_completion_to_response_with_context, chat_error_to_response_error,
        responses_to_chat_completions, responses_to_chat_completions_with_reasoning,
        CodexToolContext,
    };
    pub(crate) use crate::proxy::providers::streaming_anthropic_to_chat::create_chat_sse_stream_from_anthropic;
    pub(crate) use crate::proxy::providers::streaming_gemini::create_anthropic_sse_stream_from_gemini;
    pub(crate) use crate::proxy::providers::streaming_responses_to_anthropic::{
        create_responses_sse_stream_from_anthropic,
        create_responses_sse_stream_from_anthropic_with_context,
    };
    pub(crate) use crate::proxy::providers::streaming_responses_to_chat::{
        create_responses_sse_stream_from_chat, create_responses_sse_stream_from_chat_with_context,
    };
    pub(crate) use crate::proxy::providers::transform_gemini::{
        anthropic_to_gemini, anthropic_to_gemini_with_shadow, gemini_to_anthropic,
        gemini_to_anthropic_with_shadow, gemini_to_anthropic_with_shadow_and_hints,
    };
}

/// 顶层也暴露 `protocol::<方向函数>`，调用方无需再关心实现模块。
#[allow(unused_imports)]
pub(crate) use conversions::*;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_format_round_trips_every_protocol() {
        for protocol in [
            Protocol::OpenAiChat,
            Protocol::OpenAiResponses,
            Protocol::Anthropic,
            Protocol::Gemini,
            Protocol::SystemOne,
        ] {
            assert_eq!(
                Protocol::from_api_format(protocol.as_api_format()),
                Some(protocol)
            );
        }
        assert_eq!(
            Protocol::from_api_format("openai"),
            Some(Protocol::OpenAiChat)
        );
        assert_eq!(
            Protocol::from_api_format("claude"),
            Some(Protocol::Anthropic)
        );
        assert_eq!(
            Protocol::from_api_format("system_one"),
            Some(Protocol::SystemOne)
        );
        assert_eq!(Protocol::from_api_format("unknown"), None);
    }

    #[test]
    fn conversion_reports_passthrough_only_for_same_protocol() {
        assert!(Conversion::new(Protocol::Anthropic, Protocol::Anthropic).is_passthrough());
        assert!(!Conversion::new(Protocol::OpenAiResponses, Protocol::Anthropic).is_passthrough());
    }
}
