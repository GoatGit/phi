//! 隐私脱敏配置（`privacy.json`）。
//!
//! 默认值刻意区分两个面：
//! - 「写进本地数据库的错误摘要」默认脱敏：它只是诊断材料，脱敏不影响任何功能；
//! - 「发往上游的请求体」默认不改：改写用户 prompt 是行为变化，必须显式开启。
//!
//! 文件缺失、损坏、版本不认识都退回默认值：脱敏是保护措施，不该因为一个坏配置
//! 让代理不可用；但读到坏文件会留一条告警，便于排查。

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::detectors::DetectorKind;
use crate::error::AppError;

/// 配置文件名（位于配置目录）。
pub const CONFIG_FILE: &str = "privacy.json";

const CURRENT_VERSION: u32 = 1;
const MAX_RULES: usize = 32;
const MAX_REPLACEMENT_CHARS: usize = 64;
const MAX_CUSTOM_PATTERN_CHARS: usize = 512;

/// 命中后的处置方式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum RedactionAction {
    /// 替换成占位文本。
    #[default]
    Mask,
    /// 空字符串。
    Remove,
}

/// 一条脱敏规则。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RedactionRuleConfig {
    pub detector: DetectorKind,
    #[serde(default)]
    pub action: RedactionAction,
    /// 自定义占位文本；缺省为 `[REDACTED:<detector>]`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replacement: Option<String>,
    /// `custom` 检测器的正则，其它检测器不允许出现。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_pattern: Option<String>,
}

impl RedactionRuleConfig {
    fn builtin(detector: DetectorKind) -> Self {
        Self {
            detector,
            action: RedactionAction::Mask,
            replacement: None,
            custom_pattern: None,
        }
    }

    fn validate(&self, index: usize) -> Result<(), String> {
        if let Some(replacement) = &self.replacement {
            if replacement.chars().count() > MAX_REPLACEMENT_CHARS {
                return Err(format!(
                    "第 {index} 条规则的占位文本超过 {MAX_REPLACEMENT_CHARS} 字符上限"
                ));
            }
        }
        match self.detector {
            DetectorKind::Custom => {
                let pattern = self
                    .custom_pattern
                    .as_deref()
                    .filter(|pattern| !pattern.is_empty())
                    .ok_or_else(|| format!("第 {index} 条规则是 custom，必须给出 customPattern"))?;
                if pattern.chars().count() > MAX_CUSTOM_PATTERN_CHARS {
                    return Err(format!(
                        "第 {index} 条规则的自定义正则超过 {MAX_CUSTOM_PATTERN_CHARS} 字符上限"
                    ));
                }
                regex::Regex::new(pattern)
                    .map_err(|err| format!("第 {index} 条规则的自定义正则非法: {err}"))?;
            }
            _ => {
                if self.custom_pattern.is_some() {
                    return Err(format!(
                        "第 {index} 条规则不是 custom，不接受 customPattern"
                    ));
                }
            }
        }
        Ok(())
    }
}

/// 隐私脱敏配置。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct PrivacyConfig {
    #[serde(default = "default_version")]
    pub version: u32,
    /// 总开关：关闭后请求体与错误摘要都不脱敏。
    pub enabled: bool,
    /// 是否改写发往上游的请求体（默认关：改 prompt 是行为变化）。
    pub apply_to_request_body: bool,
    /// 是否脱敏写入本地数据库的错误摘要（默认开：纯诊断材料）。
    pub redact_error_logs: bool,
    pub rules: Vec<RedactionRuleConfig>,
}

fn default_version() -> u32 {
    CURRENT_VERSION
}

impl Default for PrivacyConfig {
    fn default() -> Self {
        Self {
            version: CURRENT_VERSION,
            enabled: true,
            apply_to_request_body: false,
            redact_error_logs: true,
            // 默认只覆盖「几乎不可能是正常内容」的凭据形态，外加高频 PII。
            // IP 地址不进默认集合：讨论网络的 prompt 里出现 IP 是常态。
            rules: [
                DetectorKind::ApiKey,
                DetectorKind::BearerToken,
                DetectorKind::AwsAccessKey,
                DetectorKind::PrivateKeyBlock,
                DetectorKind::Email,
                DetectorKind::Phone,
                DetectorKind::IdCard,
                DetectorKind::CreditCard,
            ]
            .into_iter()
            .map(RedactionRuleConfig::builtin)
            .collect(),
        }
    }
}

impl PrivacyConfig {
    /// 读取配置；文件不存在返回默认值。
    pub fn load(path: &Path) -> Self {
        let Ok(raw) = fs::read_to_string(path) else {
            return Self::default();
        };
        match serde_json::from_str::<Self>(&raw) {
            Ok(config) if config.version == CURRENT_VERSION => match config.validate() {
                Ok(()) => config,
                Err(err) => {
                    log::warn!("隐私脱敏配置校验失败，按默认值处理: {err}");
                    Self::default()
                }
            },
            Ok(config) => {
                log::warn!(
                    "隐私脱敏配置版本为 {}，当前支持 {CURRENT_VERSION}，按默认值处理",
                    config.version
                );
                Self::default()
            }
            Err(err) => {
                log::warn!("隐私脱敏配置无法解析，按默认值处理: {err}");
                Self::default()
            }
        }
    }

    /// 校验并写盘（原子写）。
    pub fn save(&self, path: &Path) -> Result<(), AppError> {
        self.validate()
            .map_err(|err| AppError::InvalidInput(format!("隐私脱敏配置非法: {err}")))?;
        if self.version != CURRENT_VERSION {
            return Err(AppError::InvalidInput(format!(
                "隐私脱敏配置版本必须为 {CURRENT_VERSION}"
            )));
        }
        let serialized = serde_json::to_string_pretty(self)
            .map_err(|source| AppError::JsonSerialize { source })?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|err| AppError::io(parent, err))?;
        }
        crate::config::atomic_write(path, format!("{serialized}\n").as_bytes())
    }

    /// 配置校验：规则数量、占位文本长度、自定义正则。
    pub fn validate(&self) -> Result<(), String> {
        if self.rules.len() > MAX_RULES {
            return Err(format!("规则数超过 {MAX_RULES} 条上限"));
        }
        for (index, rule) in self.rules.iter().enumerate() {
            rule.validate(index)?;
        }
        Ok(())
    }

    /// 当前配置下是否需要在请求体上动手。
    pub fn rewrites_request_body(&self) -> bool {
        self.enabled && self.apply_to_request_body && !self.rules.is_empty()
    }

    /// 当前配置下是否需要脱敏错误摘要。
    pub fn redacts_error_logs(&self) -> bool {
        self.enabled && self.redact_error_logs && !self.rules.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_privacy_preserving_but_do_not_rewrite_requests() {
        let config = PrivacyConfig::default();
        assert!(config.enabled);
        assert!(!config.rewrites_request_body());
        assert!(config.redacts_error_logs());
        assert_eq!(config.rules.len() + 1, DetectorKind::ALL.len());
    }

    #[test]
    fn roundtrips_through_disk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(CONFIG_FILE);
        let mut config = PrivacyConfig {
            apply_to_request_body: true,
            ..PrivacyConfig::default()
        };
        config.rules.push(RedactionRuleConfig {
            detector: DetectorKind::Custom,
            action: RedactionAction::Remove,
            replacement: None,
            custom_pattern: Some("project-[0-9]+".to_string()),
        });
        config.save(&path).unwrap();
        assert_eq!(PrivacyConfig::load(&path), config);
    }

    #[test]
    fn broken_file_falls_back_to_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(CONFIG_FILE);
        fs::write(&path, "{broken").unwrap();
        assert_eq!(PrivacyConfig::load(&path), PrivacyConfig::default());
        fs::write(&path, r#"{"version":7,"enabled":false}"#).unwrap();
        assert_eq!(PrivacyConfig::load(&path), PrivacyConfig::default());
    }

    #[test]
    fn custom_rule_without_pattern_is_rejected_on_save() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(CONFIG_FILE);
        let config = PrivacyConfig {
            rules: vec![RedactionRuleConfig {
                detector: DetectorKind::Custom,
                action: RedactionAction::Mask,
                replacement: None,
                custom_pattern: None,
            }],
            ..PrivacyConfig::default()
        };
        assert!(config.save(&path).is_err());
    }

    #[test]
    fn pattern_on_builtin_detector_is_rejected() {
        let config = PrivacyConfig {
            rules: vec![RedactionRuleConfig {
                detector: DetectorKind::Email,
                action: RedactionAction::Mask,
                replacement: None,
                custom_pattern: Some("x".to_string()),
            }],
            ..PrivacyConfig::default()
        };
        assert!(config.validate().is_err());
    }

    #[test]
    fn illegal_custom_regex_is_rejected() {
        let config = PrivacyConfig {
            rules: vec![RedactionRuleConfig {
                detector: DetectorKind::Custom,
                action: RedactionAction::Mask,
                replacement: None,
                custom_pattern: Some("(".to_string()),
            }],
            ..PrivacyConfig::default()
        };
        assert!(config.validate().is_err());
    }

    #[test]
    fn too_many_rules_are_rejected() {
        let config = PrivacyConfig {
            rules: (0..MAX_RULES + 1)
                .map(|_| RedactionRuleConfig::builtin(DetectorKind::Email))
                .collect(),
            ..PrivacyConfig::default()
        };
        assert!(config.validate().is_err());
    }
}
