//! 各线协议的 codec：线格式 → [`crate::proxy::protocol::ir`] → 线格式。
//!
//! 除 `system_one` 外，这些 codec 是 IR 化的迁移底座：形状与单测都已落地，但还
//! 没有被转发路径调用。允许死代码，避免为了消警告去伪造一个假的调用者。

#![allow(dead_code)]

pub(crate) mod anthropic;
pub(crate) mod gemini;
pub(crate) mod openai_chat;
pub(crate) mod openai_responses;
pub(crate) mod system_one;
