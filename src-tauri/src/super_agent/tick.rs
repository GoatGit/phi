//! 一个 tick 的控制结构：快照 → 过滤 → 配额门 →（可选）注意力分桶 → episode → 结算 → 执行。
//!
//! 两条纪律写在这一层，而不是写在提示词里：
//!
//! 1. **能被绕过的东西不能当闸门。** 决策只能来自 episode，执行只发生在这里；
//!    episode 拿不到文件写、拿不到进程，也拿不到数据库。
//! 2. **概率不变判决。** 判官的输出只经 [`crate::super_agent::judge::Thresholds`]
//!    变成布尔，而且失败按后果分档：代价可回滚的放行，代价不可逆的拦住。

use std::collections::{BTreeMap, HashMap, HashSet};

use crate::super_agent::episode::{Episode, EpisodeInput, EpisodeOutcome};
use crate::super_agent::judge::{Judge, Question, Thresholds};
use crate::super_agent::model::{
    Action, Candidate, Decision, DispatchSpec, RouterSettings, RouterTrace, RunState, TickReport,
};
use crate::super_agent::{dispatch, prefilter, snapshot, store};
use crate::Database;

/// 一次 episode 的预算。与 pi 版共用同一套口径：读一次卡算一步，提名一次算一步。
pub(crate) const EPISODE_STEPS: usize = 8;
pub(crate) const EPISODE_JUDGE_CALLS: usize = 5;

pub(crate) struct TickContext<'a> {
    pub db: &'a Database,
    pub judge: &'a dyn Judge,
    pub dispatcher: &'a dyn dispatch::Dispatcher,
    pub episode: &'a dyn Episode,
    pub now: i64,
}

/// 一次 tick 的执行结果与中间事实，命令层只要报告，测试还要看中间量。
#[derive(Clone, Debug)]
pub(crate) struct TickOutcome {
    pub report: TickReport,
    /// episode 走过的步骤。只用于排障与测试，生产路径不读它。
    #[allow(dead_code)]
    pub episode_steps: Vec<String>,
}

pub(crate) async fn run(ctx: TickContext<'_>, trigger: &str) -> Result<TickOutcome, String> {
    let started = store::now_ms();
    let settings = ctx.db.router_settings().map_err(|e| e.to_string())?;
    let trace_id = uuid::Uuid::new_v4().to_string();
    let mut report = TickReport {
        trace_id: trace_id.clone(),
        at: ctx.now,
        trigger: trigger.into(),
        skipped: None,
        scanned: 0,
        candidates: 0,
        filtered: Vec::new(),
        narrowed: false,
        degraded: Vec::new(),
        decisions: Vec::new(),
        dispatched: Vec::new(),
        needs_you: Vec::new(),
        judge_calls: 0,
        duration_ms: 0,
        shadow: settings.shadow,
    };
    let mut steps: Vec<String> = Vec::new();

    if !settings.enabled {
        report.skipped = Some("disabled".into());
        return finish(ctx.db, report, steps, started);
    }

    // ---------------------------------------------------------------- 收尾
    // 先把已经结束的 worker 结算掉，再决定这一轮派谁：否则一张早就跑完的卡
    // 会一直占着并发名额，看起来像「调度器停了」。
    reconcile(
        ctx.db,
        &settings,
        ctx.now,
        &crate::exit_hook::journal_path(),
        &mut report,
    );

    // ---------------------------------------------------------------- 快照
    let scan = snapshot::collect(ctx.db)?;
    report.scanned = scan.scanned;
    report.degraded.extend(scan.notes.clone());
    if scan.candidates.is_empty() {
        report.skipped = Some("no-tasks".into());
        return finish(ctx.db, report, steps, started);
    }
    let statuses: HashMap<String, String> = scan
        .candidates
        .iter()
        .map(|candidate| (candidate.task_id.clone(), candidate.status.clone()))
        .collect();
    let filtered = prefilter::apply(scan.candidates, &settings, &statuses, ctx.now);
    report.candidates = filtered.survivors.len();
    report.filtered = filtered.filtered;
    steps.push(format!("prefilter {} survivors", report.candidates));

    if filtered.survivors.is_empty() {
        report.skipped = Some("no-candidates".into());
        return finish(ctx.db, report, steps, started);
    }

    // ------------------------------------------------------------ 配额门
    let quota = ctx
        .db
        .router_quota_usage(ctx.now)
        .map_err(|e| e.to_string())?;
    if quota.dispatches >= settings.dispatches_per_day {
        report.skipped = Some("dispatch-quota-used".into());
        return finish(ctx.db, report, steps, started);
    }
    let running = snapshot::running(&ctx.db.router_runs().map_err(|e| e.to_string())?);
    if running >= settings.concurrency {
        report.skipped = Some("concurrency-full".into());
        return finish(ctx.db, report, steps, started);
    }

    // 判官今天还有没有额度：没有就整轮不调判官，只用确定性规则。
    let judge_available = quota.judge_calls < settings.judge_calls_per_day;
    if !judge_available {
        report.degraded.push("judge-quota-used".into());
    }

    // ------------------------------------------------------- 注意力分桶
    let mut survivors = filtered.survivors;
    if judge_available && survivors.len() > settings.attention_threshold {
        match narrow_with_judge(ctx.judge, &settings, &survivors).await {
            Ok((narrowed, used)) => {
                report.judge_calls += used;
                report.narrowed = true;
                report.candidates = narrowed.len();
                steps.push(format!("attention narrowed to {}", narrowed.len()));
                survivors = narrowed;
            }
            // 桶错了只是多花 token，所以这里放行：失败就把全量交给循环。
            Err(reason) => {
                report
                    .degraded
                    .push(format!("attention-fail-open:{reason}"));
                steps.push("attention-fail-open".into());
            }
        }
    }

    // 并发与单 tick 上限一起压：剩下的名额才进循环。
    let capacity = settings
        .concurrency
        .saturating_sub(running)
        .min(settings.dispatches_per_tick)
        .min(settings.dispatches_per_day.saturating_sub(quota.dispatches));
    if capacity == 0 {
        report.skipped = Some("no-capacity".into());
        return finish(ctx.db, report, steps, started);
    }
    survivors.truncate(settings.attention_threshold.max(capacity));

    // ------------------------------------------------------------- episode
    let outcome = ctx
        .episode
        .run(EpisodeInput {
            candidates: &survivors,
            settings: &settings,
            steps: EPISODE_STEPS,
            judge_calls: if judge_available {
                EPISODE_JUDGE_CALLS
            } else {
                0
            },
            // 判官额度用完就交 None：sidecar 的 judge 工具当场报错，不必空等一次超时。
            judge: judge_available.then_some(ctx.judge),
            judge_model: &settings.judge_model,
        })
        .await
        .map_err(|error| format!("episode-failed:{error:?}"))?;
    report.judge_calls += outcome.judge_calls;
    steps.extend(outcome.steps.clone());

    // -------------------------------------------------------------- 结算
    let settled = settle(outcome, &survivors, &settings, capacity);
    if settled.unfinished {
        report.degraded.push("episode-unfinished".into());
    }
    report.decisions = settled.decisions;
    for dropped in settled.dropped {
        report.degraded.push(dropped);
    }

    // -------------------------------------------------------------- 执行
    let decisions = report.decisions.clone();
    apply(
        ctx.db,
        ctx.dispatcher,
        &settings,
        &survivors,
        &decisions,
        ctx.now,
        &mut report,
    );

    finish(ctx.db, report, steps, started)
}

fn finish(
    db: &Database,
    mut report: TickReport,
    steps: Vec<String>,
    started: i64,
) -> Result<TickOutcome, String> {
    report.duration_ms = store::now_ms() - started;
    let trace = RouterTrace {
        id: report.trace_id.clone(),
        root: None,
        created_at: report.at,
        trigger: report.trigger.clone(),
        candidates: report.candidates,
        narrowed: report.narrowed,
        degraded: report.degraded.clone(),
        decisions: report.decisions.clone(),
        judge_calls: report.judge_calls,
        duration_ms: report.duration_ms,
        unfinished: report
            .degraded
            .iter()
            .any(|note| note == "episode-unfinished"),
        shadow: report.shadow,
    };
    db.insert_router_trace(&trace).map_err(|e| e.to_string())?;
    Ok(TickOutcome {
        report,
        episode_steps: steps,
    })
}

/// 结算已经结束的 worker。
///
/// 三个信号逐级降级：托管会话还在不在 → journal 里的退出码 → 卡片内容有没有被改过。
/// 只有「退出码 0 且卡片确实被改过」才算完成；其余一律转人工，不猜。
pub(crate) fn reconcile(
    db: &Database,
    settings: &RouterSettings,
    now: i64,
    journal: &std::path::Path,
    report: &mut TickReport,
) {
    let Ok(runs) = db.router_runs() else { return };
    for run in runs.into_iter().filter(|run| run.state.is_running()) {
        let Some(session) = run.session_id.clone() else {
            continue;
        };
        if crate::terminal::session_exists(&session) {
            if run.state == RunState::Dispatched {
                let _ = db.set_router_state(
                    &run.root,
                    &run.task_id,
                    RunState::Working,
                    run.detail.as_deref(),
                    now,
                );
            }
            continue;
        }

        let current = snapshot::task_fingerprint(&run.root, &run.task_id);
        let record = crate::exit_hook::journal::last_exit(journal, &session);
        let (state, detail) = match record {
            Some(record) if record.exit_code == 0 => {
                let card_changed = current
                    .as_deref()
                    .zip(run.card_fingerprint.as_deref())
                    .is_some_and(|(current, before)| current != before);
                if settings.trust_exit_zero && card_changed {
                    (RunState::Done, "worker 退出码 0，卡片已被改动".to_string())
                } else {
                    let why = if card_changed {
                        "自动判定已关闭"
                    } else {
                        "卡片没有改动"
                    };
                    (
                        RunState::NeedsYou,
                        format!("worker 退出码 0，但{why}，请确认结果"),
                    )
                }
            }
            Some(record) => (
                RunState::Failed,
                format!("worker 退出码 {}", record.exit_code),
            ),
            None => (
                RunState::NeedsYou,
                "会话已结束，但没有退出记录，请确认结果".to_string(),
            ),
        };
        let _ = db.put_router_run(
            &run.root,
            &run.task_id,
            store::RunWrite {
                state,
                worker_app: run.worker_app.as_deref(),
                session_id: None,
                attempts: run.attempts,
                detail: Some(&detail),
                card_fingerprint: run.card_fingerprint.as_deref(),
                shadow: run.shadow,
            },
            now,
        );
        report
            .degraded
            .push(format!("reconciled:{}:{}", run.task_id, state.as_str()));
    }
}

/// 用一次调用同时问「哪几张现在值得动」：每张卡一个问题，noul 概率过阈值才算数。
///
/// 只问候选，不生成候选；选项（任务 id）由代码给。
async fn narrow_with_judge(
    judge: &dyn Judge,
    settings: &RouterSettings,
    candidates: &[Candidate],
) -> Result<(Vec<Candidate>, usize), String> {
    let thresholds = Thresholds::default();
    let mut questions = BTreeMap::new();
    for candidate in candidates {
        questions.insert(
            format!("pick:{}", candidate.task_id),
            Question::noul(format!(
                "看板和配额都很紧。现在最值得马上动手的是「{}」这张卡吗？\
                 判断依据：它是否阻塞别人、是否已经有明确的下一步、是否适合交给 agent 做。",
                candidate.title
            )),
        );
    }
    let state = serde_json::json!({
        "phase": "attention",
        "candidates": candidates
            .iter()
            .map(|candidate| serde_json::json!({
                "id": candidate.task_id,
                "title": candidate.title,
                "status": candidate.status,
                "attempts": candidate.attempts(),
            }))
            .collect::<Vec<_>>(),
    });
    let reply = judge
        .ask(&settings.judge_model, state, questions)
        .await
        .map_err(|error| error.reason())?;
    let picked: Vec<Candidate> = candidates
        .iter()
        .filter(|candidate| {
            thresholds.should_act(reply.noul(&format!("pick:{}", candidate.task_id)))
        })
        .cloned()
        .collect();
    // 一张都没过阈值：不硬凑，交给确定性规则按顺序处理。
    if picked.is_empty() {
        return Ok((candidates.to_vec(), 1));
    }
    Ok((picked, 1))
}

#[derive(Clone, Debug, Default)]
pub(crate) struct Settled {
    pub decisions: Vec<Decision>,
    pub dropped: Vec<String>,
    pub unfinished: bool,
}

/// 校验 episode 的输出：任务必须在候选里、动作必须合法、派发必须落在配额内。
///
/// 这里不做「判断题」，只做「能不能执行」的硬校验。非法项丢弃并记因，不重试——
/// 重试一次非法输出只是再花一次钱。
pub(crate) fn settle(
    outcome: EpisodeOutcome,
    candidates: &[Candidate],
    settings: &RouterSettings,
    capacity: usize,
) -> Settled {
    let known: HashSet<&str> = candidates
        .iter()
        .map(|candidate| candidate.task_id.as_str())
        .collect();
    let mut settled = Settled {
        unfinished: outcome.decisions.unfinished,
        ..Default::default()
    };
    let mut seen = HashSet::new();
    let mut dispatches = 0usize;

    for decision in outcome.decisions.decisions {
        if !known.contains(decision.task_id.as_str()) {
            settled
                .dropped
                .push(format!("decision-for-unknown-task:{}", decision.task_id));
            continue;
        }
        if !seen.insert(decision.task_id.clone()) {
            settled
                .dropped
                .push(format!("duplicate-decision:{}", decision.task_id));
            continue;
        }
        match decision.action {
            Action::Dispatch => {
                let worker = decision
                    .app_id
                    .as_deref()
                    .filter(|app| settings.worker_apps.iter().any(|allowed| allowed == app));
                let Some(worker) = worker else {
                    // 派给一个没配置的 worker：不改写、不猜，转人工。
                    settled.decisions.push(Decision::ask(
                        decision.task_id.clone(),
                        format!(
                            "提名了 {}，但它不在允许的 worker 列表里（{}），需要人确认派给谁。",
                            decision.app_id.as_deref().unwrap_or("（空）"),
                            settings.worker_apps.join(" / ")
                        ),
                    ));
                    settled
                        .dropped
                        .push(format!("invalid-worker:{}", decision.task_id));
                    continue;
                };
                if dispatches >= capacity {
                    settled
                        .dropped
                        .push(format!("dispatch-over-capacity:{}", decision.task_id));
                    settled.decisions.push(Decision::skip(
                        decision.task_id.clone(),
                        "本轮名额已满，下一轮再派。",
                    ));
                    continue;
                }
                dispatches += 1;
                settled.decisions.push(Decision {
                    app_id: Some(worker.to_string()),
                    reason: decision.reason,
                    ..decision
                });
            }
            Action::Ask => {
                if decision.question.as_deref().unwrap_or("").trim().is_empty() {
                    settled
                        .dropped
                        .push(format!("ask-without-question:{}", decision.task_id));
                    continue;
                }
                settled.decisions.push(decision);
            }
            Action::Skip => settled.decisions.push(decision),
        }
    }
    settled
}

/// 执行决策。
///
/// 影子模式只把运行态记成 `queued` 并落 trace，不派发任何进程。这不是省略，
/// 是第一次开自动调度时必须走的路：先看它判断得对不对。
fn apply(
    db: &Database,
    dispatcher: &dyn dispatch::Dispatcher,
    settings: &RouterSettings,
    candidates: &[Candidate],
    decisions: &[Decision],
    now: i64,
    report: &mut TickReport,
) {
    let by_id: HashMap<&str, &Candidate> = candidates
        .iter()
        .map(|candidate| (candidate.task_id.as_str(), candidate))
        .collect();

    for decision in decisions {
        let Some(candidate) = by_id.get(decision.task_id.as_str()).copied() else {
            report
                .degraded
                .push(format!("decision-without-candidate:{}", decision.task_id));
            continue;
        };
        match decision.action {
            Action::Dispatch => {
                let Some(app_id) = decision.app_id.clone() else {
                    continue;
                };
                if settings.shadow {
                    let detail = format!(
                        "shadow: would dispatch to {app_id}（{}）",
                        decision.reason.clone().unwrap_or_default()
                    );
                    let _ = db.put_router_run(
                        &candidate.root,
                        &candidate.task_id,
                        store::RunWrite {
                            state: RunState::Queued,
                            worker_app: Some(&app_id),
                            session_id: None,
                            attempts: candidate.attempts(),
                            detail: Some(&detail),
                            card_fingerprint: Some(&candidate.fingerprint),
                            // 影子模式：记录一次「本来会派谁」，不产生进程。
                            shadow: true,
                        },
                        now,
                    );
                    continue;
                }

                let holder = snapshot::holder();
                let lease = db.acquire_router_lease(
                    &candidate.root,
                    &candidate.task_id,
                    &holder,
                    now + settings.lease_seconds.max(1) * 1000,
                );
                if !matches!(lease, Ok(true)) {
                    report
                        .degraded
                        .push(format!("lease-busy:{}", candidate.task_id));
                    continue;
                }

                let spec = DispatchSpec {
                    task_id: candidate.task_id.clone(),
                    root: candidate.root.clone(),
                    app_id: app_id.clone(),
                    file: candidate.file.clone(),
                    title: candidate.title.clone(),
                };
                let result = dispatcher.dispatch(&spec);
                let _ = db.release_router_lease(&candidate.root, &candidate.task_id);

                match result {
                    Ok(outcome) => {
                        let _ = db.put_router_run(
                            &candidate.root,
                            &candidate.task_id,
                            store::RunWrite {
                                state: RunState::Dispatched,
                                worker_app: Some(&app_id),
                                session_id: Some(&outcome.session_id),
                                attempts: candidate.attempts() + 1,
                                detail: None,
                                // 记下派发那一刻的卡片指纹：收尾时用它判断 worker 动没动过。
                                card_fingerprint: Some(&candidate.fingerprint),
                                shadow: false,
                            },
                            now,
                        );
                        let _ = db.insert_router_dispatch(
                            &candidate.task_id,
                            &candidate.root,
                            &app_id,
                            now,
                        );
                        report.dispatched.push(candidate.task_id.clone());
                    }
                    Err(error) => {
                        // 环境类错误（没窗口、平台不支持）不是 worker 的错，转人工；
                        // 其它错误按失败退避重试。
                        let environment = matches!(
                            error.as_str(),
                            "no-window" | "unsupported-platform" | "unsupported-app"
                        );
                        let state = if environment {
                            RunState::NeedsYou
                        } else {
                            RunState::Failed
                        };
                        let _ = db.put_router_run(
                            &candidate.root,
                            &candidate.task_id,
                            store::RunWrite {
                                state,
                                worker_app: Some(&app_id),
                                session_id: None,
                                attempts: candidate.attempts() + 1,
                                detail: Some(&format!("dispatch-failed:{error}")),
                                card_fingerprint: candidate
                                    .run
                                    .as_ref()
                                    .and_then(|run| run.card_fingerprint.as_deref()),
                                shadow: false,
                            },
                            now,
                        );
                        if environment {
                            report.needs_you.push(candidate.task_id.clone());
                        }
                        report
                            .degraded
                            .push(format!("dispatch-failed:{}:{error}", candidate.task_id));
                    }
                }
            }
            Action::Ask => {
                let question = decision.question.clone().unwrap_or_default();
                let _ = db.put_router_run(
                    &candidate.root,
                    &candidate.task_id,
                    store::RunWrite {
                        state: RunState::NeedsYou,
                        worker_app: candidate
                            .run
                            .as_ref()
                            .and_then(|run| run.worker_app.as_deref()),
                        session_id: candidate
                            .run
                            .as_ref()
                            .and_then(|run| run.session_id.as_deref()),
                        attempts: candidate.attempts(),
                        detail: Some(&question),
                        card_fingerprint: candidate
                            .run
                            .as_ref()
                            .and_then(|run| run.card_fingerprint.as_deref()),
                        shadow: false,
                    },
                    now,
                );
                report.needs_you.push(candidate.task_id.clone());
            }
            Action::Skip => {}
        }
    }
}

/// 从快照里找出任务所在的仓库根、卡片路径与标题。派发要用它们当工作目录与指令。
pub(crate) fn resolve_task(db: &Database, root: Option<&str>, task_id: &str) -> Option<Candidate> {
    let scan = snapshot::collect(db).ok()?;
    scan.candidates.into_iter().find(|candidate| {
        candidate.task_id == task_id && root.is_none_or(|root| candidate.root == root)
    })
}
