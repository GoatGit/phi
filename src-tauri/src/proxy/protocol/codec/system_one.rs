//! System One（`POST /v1/systemone`）↔ 决策 IR。
//!
//! 只接受官方顶层字段 `state` / `model` / `questions`，并保留每个 question
//! 与 answer 的原始 JSON，避免丢掉 probabilities、legend、confidence 等
//! 决策协议特有的形状。

use std::collections::BTreeMap;

use serde_json::{json, Value};

use crate::proxy::error::ProxyError;
use crate::proxy::protocol::decision::{Request, Response};
use crate::proxy::protocol::ir::Usage;

const QUESTION_TYPES: [&str; 4] = ["noul", "choice", "score", "box"];

pub(crate) fn parse_request(body: Value) -> Result<Request, ProxyError> {
    let object = body.as_object().ok_or_else(|| invalid("body"))?;
    for key in object.keys() {
        if !matches!(key.as_str(), "state" | "model" | "questions") {
            return Err(invalid(key));
        }
    }
    let model = object
        .get("model")
        .and_then(Value::as_str)
        .filter(|model| !model.is_empty())
        .ok_or_else(|| invalid("model"))?;
    let state = object
        .get("state")
        .filter(|state| matches!(state, Value::String(_) | Value::Object(_) | Value::Array(_)))
        .cloned()
        .ok_or_else(|| invalid("state"))?;
    let questions = object
        .get("questions")
        .and_then(Value::as_object)
        .filter(|questions| !questions.is_empty())
        .ok_or_else(|| invalid("questions"))?;

    let mut parsed = BTreeMap::new();
    for (id, question) in questions {
        let question = question
            .as_object()
            .ok_or_else(|| invalid("questions.<id>"))?;
        let kind = question
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("questions.<id>.type"))?;
        if !QUESTION_TYPES.contains(&kind) {
            return Err(invalid("questions.<id>.type"));
        }
        match question.get("instructions") {
            Some(Value::String(text)) if text.trim().is_empty() => {
                return Err(invalid("questions.<id>.instructions"));
            }
            Some(Value::String(_) | Value::Object(_) | Value::Array(_)) => {}
            _ => return Err(invalid("questions.<id>.instructions")),
        }
        parsed.insert(id.clone(), Value::Object(question.clone()));
    }

    Ok(Request {
        model: model.to_string(),
        state,
        questions: parsed,
    })
}

pub(crate) fn build_request(request: &Request) -> Result<Value, ProxyError> {
    if request.model.is_empty() {
        return Err(invalid("model"));
    }
    if request.questions.is_empty() {
        return Err(invalid("questions"));
    }
    Ok(json!({
        "model": request.model.as_str(),
        "state": request.state.clone(),
        "questions": request.questions.clone(),
    }))
}

pub(crate) fn parse_response(body: Value) -> Result<Response, ProxyError> {
    let object = body.as_object().ok_or_else(|| invalid("body"))?;
    let model = object
        .get("model")
        .and_then(Value::as_str)
        .filter(|model| !model.is_empty())
        .ok_or_else(|| invalid("model"))?;
    let answers = object
        .get("answers")
        .and_then(Value::as_object)
        .ok_or_else(|| invalid("answers"))?;
    let mut parsed = BTreeMap::new();
    for (id, answer) in answers {
        let answer = answer.as_object().ok_or_else(|| invalid("answers.<id>"))?;
        let kind = answer
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("answers.<id>.type"))?;
        if !QUESTION_TYPES.contains(&kind) {
            return Err(invalid("answers.<id>.type"));
        }
        parsed.insert(id.clone(), Value::Object(answer.clone()));
    }
    Ok(Response {
        model: model.to_string(),
        answers: parsed,
        usage: parse_usage(object.get("usage"))?,
    })
}

pub(crate) fn build_response(response: &Response) -> Result<Value, ProxyError> {
    if response.model.is_empty() {
        return Err(invalid("model"));
    }
    let mut result = json!({
        "model": response.model.as_str(),
        "answers": response.answers.clone(),
    });
    if response.usage != Usage::default() {
        result["usage"] = json!({
            "input_tokens": response.usage.input_tokens,
            "output_tokens": response.usage.output_tokens,
        });
    }
    Ok(result)
}

fn parse_usage(value: Option<&Value>) -> Result<Usage, ProxyError> {
    let Some(value) = value else {
        return Ok(Usage::default());
    };
    let object = value.as_object().ok_or_else(|| invalid("usage"))?;
    let number = |key: &str| -> Result<u64, ProxyError> {
        match object.get(key) {
            Some(Value::Null) | None => Ok(0),
            Some(value) => value.as_u64().ok_or_else(|| invalid("usage")),
        }
    };
    Ok(Usage {
        input_tokens: number("input_tokens")?,
        output_tokens: number("output_tokens")?,
        ..Usage::default()
    })
}

fn invalid(field: &str) -> ProxyError {
    ProxyError::InvalidRequest(format!("invalid System One {field}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_round_trip_preserves_typed_questions() {
        let body = json!({
            "model": "jev-latest",
            "state": {"message":"I was charged twice."},
            "questions": {
                "refund": {
                    "type":"noul",
                    "instructions":"Does the customer request a refund?",
                    "criteria":{"true":"Explicitly asks for money back","false":"No"}
                },
                "department": {
                    "type":"choice",
                    "instructions":"Which team should handle this?",
                    "criteria":{"billing":null,"technical":["bug","outage"]}
                },
                "severity": {
                    "type":"score",
                    "instructions":"How severe is it?",
                    "criteria":["cosmetic","workaround","blocking"]
                }
            }
        });
        let request = parse_request(body).unwrap();
        assert_eq!(request.model, "jev-latest");
        assert_eq!(request.questions.len(), 3);
        let rebuilt = build_request(&request).unwrap();
        assert_eq!(rebuilt["questions"]["refund"]["type"], "noul");
        assert_eq!(
            rebuilt["questions"]["department"]["criteria"]["technical"][1],
            "outage"
        );
        assert_eq!(rebuilt["state"]["message"], "I was charged twice.");
    }

    #[test]
    fn request_rejects_unknown_type_or_missing_instructions() {
        for question in [
            json!({"type":"unknown","instructions":"x"}),
            json!({"type":"noul"}),
            json!({"type":"noul","instructions":42}),
        ] {
            let body = json!({
                "model":"jev-latest",
                "state":"x",
                "questions":{"q":question}
            });
            assert!(parse_request(body).is_err());
        }
        assert!(parse_request(json!({"model":"jev-latest","state":"x"})).is_err());
        assert!(parse_request(json!({"model":"jev-latest","state":"x","questions":{}})).is_err());
    }

    #[test]
    fn response_round_trip_preserves_probabilities_and_confidence() {
        let body = json!({
            "model": "jev-1.14.0",
            "answers": {
                "department": {
                    "type":"choice",
                    "choice":"technical",
                    "probabilities":{"billing":0.08,"technical":0.85,"sales":0.07},
                    "confidence":0.82
                },
                "frustration": {
                    "type":"score",
                    "score":1.6,
                    "legend":{"0":"Calm","1":"Frustrated","2":"Very angry"},
                    "probabilities":{"0":0.05,"1":0.3,"2":0.65},
                    "confidence":0.78
                },
                "refund": {"type":"noul","noul":0.95}
            },
            "usage": {"input_tokens":312,"output_tokens":48}
        });
        let response = parse_response(body).unwrap();
        assert_eq!(response.answers.len(), 3);
        assert_eq!(response.usage.input_tokens, 312);
        let rebuilt = build_response(&response).unwrap();
        assert_eq!(rebuilt["answers"]["department"]["choice"], "technical");
        assert_eq!(
            rebuilt["answers"]["department"]["probabilities"]["technical"],
            0.85
        );
        assert_eq!(
            rebuilt["answers"]["frustration"]["legend"]["2"],
            "Very angry"
        );
        assert_eq!(rebuilt["answers"]["refund"]["noul"], 0.95);
        assert_eq!(rebuilt["usage"]["input_tokens"], 312);
    }
}
