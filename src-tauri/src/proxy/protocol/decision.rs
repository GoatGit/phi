//! System One（TypeSafe / Jev）的决策请求与响应。
//!
//! 它和聊天协议不是同一类东西：请求是「一段 state + 一组 typed questions」，
//! 响应是「每个问题的 typed answer + 概率/置信度」。因此不复用聊天的 IR
//! 消息结构，也不做聊天 ↔ 决策的伪转换。

use std::collections::BTreeMap;

use serde_json::Value;

use crate::proxy::protocol::ir::Usage;

#[derive(Debug, Clone, PartialEq)]
pub struct Request {
    pub model: String,
    pub state: Value,
    /// 问题 id → 原始 Question 对象（type / instructions / criteria）。
    pub questions: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Response {
    pub model: String,
    /// 问题 id → 原始 Answer 对象（choice/score/noul/box + 概率）。
    pub answers: BTreeMap<String, Value>,
    pub usage: Usage,
}

impl Request {
    pub fn new(model: impl Into<String>, state: Value) -> Self {
        Self {
            model: model.into(),
            state,
            questions: BTreeMap::new(),
        }
    }
}

impl Response {
    pub fn new(model: impl Into<String>) -> Self {
        Self {
            model: model.into(),
            answers: BTreeMap::new(),
            usage: Usage::default(),
        }
    }
}
