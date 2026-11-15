//! 纯代码的前置过滤。这里没有任何模型调用，全部规则可单测。
//!
//! 剔除顺序就是排查顺序：越靠前的规则越确定，写进 trace 的 reason 也越具体。
//! 依赖判断只认「依赖卡状态是 Done 或运行态是 done」——Backlog.md 的默认
//! 终态就叫 Done，这里不额外引入配置项。

use crate::super_agent::model::{Candidate, FilteredOut, RouterSettings, RunState};
use std::collections::HashMap;

/// 失败重试的等待上限。再久也不该超过这个数：卡片停在「失败」上等半小时，
/// 人早就自己动手了。
const MAX_BACKOFF_MS: i64 = 30 * 60 * 1000;

/// 失败后的等待时间：基础冷却 × 2^(已尝试次数-1)，封顶 [`MAX_BACKOFF_MS`]。
///
/// 固定冷却会让「一直失败」的卡按同一个节拍反复烧钱；退避让第一次失败仍然
/// 「及时重启」，但第 N 次会明显放慢，直到重试预算用完转人工。
pub(crate) fn backoff_ms(settings: &RouterSettings, attempts: u32) -> i64 {
    let base = settings.cooldown_seconds.max(0) * 1000;
    if base == 0 {
        return 0;
    }
    let doublings = attempts.saturating_sub(1).min(6);
    base.saturating_mul(1 << doublings).min(MAX_BACKOFF_MS)
}

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
            // 失败按退避重试：worker 已经退出、卡片也没完成，正是「没在跑、
            // 没完成、也不是人停的」那一类，冷却一到就重新派。
            RunState::Failed => {
                let backoff = backoff_ms(settings, candidate.attempts());
                if backoff > 0
                    && candidate
                        .run
                        .as_ref()
                        .is_some_and(|run| run.updated_at + backoff > now)
                {
                    reject(&mut outcome, &candidate, "cooling-down");
                    continue;
                }
            }
            RunState::Idle | RunState::Queued => {}
        }

        // 重试预算按「卡片这一版」算：卡片被改动过，预算在巡检里已经清零，
        // 所以这里能拦住的只有「同一版卡片被反复派发且一直失败」这一种。
        if candidate.attempts() >= settings.max_attempts {
            reject(&mut outcome, &candidate, "retry-budget-used");
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

/// 看板上算「完成」的列。Backlog.md 的默认终态就叫 Done，这里不为它加配置项。
pub(crate) fn done_status(status: &str) -> bool {
    is_done(status)
}
