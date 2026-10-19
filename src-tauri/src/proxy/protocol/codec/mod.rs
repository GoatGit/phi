//! 各线协议的 codec：线格式 → [`crate::proxy::protocol::ir`] → 线格式。

pub(crate) mod anthropic;
pub(crate) mod gemini;
pub(crate) mod openai_chat;
pub(crate) mod openai_responses;
pub(crate) mod system_one;
