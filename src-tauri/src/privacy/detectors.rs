//! 隐私脱敏的检测器表。
//!
//! 检测器只有「形状」这一层语义：每个检测器对应一个内置正则，外加一个可选的
//! 后置校验（信用卡走 Luhn，避免把任意长数字串当卡号）。形状判断永远可能有
//! 误报，所以脱敏是**可配置**的，默认只覆盖「几乎不可能是正常内容」的凭据形态。

use serde::{Deserialize, Serialize};

/// 内置检测器。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DetectorKind {
    /// 常见供应商 API key 前缀（`sk-` / `AIza` / `ghp_` / `xoxb-` 等）。
    ApiKey,
    /// `Authorization: Bearer ...` 形态的令牌。
    BearerToken,
    /// AWS access key id（`AKIA` / `ASIA`）。
    AwsAccessKey,
    /// PEM 私钥块。
    PrivateKeyBlock,
    /// 邮箱地址。
    Email,
    /// 手机号（中国大陆 11 位 + 带 `+` 的国际号）。
    Phone,
    /// 中国大陆 18 位身份证号。
    IdCard,
    /// 银行卡号（Luhn 校验通过才算）。
    CreditCard,
    /// IPv4 地址。
    IpAddress,
    /// 用户自定义正则，必须随规则给出 `customPattern`。
    Custom,
}

impl DetectorKind {
    /// 全部内置检测器，供配置界面列举。
    pub const ALL: [Self; 9] = [
        Self::ApiKey,
        Self::BearerToken,
        Self::AwsAccessKey,
        Self::PrivateKeyBlock,
        Self::Email,
        Self::Phone,
        Self::IdCard,
        Self::CreditCard,
        Self::IpAddress,
    ];

    /// 稳定的机器名，用于替换文本与日志。
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::ApiKey => "api-key",
            Self::BearerToken => "bearer-token",
            Self::AwsAccessKey => "aws-access-key",
            Self::PrivateKeyBlock => "private-key-block",
            Self::Email => "email",
            Self::Phone => "phone",
            Self::IdCard => "id-card",
            Self::CreditCard => "credit-card",
            Self::IpAddress => "ip-address",
            Self::Custom => "custom",
        }
    }

    /// 内置正则；`Custom` 没有内置形状。
    pub fn builtin_pattern(&self) -> Option<&'static str> {
        Some(match self {
            // 前缀 + 足够长的随机体：`sk-` 后面短于 16 位更像普通单词。
            Self::ApiKey => {
                r"(?:\bsk-[A-Za-z0-9_\-]{16,}\b|\bAIza[0-9A-Za-z_\-]{30,}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bxox[abp]-[A-Za-z0-9\-]{10,}\b)"
            }
            Self::BearerToken => r"(?i)\bBearer\s+[A-Za-z0-9\-._~+/]{16,}=*",
            Self::AwsAccessKey => r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b",
            Self::PrivateKeyBlock => {
                r"(?s)-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?-----END [A-Z0-9 ]*PRIVATE KEY-----"
            }
            Self::Email => r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b",
            // 大陆手机号 + 带 `+` 的国际号；不带 `+` 的长数字留给卡号检测器。
            Self::Phone => r"(?:\b1[3-9]\d{9}\b|\+\d{8,15}\b)",
            Self::IdCard => {
                r"\b[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[0-9Xx]\b"
            }
            // 先粗筛，命中后必须过 Luhn（见 `requires_luhn`）。
            Self::CreditCard => r"\b\d{13,19}\b",
            Self::IpAddress => r"\b(?:\d{1,3}\.){3}\d{1,3}\b",
            Self::Custom => return None,
        })
    }

    /// 该检测器是否需要 Luhn 后置校验。
    pub fn requires_luhn(&self) -> bool {
        matches!(self, Self::CreditCard)
    }
}

impl std::fmt::Display for DetectorKind {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// Luhn 校验（信用卡号）。
pub fn luhn_valid(candidate: &str) -> bool {
    let digits: Vec<u32> = candidate
        .chars()
        .filter(|c| c.is_ascii_digit())
        .filter_map(|c| c.to_digit(10))
        .collect();
    if digits.len() < 13 || digits.len() > 19 {
        return false;
    }
    let mut sum = 0u32;
    let mut double = false;
    for digit in digits.iter().rev() {
        let mut value = *digit;
        if double {
            value *= 2;
            if value > 9 {
                value -= 9;
            }
        }
        sum += value;
        double = !double;
    }
    sum % 10 == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn matches(detector: DetectorKind, text: &str) -> bool {
        let pattern = detector.builtin_pattern().expect("builtin pattern");
        regex::Regex::new(pattern).unwrap().is_match(text)
    }

    #[test]
    fn api_key_shape_requires_enough_entropy() {
        assert!(matches(DetectorKind::ApiKey, "sk-abcdefghijklmnopqrst"));
        assert!(matches(
            DetectorKind::ApiKey,
            "ghp_0123456789abcdefghijABCDEFGHIJ"
        ));
        assert!(!matches(DetectorKind::ApiKey, "sk-short"));
        assert!(!matches(DetectorKind::ApiKey, "task-manager"));
    }

    #[test]
    fn bearer_token_matches_case_insensitively() {
        assert!(matches(
            DetectorKind::BearerToken,
            "authorization: bearer abcdefghijklmnop1234"
        ));
        assert!(!matches(DetectorKind::BearerToken, "bearer short"));
    }

    #[test]
    fn private_key_block_spans_lines() {
        let text = "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----";
        assert!(matches(DetectorKind::PrivateKeyBlock, text));
    }

    #[test]
    fn id_card_and_phone_shapes() {
        assert!(matches(DetectorKind::IdCard, "11010519491231002X"));
        assert!(matches(DetectorKind::Phone, "13812345678"));
        assert!(matches(DetectorKind::Phone, "+14155552671"));
        assert!(!matches(DetectorKind::IdCard, "1101051949123100"));
    }

    #[test]
    fn luhn_accepts_known_test_numbers_only() {
        assert!(luhn_valid("4111111111111111"));
        assert!(luhn_valid("5500 0000 0000 0004"));
        assert!(!luhn_valid("4111111111111112"));
        assert!(!luhn_valid("1234"));
    }

    #[test]
    fn every_builtin_detector_exposes_a_compilable_pattern() {
        for detector in DetectorKind::ALL {
            let pattern = detector.builtin_pattern().expect("builtin pattern");
            regex::Regex::new(pattern).expect("pattern compiles");
        }
    }
}
