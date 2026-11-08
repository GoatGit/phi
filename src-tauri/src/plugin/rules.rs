//! 声明式规则引擎。
//!
//! 规则是清单里的一段 JSON，不是代码：宿主编译一次、热路径只做遍历与替换。
//! 路径语法见 [`DeclarativeRule::path`](super::manifest::DeclarativeRule)，`*`
//! 同时匹配对象的所有键与数组的所有元素，因此 `messages.*.content` 既能处理
//! 多轮消息，也能处理多模态内容数组。

use serde_json::Value;

use super::manifest::{DeclarativeOp, DeclarativeRule};

const DEFAULT_REPLACEMENT: &str = "[REDACTED]";

#[derive(Debug, Clone, PartialEq, Eq)]
enum PathSegment {
    Key(String),
    Any,
}

#[derive(Debug, Clone)]
struct CompiledRule {
    op: DeclarativeOp,
    segments: Vec<PathSegment>,
    pattern: Option<regex::Regex>,
    replacement: String,
}

/// 编译后的规则集合：构造时校验正则，失败即整个插件不可用。
pub struct CompiledRules {
    rules: Vec<CompiledRule>,
}

impl CompiledRules {
    /// 编译规则；任何一条正则非法都返回带序号的错误。
    pub fn compile(rules: &[DeclarativeRule]) -> Result<Self, String> {
        let mut compiled = Vec::with_capacity(rules.len());
        for (index, rule) in rules.iter().enumerate() {
            let segments = parse_path(&rule.path)
                .map_err(|message| format!("第 {index} 条规则路径非法: {message}"))?;
            let pattern = match &rule.pattern {
                Some(pattern) => Some(
                    regex::Regex::new(pattern)
                        .map_err(|err| format!("第 {index} 条规则正则非法: {err}"))?,
                ),
                None => None,
            };
            compiled.push(CompiledRule {
                op: rule.op,
                segments,
                pattern,
                replacement: rule
                    .replacement
                    .clone()
                    .unwrap_or_else(|| DEFAULT_REPLACEMENT.to_string()),
            });
        }
        Ok(Self { rules: compiled })
    }

    /// 按声明顺序应用所有规则，返回命中的字段/替换次数。
    pub fn apply(&self, body: &mut Value) -> usize {
        let mut hits = 0;
        for rule in &self.rules {
            apply_rule(body, rule, &rule.segments, &mut hits);
        }
        hits
    }

    pub fn is_empty(&self) -> bool {
        self.rules.is_empty()
    }
}

fn parse_path(path: &str) -> Result<Vec<PathSegment>, String> {
    let mut segments = Vec::new();
    for raw in path.split('.') {
        if raw.is_empty() {
            return Err("路径含空段".to_string());
        }
        if raw == "*" {
            segments.push(PathSegment::Any);
        } else {
            segments.push(PathSegment::Key(raw.to_string()));
        }
    }
    if segments.is_empty() {
        return Err("路径为空".to_string());
    }
    Ok(segments)
}

fn apply_rule(value: &mut Value, rule: &CompiledRule, segments: &[PathSegment], hits: &mut usize) {
    let Some((segment, rest)) = segments.split_first() else {
        return;
    };
    match value {
        Value::Object(map) => {
            let keys: Vec<String> = match segment {
                PathSegment::Key(key) => {
                    if map.contains_key(key) {
                        vec![key.clone()]
                    } else {
                        Vec::new()
                    }
                }
                PathSegment::Any => map.keys().cloned().collect(),
            };
            for key in keys {
                if rest.is_empty() {
                    match rule.op {
                        DeclarativeOp::Remove => {
                            if map.remove(&key).is_some() {
                                *hits += 1;
                            }
                        }
                        DeclarativeOp::Mask => {
                            if let Some(entry) = map.get_mut(&key) {
                                mask_value(entry, rule, hits);
                            }
                        }
                    }
                } else if let Some(entry) = map.get_mut(&key) {
                    apply_rule(entry, rule, rest, hits);
                }
            }
        }
        Value::Array(items) => match segment {
            PathSegment::Any => {
                if rest.is_empty() {
                    match rule.op {
                        DeclarativeOp::Remove => {
                            *hits += items.len();
                            items.clear();
                        }
                        DeclarativeOp::Mask => {
                            for item in items.iter_mut() {
                                mask_value(item, rule, hits);
                            }
                        }
                    }
                } else {
                    for item in items.iter_mut() {
                        apply_rule(item, rule, rest, hits);
                    }
                }
            }
            PathSegment::Key(key) => {
                let Ok(index) = key.parse::<usize>() else {
                    return;
                };
                if index >= items.len() {
                    return;
                }
                if rest.is_empty() {
                    match rule.op {
                        DeclarativeOp::Remove => {
                            items.remove(index);
                            *hits += 1;
                        }
                        DeclarativeOp::Mask => {
                            mask_value(&mut items[index], rule, hits);
                        }
                    }
                } else {
                    apply_rule(&mut items[index], rule, rest, hits);
                }
            }
        },
        _ => {}
    }
}

fn mask_value(value: &mut Value, rule: &CompiledRule, hits: &mut usize) {
    let Value::String(text) = value else {
        return;
    };
    match &rule.pattern {
        Some(pattern) => {
            let count = pattern.find_iter(text).count();
            if count > 0 {
                *text = pattern
                    .replace_all(text, rule.replacement.as_str())
                    .into_owned();
                *hits += count;
            }
        }
        None => {
            if text.as_str() != rule.replacement {
                *text = rule.replacement.clone();
                *hits += 1;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rules(items: Value) -> CompiledRules {
        let rules: Vec<DeclarativeRule> = serde_json::from_value(items).expect("rules");
        CompiledRules::compile(&rules).expect("compile")
    }

    #[test]
    fn removes_nested_key_under_wildcards() {
        let compiled = rules(json!([{"op":"remove","path":"messages.*.secret"}]));
        let mut body = json!({
            "messages": [
                {"role":"user","secret":"x"},
                {"role":"assistant","secret":"y","content":"ok"}
            ]
        });
        assert_eq!(compiled.apply(&mut body), 2);
        assert_eq!(body["messages"][1]["content"], json!("ok"));
        assert!(body["messages"][0].get("secret").is_none());
    }

    #[test]
    fn masks_array_elements_by_numeric_index() {
        let compiled = rules(json!([{
            "op":"mask","path":"tags.0","pattern":"^internal$","replacement":"public"
        }]));
        let mut body = json!({"tags":["internal","internal"]});
        assert_eq!(compiled.apply(&mut body), 1);
        assert_eq!(body, json!({"tags":["public","internal"]}));
    }

    #[test]
    fn masks_every_string_without_pattern() {
        let compiled = rules(json!([{"op":"mask","path":"notes.*"}]));
        let mut body = json!({"notes":["a","",1,null]});
        assert_eq!(compiled.apply(&mut body), 2);
        assert_eq!(body, json!({"notes":["[REDACTED]","[REDACTED]",1,null]}));
    }

    #[test]
    fn removing_all_array_elements_only_matches_wildcard() {
        let compiled = rules(json!([{"op":"remove","path":"a.*"}]));
        let mut body = json!({"a":[1,2,3],"b":[1]});
        assert_eq!(compiled.apply(&mut body), 3);
        assert_eq!(body, json!({"a":[],"b":[1]}));
    }

    #[test]
    fn missing_paths_are_noops() {
        let compiled = rules(json!([{"op":"remove","path":"nope.deep.path"}]));
        let mut body = json!({"a":1});
        assert_eq!(compiled.apply(&mut body), 0);
        assert_eq!(body, json!({"a":1}));
    }

    #[test]
    fn invalid_regex_is_reported_with_index() {
        let parsed: Vec<DeclarativeRule> =
            serde_json::from_value(json!([{"op":"mask","path":"a","pattern":"("}])).unwrap();
        let err = CompiledRules::compile(&parsed)
            .err()
            .expect("invalid regex is rejected");
        assert!(err.contains("第 0 条"), "{err}");
    }

    #[test]
    fn masking_is_idempotent() {
        let compiled = rules(json!([{"op":"mask","path":"a"}]));
        let mut body = json!({"a":"secret"});
        assert_eq!(compiled.apply(&mut body), 1);
        assert_eq!(compiled.apply(&mut body), 0);
        assert_eq!(body, json!({"a":"[REDACTED]"}));
    }

    #[test]
    fn string_values_are_not_masked_by_remove_op() {
        let compiled = rules(json!([{"op":"mask","path":"a.b","pattern":"x"}]));
        let mut body = json!({"a":{"b":42}});
        assert_eq!(compiled.apply(&mut body), 0);
        assert_eq!(body, json!({"a":{"b":42}}));
    }
}
