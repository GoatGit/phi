//! 隐私脱敏作为插件管线里的内置阶段。
//!
//! 内置而不是外部插件，是因为它必须**默认存在**：用户没装任何插件时，
//! 「错误摘要落库前脱敏」也要生效。位置固定在所有外部插件之后，
//! 保证插件引入的字段同样被兜底脱敏。

use std::sync::Arc;

use super::redactor::PrivacyRedactor;
use crate::plugin::stage::{RequestStage, StageContext};

/// 内置阶段的稳定 id，出现在日志与命令返回里。
pub const PRIVACY_STAGE_ID: &str = "builtin.privacy";

/// 请求体脱敏阶段。
pub struct PrivacyStage {
    redactor: Arc<PrivacyRedactor>,
}

impl PrivacyStage {
    pub fn new(redactor: Arc<PrivacyRedactor>) -> Self {
        Self { redactor }
    }
}

impl RequestStage for PrivacyStage {
    fn id(&self) -> &str {
        PRIVACY_STAGE_ID
    }

    fn apply(&self, context: &mut StageContext<'_>) -> Result<usize, String> {
        Ok(self.redactor.redact_json_strings(context.body))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin::stage::run_request_stages;
    use crate::privacy::config::{PrivacyConfig, RedactionAction, RedactionRuleConfig};
    use crate::privacy::detectors::DetectorKind;
    use serde_json::json;

    fn stage() -> PrivacyStage {
        let config = PrivacyConfig {
            rules: vec![RedactionRuleConfig {
                detector: DetectorKind::Email,
                action: RedactionAction::Mask,
                replacement: None,
                custom_pattern: None,
            }],
            ..PrivacyConfig::default()
        };
        PrivacyStage::new(Arc::new(PrivacyRedactor::compile(&config).unwrap()))
    }

    #[test]
    fn stage_redacts_request_body_strings() {
        let mut body = json!({"messages":[{"content":"mail a@b.com"}]});
        let outcomes =
            run_request_stages(&[Arc::new(stage())], "claude", "/v1/messages", &mut body);
        assert_eq!(outcomes[0].result, Ok(1));
        assert_eq!(
            body["messages"][0]["content"],
            json!("mail [REDACTED:email]")
        );
    }
}
