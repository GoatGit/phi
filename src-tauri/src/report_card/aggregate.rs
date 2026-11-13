//! 把任务事实汇总成「每个模型一张成绩单」。
//!
//! 只汇总可靠性指标：失败率、中断率、空交付率、单步耗时、单任务成本。
//! 没有验收命令与返工观察，所以这里不下「通过 / 返工」的判决——
//! 页面上的每个数字都带着样本量，样本不足就只说样本不足。

use crate::report_card::extract::{TaskFact, MIN_SAMPLES};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// 一条任务事实 + 它归属的供应商 / 项目。
#[derive(Debug, Clone, PartialEq)]
pub struct TaskRow {
    pub provider_id: String,
    pub project_dir: String,
    pub fact: TaskFact,
}

/// 成绩单的一行：一个模型在一个供应商下。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelScoreboardRow {
    pub provider_id: String,
    pub model: String,
    pub tasks: u64,
    pub tool_calls: u64,
    pub tool_failures: u64,
    pub interruptions: u64,
    /// 失败率的分母：扣掉被中断的调用（中断不是模型的错）
    pub effective_calls: u64,
    pub tool_failure_rate: Option<f64>,
    pub interruption_rate: Option<f64>,
    pub write_attempts: u64,
    pub write_successes: u64,
    /// 有写盘意图的任务数
    pub delivery_tasks: u64,
    pub empty_tasks: u64,
    pub empty_delivery_rate: Option<f64>,
    /// 中途换过模型的任务数（接棒场景，归因只认主模型）
    pub mixed_model_tasks: u64,
    pub cost_usd: f64,
    pub cost_per_task: Option<f64>,
    pub timed_calls: u64,
    pub avg_step_ms: Option<f64>,
    pub exit_samples: u64,
    pub exit_failures: u64,
    pub sample_size: u64,
    /// 样本够不够报百分比
    pub sufficient: bool,
    pub last_seen_at: i64,
}

#[derive(Default)]
struct Accumulator {
    tasks: u64,
    tool_calls: u64,
    tool_failures: u64,
    interruptions: u64,
    write_attempts: u64,
    write_successes: u64,
    delivery_tasks: u64,
    empty_tasks: u64,
    mixed_model_tasks: u64,
    cost_usd: f64,
    timed_calls: u64,
    duration_sum_ms: u64,
    exit_samples: u64,
    exit_failures: u64,
    last_seen_at: i64,
}

impl Accumulator {
    fn push(&mut self, fact: &TaskFact) {
        self.tasks += 1;
        self.tool_calls += fact.tool_calls;
        self.tool_failures += fact.tool_failures;
        self.interruptions += fact.interruptions;
        self.write_attempts += fact.write_attempts;
        self.write_successes += fact.write_successes;
        if fact.write_attempts > 0 {
            self.delivery_tasks += 1;
        }
        if fact.empty_delivery {
            self.empty_tasks += 1;
        }
        if fact.mixed_models {
            self.mixed_model_tasks += 1;
        }
        self.cost_usd += fact.cost_usd;
        self.timed_calls += fact.timed_calls;
        self.duration_sum_ms += fact.duration_sum_ms;
        self.exit_samples += fact.exit_samples;
        self.exit_failures += fact.exit_failures;
        self.last_seen_at = self.last_seen_at.max(fact.ended_at);
    }

    fn finish(self, provider_id: &str, model: &str) -> ModelScoreboardRow {
        let effective_calls = self.tool_calls.saturating_sub(self.interruptions);
        ModelScoreboardRow {
            provider_id: provider_id.to_string(),
            model: model.to_string(),
            tasks: self.tasks,
            tool_calls: self.tool_calls,
            tool_failures: self.tool_failures,
            interruptions: self.interruptions,
            effective_calls,
            tool_failure_rate: ratio(self.tool_failures, effective_calls),
            interruption_rate: ratio(self.interruptions, self.tool_calls),
            write_attempts: self.write_attempts,
            write_successes: self.write_successes,
            delivery_tasks: self.delivery_tasks,
            empty_tasks: self.empty_tasks,
            empty_delivery_rate: ratio(self.empty_tasks, self.delivery_tasks),
            mixed_model_tasks: self.mixed_model_tasks,
            cost_usd: self.cost_usd,
            cost_per_task: ratio_f64(self.cost_usd, self.tasks),
            timed_calls: self.timed_calls,
            avg_step_ms: ratio_f64(self.duration_sum_ms as f64, self.timed_calls),
            exit_samples: self.exit_samples,
            exit_failures: self.exit_failures,
            sample_size: self.tool_calls,
            sufficient: self.tool_calls >= MIN_SAMPLES,
            last_seen_at: self.last_seen_at,
        }
    }
}

fn ratio(part: u64, total: u64) -> Option<f64> {
    (total > 0).then(|| part as f64 / total as f64)
}

fn ratio_f64(part: f64, total: u64) -> Option<f64> {
    (total > 0).then(|| part / total as f64)
}

/// 按 (供应商, 模型) 汇总，任务多的在前。
pub fn aggregate(rows: &[TaskRow]) -> Vec<ModelScoreboardRow> {
    let mut groups: HashMap<(String, String), Accumulator> = HashMap::new();
    for row in rows {
        let key = (row.provider_id.clone(), row.fact.model.clone());
        groups.entry(key).or_default().push(&row.fact);
    }

    let mut scoreboard: Vec<ModelScoreboardRow> = groups
        .into_iter()
        .map(|((provider_id, model), accumulator)| accumulator.finish(&provider_id, &model))
        .collect();
    scoreboard.sort_by(|a, b| {
        b.tasks
            .cmp(&a.tasks)
            .then_with(|| b.tool_calls.cmp(&a.tool_calls))
            .then_with(|| a.model.cmp(&b.model))
    });
    scoreboard
}

/// 样本覆盖：任务数、供应商数、项目数。覆盖不全时排序会偏，必须一起显示。
pub fn coverage(rows: &[TaskRow]) -> (u64, u64, u64) {
    let mut providers = std::collections::HashSet::new();
    let mut projects = std::collections::HashSet::new();
    for row in rows {
        providers.insert(row.provider_id.as_str());
        if !row.project_dir.is_empty() {
            projects.insert(row.project_dir.as_str());
        }
    }
    (
        rows.len() as u64,
        providers.len() as u64,
        projects.len() as u64,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(model: &str, calls: u64, failures: u64, interruptions: u64) -> TaskFact {
        TaskFact {
            started_at: 1,
            ended_at: 2,
            model: model.into(),
            mixed_models: false,
            tool_calls: calls,
            tool_failures: failures,
            interruptions,
            write_attempts: 0,
            write_successes: 0,
            empty_delivery: false,
            timed_calls: 0,
            duration_sum_ms: 0,
            exit_samples: 0,
            exit_failures: 0,
            cost_usd: 0.0,
            input_tokens: 0,
            output_tokens: 0,
        }
    }

    fn row(provider: &str, fact: TaskFact) -> TaskRow {
        TaskRow {
            provider_id: provider.into(),
            project_dir: "/repo".into(),
            fact,
        }
    }

    #[test]
    fn excludes_interruptions_from_the_failure_rate() {
        let rows = vec![
            row("codex", task("m", 4, 1, 0)),
            row("codex", task("m", 6, 1, 4)),
        ];
        let scoreboard = aggregate(&rows);
        let entry = &scoreboard[0];
        assert_eq!(entry.tool_calls, 10);
        assert_eq!(entry.effective_calls, 6);
        assert_eq!(entry.tool_failures, 2);
        assert_eq!(entry.tool_failure_rate, Some(2.0 / 6.0));
        assert_eq!(entry.interruption_rate, Some(4.0 / 10.0));
    }

    #[test]
    fn small_samples_are_marked_insufficient() {
        let rows = vec![row("codex", task("small", 3, 0, 0))];
        assert!(!aggregate(&rows)[0].sufficient);

        let rows: Vec<TaskRow> = (0..MIN_SAMPLES)
            .map(|_| row("codex", task("big", 1, 0, 0)))
            .collect();
        assert!(aggregate(&rows)[0].sufficient);
    }

    #[test]
    fn empty_delivery_rate_uses_delivery_tasks_as_denominator() {
        let mut failed = task("m", 2, 0, 0);
        failed.write_attempts = 2;
        failed.empty_delivery = true;
        let mut ok = task("m", 2, 0, 0);
        ok.write_attempts = 1;
        ok.write_successes = 1;
        let read_only = task("m", 1, 0, 0);

        let scoreboard = aggregate(&[
            row("claude", failed),
            row("claude", ok),
            row("claude", read_only),
        ]);
        let entry = &scoreboard[0];
        assert_eq!(entry.tasks, 3);
        assert_eq!(entry.delivery_tasks, 2);
        assert_eq!(entry.empty_tasks, 1);
        assert_eq!(entry.empty_delivery_rate, Some(0.5));
    }

    #[test]
    fn groups_by_provider_and_model_separately() {
        let rows = vec![
            row("codex", task("gpt-5", 2, 0, 0)),
            row("claude", task("gpt-5", 1, 0, 0)),
            row("codex", task("gpt-5", 3, 0, 0)),
        ];
        let scoreboard = aggregate(&rows);
        assert_eq!(scoreboard.len(), 2);
        assert_eq!(scoreboard[0].provider_id, "codex");
        assert_eq!(scoreboard[0].tasks, 2);
        assert_eq!(scoreboard[0].tool_calls, 5);
    }

    #[test]
    fn unlabeled_models_stay_as_their_own_row() {
        let rows = vec![row("codex", task("", 6, 0, 0))];
        let scoreboard = aggregate(&rows);
        assert_eq!(scoreboard[0].model, "");
        assert_eq!(coverage(&rows), (1, 1, 1));
    }
}
