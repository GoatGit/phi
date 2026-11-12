//! 从会话消息里抽出「执行事实」。
//!
//! 能观察到的只有三件事：工具调用成功没有、写盘有没有落地、这一步花了多久；
//! 再加上模型归因（一个任务中途换模型时必须记清是谁写的）。
//! 这里不执行任何命令、不读仓库，所以产出的只是「可靠性」，不是「质量」。

use crate::session_manager::model::{
    EventKind, SessionBlock, SessionMessage, ToolKind, ToolStatus,
};
use std::collections::HashMap;

/// 空闲超过 30 分钟切一刀，视为两个任务（调研报告的判定口径）。
pub const IDLE_GAP_MS: i64 = 30 * 60 * 1000;

/// 一个模型的样本少于这个数时只报「样本不足」，不报百分比。
pub const MIN_SAMPLES: u64 = 5;

/// 任务级事实：一个会话按空闲间隔切开的一段活儿。
#[derive(Debug, Clone, PartialEq)]
pub struct TaskFact {
    pub started_at: i64,
    pub ended_at: i64,
    /// 按写入行数（没有写入时按调用次数）加权后的主模型
    pub model: String,
    /// 同一任务中途换过模型（接棒）——归因只认主模型，但这件事要留痕
    pub mixed_models: bool,
    pub tool_calls: u64,
    pub tool_failures: u64,
    pub interruptions: u64,
    pub write_attempts: u64,
    pub write_successes: u64,
    /// 有写盘意图但一次都没成功
    pub empty_delivery: bool,
    pub timed_calls: u64,
    pub duration_sum_ms: u64,
    pub exit_samples: u64,
    pub exit_failures: u64,
    pub cost_usd: f64,
    pub input_tokens: u64,
    pub output_tokens: u64,
}

struct CallResult {
    status: ToolStatus,
    exit_code: Option<i32>,
    duration_ms: Option<u64>,
}

struct PendingCall {
    ts: i64,
    model: String,
    weight: i64,
    write: bool,
    result: Option<CallResult>,
}

struct Spend {
    ts: i64,
    model: String,
    cost_usd: f64,
    input_tokens: u64,
    output_tokens: u64,
}

/// 把一次会话切成任务，并算出每个任务的执行事实。
///
/// `fallback` 是会话自身记录的起止时间，用于源记录完全没有时间戳的格式。
pub fn extract_facts(messages: &[SessionMessage], fallback: (i64, i64)) -> Vec<TaskFact> {
    let mut model = String::new();
    let mut last_ts = fallback.0;
    let mut pending: Vec<PendingCall> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    let mut aborts: Vec<(i64, String)> = Vec::new();
    let mut spends: Vec<Spend> = Vec::new();
    let mut timeline: Vec<i64> = Vec::new();

    for message in messages {
        // 时间戳缺失时沿用上一个时刻：会话是顺序写的，这比丢弃事件更接近事实
        if let Some(ts) = message.ts.filter(|ts| *ts > 0) {
            last_ts = ts;
            timeline.push(ts);
        }
        if let Some(meta) = &message.meta {
            if let Some(name) = meta.model.as_deref().filter(|name| !name.is_empty()) {
                model = name.to_string();
            }
            let spend = Spend {
                ts: last_ts,
                model: model.clone(),
                cost_usd: meta.cost_usd.unwrap_or(0.0),
                input_tokens: meta.input_tokens.unwrap_or(0),
                output_tokens: meta.output_tokens.unwrap_or(0),
            };
            if spend.cost_usd > 0.0 || spend.input_tokens > 0 || spend.output_tokens > 0 {
                spends.push(spend);
            }
        }

        for block in &message.blocks {
            match block {
                SessionBlock::ToolCall {
                    id,
                    kind,
                    diff,
                    by_user,
                    ..
                } => {
                    // 用户自己敲的命令不算模型这一次干的活
                    if *by_user || index.contains_key(id) {
                        continue;
                    }
                    let weight = diff
                        .as_ref()
                        .map_or(1, |diff| i64::from(diff.added + diff.removed).max(1));
                    index.insert(id.clone(), pending.len());
                    pending.push(PendingCall {
                        ts: last_ts,
                        model: model.clone(),
                        weight,
                        write: matches!(kind, ToolKind::Edit | ToolKind::Write),
                        result: None,
                    });
                }
                SessionBlock::ToolResult {
                    call_id,
                    status,
                    exit_code,
                    duration_ms,
                    ..
                } => {
                    if let Some(&position) = index.get(call_id) {
                        pending[position].result = Some(CallResult {
                            status: *status,
                            exit_code: *exit_code,
                            duration_ms: *duration_ms,
                        });
                    }
                }
                SessionBlock::Event {
                    kind: EventKind::Aborted,
                    ..
                } => {
                    aborts.push((last_ts, model.clone()));
                }
                _ => {}
            }
        }
    }

    let windows = split_windows(&mut timeline, fallback);
    let mut calls: Vec<Vec<&PendingCall>> = vec![Vec::new(); windows.len()];
    for call in &pending {
        if let Some(position) = window_index(&windows, call.ts) {
            calls[position].push(call);
        }
    }
    let mut abort_counts = vec![0u64; windows.len()];
    for (ts, _) in &aborts {
        if let Some(position) = window_index(&windows, *ts) {
            abort_counts[position] += 1;
        }
    }
    let mut spends_by_window: Vec<Vec<&Spend>> = vec![Vec::new(); windows.len()];
    for spend in &spends {
        if let Some(position) = window_index(&windows, spend.ts) {
            spends_by_window[position].push(spend);
        }
    }

    windows
        .iter()
        .enumerate()
        .map(|(position, (started_at, ended_at))| {
            build_task(
                *started_at,
                *ended_at,
                &calls[position],
                abort_counts[position],
                &spends_by_window[position],
            )
        })
        .collect()
}

fn build_task(
    started_at: i64,
    ended_at: i64,
    calls: &[&PendingCall],
    aborts: u64,
    spends: &[&Spend],
) -> TaskFact {
    let mut weigher: HashMap<&str, i64> = HashMap::new();
    let mut models: Vec<&str> = Vec::new();
    let mut tool_calls = 0u64;
    let mut tool_failures = 0u64;
    let mut interruptions = aborts;
    let mut write_attempts = 0u64;
    let mut write_successes = 0u64;
    let mut timed_calls = 0u64;
    let mut duration_sum_ms = 0u64;
    let mut exit_samples = 0u64;
    let mut exit_failures = 0u64;

    for call in calls {
        tool_calls += 1;
        let status = call.result.as_ref().map(|result| result.status);
        match status {
            Some(ToolStatus::Error) => tool_failures += 1,
            Some(ToolStatus::Interrupted) => interruptions += 1,
            _ => {}
        }
        if call.write {
            write_attempts += 1;
            if status == Some(ToolStatus::Success) {
                write_successes += 1;
            }
        }
        if let Some(duration_ms) = call.result.as_ref().and_then(|result| result.duration_ms) {
            timed_calls += 1;
            duration_sum_ms += duration_ms;
        }
        if let Some(code) = call.result.as_ref().and_then(|result| result.exit_code) {
            exit_samples += 1;
            if code != 0 {
                exit_failures += 1;
            }
        }
        if !call.model.is_empty() {
            *weigher.entry(call.model.as_str()).or_insert(0) += call.weight;
            if !models.contains(&call.model.as_str()) {
                models.push(call.model.as_str());
            }
        }
    }

    // 没有工具调用的任务（纯问答）也要保留：成本仍然要归到它头上
    if models.is_empty() {
        for spend in spends {
            if !spend.model.is_empty() && !models.contains(&spend.model.as_str()) {
                models.push(spend.model.as_str());
            }
        }
    }

    let mut cost_usd = 0.0;
    let mut input_tokens = 0u64;
    let mut output_tokens = 0u64;
    for spend in spends {
        cost_usd += spend.cost_usd;
        input_tokens += spend.input_tokens;
        output_tokens += spend.output_tokens;
        if !spend.model.is_empty() {
            *weigher.entry(spend.model.as_str()).or_insert(0) += 1;
        }
    }

    let model = dominant_model(&weigher, &models);

    TaskFact {
        started_at,
        ended_at,
        model,
        mixed_models: models.len() > 1,
        tool_calls,
        tool_failures,
        interruptions,
        write_attempts,
        write_successes,
        empty_delivery: write_attempts > 0 && write_successes == 0,
        timed_calls,
        duration_sum_ms,
        exit_samples,
        exit_failures,
        cost_usd,
        input_tokens,
        output_tokens,
    }
}

/// 权重最大的模型；权重相同时取最后出现的那个（通常就是兜底的那个）。
fn dominant_model(weigher: &HashMap<&str, i64>, models: &[&str]) -> String {
    let mut best: Option<(&str, i64)> = None;
    for model in models {
        let weight = weigher.get(model).copied().unwrap_or(0);
        match best {
            Some((_, current)) if weight < current => {}
            _ => best = Some((model, weight)),
        }
    }
    best.map(|(model, _)| model.to_string()).unwrap_or_default()
}

fn split_windows(points: &mut [i64], fallback: (i64, i64)) -> Vec<(i64, i64)> {
    points.sort_unstable();
    let mut windows: Vec<(i64, i64)> = Vec::new();
    for ts in points.iter().copied() {
        match windows.last_mut() {
            Some((_, end)) if ts - *end <= IDLE_GAP_MS => *end = ts,
            _ => windows.push((ts, ts)),
        }
    }
    if windows.is_empty() {
        let start = fallback.0;
        let end = fallback.1.max(fallback.0);
        windows.push((start, end));
    }
    windows
}

fn window_index(windows: &[(i64, i64)], ts: i64) -> Option<usize> {
    let position = windows.partition_point(|(_, end)| *end < ts);
    windows
        .get(position)
        .filter(|(start, end)| ts >= *start && ts <= *end)
        .map(|_| position)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_manager::model::{DiffSummary, MessageMeta};

    fn call(id: &str, kind: ToolKind, ts: i64) -> SessionMessage {
        SessionMessage::from_blocks(
            "assistant",
            Some(ts),
            vec![SessionBlock::ToolCall {
                id: id.into(),
                raw_name: format!("{kind:?}"),
                kind,
                title: String::new(),
                detail: None,
                server: None,
                input_preview: String::new(),
                input_total_len: 0,
                input_full: None,
                diff: None,
                by_user: false,
            }],
        )
    }

    fn result(
        call_id: &str,
        status: ToolStatus,
        ts: i64,
        exit_code: Option<i32>,
    ) -> SessionMessage {
        SessionMessage::from_blocks(
            "tool",
            Some(ts),
            vec![SessionBlock::ToolResult {
                call_id: call_id.into(),
                status,
                preview: String::new(),
                total_len: 0,
                line_count: 0,
                truncated: false,
                full: None,
                exit_code,
                duration_ms: Some(1_200),
                images: Vec::new(),
                saved_path: None,
            }],
        )
    }

    fn with_model(mut message: SessionMessage, model: &str) -> SessionMessage {
        message.meta = Some(MessageMeta {
            model: Some(model.into()),
            ..MessageMeta::default()
        });
        message
    }

    #[test]
    fn splits_tasks_on_idle_gap() {
        let first = 1_700_000_000_000;
        // 第二个任务的首个事件与上一个事件相距超过空闲阈值
        let second = first + IDLE_GAP_MS + 1_000;
        let messages = vec![
            call("a", ToolKind::Shell, first),
            result("a", ToolStatus::Success, first + 10, Some(0)),
            call("b", ToolKind::Read, second),
            result("b", ToolStatus::Success, second + 20, Some(0)),
        ];

        let tasks = extract_facts(&messages, (first, first));
        assert_eq!(tasks.len(), 2);
        assert_eq!(tasks[0].started_at, first);
        assert_eq!(tasks[1].started_at, second);
        assert_eq!(tasks[0].tool_calls, 1);
        assert!(tasks.iter().all(|task| task.started_at >= first));
    }

    #[test]
    fn interrupted_calls_are_counted_separately_from_failures() {
        let ts = 1_700_000_000_000;
        let messages = vec![
            call("a", ToolKind::Shell, ts),
            result("a", ToolStatus::Interrupted, ts + 1, None),
            call("b", ToolKind::Shell, ts + 2),
            result("b", ToolStatus::Error, ts + 3, Some(1)),
        ];

        let tasks = extract_facts(&messages, (ts, ts));
        assert_eq!(tasks[0].tool_calls, 2);
        assert_eq!(tasks[0].interruptions, 1);
        assert_eq!(tasks[0].tool_failures, 1);
        assert_eq!(tasks[0].exit_samples, 1);
        assert_eq!(tasks[0].exit_failures, 1);
    }

    #[test]
    fn empty_delivery_needs_a_write_attempt() {
        let ts = 1_700_000_000_000;
        // 只读不改：纯问答类任务，不算空交付
        let read_only = vec![
            call("r", ToolKind::Read, ts),
            result("r", ToolStatus::Success, ts + 1, Some(0)),
        ];
        assert!(!extract_facts(&read_only, (ts, ts))[0].empty_delivery);

        // 想写但写失败
        let failed_write = vec![
            call("w", ToolKind::Edit, ts),
            result("w", ToolStatus::Error, ts + 1, Some(0)),
        ];
        let task = &extract_facts(&failed_write, (ts, ts))[0];
        assert_eq!(task.write_attempts, 1);
        assert_eq!(task.write_successes, 0);
        assert!(task.empty_delivery);
    }

    #[test]
    fn user_commands_are_not_attributed_to_the_model() {
        let ts = 1_700_000_000_000;
        let mut message = with_model(call("u", ToolKind::Shell, ts), "claude-opus-4");
        if let SessionBlock::ToolCall { by_user, .. } = &mut message.blocks[0] {
            *by_user = true;
        }
        let tasks = extract_facts(&[message], (ts, ts));
        assert_eq!(tasks[0].tool_calls, 0);
    }

    #[test]
    fn attributes_by_written_lines_and_marks_mixed_tasks() {
        let ts = 1_700_000_000_000;
        let mut small = with_model(call("small", ToolKind::Edit, ts), "cheap-model");
        if let SessionBlock::ToolCall { diff, .. } = &mut small.blocks[0] {
            *diff = Some(DiffSummary {
                files: Vec::new(),
                added: 1,
                removed: 0,
                full: None,
            });
        }
        let mut large = with_model(call("large", ToolKind::Write, ts + 1), "smart-model");
        if let SessionBlock::ToolCall { diff, .. } = &mut large.blocks[0] {
            *diff = Some(DiffSummary {
                files: Vec::new(),
                added: 40,
                removed: 2,
                full: None,
            });
        }

        let tasks = extract_facts(&[small, large], (ts, ts));
        assert_eq!(tasks[0].model, "smart-model");
        assert!(tasks[0].mixed_models);
    }

    #[test]
    fn falls_back_to_session_time_without_timestamps() {
        let mut message = call("a", ToolKind::Shell, 0);
        message.ts = None;
        let tasks = extract_facts(&[message], (10, 20));
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].started_at, 10);
        assert_eq!(tasks[0].ended_at, 20);
    }
}
