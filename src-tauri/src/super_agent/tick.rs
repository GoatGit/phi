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
use crate::super_agent::prefilter;
use crate::super_agent::snapshot;
use crate::super_agent::store;
use crate::super_agent::worker::{WorkerRuntime, WorkerState};
use crate::Database;

/// 一次 episode 的预算。与 pi 版共用同一套口径：读一次卡算一步，提名一次算一步。
pub(crate) const EPISODE_STEPS: usize = 8;
pub(crate) const EPISODE_JUDGE_CALLS: usize = 5;

/// 一次只跑一轮 tick。
///
/// 定时器、面板上的「跑一轮」、人按下「开始」都会触发 tick。两轮重叠时看到的是同一份
/// 快照，会把同一批候选算两遍、把判官与模型的钱花两遍；派发本身有租约挡，
/// 但预算挡不住。锁是整个 tick 共享的，与具体数据库无关。
pub(crate) static TICK_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub(crate) struct TickContext<'a> {
    pub db: &'a Database,
    pub judge: &'a dyn Judge,
    pub workers: &'a dyn WorkerRuntime,
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
    let _one_at_a_time = TICK_LOCK.lock().await;
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

    // ---------------------------------------------------------------- 收尾
    // 先把已经结束的 worker 结算掉，再决定这一轮派谁：否则一张早就跑完的卡
    // 会一直占着并发名额，看起来像「调度器停了」。
    // 这一步只读写自己的运行态，不派发、不调判官，所以调度器关着时也要跑：
    // 关掉/重启后没人收尾，卡片会永远挂着「运行中」。
    reconcile(
        ctx.db,
        &settings,
        ctx.now,
        &crate::exit_hook::journal_path(),
        ctx.workers,
        &mut report,
    );

    if !settings.enabled {
        report.skipped = Some("disabled".into());
        return finish(ctx.db, report, steps, started);
    }

    // ---------------------------------------------------------------- 快照
    let mut scan = snapshot::collect(ctx.db)?;
    scan.candidates.retain(|task| !task.discussion_hold);
    report.scanned = scan.scanned;
    report.degraded.extend(scan.notes.clone());
    if scan.candidates.is_empty() {
        report.skipped = Some("no-tasks".into());
        return finish(ctx.db, report, steps, started);
    }
    // 巡检：看板上的事实优先于运行记录。一张卡还挂在执行列上，运行记录却说它
    // 「完成 / 失败 / 等人确认」，那它既没在跑、也没完成——正是该被重新派发的那类。
    let mut candidates = scan.candidates;
    // 排期先走：到点的持续 / 定时任务要先把卡片送回执行列，否则后面的巡检和
    // 预过滤都看不到它（它可能还挂在 Done 里）。
    advance_schedules(ctx.db, &settings, &mut candidates, ctx.now, &mut report);
    supervise(ctx.db, &settings, &mut candidates, ctx.now, &mut report);
    let statuses: HashMap<(String, String), String> = candidates
        .iter()
        .map(|candidate| {
            (
                (candidate.root.clone(), candidate.task_id.clone()),
                if candidate.state() == RunState::Done {
                    "Done".into()
                } else {
                    candidate.status.clone()
                },
            )
        })
        .collect();
    let filtered = prefilter::apply(candidates, &settings, &statuses, ctx.now);
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
    // 一次 episode 只喂一个仓库的候选。任务 id 只在仓库内唯一，两个仓库都有 TASK-1
    // 时混在一次循环里，会让「给 TASK-1 的结论」落到另一张卡上，甚至派发到错的仓库。
    let mut remaining = capacity;
    for group in group_by_root(survivors) {
        if remaining == 0 {
            report.degraded.push("capacity-exhausted".into());
            break;
        }
        let outcome = ctx
            .episode
            .run(EpisodeInput {
                candidates: &group,
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
        steps.push(format!(
            "episode: {} 张候选（{}）",
            group.len(),
            group[0].root
        ));

        // ---------------------------------------------------------- 结算
        let settled = settle(outcome, &group, &settings, remaining);
        if settled.unfinished {
            report.degraded.push("episode-unfinished".into());
        }
        for dropped in &settled.dropped {
            report.degraded.push(dropped.clone());
        }
        let decisions = settled.decisions;
        // 名额按「真正要派发」的决策扣，跨仓库累计，不能让每个仓库各自用满一次。
        remaining = remaining.saturating_sub(
            decisions
                .iter()
                .filter(|decision| decision.action == Action::Dispatch)
                .count(),
        );
        report.decisions.extend(decisions.iter().cloned());

        // ---------------------------------------------------------- 执行
        apply(
            ctx.db,
            ctx.workers,
            &settings,
            &group,
            &decisions,
            ctx.now,
            &mut report,
        );

        // 有候选、却没有一条决策落在这张卡上：这一轮等于什么都没判断出来。
        // 不留状态的话，卡在看板上就是一个空徽标，和从没派发过一模一样，
        // 用户只能得出「调度器死了」的结论。写一条 queued 至少看得出它还在排队；
        // 下一轮仍会重试（prefilter 不拦 Queued）。
        for candidate in &group {
            if decisions
                .iter()
                .any(|decision| decision.task_id == candidate.task_id)
            {
                continue;
            }
            let _ = ctx.db.put_router_run(
                &candidate.root,
                &candidate.task_id,
                store::RunWrite {
                    state: RunState::Queued,
                    worker_app: None,
                    session_id: None,
                    attempts: candidate.attempts(),
                    detail: Some("Lead 这一轮没有给出结论，下一轮重试"),
                    card_fingerprint: Some(&candidate.fingerprint),
                    shadow: settings.shadow,
                },
                ctx.now,
            );
            // 应用已经置空，上一轮的智能体快照跟着一起清：留着它，界面会出现
            // 「没有应用，却写着上一轮用的模型」这种自相矛盾的一行。
            let _ = ctx
                .db
                .clear_router_run_agent(&candidate.root, &candidate.task_id);
            report
                .degraded
                .push(format!("undecided:{}", candidate.task_id));
        }
    }

    finish(ctx.db, report, steps, started)
}

/// 按仓库分组，组内顺序与候选顺序一致。
fn group_by_root(candidates: Vec<Candidate>) -> Vec<Vec<Candidate>> {
    let mut groups: Vec<Vec<Candidate>> = Vec::new();
    for candidate in candidates {
        match groups
            .iter_mut()
            .find(|group| group[0].root == candidate.root)
        {
            Some(group) => group.push(candidate),
            None => groups.push(vec![candidate]),
        }
    }
    groups
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

/// 持续 / 定时任务：到点了就把卡片送回执行列，并重新排队。
///
/// 为什么不是「再派一次」而是先改卡片状态：看板是事实来源。一张已经 Done 的卡
/// 不挪回执行列，预过滤会照旧剔除它，下一个人打开看板也看不出它还在周期里。
///
/// 首次看到排期时只记「从现在的时刻起算」，不补跑一次：给一张跑了半年的卡加上
/// 「每小时」，不该立刻触发一次陈年旧跑。
pub(crate) fn advance_schedules(
    db: &Database,
    settings: &RouterSettings,
    candidates: &mut [Candidate],
    now: i64,
    report: &mut TickReport,
) {
    for candidate in candidates.iter_mut() {
        let Some(spec) = candidate.schedule.clone() else {
            continue;
        };
        let state = candidate.state();
        // 正在跑、等人回话、被用户暂停：排期都不该抢在前面。
        if state.is_running() || matches!(state, RunState::Paused | RunState::NeedsYou) {
            continue;
        }
        let last = match db.router_schedule_last(&candidate.root, &candidate.task_id) {
            Ok(value) => value,
            Err(error) => {
                log::warn!(
                    "router schedule read failed task={}: {error}",
                    candidate.task_id
                );
                continue;
            }
        };
        // 只有间隔任务需要「起点」；每日 / 一次性的时刻是绝对的，
        // 把「上表」写成一次触发会让它们白白少跑一轮。
        if last.is_none() && spec.kind == crate::tasks::schedule::Kind::Interval {
            if let Err(error) = db.mark_router_schedule(&candidate.root, &candidate.task_id, now) {
                log::warn!(
                    "router schedule arm failed task={}: {error}",
                    candidate.task_id
                );
                continue;
            }
            report
                .degraded
                .push(format!("schedule-armed:{}", candidate.task_id));
            continue;
        }
        if spec.spent(last) {
            continue;
        }
        let Some(due) = spec.due_at(last) else {
            continue;
        };
        if due > now {
            continue;
        }

        // 卡片不在执行列：先挪回去（指纹会变，后面排队要用挪完的指纹）。
        let mut fingerprint = candidate.fingerprint.clone();
        if candidate.status != settings.trigger_status {
            let workspace =
                match crate::tasks::document::open(std::path::Path::new(&candidate.root)) {
                    Ok(workspace) => workspace,
                    Err(error) => {
                        log::warn!(
                            "router schedule workspace failed root={}: {error}",
                            candidate.root
                        );
                        continue;
                    }
                };
            match crate::tasks::repository::set_status(
                &workspace,
                &candidate.task_id,
                &settings.trigger_status,
                &candidate.fingerprint,
            ) {
                Ok(detail) => fingerprint = detail.task.fingerprint,
                Err(error) => {
                    log::warn!(
                        "router schedule move failed task={}: {error}",
                        candidate.task_id
                    );
                    report.degraded.push(format!(
                        "schedule-move-failed:{}:{error}",
                        candidate.task_id
                    ));
                    continue;
                }
            }
        }

        let detail = format!(
            "{}：到达下一次运行时间，已放回执行列",
            if spec.kind == crate::tasks::schedule::Kind::Once {
                "定时任务"
            } else {
                "持续任务"
            }
        );
        let persisted = db.put_router_run(
            &candidate.root,
            &candidate.task_id,
            store::RunWrite {
                state: RunState::Queued,
                worker_app: None,
                session_id: None,
                // 每一轮重新给满预算：上一轮失败多少次，都不该拖累下一轮。
                attempts: 0,
                detail: Some(&detail),
                card_fingerprint: Some(&fingerprint),
                shadow: settings.shadow,
            },
            now,
        );
        if let Err(error) = persisted {
            log::error!(
                "router schedule requeue failed task={}: {error}",
                candidate.task_id
            );
            report
                .degraded
                .push(format!("schedule-requeue-failed:{}", candidate.task_id));
            continue;
        }
        // 上一轮派给谁不再适用：这一轮要重新选人，快照跟着运行态一起清。
        if let Err(error) = db.clear_router_run_agent(&candidate.root, &candidate.task_id) {
            log::warn!(
                "router schedule snapshot clear failed task={}: {error}",
                candidate.task_id
            );
        }
        if let Err(error) = db.mark_router_schedule(&candidate.root, &candidate.task_id, now) {
            log::warn!(
                "router schedule mark failed task={}: {error}",
                candidate.task_id
            );
        }
        let _ = db.release_router_lease(&candidate.root, &candidate.task_id);
        candidate.status = settings.trigger_status.clone();
        candidate.fingerprint = fingerprint.clone();
        candidate.run = Some(crate::super_agent::model::TaskRun {
            task_id: candidate.task_id.clone(),
            root: candidate.root.clone(),
            state: RunState::Queued,
            worker_app: None,
            agent_id: None,
            agent_name: None,
            agent_model: None,
            session_id: None,
            attempts: 0,
            detail: Some(detail),
            card_fingerprint: Some(fingerprint),
            shadow: settings.shadow,
            updated_at: now,
        });
        report
            .degraded
            .push(format!("scheduled:{}", candidate.task_id));
    }
}

/// 看板巡检：把「运行记录」和「看板上的事实」对齐。
///
/// 处理三种矛盾：
/// - 卡片还挂在执行列（`trigger_status`）上，运行记录却说它已经结束
///   （`done` / `failed` / `needs-you`）——那就是「没在跑、没完成、也不是人停的」；
/// - 卡片回到了执行列，但运行记录停在 `done`（人把它拖回来的）；
/// - 「等你看」放得太久（`needs_you_seconds`）没人回——用户不可能永远守着看板，
///   超过时限就按原卡片再跑一次，但仍然守着重试预算。
///
/// 重排时把重试预算清零（除了「等你看」超时那条：那不代表卡片换了一版，不应当
/// 重置预算，否则同一件事可以无限重试）。
pub(crate) fn supervise(
    db: &Database,
    settings: &RouterSettings,
    candidates: &mut [Candidate],
    now: i64,
    report: &mut TickReport,
) {
    for candidate in candidates.iter_mut() {
        let Some(run) = candidate.run.as_mut() else {
            continue;
        };
        // 正在跑、或者人按了暂停：都不归这里管。
        if run.state.is_running() || run.state == RunState::Paused {
            continue;
        }
        // 只看执行列：其它列的卡本来就不该自动派发，写一条「排队中」只会让人误会。
        if candidate.status != settings.trigger_status {
            continue;
        }
        // 等你确认放得太久：按原卡片自动继续。预算已经用完的那张卡不再自动重来，
        // 它问就是真的需要人给一句。
        let waited = now.saturating_sub(run.updated_at);
        let needs_you_expired = run.state == RunState::NeedsYou
            && settings.needs_you_seconds > 0
            && waited >= settings.needs_you_seconds.saturating_mul(1000)
            && run.attempts < settings.max_attempts;
        let fingerprint_changed = run
            .card_fingerprint
            .as_deref()
            .is_some_and(|before| before != candidate.fingerprint);
        let reopened = run.state == RunState::Done && !prefilter::done_status(&candidate.status);
        let reconsidered =
            matches!(run.state, RunState::Failed | RunState::NeedsYou) && fingerprint_changed;
        if !needs_you_expired && !reopened && !reconsidered {
            continue;
        }
        let expired = needs_you_expired && !reopened && !reconsidered;
        let (detail, attempts) = if expired {
            let minutes = (settings.needs_you_seconds / 60).max(1);
            let previous = run
                .detail
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("（没有记录问题）");
            (
                format!(
                    "{minutes} 分钟没有收到你的确认，已按当前卡片自动继续。上一轮在等：{previous}"
                ),
                run.attempts,
            )
        } else if reopened {
            ("任务又回到执行列，重新排队".to_string(), 0)
        } else {
            ("卡片已被改动，重新排队并清零重试预算".to_string(), 0)
        };
        run.state = RunState::Queued;
        run.session_id = None;
        run.attempts = attempts;
        run.detail = Some(detail.clone());
        run.card_fingerprint = Some(candidate.fingerprint.clone());
        run.updated_at = now;
        let persisted = db.put_router_run(
            &run.root,
            &run.task_id,
            store::RunWrite {
                state: RunState::Queued,
                worker_app: run.worker_app.as_deref(),
                session_id: None,
                attempts,
                detail: Some(&detail),
                card_fingerprint: Some(&candidate.fingerprint),
                shadow: run.shadow,
            },
            now,
        );
        if let Err(error) = persisted {
            log::error!("router requeue failed task={}: {error}", candidate.task_id);
            report
                .degraded
                .push(format!("requeue-failed:{}", candidate.task_id));
            continue;
        }
        // 重新排队意味着上一次运行的租约作废，否则新的一轮会被自己的旧租约拦住。
        let _ = db.release_router_lease(&run.root, &run.task_id);
        report.degraded.push(format!(
            "{}:{}",
            if expired {
                "needs-you-expired"
            } else {
                "requeued"
            },
            candidate.task_id
        ));
    }
}

/// 卡片正文里 worker 留下的「需要你决定」那一行。
///
/// 读不到卡片就当没有：结算不能因为一次读文件失败而崩溃，也不能凭空造一个问题出来。
fn card_question(root: &str, task_id: &str) -> Option<String> {
    let workspace = crate::tasks::document::open(std::path::Path::new(root)).ok()?;
    let detail = crate::tasks::repository::read(&workspace, task_id).ok()?;
    crate::super_agent::model::human_question(&detail.body)
}

/// 结算已经结束的 worker。
///
/// 先看退出记账，再看托管会话还在不在。顺序不能反：`session.sh` 在 CLI 退出后会
/// 落回一个交互式 shell，**终端会话还在**——用「会话存在」当「worker 还在跑」，
/// 一张卡会永远停在「运行中」，一直占着并发名额，直到调度器再也不会派活。
///
/// 退出码为 0 且任务已移到 Done 才算完成。触发列中尚未完成的任务冷却后重派，
/// 无退出记录或耗尽次数的任务转人工；不把进程消失或任意文件改动冒充完成。
///
/// 「还在不在」问运行时（[`WorkerRuntime::probe`]），不问进程名也不问 pane：
/// zellij 的 session 活着不等于任务在跑，pane 退出也不等于任务完成。
pub(crate) fn reconcile(
    db: &Database,
    settings: &RouterSettings,
    now: i64,
    journal: &std::path::Path,
    workers: &dyn WorkerRuntime,
    report: &mut TickReport,
) {
    let Ok(runs) = db.router_runs() else { return };
    for run in runs {
        if run.state == RunState::Failed && run.attempts >= settings.max_attempts {
            if let Err(error) = db.set_router_state(
                &run.root,
                &run.task_id,
                RunState::NeedsYou,
                Some("已达到自动尝试上限，请确认下一步"),
                now,
            ) {
                log::error!(
                    "router exhausted state write failed task={}: {error}",
                    run.task_id
                );
            }
            continue;
        }
        if !run.state.is_running() {
            continue;
        }
        let record = run
            .session_id
            .as_deref()
            .and_then(|session| crate::exit_hook::journal::last_exit(journal, session));
        let alive = run
            .session_id
            .as_deref()
            .map(|session| workers.probe(session))
            .unwrap_or(WorkerState::Unknown);
        // 卡死看门狗。界面停在提示符、进程却永远不死的 worker（交互式 TUI 跑完一轮
        // 就是这样）在运行时那里一直是 `Alive`：不留这道上限，它就永远占着一个
        // 并发位，后面的卡一张也派不出去——表现就是「调度器停了」。
        let stalled = settings.stall_seconds > 0
            && now.saturating_sub(run.updated_at) >= settings.stall_seconds.saturating_mul(1000);
        if record.is_none() && alive == WorkerState::Alive {
            if !stalled {
                // 还没有退出记录、运行时也说还在跑：worker 真的还在。
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
            // 超过上限还没结束：先停掉，再按失败结算，让它进入重试而不是占着位置。
            if let Some(session) = run.session_id.as_deref() {
                if let Err(error) = workers.cancel(session) {
                    log::warn!("router stall cancel failed task={}: {error}", run.task_id);
                }
            }
            let attempts = run.attempts + 1;
            let minutes = (settings.stall_seconds / 60).max(1);
            let (state, detail) = if attempts >= settings.max_attempts {
                (
                    RunState::NeedsYou,
                    format!(
                        "worker 超过 {minutes} 分钟没有结束，已尝试 {attempts} 次，请确认下一步"
                    ),
                )
            } else {
                (
                    RunState::Failed,
                    format!("worker 超过 {minutes} 分钟没有结束，已停掉它，等冷却后重派"),
                )
            };
            let persisted = db.put_router_run(
                &run.root,
                &run.task_id,
                store::RunWrite {
                    state,
                    worker_app: run.worker_app.as_deref(),
                    session_id: None,
                    attempts,
                    detail: Some(&detail),
                    card_fingerprint: run.card_fingerprint.as_deref(),
                    shadow: run.shadow,
                },
                now,
            );
            if let Err(error) = persisted {
                log::error!("router stall settle failed task={}: {error}", run.task_id);
                report
                    .degraded
                    .push(format!("reconcile-write-failed:{}", run.task_id));
                continue;
            }
            let _ = db.release_router_lease(&run.root, &run.task_id);
            report
                .degraded
                .push(format!("stalled:{}:{}", run.task_id, state.as_str()));
            continue;
        }

        let task = resolve_task(db, Some(&run.root), &run.task_id);
        let current = task.as_ref().map(|task| task.fingerprint.as_str());
        // journal 是唯一事实；它没写成功时，pane 自己记的退出码还能救一次
        // （两者同源：worker.sh 拿到的就是 CLI 的退出码）。
        let exit_code = record
            .as_ref()
            .map(|record| record.exit_code)
            .or(match alive {
                WorkerState::Exited(code) => Some(code),
                _ => None,
            });
        let (state, detail) = match exit_code {
            Some(0) => {
                let card_changed = current
                    .zip(run.card_fingerprint.as_deref())
                    .is_some_and(|(current, before)| current != before);
                let done = task
                    .as_ref()
                    .is_some_and(|task| task.status.eq_ignore_ascii_case("done"));
                // worker 在卡里写了「需要你决定：…」：这是停下来等人回话，不是失败。
                // 重派只会拿着同一版卡片把同一个问题再问一遍——钱花两遍，一个字没变。
                let question = if card_changed && !done {
                    task.as_ref()
                        .and_then(|task| card_question(&run.root, &task.task_id))
                } else {
                    None
                };
                if settings.trust_exit_zero && card_changed && done {
                    (
                        RunState::Done,
                        "worker 退出码 0，任务已移到 Done".to_string(),
                    )
                } else if let Some(question) = question {
                    (
                        RunState::NeedsYou,
                        format!("worker 停下来等你回话：{question}。把答案补进卡片正文，再选「继续执行」"),
                    )
                } else if settings.trust_exit_zero
                    && task
                        .as_ref()
                        .is_some_and(|task| task.status == settings.trigger_status)
                {
                    (
                        RunState::Failed,
                        "worker 已结束，任务未完成，将在冷却后继续派发".to_string(),
                    )
                } else {
                    // 原因要说对人真正看到的那一种：自动判定开着、worker 把卡挪到了
                    // 「审阅」这类非触发列时，说成「自动判定已关闭」会让人去找一个
                    // 本来就是开的开关。
                    let why = if !settings.trust_exit_zero {
                        "自动判定已关闭"
                    } else if task.is_none() {
                        "卡片已不在工作区"
                    } else if card_changed {
                        "任务没移进 Done"
                    } else {
                        "卡片没有改动"
                    };
                    (
                        RunState::NeedsYou,
                        format!("worker 退出码 0，但{why}，请确认结果"),
                    )
                }
            }
            Some(code) => (RunState::Failed, format!("worker 退出码 {code}")),
            None => {
                // 既没有退出记录，运行时也查不到它：worker 是被打断的（客户端重启、
                // 机器重启、pane 没了），不是「跑完了」。卡片还挂在执行列时，这正是
                // 「没在跑、没完成、也不是人停的」，该自动重新派，而不是每天来问人。
                let in_trigger = task
                    .as_ref()
                    .is_some_and(|task| task.status == settings.trigger_status);
                if !settings.trust_exit_zero {
                    (
                        RunState::NeedsYou,
                        "会话已结束，但没有退出记录（自动判定已关闭），请确认结果".to_string(),
                    )
                } else if in_trigger && run.attempts < settings.max_attempts {
                    (
                        RunState::Failed,
                        "worker 已经不在（应用退出/重启或 pane 消失），冷却后自动重新派发"
                            .to_string(),
                    )
                } else if in_trigger {
                    (
                        RunState::NeedsYou,
                        format!(
                            "会话已结束且没有退出记录，已尝试 {} 次，请确认结果",
                            run.attempts
                        ),
                    )
                } else {
                    (
                        RunState::NeedsYou,
                        "会话已结束，但没有退出记录，请确认结果".to_string(),
                    )
                }
            }
        };
        let (state, detail) = if state == RunState::Failed && run.attempts >= settings.max_attempts
        {
            (
                RunState::NeedsYou,
                format!("{detail}；已达到自动尝试上限，请确认下一步"),
            )
        } else {
            (state, detail)
        };
        log::info!(
            "router reconciled task={} state={} attempts={}",
            run.task_id,
            state.as_str(),
            run.attempts
        );
        let persisted = db.put_router_run(
            &run.root,
            &run.task_id,
            store::RunWrite {
                state,
                worker_app: run.worker_app.as_deref(),
                session_id: None,
                attempts: run.attempts,
                detail: Some(&detail),
                // 记下「这次运行结束后」的卡片指纹：下一次比较的是它，于是
                // worker 自己改卡不会被当成「有人动过」，只有之后的外部改动才算。
                card_fingerprint: current.or(run.card_fingerprint.as_deref()),
                shadow: run.shadow,
            },
            now,
        );
        if let Err(error) = persisted {
            log::error!(
                "router reconcile persistence failed task={}: {error}",
                run.task_id
            );
            report
                .degraded
                .push(format!("reconcile-write-failed:{}", run.task_id));
            continue;
        }
        let _ = db.release_router_lease(&run.root, &run.task_id);
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
    let by_id: HashMap<&str, &Candidate> = candidates
        .iter()
        .map(|candidate| (candidate.task_id.as_str(), candidate))
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
                // 人工指派优先：卡片写着归属时，判官提名的人不算数。
                // 这条放在结算层而不是提示词里——能被绕过的东西不能当闸门。
                let forced = match by_id
                    .get(decision.task_id.as_str())
                    .and_then(|candidate| candidate.assignee_agent(settings))
                {
                    Some(Ok(id)) => Some(id),
                    Some(Err(id)) => {
                        settled
                            .dropped
                            .push(format!("unknown-assignee:{}", decision.task_id));
                        settled.decisions.push(Decision::ask(
                            decision.task_id.clone(),
                            format!(
                                "这张卡指派给 {id}，但本机没有这个智能体。请指派一个已存在的智能体，或改回未指派。"
                            ),
                        ));
                        continue;
                    }
                    None => None,
                };
                let nominated = forced.as_deref().or(decision.app_id.as_deref());
                let worker = nominated
                    .filter(|app| settings.worker_apps.iter().any(|allowed| allowed == app));
                let Some(worker) = worker else {
                    // 派给一个没配置的 worker：不改写、不猜，转人工。
                    settled.decisions.push(Decision::ask(
                        decision.task_id.clone(),
                        format!(
                            "提名了 {}，但它不在允许的智能体列表里（{}），需要人确认派给谁。",
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
    workers: &dyn WorkerRuntime,
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
                let Some(agent) = decision.app_id.as_deref().and_then(|id| settings.agent(id))
                else {
                    continue;
                };
                let app_id = agent.app_id.clone();
                if let Err(detail) = agent.ready(db) {
                    let _ = db.put_router_run(
                        &candidate.root,
                        &candidate.task_id,
                        store::RunWrite {
                            state: RunState::NeedsYou,
                            worker_app: Some(&app_id),
                            session_id: None,
                            attempts: candidate.attempts(),
                            detail: Some(&detail),
                            card_fingerprint: Some(&candidate.fingerprint),
                            shadow: settings.shadow,
                        },
                        now,
                    );
                    report.degraded.push(detail);
                    report.needs_you.push(candidate.task_id.clone());
                    continue;
                }
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
                    agent,
                    task_id: candidate.task_id.clone(),
                    root: candidate.root.clone(),
                    app_id: app_id.clone(),
                    file: candidate.file.clone(),
                    title: candidate.title.clone(),
                };
                let result = workers.dispatch(&spec);
                // 成功时不放租约：写入运行态之前有一个窗口，并发的另一轮 tick
                // （手动「开始」会 kick 一次）看到旧快照就会再派一次。租约到期
                // （TTL）自己会被回收，不需要提前放。
                if result.is_err() {
                    let _ = db.release_router_lease(&candidate.root, &candidate.task_id);
                }

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
                        // 快照和运行态分开记：智能体改名 / 改模型 / 删除都不改历史。
                        let _ = db.record_router_run_agent(
                            &candidate.root,
                            &candidate.task_id,
                            &spec.agent,
                            now,
                        );
                        report.dispatched.push(candidate.task_id.clone());
                    }
                    Err(error) => {
                        // 派发失败一律按失败重试，包括环境类错误（没有窗口、平台不支持、
                        // zellij 起不来）。这张卡既没在跑也没完成，也不是人停的；环境修好
                        // 后下一轮就该派出去。真的一直失败，重试预算会把它转成「等你看」，
                        // 而不是在第一次失败就永久停在那里。
                        let attempts = candidate.attempts() + 1;
                        let state = if attempts >= settings.max_attempts {
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
                                attempts,
                                detail: Some(&format!("dispatch-failed:{error}")),
                                // 记录里存的永远是「写入这一刻」的卡片指纹：巡检靠
                                // 它区分「之后有人动过」与「机器自己写的」。
                                card_fingerprint: Some(&candidate.fingerprint),
                                shadow: false,
                            },
                            now,
                        );
                        if state == RunState::NeedsYou {
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
                // 影子模式不能把卡片钉在「等你看」：那会改变运行态，此后 prefilter
                // 直接剔除它，影子就再也观测不到这张卡了。只记「本来会问什么」。
                let (state, detail) = if settings.shadow {
                    (
                        RunState::Queued,
                        format!("shadow: would ask a human（{question}）"),
                    )
                } else {
                    (RunState::NeedsYou, question.clone())
                };
                let _ = db.put_router_run(
                    &candidate.root,
                    &candidate.task_id,
                    store::RunWrite {
                        state,
                        worker_app: candidate
                            .run
                            .as_ref()
                            .and_then(|run| run.worker_app.as_deref()),
                        session_id: candidate
                            .run
                            .as_ref()
                            .and_then(|run| run.session_id.as_deref()),
                        attempts: candidate.attempts(),
                        detail: Some(&detail),
                        card_fingerprint: Some(&candidate.fingerprint),
                        shadow: settings.shadow,
                    },
                    now,
                );
                if !settings.shadow {
                    report.needs_you.push(candidate.task_id.clone());
                }
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
