//! 协议无关的中间表示（IR）。
//!
//! 四协议（OpenAI Chat、OpenAI Responses、Anthropic Messages、Gemini
//! generateContent）先在 codec 里解析成这里的中性形状，再由目标 codec 构建。
//! 这样厂商特有的字段不会因为先落到另一家协议而被丢掉：
//!
//! - Gemini：`thoughtSignature`、`groundingMetadata`、`safetyRatings`、
//!   `citationMetadata`、`promptFeedback`；
//! - Anthropic：thinking block 的 `signature`；
//! - 两家的工具调用 id / 工具结果关联。

use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Role {
    User,
    Assistant,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ImageSource {
    Base64 { media_type: String, data: String },
    Url(String),
}

#[derive(Debug, Clone, PartialEq)]
pub enum Block {
    Text(String),
    Image(ImageSource),
    /// 模型发起的工具调用。`thought_signature` 只在 Gemini 系模型上出现，
    /// 跨协议时必须一路带着，下一轮工具结果才能被上游接受。
    ToolUse {
        id: String,
        name: String,
        input: Value,
        thought_signature: Option<String>,
    },
    /// 工具结果。`content` 保留原始 JSON 或字符串，避免不同厂商的包裹形状
    /// 在 IR 里被拍平。
    ToolResult {
        tool_use_id: String,
        name: Option<String>,
        content: Value,
        is_error: bool,
    },
    /// 扩展思考。`signature` 是 Anthropic 的签名块；Gemini 的
    /// `thoughtSignature` 也可放在这里。
    Thinking {
        text: String,
        signature: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct Message {
    pub role: Role,
    pub blocks: Vec<Block>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Tool {
    pub name: String,
    pub description: Option<String>,
    pub input_schema: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolChoice {
    Auto,
    Required,
    None,
    Tool(String),
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct RequestExtensions {
    /// Gemini 的 generationConfig 里不属于通用字段的部分（responseSchema、
    /// responseMimeType、thinkingConfig 等）。
    pub gemini_generation_config: Option<Value>,
    /// Anthropic 的 thinking / output_config 等。
    pub anthropic_thinking: Option<Value>,
    pub anthropic_output_config: Option<Value>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Request {
    pub model: String,
    pub system: Vec<String>,
    pub messages: Vec<Message>,
    pub tools: Vec<Tool>,
    pub tool_choice: ToolChoice,
    pub max_tokens: Option<u64>,
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub stream: bool,
    pub stop: Vec<String>,
    /// Chat / Codex 的 reasoning effort；由目标 codec 决定映射成
    /// Anthropic thinking、Gemini thinkingConfig 或忽略。
    pub reasoning_effort: Option<String>,
    pub extensions: RequestExtensions,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StopReason {
    EndTurn,
    MaxTokens,
    ToolUse,
    StopSequence,
    ContentFilter,
    Other(String),
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_input_tokens: u64,
    pub cache_creation_input_tokens: u64,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ResponseExtensions {
    pub gemini_grounding_metadata: Option<Value>,
    pub gemini_safety_ratings: Option<Value>,
    pub gemini_citation_metadata: Option<Value>,
    pub gemini_prompt_feedback: Option<Value>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Response {
    pub id: String,
    pub model: String,
    pub blocks: Vec<Block>,
    pub stop_reason: StopReason,
    pub usage: Usage,
    pub extensions: ResponseExtensions,
}

impl Request {
    pub fn new(model: impl Into<String>) -> Self {
        Self {
            model: model.into(),
            system: Vec::new(),
            messages: Vec::new(),
            tools: Vec::new(),
            tool_choice: ToolChoice::Auto,
            max_tokens: None,
            temperature: None,
            top_p: None,
            stream: false,
            stop: Vec::new(),
            reasoning_effort: None,
            extensions: RequestExtensions::default(),
        }
    }
}

impl Response {
    pub fn new(id: impl Into<String>, model: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            model: model.into(),
            blocks: Vec::new(),
            stop_reason: StopReason::EndTurn,
            usage: Usage::default(),
            extensions: ResponseExtensions::default(),
        }
    }
}

/// 取一段文本块里的文字，供 codec 拼接 system / 纯文本响应。
pub fn text_of(blocks: &[Block]) -> String {
    let mut text = String::new();
    for block in blocks {
        if let Block::Text(value) = block {
            text.push_str(value);
        }
    }
    text
}
