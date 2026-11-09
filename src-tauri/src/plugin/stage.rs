//! 请求阶段：插件系统对代理暴露的唯一形状。
//!
//! 一个阶段就是一个「拿到请求体、原地改写、报告改了几处」的对象。内置能力
//! （隐私脱敏）与外部插件（脚本 / 声明式规则）走同一条管线，因此顺序、隔离和
//! 降级策略只有一份实现。

use std::sync::Arc;

use serde_json::Value;

use super::manifest::PluginHook;
use super::rules::CompiledRules;
use super::sandbox::{self, SandboxError, SandboxLimits};

/// 阶段看到的请求上下文。
pub struct StageContext<'a> {
    /// 应用 id（`claude` / `codex` / …），脚本可据此做差异化改写。
    pub app: &'a str,
    /// 上游端点路径（不含 query，避免密钥进插件）。
    pub endpoint: &'a str,
    /// 待改写的请求体。
    pub body: &'a mut Value,
}

/// 一个请求阶段。
pub trait RequestStage: Send + Sync {
    /// 阶段标识，用于日志与错误归因。
    fn id(&self) -> &str;

    /// 原地应用；返回命中次数，`Err` 表示本次阶段跳过（不影响其他阶段）。
    fn apply(&self, context: &mut StageContext<'_>) -> Result<usize, String>;
}

/// 单次管线运行的结果，供调用方按阶段记日志。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StageOutcome {
    pub id: String,
    pub result: Result<usize, String>,
}

/// 依次运行所有阶段，任何单个阶段的失败都被隔离。
pub fn run_request_stages(
    stages: &[Arc<dyn RequestStage>],
    app: &str,
    endpoint: &str,
    body: &mut Value,
) -> Vec<StageOutcome> {
    let mut outcomes = Vec::with_capacity(stages.len());
    for stage in stages {
        let mut context = StageContext {
            app,
            endpoint,
            body,
        };
        let result = stage.apply(&mut context);
        outcomes.push(StageOutcome {
            id: stage.id().to_string(),
            result,
        });
    }
    outcomes
}

/// 声明式规则阶段。
pub struct RuleStage {
    id: String,
    rules: CompiledRules,
}

impl RuleStage {
    pub fn new(id: impl Into<String>, rules: CompiledRules) -> Self {
        Self {
            id: id.into(),
            rules,
        }
    }
}

impl RequestStage for RuleStage {
    fn id(&self) -> &str {
        &self.id
    }

    fn apply(&self, context: &mut StageContext<'_>) -> Result<usize, String> {
        if self.rules.is_empty() {
            return Ok(0);
        }
        Ok(self.rules.apply(context.body))
    }
}

/// 脚本阶段。
pub struct ScriptStage {
    id: String,
    script: String,
    limits: SandboxLimits,
}

impl ScriptStage {
    pub fn new(id: impl Into<String>, script: impl Into<String>, limits: SandboxLimits) -> Self {
        Self {
            id: id.into(),
            script: script.into(),
            limits,
        }
    }

    /// 只有声明了 `request` 钩子的插件才会被构造成阶段。
    pub fn handles(hook: PluginHook) -> bool {
        hook == PluginHook::Request
    }
}

impl RequestStage for ScriptStage {
    fn id(&self) -> &str {
        &self.id
    }

    fn apply(&self, context: &mut StageContext<'_>) -> Result<usize, String> {
        match sandbox::run_request_script(&self.script, context.body, &self.limits) {
            Ok(Some(replacement)) => {
                if replacement == *context.body {
                    return Ok(0);
                }
                *context.body = replacement;
                Ok(1)
            }
            Ok(None) => Ok(0),
            Err(err @ SandboxError::PayloadTooLarge { .. }) => Err(err.to_string()),
            Err(err) => Err(err.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin::manifest::DeclarativeRule;
    use serde_json::json;

    struct FailingStage;

    impl RequestStage for FailingStage {
        fn id(&self) -> &str {
            "failing"
        }

        fn apply(&self, _context: &mut StageContext<'_>) -> Result<usize, String> {
            Err("故意失败".to_string())
        }
    }

    fn rule_stage() -> RuleStage {
        let rules: Vec<DeclarativeRule> =
            serde_json::from_value(json!([{"op":"mask","path":"secret"}])).unwrap();
        RuleStage::new("rules", CompiledRules::compile(&rules).unwrap())
    }

    #[test]
    fn one_failing_stage_does_not_stop_the_next() {
        let stages: Vec<Arc<dyn RequestStage>> =
            vec![Arc::new(FailingStage), Arc::new(rule_stage())];
        let mut body = json!({"secret":"s3cret","keep":1});
        let outcomes = run_request_stages(&stages, "claude", "/v1/messages", &mut body);
        assert_eq!(outcomes.len(), 2);
        assert!(outcomes[0].result.is_err());
        assert_eq!(outcomes[1].result, Ok(1));
        assert_eq!(body, json!({"secret":"[REDACTED]","keep":1}));
    }

    #[test]
    fn script_stage_reports_no_change_when_output_equals_input() {
        let stage = ScriptStage::new(
            "identity",
            "function onRequest(request) { return request; }",
            SandboxLimits::default(),
        );
        let mut body = json!({"a":1});
        let outcomes = run_request_stages(&[Arc::new(stage)], "codex", "/v1/responses", &mut body);
        assert_eq!(outcomes[0].result, Ok(0));
        assert_eq!(body, json!({"a":1}));
    }
}
