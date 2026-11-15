//! 谓词层：把「像不像 / 值不值得 / 哪一类」问给 Jev。
//!
//! 这里只做三件事：拼请求、解析答案、把「判官不确定」翻译成一个明确的返回值。
//! 任何阈值判断都不在这里——阈值是确定性规则，属于 [`crate::super_agent::tick`]。
//!
//! 调用走 phi 自己的代理（`/typesafe/v1/systemone` 的进程内入口），因此故障转移、
//! 成本记账、路由分组与其它协议一致，不需要额外对接供应商。

use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde::Serialize;
use serde_json::{json, Map, Value};

use crate::Database;

pub(crate) type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// System One 只接受这四种题型。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum QuestionKind {
    Noul,
    Choice,
    #[allow(dead_code)] // 有序打分，闸门接入后启用。
    Score,
}

impl QuestionKind {
    fn as_str(self) -> &'static str {
        match self {
            QuestionKind::Noul => "noul",
            QuestionKind::Choice => "choice",
            QuestionKind::Score => "score",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Question {
    pub kind: QuestionKind,
    pub instructions: String,
    /// choice 的封闭候选。**由代码给**，不让模型编。
    pub options: Vec<String>,
}

impl Question {
    pub(crate) fn noul(instructions: impl Into<String>) -> Self {
        Self {
            kind: QuestionKind::Noul,
            instructions: instructions.into(),
            options: Vec::new(),
        }
    }

    #[allow(dead_code)] // 闸门与 sidecar episode 的 worker 选择用；当前只有 noul 分桶在用。
    pub(crate) fn choice(instructions: impl Into<String>, options: Vec<String>) -> Self {
        Self {
            kind: QuestionKind::Choice,
            instructions: instructions.into(),
            options,
        }
    }

    fn to_json(&self) -> Value {
        let mut body = Map::new();
        body.insert("type".into(), json!(self.kind.as_str()));
        body.insert("instructions".into(), json!(self.instructions));
        if self.kind == QuestionKind::Choice {
            let criteria: Map<String, Value> = self
                .options
                .iter()
                .map(|option| (option.clone(), Value::Null))
                .collect();
            body.insert("criteria".into(), Value::Object(criteria));
        }
        Value::Object(body)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum JudgeError {
    /// 路由里没有可用的判官（没配 typesafe 组、或组里没有供应商）。
    Unavailable(String),
    /// 上游回了错误、超时，或者回包不是合法 JSON。
    Failed(String),
    /// 回包里没有这个问题，或形状不认识。
    Unusable(String),
}

impl JudgeError {
    /// 给 trace 用的一句话，不含内部堆栈。
    pub(crate) fn reason(&self) -> String {
        match self {
            JudgeError::Unavailable(reason)
            | JudgeError::Failed(reason)
            | JudgeError::Unusable(reason) => reason.clone(),
        }
    }
}

#[derive(Clone, Debug, Default)]
pub(crate) struct JudgeReply {
    pub answers: BTreeMap<String, Value>,
}

impl JudgeReply {
    /// noul：概率。返回 None 表示这个问题没有答案。
    pub(crate) fn noul(&self, id: &str) -> Option<f64> {
        self.answers
            .get(id)
            .and_then(|answer| answer.get("noul"))
            .and_then(Value::as_f64)
            .map(|value| value.clamp(0.0, 1.0))
    }

    /// choice：得票最高的选项与 top1 - top2 的差距。
    #[allow(dead_code)] // 供 sidecar 版 episode 的闸门使用；规则版 episode 不调它。
    ///
    /// 差距为 0 表示「判官也不确定」（没有 probabilities 或概率并列），
    /// 调用方必须按不确定处理，不能赌第一个。
    pub(crate) fn choice_with_margin(&self, id: &str) -> Option<(String, f64)> {
        let answer = self.answers.get(id)?;
        let choice = answer.get("choice").and_then(Value::as_str)?;
        let mut ranked: Vec<f64> = answer
            .get("probabilities")
            .and_then(Value::as_object)
            .map(|probabilities| {
                probabilities
                    .values()
                    .filter_map(Value::as_f64)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        ranked.sort_by(|a, b| b.partial_cmp(a).unwrap_or(std::cmp::Ordering::Equal));
        let margin = match ranked.as_slice() {
            [first, second, ..] => (first - second).max(0.0),
            _ => 0.0,
        };
        Some((choice.to_string(), margin))
    }

    #[allow(dead_code)]
    pub(crate) fn score(&self, id: &str) -> Option<f64> {
        self.answers
            .get(id)
            .and_then(|answer| answer.get("score"))
            .and_then(Value::as_f64)
    }
}

pub(crate) trait Judge: Send + Sync {
    fn ask<'a>(
        &'a self,
        model: &'a str,
        state: Value,
        questions: BTreeMap<String, Question>,
    ) -> BoxFuture<'a, Result<JudgeReply, JudgeError>>;
}

/// 真正问 Jev 的实现：走 phi 代理的进程内入口。
pub(crate) struct SystemOneJudge {
    db: Arc<Database>,
}

impl SystemOneJudge {
    pub(crate) fn new(db: Arc<Database>) -> Self {
        Self { db }
    }
}

impl Judge for SystemOneJudge {
    fn ask<'a>(
        &'a self,
        model: &'a str,
        state: Value,
        questions: BTreeMap<String, Question>,
    ) -> BoxFuture<'a, Result<JudgeReply, JudgeError>> {
        Box::pin(async move {
            if questions.is_empty() {
                return Err(JudgeError::Unusable("questions is empty".into()));
            }
            let body = json!({
                "model": model,
                "state": state,
                "questions": questions
                    .iter()
                    .map(|(id, question)| (id.clone(), question.to_json()))
                    .collect::<Map<String, Value>>(),
            });
            let response = crate::proxy::ask_system_one(self.db.clone(), body)
                .await
                .map_err(|reason| {
                    // 「没有可用路由」和「上游失败」要分开：前者是配置问题，
                    // 后者是抖动。两者在 trace 里都应该能一眼认出来。
                    if reason.contains("NoAvailableProvider") || reason.contains("no route group") {
                        JudgeError::Unavailable(reason)
                    } else {
                        JudgeError::Failed(reason)
                    }
                })?;
            parse_reply(response)
        })
    }
}

fn parse_reply(body: Value) -> Result<JudgeReply, JudgeError> {
    let answers = body
        .get("answers")
        .and_then(Value::as_object)
        .ok_or_else(|| JudgeError::Unusable("response has no answers".into()))?;
    let mut parsed = BTreeMap::new();
    for (id, answer) in answers {
        if answer.is_object() {
            parsed.insert(id.clone(), answer.clone());
        }
    }
    Ok(JudgeReply { answers: parsed })
}

/// 判官给出的答案在阈值上算不算「确定」。
///
/// 这是唯一允许把概率变成布尔的地方，而且必须由确定性规则收口：
/// 概率只用来告诉人「有多确定」，边界永远由阈值决定。
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Thresholds {
    pub act: f64,
    pub needs_human: f64,
    pub margin: f64,
}

impl Default for Thresholds {
    fn default() -> Self {
        Self {
            act: 0.6,
            needs_human: 0.7,
            margin: 0.25,
        }
    }
}

impl Thresholds {
    pub(crate) fn should_act(&self, probability: Option<f64>) -> bool {
        probability.is_some_and(|value| value >= self.act)
    }

    #[allow(dead_code)] // 闸门的「该不该打扰人」这一档，随 sidecar episode 一起启用。
    pub(crate) fn needs_human(&self, probability: Option<f64>) -> bool {
        probability.is_some_and(|value| value >= self.needs_human)
    }

    /// 选项可信：差距达到 margin，且选项在封闭候选里。
    #[allow(dead_code)]
    pub(crate) fn confident_choice(
        &self,
        choice: Option<(String, f64)>,
        options: &[String],
    ) -> Option<String> {
        let (choice, margin) = choice?;
        if margin < self.margin || !options.iter().any(|option| option == &choice) {
            return None;
        }
        Some(choice)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reply(value: Value) -> JudgeReply {
        parse_reply(json!({ "model": "jev", "answers": value })).expect("reply")
    }

    #[test]
    fn noul_is_clamped_to_probability_range() {
        let reply = reply(json!({
            "a": {"type":"noul","noul":1.4},
            "b": {"type":"noul","noul":-0.2}
        }));
        assert_eq!(reply.noul("a"), Some(1.0));
        assert_eq!(reply.noul("b"), Some(0.0));
        assert_eq!(reply.noul("missing"), None);
    }

    #[test]
    fn choice_margin_separates_clear_wins_from_ties() {
        let reply = reply(json!({
            "clear": {"type":"choice","choice":"claude","probabilities":{"claude":0.8,"codex":0.2}},
            "tie": {"type":"choice","choice":"claude","probabilities":{"claude":0.45,"codex":0.45}},
            "bare": {"type":"choice","choice":"claude"}
        }));
        let (choice, margin) = reply.choice_with_margin("clear").expect("clear");
        assert_eq!(choice, "claude");
        assert!((margin - 0.6).abs() < 1e-9);
        assert_eq!(reply.choice_with_margin("tie").map(|(_, m)| m), Some(0.0));
        assert_eq!(reply.choice_with_margin("bare").map(|(_, m)| m), Some(0.0));
    }

    #[test]
    fn thresholds_refuse_uncertain_choices() {
        let thresholds = Thresholds::default();
        let options = vec!["claude".to_string(), "codex".to_string()];
        assert_eq!(
            thresholds.confident_choice(Some(("claude".into(), 0.6)), &options),
            Some("claude".into())
        );
        // 差距不够：判官也不确定，按「没有答案」处理。
        assert_eq!(
            thresholds.confident_choice(Some(("claude".into(), 0.05)), &options),
            None
        );
        // 不在封闭候选里：模型编的选项一律不认。
        assert_eq!(
            thresholds.confident_choice(Some(("gpt".into(), 0.9)), &options),
            None
        );
        assert!(!thresholds.should_act(None));
        assert!(thresholds.should_act(Some(0.61)));
        assert!(!thresholds.needs_human(Some(0.69)));
    }
}
