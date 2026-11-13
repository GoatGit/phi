//! `session-exit` 钩子：托管会话跑挂了，插件决定接不接、怎么接。
//!
//! 能力与策略分离在这里：
//! - 宿主（`baton`）掌握进程、退出码、git、交接单、重启能力；
//! - 插件只拿到一份结构化事件，返回一个决策对象。
//!
//! 插件永远不能把宿主「没打算接」的会话硬拉起来：决策在这里只被解析成
//! [`SessionExitDecision`]，是否采纳、是否越权，由 `baton` 用同一套安全规则再判一次。

use serde_json::{Map, Value};

use super::manifest::PluginHook;
use super::sandbox::{self, SandboxError, SandboxLimits};

/// 决策动作。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionExitAction {
    /// 接棒（重启同一条会话或开新会话）。
    Resume,
    /// 只记录，不重启。
    Record,
}

/// 插件给出的接棒决策。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionExitDecision {
    pub action: SessionExitAction,
    pub mode: Option<String>,
    pub reason: String,
}

/// 一个已编译好的接棒钩子。
#[derive(Clone, Debug)]
pub struct SessionExitHook {
    pub id: String,
    script: String,
    limits: SandboxLimits,
}

impl SessionExitHook {
    pub fn new(id: impl Into<String>, script: impl Into<String>, limits: SandboxLimits) -> Self {
        Self {
            id: id.into(),
            script: script.into(),
            limits,
        }
    }

    /// 只有声明了 `session-exit` 钩子的插件才会被构造出来。
    pub fn handles(hook: PluginHook) -> bool {
        hook == PluginHook::SessionExit
    }

    /// 跑一次决策。返回 `Ok(None)` 表示弃权。
    pub fn decide(&self, event: &Value) -> Result<Option<SessionExitDecision>, String> {
        match sandbox::run_session_exit_script(&self.script, event, &self.limits) {
            Ok(Some(value)) => parse_decision(&value).map(Some),
            Ok(None) => Ok(None),
            Err(error @ SandboxError::PayloadTooLarge { .. }) => Err(error.to_string()),
            Err(error) => Err(error.to_string()),
        }
    }
}

/// 采纳的决策，带上决定它的插件 id（便于归因与展示）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionExitChoice {
    pub plugin_id: String,
    pub decision: SessionExitDecision,
}

/// 单次钩子运行结果，用于日志与错误归因。
#[derive(Clone, Debug, PartialEq)]
pub struct SessionExitOutcome {
    pub id: String,
    pub decision: Option<SessionExitDecision>,
}

/// 按注册表顺序跑，第一个给出决策的插件生效；单个插件失败只影响它自己。
pub fn run_session_exit_hooks(
    hooks: &[SessionExitHook],
    event: &Value,
) -> (Option<SessionExitChoice>, Vec<SessionExitOutcome>) {
    let mut outcomes = Vec::with_capacity(hooks.len());
    let mut decided: Option<SessionExitChoice> = None;
    for hook in hooks {
        let decision = hook.decide(event).unwrap_or_else(|error| {
            log::warn!("[baton] 插件 {} 的接棒决策失败，已忽略: {error}", hook.id);
            None
        });
        outcomes.push(SessionExitOutcome {
            id: hook.id.clone(),
            decision: decision.clone(),
        });
        if let Some(decision) = decision {
            decided = Some(SessionExitChoice {
                plugin_id: hook.id.clone(),
                decision,
            });
            break;
        }
    }
    (decided, outcomes)
}

/// 解析插件返回值。字段不对就整条拒掉——宁可回落到内置策略，也不猜。
fn parse_decision(value: &Value) -> Result<SessionExitDecision, String> {
    let object: &Map<String, Value> = value
        .as_object()
        .ok_or_else(|| "决策必须是对象".to_string())?;
    let action = match object.get("action").and_then(Value::as_str) {
        Some("resume") => SessionExitAction::Resume,
        Some("record") => SessionExitAction::Record,
        Some(other) => return Err(format!("未知的 action: {other}")),
        None => return Err("决策缺少 action".to_string()),
    };
    let mode = match object.get("mode").and_then(Value::as_str) {
        Some("same-session") => Some("same-session".to_string()),
        Some("fresh-session") => Some("fresh-session".to_string()),
        Some(other) => return Err(format!("未知的 mode: {other}")),
        None => None,
    };
    let reason = match object.get("reason").and_then(Value::as_str) {
        Some(reason) if !reason.trim().is_empty() => reason.chars().take(200).collect(),
        Some(_) => return Err("reason 不能为空".to_string()),
        None => "插件决策".to_string(),
    };
    Ok(SessionExitDecision {
        action,
        mode,
        reason,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn hook(id: &str, script: &str) -> SessionExitHook {
        SessionExitHook::new(id, script, SandboxLimits::default())
    }

    #[test]
    fn a_script_can_ask_for_a_fresh_session() {
        let hook = hook(
            "policy",
            r#"function onSessionExit(event) {
                 return { action: "resume", mode: "fresh-session", reason: "上下文满了" };
               }"#,
        );
        let decision = hook.decide(&json!({"failureKind":"context"})).unwrap();
        assert_eq!(
            decision,
            Some(SessionExitDecision {
                action: SessionExitAction::Resume,
                mode: Some("fresh-session".into()),
                reason: "上下文满了".into(),
            })
        );
    }

    #[test]
    fn abstaining_plugins_return_none() {
        let hook = hook("quiet", "function onSessionExit() { return null; }");
        assert_eq!(hook.decide(&json!({})).unwrap(), None);
    }

    #[test]
    fn malformed_decisions_are_rejected_instead_of_guessed() {
        for script in [
            r#"function onSessionExit() { return { action: "restart" }; }"#,
            r#"function onSessionExit() { return { action: "resume", mode: "somewhere" }; }"#,
            r#"function onSessionExit() { return { mode: "same-session" }; }"#,
            r#"function onSessionExit() { return "resume"; }"#,
            r#"function onSessionExit() { return { action: "resume", reason: "   " }; }"#,
        ] {
            let hook = hook("bad", script);
            assert!(hook.decide(&json!({})).is_err(), "should reject: {script}");
        }
    }

    #[test]
    fn the_first_decisive_plugin_wins_and_errors_are_isolated() {
        let hooks = vec![
            hook(
                "broken",
                "function onSessionExit() { throw new Error('boom'); }",
            ),
            hook("quiet", "function onSessionExit() { return null; }"),
            hook(
                "policy",
                r#"function onSessionExit() { return { action: "record", reason: "只记录" }; }"#,
            ),
            hook(
                "never",
                r#"function onSessionExit() { return { action: "resume" }; }"#,
            ),
        ];
        let (decision, outcomes) = run_session_exit_hooks(&hooks, &json!({}));
        assert_eq!(
            decision,
            Some(SessionExitChoice {
                plugin_id: "policy".into(),
                decision: SessionExitDecision {
                    action: SessionExitAction::Record,
                    mode: None,
                    reason: "只记录".into(),
                },
            })
        );
        // 第一个插件报错 -> 弃权；只有跑到决定性那个为止
        assert_eq!(outcomes.len(), 3);
        assert_eq!(outcomes[0].id, "broken");
        assert!(outcomes[0].decision.is_none());
    }

    #[test]
    fn no_plugins_means_no_decision() {
        let (decision, outcomes) = run_session_exit_hooks(&[], &json!({}));
        assert!(decision.is_none());
        assert!(outcomes.is_empty());
    }

    #[test]
    fn hooks_only_build_for_the_session_exit_hook_point() {
        assert!(SessionExitHook::handles(PluginHook::SessionExit));
        assert!(!SessionExitHook::handles(PluginHook::Request));
    }

    #[test]
    fn long_reasons_are_truncated() {
        let long = "原".repeat(400);
        let hook = hook(
            "chatty",
            &format!(
                "function onSessionExit() {{ return {{ action: \"record\", reason: \"{long}\" }}; }}"
            ),
        );
        let decision = hook.decide(&json!({})).unwrap().unwrap();
        assert_eq!(decision.reason.chars().count(), 200);
    }
}
