//! 脱敏引擎：把配置编译成一组「正则 + 处置」并在文本 / JSON 上执行。
//!
//! 三个刻意的约束：
//! 1. 只脱敏**命中的形状**，不做「看起来像密钥」的猜测——误伤 prompt 内容比漏一个
//!    形状更糟（用户会立刻发现功能坏了，然后关掉整个功能）。
//! 2. 替换文本自带检测器名（`[REDACTED:email]`），既保留了「这里被脱敏过」的信号，
//!    又不泄露原值；重复执行不会再命中（幂等）。
//! 3. 超长字符串（媒体 base64、`data:` URL）不扫描：正则扫 MB 级 base64 只会拖慢
//!    请求，且这些位置本来就不是凭据出现的地方。

use serde_json::Value;

use super::config::{PrivacyConfig, RedactionAction, RedactionRuleConfig};
use super::detectors::{luhn_valid, DetectorKind};

/// 单条字符串的扫描上限；超过就跳过（见模块文档第 3 条）。
pub const MAX_SCANNED_STRING_CHARS: usize = 256 * 1024;

struct CompiledRule {
    regex: regex::Regex,
    action: RedactionAction,
    replacement: String,
    requires_luhn: bool,
}

impl CompiledRule {
    fn apply(&self, text: &str) -> (String, usize) {
        let matches: Vec<(usize, usize)> = self
            .regex
            .find_iter(text)
            .filter(|found| !self.requires_luhn || luhn_valid(found.as_str()))
            .map(|found| (found.start(), found.end()))
            .collect();
        if matches.is_empty() {
            return (text.to_string(), 0);
        }
        let mut output = String::with_capacity(text.len());
        let mut cursor = 0;
        for (start, end) in &matches {
            output.push_str(&text[cursor..*start]);
            if self.action == RedactionAction::Mask {
                output.push_str(&self.replacement);
            }
            cursor = *end;
        }
        output.push_str(&text[cursor..]);
        (output, matches.len())
    }
}

/// 编译后的脱敏器。不可变，可跨线程共享。
pub struct PrivacyRedactor {
    rules: Vec<CompiledRule>,
}

impl std::fmt::Debug for PrivacyRedactor {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PrivacyRedactor")
            .field("rule_count", &self.rules.len())
            .finish()
    }
}

impl PrivacyRedactor {
    /// 编译配置；任何一条规则非法都整体失败（保存前就该拦住）。
    pub fn compile(config: &PrivacyConfig) -> Result<Self, String> {
        config.validate()?;
        let mut rules = Vec::with_capacity(config.rules.len());
        for rule in &config.rules {
            rules.push(compile_rule(rule)?);
        }
        Ok(Self { rules })
    }

    pub fn rule_count(&self) -> usize {
        self.rules.len()
    }

    pub fn is_empty(&self) -> bool {
        self.rules.is_empty()
    }

    /// 对一段文本脱敏，返回（结果，命中次数）。
    pub fn redact_text(&self, text: &str) -> (String, usize) {
        if self.rules.is_empty() || text.is_empty() {
            return (text.to_string(), 0);
        }
        if text.chars().count() > MAX_SCANNED_STRING_CHARS {
            return (text.to_string(), 0);
        }
        let mut current = text.to_string();
        let mut total = 0;
        for rule in &self.rules {
            let (next, hits) = rule.apply(&current);
            if hits > 0 {
                current = next;
                total += hits;
            }
        }
        (current, total)
    }

    /// 递归脱敏 JSON 里所有字符串值（键名不动），返回命中次数。
    pub fn redact_json_strings(&self, value: &mut Value) -> usize {
        if self.rules.is_empty() {
            return 0;
        }
        match value {
            Value::String(text) => self.redact_string_in_place(text),
            Value::Array(items) => items
                .iter_mut()
                .map(|item| self.redact_json_strings(item))
                .sum(),
            Value::Object(map) => map
                .values_mut()
                .map(|entry| self.redact_json_strings(entry))
                .sum(),
            _ => 0,
        }
    }

    fn redact_string_in_place(&self, text: &mut String) -> usize {
        // 媒体载荷不是凭据出现的地方，扫它只会白花 CPU。
        if text.starts_with("data:") {
            return 0;
        }
        let (redacted, hits) = self.redact_text(text);
        if hits > 0 {
            *text = redacted;
        }
        hits
    }
}

fn compile_rule(rule: &RedactionRuleConfig) -> Result<CompiledRule, String> {
    let pattern = match rule.detector {
        DetectorKind::Custom => rule
            .custom_pattern
            .as_deref()
            .ok_or_else(|| "custom 规则缺少 customPattern".to_string())?,
        detector => detector
            .builtin_pattern()
            .ok_or_else(|| format!("检测器 {detector} 没有内置形状"))?,
    };
    let regex = regex::Regex::new(pattern)
        .map_err(|err| format!("检测器 {} 的正则非法: {err}", rule.detector))?;
    let replacement = rule
        .replacement
        .clone()
        .unwrap_or_else(|| format!("[REDACTED:{}]", rule.detector.as_str()));
    Ok(CompiledRule {
        regex,
        action: if replacement.is_empty() {
            RedactionAction::Remove
        } else {
            rule.action
        },
        replacement,
        requires_luhn: rule.detector.requires_luhn(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn redactor(kinds: &[DetectorKind]) -> PrivacyRedactor {
        let config = PrivacyConfig {
            rules: kinds
                .iter()
                .map(|detector| RedactionRuleConfig {
                    detector: *detector,
                    action: RedactionAction::Mask,
                    replacement: None,
                    custom_pattern: None,
                })
                .collect(),
            ..PrivacyConfig::default()
        };
        PrivacyRedactor::compile(&config).expect("compile")
    }

    #[test]
    fn masquerades_detector_name_in_placeholder() {
        let redactor = redactor(&[DetectorKind::Email]);
        let (output, hits) = redactor.redact_text("mail me at alice@example.com please");
        assert_eq!(hits, 1);
        assert_eq!(output, "mail me at [REDACTED:email] please");
    }

    #[test]
    fn redaction_is_idempotent() {
        let redactor = redactor(&[DetectorKind::Email]);
        let (once, _) = redactor.redact_text("a@b.com");
        let (twice, hits) = redactor.redact_text(&once);
        assert_eq!(hits, 0);
        assert_eq!(once, twice);
    }

    #[test]
    fn credit_card_requires_luhn_checksum() {
        let redactor = redactor(&[DetectorKind::CreditCard]);
        let (output, hits) = redactor.redact_text("cards: 4111111111111111 and 4111111111111112");
        assert_eq!(hits, 1);
        assert!(output.contains("4111111111111112"), "{output}");
        assert!(output.contains("[REDACTED:credit-card]"), "{output}");
    }

    #[test]
    fn remove_action_drops_the_match_entirely() {
        let config = PrivacyConfig {
            rules: vec![RedactionRuleConfig {
                detector: DetectorKind::Email,
                action: RedactionAction::Remove,
                replacement: None,
                custom_pattern: None,
            }],
            ..PrivacyConfig::default()
        };
        let redactor = PrivacyRedactor::compile(&config).unwrap();
        let (output, hits) = redactor.redact_text("x a@b.com y");
        assert_eq!(hits, 1);
        assert_eq!(output, "x  y");
    }

    #[test]
    fn json_walk_redacts_string_values_and_leaves_keys_alone() {
        let redactor = redactor(&[DetectorKind::Email]);
        let mut body = json!({
            "messages": [
                {"role": "user", "content": "write to bob@example.com"},
                {"role": "assistant", "content": ["nested alice@example.com", 42]}
            ],
            "alice@example.com": {"note": "no dots here"}
        });
        assert_eq!(redactor.redact_json_strings(&mut body), 2);
        assert_eq!(
            body["messages"].as_array().map(|messages| messages.len()),
            Some(2)
        );
        assert_eq!(
            body["messages"][0]["content"],
            json!("write to [REDACTED:email]")
        );
        assert_eq!(
            body["messages"][1]["content"][0],
            json!("nested [REDACTED:email]")
        );
        // 键名不脱敏：脱敏键会改坏用户请求的结构。
        assert!(body.get("alice@example.com").is_some());
    }

    #[test]
    fn data_urls_and_oversized_strings_are_skipped() {
        let redactor = redactor(&[DetectorKind::Email]);
        let mut body = json!({
            "image": "data:image/png;base64,alice@example.com",
            "huge": format!("a@b.com{}", "x".repeat(MAX_SCANNED_STRING_CHARS + 1))
        });
        assert_eq!(redactor.redact_json_strings(&mut body), 0);
        assert_eq!(
            body["image"],
            json!("data:image/png;base64,alice@example.com")
        );
    }

    #[test]
    fn custom_detectors_use_their_own_pattern() {
        let config = PrivacyConfig {
            rules: vec![RedactionRuleConfig {
                detector: DetectorKind::Custom,
                action: RedactionAction::Mask,
                replacement: Some("[PROJECT]".to_string()),
                custom_pattern: Some("project-[0-9]{4}".to_string()),
            }],
            ..PrivacyConfig::default()
        };
        let redactor = PrivacyRedactor::compile(&config).unwrap();
        let (output, hits) = redactor.redact_text("see project-1234 now");
        assert_eq!(hits, 1);
        assert_eq!(output, "see [PROJECT] now");
    }

    #[test]
    fn empty_replacement_degrades_to_remove() {
        let config = PrivacyConfig {
            rules: vec![RedactionRuleConfig {
                detector: DetectorKind::Email,
                action: RedactionAction::Mask,
                replacement: Some(String::new()),
                custom_pattern: None,
            }],
            ..PrivacyConfig::default()
        };
        let redactor = PrivacyRedactor::compile(&config).unwrap();
        let (output, _) = redactor.redact_text("a@b.com!");
        assert_eq!(output, "!");
    }

    #[test]
    fn default_rules_catch_credentials_but_not_plain_words() {
        let redactor = PrivacyRedactor::compile(&PrivacyConfig::default()).unwrap();
        let (output, hits) = redactor.redact_text(
            "key sk-abcdefghijklmnopqrstuvwxyz token Bearer abcdefghijklmnop1234 mail a@b.com",
        );
        assert_eq!(hits, 3, "{output}");
        assert!(!output.contains("abcdefghijklmnopqrstuvwxyz"));
        let (clean, clean_hits) = redactor.redact_text("hello world, 42 tokens");
        assert_eq!(clean_hits, 0);
        assert_eq!(clean, "hello world, 42 tokens");
    }
}
