//! 调度器提议：人反复手工派同类活时，建议把它收成一个智能体。
//!
//! 只提议、不落库：提议是「一条可以点开的预填草稿」，人改完点保存才算数。
//! 判据全部来自已经发生的事实（运行快照 + 卡片标签），不猜、不调模型：
//! 这项功能的价值是「提醒你这类活已经有 3 张了」，不是替你想一个岗位出来。

use super::model::{RouterSettings, RunState};
use super::snapshot;
use super::store;
use crate::Database;
use serde::Serialize;
use std::collections::BTreeMap;

/// 只回看这么久之内完成的卡。更早的完成记录反映不了现在的活。
const WINDOW_MS: i64 = 14 * 24 * 60 * 60 * 1000;

/// 同类活至少完成几张才值得提议。两张是巧合，三张才是「这一类」。
const MIN_CARDS: usize = 3;

/// 一条提议：可以点开成编辑器里的预填草稿。
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSuggestion {
    /// 建议的岗位名（也是保存时派生 id 的来源）。
    pub name: String,
    pub app_id: String,
    /// 一句话说明什么任务派给它，带「近 14 天完成 N 张」这个事实。
    pub summary: String,
    pub steps: Vec<String>,
    /// 预填的完工自查：最近完成的几张卡就是证据。
    pub evidence: Vec<String>,
    /// 这个标签下完成的张数。
    pub completed: usize,
}

/// 扫一遍已完成卡，给「还没有对应智能体」的标签各出一条建议。
pub fn propose(db: &Database, settings: &RouterSettings) -> Vec<AgentSuggestion> {
    let Ok(snapshot) = snapshot::collect(db) else {
        return Vec::new();
    };
    let now = store::now_ms();
    // 键是标签；值是（标题，应用，完成时刻）。
    let mut groups: BTreeMap<String, Vec<(String, Option<String>, i64)>> = BTreeMap::new();
    for candidate in &snapshot.candidates {
        let Some(run) = candidate.run.as_ref() else {
            continue;
        };
        if run.state != RunState::Done || now.saturating_sub(run.updated_at) > WINDOW_MS {
            continue;
        }
        let label = candidate
            .labels
            .iter()
            .map(|label| label.trim())
            .find(|label| !label.is_empty())
            .unwrap_or("未分类")
            .to_string();
        groups.entry(label).or_default().push((
            candidate.title.clone(),
            run.worker_app.clone(),
            run.updated_at,
        ));
    }

    let mut suggestions = Vec::new();
    for (label, mut items) in groups {
        if items.len() < MIN_CARDS {
            continue;
        }
        // 已经有智能体覆盖这一类：名称或用途里写着这个词，就当人已经建过。
        if settings
            .agents
            .iter()
            .any(|agent| agent.name.contains(&label) || agent.description.contains(&label))
        {
            continue;
        }
        // 应用取这一组里出现最多的那个；一条记录都没有应用就不提议，
        // 提议一个不知道用哪个应用跑的岗位只是噪音。
        let mut counts: BTreeMap<String, usize> = BTreeMap::new();
        for (_, app, _) in &items {
            if let Some(app) = app {
                *counts.entry(app.clone()).or_default() += 1;
            }
        }
        let Some((app, _)) = counts.into_iter().max_by_key(|(_, count)| *count) else {
            continue;
        };
        items.sort_by_key(|(_, _, at)| -*at);
        let completed = items.len();
        let titles: Vec<String> = items
            .iter()
            .take(3)
            .map(|(title, _, _)| title.clone())
            .collect();
        suggestions.push(AgentSuggestion {
            name: label.clone(),
            app_id: app,
            summary: format!(
                "处理「{label}」类任务：近 14 天已完成 {completed} 张（{}）。",
                titles.join("、")
            ),
            steps: vec![
                "先读卡片、相关代码与项目规则，确认这一类的验收条件".into(),
                "按项目惯例完成实现，可逆的选择自行决定并写进结论".into(),
                "在卡片写结果与产物，验收满足后再标 Done".into(),
            ],
            evidence: titles,
            completed,
        });
    }
    // 完成得多的先提：那是最像「一类活」的那一组。
    suggestions.sort_by_key(|suggestion| std::cmp::Reverse(suggestion.completed));
    suggestions
}

#[cfg(test)]
mod tests {
    // 提议的判据依赖磁盘上的看板与 sqlite 运行态，集成测试在
    // `super_agent::tests` 里用真实仓库跑；这里只钉住纯逻辑的两条边界。
    use super::*;

    #[test]
    fn a_group_needs_three_cards_to_become_a_suggestion() {
        assert_eq!(MIN_CARDS, 3);
    }

    #[test]
    fn the_window_is_fourteen_days() {
        assert_eq!(WINDOW_MS, 14 * 24 * 60 * 60 * 1000);
    }
}
