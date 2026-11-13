//! 从任务卡片里读「实现契约」。
//!
//! 契约写在卡片 frontmatter 的 `phi:` 块里，是编排接力的唯一输入：
//!
//! ```yaml
//! phi:
//!   role: implement
//!   accept:
//!     - cmd: pnpm test -- auth
//!       expect: exit 0
//!     - pnpm build
//!   touched: [src/auth/**, tests/auth/**]
//!   forbidden: [package.json]
//!   base: 10466fa
//!   budget: { max_tokens: 400000, max_minutes: 40 }
//! ```
//!
//! 解析原则是**宽容**：卡片可能由人手写，也可能是别的 agent 写的，读不懂的
//! 地方只记 `warnings` 交给界面提示，不因此整页失败；但缺命令、缺边界这种
//! 让门 2 失去意义的情况会体现为 `ready = false`。

use std::time::Duration;

use serde_yaml::Value;

use super::model::{AcceptStep, Contract};
use crate::tasks::frontmatter::Document;

/// 卡片允许声明的角色。不认识的角色只提示，不改变判定。
pub const ROLES: [&str; 3] = ["plan", "implement", "review"];

/// 单条验收命令没写超时、卡片也没有预算时的兜底（分钟）。
const DEFAULT_STEP_MINUTES: u64 = 10;

/// 解析卡片里的 `phi:` 块。没有这个块时返回空契约（`ready = false`）。
pub fn parse(doc: &Document) -> Contract {
    let mapping = doc.mapping();
    let mut contract = Contract::default();

    let Some(Value::Mapping(phi)) = mapping.get(Value::String("phi".into())).cloned() else {
        contract
            .warnings
            .push("卡片没有 phi 块：这不是一张接力卡，门 2 / 门 3 都没有可判定的东西".to_string());
        return contract;
    };

    contract.accept = parse_accept(
        phi.get(Value::String("accept".into())),
        &mut contract.warnings,
    );
    contract.touched = strings(phi.get(Value::String("touched".into())));
    contract.forbidden = strings(phi.get(Value::String("forbidden".into())));
    contract.base = phi
        .get(Value::String("base".into()))
        .and_then(scalar)
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty());
    contract.max_tokens = budget(&phi, "max_tokens");
    contract.max_minutes = budget(&phi, "max_minutes");

    if let Some(role) = phi.get(Value::String("role".into())).and_then(scalar) {
        let role = role.trim().to_lowercase();
        if !ROLES.contains(&role.as_str()) {
            contract.warnings.push(format!(
                "phi.role 不认识：{role}（可用 plan / implement / review）"
            ));
        }
        if !role.is_empty() {
            contract.role = Some(role);
        }
    }

    contract.ready = contract.is_ready();
    if contract.accept.is_empty() {
        contract
            .warnings
            .push("phi.accept 是空的：没有可执行的验收命令，门 2 无从判定".to_string());
    }
    if contract.touched.is_empty() {
        contract
            .warnings
            .push("phi.touched 是空的：没有改动边界，越界检查会整份放行".to_string());
    }

    contract
}

/// 单条命令的实际超时：命令自带 > 卡片预算 > 兜底。
pub fn step_timeout(contract: &Contract, step: &AcceptStep) -> Duration {
    let minutes = step
        .timeout_minutes
        .or(contract.max_minutes)
        .unwrap_or(DEFAULT_STEP_MINUTES)
        .max(1);
    Duration::from_secs(minutes.saturating_mul(60))
}

fn parse_accept(value: Option<&Value>, warnings: &mut Vec<String>) -> Vec<AcceptStep> {
    let Some(value) = value else {
        return Vec::new();
    };
    let items: Vec<&Value> = match value {
        Value::Sequence(items) => items.iter().collect(),
        // 允许只写一条命令，不必包成列表
        other => vec![other],
    };

    let mut steps = Vec::new();
    for item in items {
        match item {
            Value::Mapping(entry) => {
                let Some(cmd) = entry
                    .get(Value::String("cmd".into()))
                    .and_then(scalar)
                    .map(|text| text.trim().to_string())
                    .filter(|text| !text.is_empty())
                else {
                    warnings.push("phi.accept 里有一条没写 cmd，已跳过".to_string());
                    continue;
                };
                steps.push(AcceptStep {
                    expect_exit: expect_exit(
                        entry.get(Value::String("expect".into())),
                        &cmd,
                        warnings,
                    ),
                    timeout_minutes: entry
                        .get(Value::String("timeout_minutes".into()))
                        .and_then(uint),
                    cmd,
                });
            }
            other => {
                let Some(cmd) = scalar(other)
                    .map(|text| text.trim().to_string())
                    .filter(|text| !text.is_empty())
                else {
                    continue;
                };
                steps.push(AcceptStep {
                    cmd,
                    expect_exit: 0,
                    timeout_minutes: None,
                });
            }
        }
    }
    steps
}

/// `expect` 允许写 `exit 0`、`0`、`exit 2`；读不懂就按 0 处理并提示。
fn expect_exit(value: Option<&Value>, cmd: &str, warnings: &mut Vec<String>) -> i32 {
    let Some(text) = value.and_then(scalar) else {
        return 0;
    };
    let digits: String = text.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        warnings.push(format!(
            "phi.accept 的 expect 读不懂（{cmd}：{text}），按 exit 0 处理"
        ));
        return 0;
    }
    match digits.parse::<i32>() {
        Ok(code) => code,
        Err(_) => {
            warnings.push(format!(
                "phi.accept 的 expect 超范围（{cmd}：{text}），按 exit 0 处理"
            ));
            0
        }
    }
}

fn budget(phi: &serde_yaml::Mapping, key: &str) -> Option<u64> {
    match phi.get(Value::String("budget".into())) {
        Some(Value::Mapping(inner)) => inner.get(Value::String(key.into())).and_then(uint),
        _ => phi.get(Value::String(key.into())).and_then(uint),
    }
}

fn strings(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::Sequence(items)) => items
            .iter()
            .filter_map(scalar)
            .map(|text| text.trim().to_string())
            .filter(|text| !text.is_empty())
            .collect(),
        Some(other) => scalar(other)
            .map(|text| text.trim().to_string())
            .filter(|text| !text.is_empty())
            .into_iter()
            .collect(),
        None => Vec::new(),
    }
}

fn uint(value: &Value) -> Option<u64> {
    match value {
        Value::Number(number) => number.as_u64(),
        Value::String(text) => text.trim().parse().ok(),
        _ => None,
    }
}

fn scalar(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(flag) => Some(flag.to_string()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(frontmatter: &str) -> Document {
        Document::parse(&format!("---\n{frontmatter}---\n\n正文\n")).expect("合法 frontmatter")
    }

    #[test]
    fn reads_full_contract() {
        let parsed = parse(&doc(
            "id: TASK-1\nphi:\n  role: implement\n  base: 10466fa\n  accept:\n    - cmd: pnpm test\n      expect: exit 0\n    - pnpm build\n  touched: [src/auth/**, tests/auth/**]\n  forbidden: [package.json]\n  budget: { max_tokens: 400000, max_minutes: 40 }\n",
        ));

        assert_eq!(parsed.role.as_deref(), Some("implement"));
        assert_eq!(parsed.base.as_deref(), Some("10466fa"));
        assert_eq!(parsed.accept.len(), 2);
        assert_eq!(parsed.accept[0].cmd, "pnpm test");
        assert_eq!(parsed.accept[0].expect_exit, 0);
        assert_eq!(parsed.accept[1].cmd, "pnpm build");
        assert_eq!(parsed.touched, vec!["src/auth/**", "tests/auth/**"]);
        assert_eq!(parsed.forbidden, vec!["package.json"]);
        assert_eq!(parsed.max_tokens, Some(400_000));
        assert_eq!(parsed.max_minutes, Some(40));
        assert!(parsed.ready);
        assert!(parsed.warnings.is_empty(), "{:?}", parsed.warnings);
    }

    #[test]
    fn expects_non_zero_exit_code() {
        let parsed = parse(&doc(
            "phi:\n  accept:\n    - cmd: sh check.sh\n      expect: exit 2\n  touched: [a]\n",
        ));
        assert_eq!(parsed.accept[0].expect_exit, 2);
    }

    #[test]
    fn missing_contract_is_not_ready() {
        let parsed = parse(&doc("id: TASK-1\ntitle: 没有契约\n"));
        assert!(!parsed.ready);
        assert!(parsed.accept.is_empty());
        assert_eq!(parsed.warnings.len(), 1);
        assert!(parsed.warnings[0].contains("phi"), "{:?}", parsed.warnings);
    }

    #[test]
    fn unreadable_role_and_expect_warn_but_do_not_fail() {
        let parsed = parse(&doc(
            "phi:\n  role: reviewer\n  accept:\n    - cmd: make\n      expect: 看情况\n  touched: [src/**]\n",
        ));
        assert_eq!(parsed.role.as_deref(), Some("reviewer"));
        assert_eq!(parsed.accept[0].expect_exit, 0);
        assert_eq!(parsed.warnings.len(), 2);
        assert!(parsed.ready);
    }

    #[test]
    fn timeout_falls_back_to_budget() {
        let parsed = parse(&doc(
            "phi:\n  accept:\n    - cmd: make\n  touched: [src/**]\n  budget:\n    max_minutes: 3\n",
        ));
        assert_eq!(
            step_timeout(&parsed, &parsed.accept[0]),
            Duration::from_secs(180)
        );
    }
}
