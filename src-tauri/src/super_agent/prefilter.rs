//! 纯代码的前置过滤。这里没有任何模型调用，全部规则可单测。
//!
//! 剔除顺序就是排查顺序：越靠前的规则越确定，写进 trace 的 reason 也越具体。
//! 依赖判断只认「依赖卡状态是 Done 或运行态是 done」——Backlog.md 的默认
//! 终态就叫 Done，这里不额外引入配置项。

use crate::super_agent::model::{Candidate, FilteredOut, RouterSettings, RunState};
use std::collections::HashMap;

#[derive(Clone, Debug, Default)]
pub(crate) struct Outcome {
    pub survivors: Vec<Candidate>,
    pub filtered: Vec<FilteredOut>,
}

fn reject(outcome: &mut Outcome, candidate: &Candidate, reason: &str) {
    outcome.filtered.push(FilteredOut {
        task_id: candidate.task_id.clone(),
        reason: reason.into(),
    });
}

pub(crate) fn apply(
    candidates: Vec<Candidate>,
    settings: &RouterSettings,
    // 键是 (仓库, 任务)：依赖也要按仓库查，两个仓库都有 TASK-1 时不能互相顶掉。
    statuses: &HashMap<(String, String), String>,
    now: i64,
) -> Outcome {
    let mut outcome = Outcome::default();
    let cooldown_ms = settings.cooldown_seconds.max(0) * 1000;

    for candidate in candidates {
        // 卡片所在的列：只有触发列上的卡才会被自动派发。
        if candidate.status != settings.trigger_status {
            reject(&mut outcome, &candidate, "not-triggered");
            continue;
        }

        match candidate.state() {
            RunState::Paused => {
                reject(&mut outcome, &candidate, "paused");
                continue;
            }
            RunState::Done => {
                reject(&mut outcome, &candidate, "done");
                continue;
            }
            RunState::NeedsYou => {
                reject(&mut outcome, &candidate, "waiting-for-human");
                continue;
            }
            RunState::Dispatched | RunState::Working => {
                reject(&mut outcome, &candidate, "running");
                continue;
            }
            RunState::Failed => {
                if cooldown_ms > 0
                    && candidate
                        .run
                        .as_ref()
                        .is_some_and(|run| run.updated_at + cooldown_ms > now)
                {
                    reject(&mut outcome, &candidate, "cooling-down");
                    continue;
                }
            }
            RunState::Idle | RunState::Queued => {}
        }

        if candidate.attempts() >= settings.max_attempts {
            reject(&mut outcome, &candidate, "attempts-exhausted");
            continue;
        }

        let blocked_by = candidate.dependencies.iter().find(|dependency| {
            if dependency.as_str() == candidate.task_id {
                return false;
            }
            let key = (candidate.root.clone(), dependency.to_string());
            match statuses.get(&key).map(String::as_str) {
                Some(status) => !is_done(status),
                // 依赖卡找不到：不猜，直接当没满足。
                None => true,
            }
        });
        if let Some(dependency) = blocked_by {
            reject(
                &mut outcome,
                &candidate,
                &format!("blocked-by:{dependency}"),
            );
            continue;
        }

        outcome.survivors.push(candidate);
    }

    outcome
}

fn is_done(status: &str) -> bool {
    status.eq_ignore_ascii_case("done")
}
