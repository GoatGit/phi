//! super-agent 的行为测试。
//!
//! 全部用内存数据库 + 临时 backlog 工作区 + 假判官 / 假派发器，不碰真终端、不联网。
//! 断言的都是「结构约束」，而不是文案：
//! - 关闭时一次都不派发；
//! - 影子模式只记 trace，不派发；
//! - 闸门拒绝时不派发，且转成等你看；
//! - 判官失败时注意力分桶放行（fail-open），闸门则拦住（fail-closed）。

use std::collections::BTreeMap;
use std::sync::Mutex;

use serde_json::Value;

use crate::super_agent::dispatch::Dispatcher;
use crate::super_agent::episode::{Episode, EpisodeInput, RuleEpisode};
use crate::super_agent::judge::{BoxFuture, Judge, JudgeError, JudgeReply, Question};
use crate::super_agent::model::{
    Candidate, Decision, DecisionSet, DispatchOutcome, DispatchSpec, RouterSettings, RunState,
};
use crate::super_agent::store::RunWrite;
use crate::super_agent::tick::{self, TickContext};
use crate::tasks::document::initialize;
use crate::tasks::model::NewTask;
use crate::tasks::repository;
use crate::Database;

struct Workspace {
    _temp: tempfile::TempDir,
    root: String,
    db: std::sync::Arc<Database>,
}

fn workspace(count: usize, status: &str) -> Workspace {
    let temp = tempfile::tempdir().expect("tempdir");
    let opened = initialize(temp.path(), "phi").expect("init");
    for index in 1..=count {
        repository::create(
            &opened,
            &NewTask {
                title: format!("任务 {index}"),
                status: Some(status.into()),
                ..Default::default()
            },
        )
        .expect("create");
    }
    let root = opened.root.to_string_lossy().into_owned();
    let db = std::sync::Arc::new(Database::memory().expect("db"));
    db.add_task_workspace(&root).expect("register");
    Workspace {
        _temp: temp,
        root,
        db,
    }
}

fn settings(shadow: bool) -> RouterSettings {
    RouterSettings {
        enabled: true,
        shadow,
        ..Default::default()
    }
}

#[derive(Default)]
struct RecordingDispatcher {
    dispatched: Mutex<Vec<DispatchSpec>>,
    cancelled: Mutex<Vec<String>>,
    fail_with: Option<String>,
}

impl Dispatcher for RecordingDispatcher {
    fn dispatch(&self, spec: &DispatchSpec) -> Result<DispatchOutcome, String> {
        if let Some(reason) = &self.fail_with {
            return Err(reason.clone());
        }
        self.dispatched.lock().unwrap().push(spec.clone());
        Ok(DispatchOutcome {
            session_id: format!("session-{}", spec.task_id),
        })
    }

    fn cancel(&self, session_id: &str) -> Result<(), String> {
        self.cancelled.lock().unwrap().push(session_id.into());
        Ok(())
    }
}

impl RecordingDispatcher {
    fn count(&self) -> usize {
        self.dispatched.lock().unwrap().len()
    }
}

struct FixedJudge {
    reply: Result<JudgeReply, JudgeError>,
    calls: Mutex<usize>,
}

impl FixedJudge {
    fn noul(value: f64) -> Self {
        let mut answers = BTreeMap::new();
        for id in [
            "pick:TASK-1",
            "pick:TASK-2",
            "pick:TASK-3",
            "pick:TASK-4",
            "pick:TASK-5",
            "pick:TASK-6",
            "pick:TASK-7",
            "pick:TASK-8",
            "pick:TASK-9",
            "pick:TASK-10",
            "pick:TASK-11",
            "pick:TASK-12",
        ] {
            answers.insert(
                id.to_string(),
                serde_json::json!({"type":"noul","noul":value}),
            );
        }
        Self {
            reply: Ok(JudgeReply { answers }),
            calls: Mutex::new(0),
        }
    }

    fn failing() -> Self {
        Self {
            reply: Err(JudgeError::Failed("upstream-timeout".into())),
            calls: Mutex::new(0),
        }
    }
}

impl Judge for FixedJudge {
    fn ask<'a>(
        &'a self,
        _model: &'a str,
        _state: Value,
        _questions: BTreeMap<String, Question>,
    ) -> BoxFuture<'a, Result<JudgeReply, JudgeError>> {
        *self.calls.lock().unwrap() += 1;
        let reply = self.reply.clone();
        Box::pin(async move { reply })
    }
}

/// 直接给一组决策的 episode，用来测结算与执行，不测规则判断。
struct FixedEpisode {
    decisions: DecisionSet,
}

impl Episode for FixedEpisode {
    fn run<'a>(
        &'a self,
        _input: EpisodeInput<'a>,
    ) -> BoxFuture<
        'a,
        Result<
            crate::super_agent::episode::EpisodeOutcome,
            crate::super_agent::episode::EpisodeError,
        >,
    > {
        let outcome = crate::super_agent::episode::EpisodeOutcome {
            decisions: self.decisions.clone(),
            steps: Vec::new(),
            judge_calls: 0,
        };
        Box::pin(async move { Ok(outcome) })
    }
}

async fn run_tick(
    db: &Database,
    settings: RouterSettings,
    judge: &dyn Judge,
    dispatcher: &dyn Dispatcher,
    episode: &dyn Episode,
) -> crate::super_agent::model::TickReport {
    db.save_router_settings(&settings).expect("settings");
    tick::run(
        TickContext {
            db,
            judge,
            dispatcher,
            episode,
            now: crate::super_agent::store::now_ms(),
        },
        "test",
    )
    .await
    .expect("tick")
    .report
}

#[tokio::test]
async fn disabled_router_touches_nothing() {
    let workspace = workspace(1, "In Progress");
    let mut config = settings(false);
    config.enabled = false;
    let dispatcher = RecordingDispatcher::default();
    let report = run_tick(
        &workspace.db,
        config,
        &FixedJudge::noul(0.9),
        &dispatcher,
        &RuleEpisode,
    )
    .await;
    assert_eq!(report.skipped.as_deref(), Some("disabled"));
    assert_eq!(dispatcher.count(), 0);
    assert!(report.decisions.is_empty());
}

#[tokio::test]
async fn shadow_mode_records_the_decision_without_dispatching() {
    let workspace = workspace(1, "In Progress");
    let dispatcher = RecordingDispatcher::default();
    let report = run_tick(
        &workspace.db,
        settings(true),
        &FixedJudge::noul(0.9),
        &dispatcher,
        &RuleEpisode,
    )
    .await;
    assert!(report.shadow);
    assert_eq!(dispatcher.count(), 0);
    assert_eq!(report.decisions.len(), 1);
    let run = workspace
        .db
        .router_run(&workspace.root, "TASK-1")
        .expect("run")
        .expect("row");
    assert_eq!(run.state, RunState::Queued);
    assert!(run.detail.expect("detail").starts_with("shadow:"));
}

#[tokio::test]
async fn dispatch_records_session_attempt_and_quota() {
    let workspace = workspace(1, "In Progress");
    let dispatcher = RecordingDispatcher::default();
    let report = run_tick(
        &workspace.db,
        settings(false),
        &FixedJudge::noul(0.9),
        &dispatcher,
        &RuleEpisode,
    )
    .await;
    assert_eq!(report.dispatched, vec!["TASK-1".to_string()]);
    assert_eq!(dispatcher.count(), 1);
    let spec = dispatcher.dispatched.lock().unwrap()[0].clone();
    assert_eq!(spec.app_id, "claude");
    assert!(spec.file.ends_with(".md"));
    assert!(spec.prompt().contains(&spec.file));

    let run = workspace
        .db
        .router_run(&workspace.root, "TASK-1")
        .expect("run")
        .expect("row");
    assert_eq!(run.state, RunState::Dispatched);
    assert_eq!(run.attempts, 1);
    assert_eq!(run.session_id.as_deref(), Some("session-TASK-1"));

    let quota = workspace
        .db
        .router_quota_usage(crate::super_agent::store::now_ms())
        .expect("quota");
    assert_eq!(quota.dispatches, 1);
}

#[tokio::test]
async fn dispatch_failure_keeps_the_reason_and_counts_the_attempt() {
    let workspace = workspace(1, "In Progress");
    let dispatcher = RecordingDispatcher {
        fail_with: Some("terminal-limit".into()),
        ..Default::default()
    };
    let report = run_tick(
        &workspace.db,
        settings(false),
        &FixedJudge::noul(0.9),
        &dispatcher,
        &RuleEpisode,
    )
    .await;
    let run = workspace
        .db
        .router_run(&workspace.root, "TASK-1")
        .expect("run")
        .expect("row");
    assert_eq!(run.state, RunState::Failed);
    assert_eq!(run.attempts, 1);
    assert!(run.detail.expect("detail").contains("terminal-limit"));
    assert!(report.dispatched.is_empty());
    assert!(report
        .degraded
        .iter()
        .any(|note| note.starts_with("dispatch-failed:TASK-1")));
}

#[tokio::test]
async fn environment_failure_asks_a_human_instead_of_retrying() {
    let workspace = workspace(1, "In Progress");
    let dispatcher = RecordingDispatcher {
        fail_with: Some("unsupported-platform".into()),
        ..Default::default()
    };
    let report = run_tick(
        &workspace.db,
        settings(false),
        &FixedJudge::noul(0.9),
        &dispatcher,
        &RuleEpisode,
    )
    .await;
    let run = workspace
        .db
        .router_run(&workspace.root, "TASK-1")
        .expect("run")
        .expect("row");
    assert_eq!(run.state, RunState::NeedsYou);
    assert_eq!(report.needs_you, vec!["TASK-1".to_string()]);
}

#[tokio::test]
async fn attention_failure_is_fail_open() {
    let workspace = workspace(11, "In Progress");
    let mut config = settings(false);
    config.attention_threshold = 2;
    config.concurrency = 2;
    config.dispatches_per_tick = 2;
    let dispatcher = RecordingDispatcher::default();
    let judge = FixedJudge::failing();
    let report = run_tick(&workspace.db, config, &judge, &dispatcher, &RuleEpisode).await;
    // 分桶失败不否决整轮：仍然照规则派发到名额上限。
    assert!(*judge.calls.lock().unwrap() == 1);
    assert!(report
        .degraded
        .iter()
        .any(|note| note.starts_with("attention-fail-open")));
    assert_eq!(dispatcher.count(), 2);
}

#[tokio::test]
async fn attention_narrows_when_the_judge_is_confident() {
    let workspace = workspace(11, "In Progress");
    let mut config = settings(false);
    config.attention_threshold = 2;
    config.concurrency = 3;
    config.dispatches_per_tick = 3;
    let dispatcher = RecordingDispatcher::default();
    let judge = FixedJudge::noul(0.95);
    let report = run_tick(&workspace.db, config, &judge, &dispatcher, &RuleEpisode).await;
    assert!(report.narrowed);
    // 全部过阈值时不做无意义的裁掉，仍然按名额上限截断。
    assert_eq!(dispatcher.count(), 3);
}

#[tokio::test]
async fn concurrency_limit_stops_the_tick_before_the_loop() {
    let workspace = workspace(2, "In Progress");
    let mut config = settings(false);
    config.concurrency = 1;
    workspace
        .db
        .put_router_run(
            &workspace.root,
            "TASK-9",
            RunWrite {
                state: RunState::Working,
                worker_app: Some("claude"),
                // 没有会话 id：reconcile 不会去猜它结束没结束，这一条只测并发上限。
                session_id: None,
                attempts: 1,
                detail: None,
                card_fingerprint: None,
                shadow: false,
            },
            crate::super_agent::store::now_ms(),
        )
        .expect("run");
    let dispatcher = RecordingDispatcher::default();
    let report = run_tick(
        &workspace.db,
        config,
        &FixedJudge::noul(0.9),
        &dispatcher,
        &RuleEpisode,
    )
    .await;
    assert_eq!(report.skipped.as_deref(), Some("concurrency-full"));
    assert_eq!(dispatcher.count(), 0);
}

#[tokio::test]
async fn decisions_for_unknown_tasks_or_duplicates_are_dropped() {
    let workspace = workspace(1, "In Progress");
    let episode = FixedEpisode {
        decisions: DecisionSet {
            decisions: vec![
                Decision::dispatch("TASK-404", "claude", "ghost"),
                Decision::dispatch("TASK-1", "claude", "first"),
                Decision::dispatch("TASK-1", "claude", "duplicate"),
            ],
            unfinished: true,
        },
    };
    let dispatcher = RecordingDispatcher::default();
    let report = run_tick(
        &workspace.db,
        settings(false),
        &FixedJudge::noul(0.9),
        &dispatcher,
        &episode,
    )
    .await;
    assert_eq!(dispatcher.count(), 1);
    assert!(report
        .degraded
        .iter()
        .any(|note| note == "decision-for-unknown-task:TASK-404"));
    assert!(report
        .degraded
        .iter()
        .any(|note| note == "duplicate-decision:TASK-1"));
    assert!(report
        .degraded
        .iter()
        .any(|note| note == "episode-unfinished"));
}

#[tokio::test]
async fn nominating_an_unlisted_worker_becomes_a_question() {
    let workspace = workspace(1, "In Progress");
    let episode = FixedEpisode {
        decisions: DecisionSet {
            decisions: vec![Decision::dispatch("TASK-1", "gemini", "best at this")],
            unfinished: false,
        },
    };
    let dispatcher = RecordingDispatcher::default();
    let report = run_tick(
        &workspace.db,
        settings(false),
        &FixedJudge::noul(0.9),
        &dispatcher,
        &episode,
    )
    .await;
    assert_eq!(dispatcher.count(), 0);
    assert_eq!(report.needs_you, vec!["TASK-1".to_string()]);
    let run = workspace
        .db
        .router_run(&workspace.root, "TASK-1")
        .expect("run")
        .expect("row");
    assert_eq!(run.state, RunState::NeedsYou);
}

#[tokio::test]
async fn pause_and_resume_are_visible_to_the_next_tick() {
    let workspace = workspace(1, "In Progress");
    workspace
        .db
        .set_router_state(&workspace.root, "TASK-1", RunState::Paused, None, 0)
        .expect("pause");
    let dispatcher = RecordingDispatcher::default();
    let report = run_tick(
        &workspace.db,
        settings(false),
        &FixedJudge::noul(0.9),
        &dispatcher,
        &RuleEpisode,
    )
    .await;
    assert_eq!(report.skipped.as_deref(), Some("no-candidates"));
    assert!(report
        .filtered
        .iter()
        .any(|filtered| filtered.reason == "paused"));
    assert_eq!(dispatcher.count(), 0);
}

#[tokio::test]
async fn attempts_exhausted_stops_the_automatic_path() {
    let workspace = workspace(1, "In Progress");
    workspace
        .db
        .put_router_run(
            &workspace.root,
            "TASK-1",
            RunWrite {
                state: RunState::Failed,
                worker_app: Some("claude"),
                session_id: None,
                attempts: 3,
                detail: Some("dispatch-failed:terminal-limit"),
                card_fingerprint: None,
                shadow: false,
            },
            0,
        )
        .expect("run");
    let dispatcher = RecordingDispatcher::default();
    let report = run_tick(
        &workspace.db,
        settings(false),
        &FixedJudge::noul(0.9),
        &dispatcher,
        &RuleEpisode,
    )
    .await;
    assert_eq!(dispatcher.count(), 0);
    assert!(report
        .filtered
        .iter()
        .any(|filtered| filtered.reason == "attempts-exhausted"));
}

#[tokio::test]
async fn trace_records_every_tick() {
    let workspace = workspace(1, "In Progress");
    run_tick(
        &workspace.db,
        settings(true),
        &FixedJudge::noul(0.9),
        &RecordingDispatcher::default(),
        &RuleEpisode,
    )
    .await;
    let traces = workspace.db.router_traces(10).expect("traces");
    assert_eq!(traces.len(), 1);
    assert_eq!(traces[0].trigger, "test");
    assert!(traces[0].shadow);
    assert_eq!(traces[0].decisions.len(), 1);
}

#[tokio::test]
async fn candidates_off_the_trigger_column_are_ignored() {
    let workspace = workspace(1, "To Do");
    let dispatcher = RecordingDispatcher::default();
    let report = run_tick(
        &workspace.db,
        settings(false),
        &FixedJudge::noul(0.9),
        &dispatcher,
        &RuleEpisode,
    )
    .await;
    assert_eq!(report.skipped.as_deref(), Some("no-candidates"));
    assert!(report
        .filtered
        .iter()
        .any(|filtered| filtered.reason == "not-triggered"));
    assert_eq!(dispatcher.count(), 0);
}

fn journal_with(
    dir: &tempfile::TempDir,
    terminal_id: &str,
    exit: i32,
    cwd: &str,
) -> std::path::PathBuf {
    let path = dir.path().join("session-exit.log");
    std::fs::write(
        &path,
        format!(
            "{terminal_id}	{exit}	1762900000	claude	{cwd}
"
        ),
    )
    .expect("journal");
    path
}

fn dispatch_run(db: &Database, root: &str, session: &str, fingerprint: Option<&str>) {
    db.put_router_run(
        root,
        "TASK-1",
        RunWrite {
            state: RunState::Dispatched,
            worker_app: Some("claude"),
            session_id: Some(session),
            attempts: 1,
            detail: None,
            card_fingerprint: fingerprint,
            shadow: false,
        },
        crate::super_agent::store::now_ms(),
    )
    .expect("run");
}

#[test]
fn reconcile_marks_done_only_when_exit_is_zero_and_the_card_changed() {
    let workspace = workspace(1, "In Progress");
    let journal_dir = tempfile::tempdir().expect("journal dir");
    let session = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
    let fingerprint = crate::super_agent::snapshot::task_fingerprint(&workspace.root, "TASK-1")
        .expect("fingerprint");

    // 退出码 0，但卡片没被改过 → 不判完成，转人工。
    dispatch_run(&workspace.db, &workspace.root, session, Some(&fingerprint));
    let journal = journal_with(&journal_dir, session, 0, &workspace.root);
    let mut report = empty_report();
    crate::super_agent::tick::reconcile(
        &workspace.db,
        &settings(false),
        crate::super_agent::store::now_ms(),
        &journal,
        &mut report,
    );
    let run = workspace
        .db
        .router_run(&workspace.root, "TASK-1")
        .expect("run")
        .expect("row");
    assert_eq!(run.state, RunState::NeedsYou);
    assert!(run.detail.expect("detail").contains("卡片没有改动"));

    // 卡片被 worker 改过 + 退出码 0 → 完成。
    let task_file = std::path::Path::new(&workspace.root).join("backlog/tasks");
    let path = std::fs::read_dir(&task_file)
        .expect("tasks dir")
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| path.extension().is_some_and(|ext| ext == "md"))
        .expect("task file");
    let mut body = std::fs::read_to_string(&path).expect("read");
    body.push_str("\n结论：改完了，测试通过。\n");
    std::fs::write(&path, body).expect("write");

    dispatch_run(&workspace.db, &workspace.root, session, Some(&fingerprint));
    let mut report = empty_report();
    crate::super_agent::tick::reconcile(
        &workspace.db,
        &settings(false),
        crate::super_agent::store::now_ms(),
        &journal,
        &mut report,
    );
    let run = workspace
        .db
        .router_run(&workspace.root, "TASK-1")
        .expect("run")
        .expect("row");
    assert_eq!(run.state, RunState::Done);
}

#[test]
fn reconcile_fails_a_non_zero_exit_and_asks_when_there_is_no_record() {
    let workspace = workspace(1, "In Progress");
    let journal_dir = tempfile::tempdir().expect("journal dir");
    let session = "3f2504e0-4f89-11d3-9a0c-0305e82c3302";

    dispatch_run(&workspace.db, &workspace.root, session, None);
    let journal = journal_with(&journal_dir, session, 130, &workspace.root);
    crate::super_agent::tick::reconcile(
        &workspace.db,
        &settings(false),
        crate::super_agent::store::now_ms(),
        &journal,
        &mut empty_report(),
    );
    let run = workspace
        .db
        .router_run(&workspace.root, "TASK-1")
        .expect("run")
        .expect("row");
    assert_eq!(run.state, RunState::Failed);
    assert!(run.detail.expect("detail").contains("130"));

    // 没有退出记录：不假装完成。
    let other = "3f2504e0-4f89-11d3-9a0c-0305e82c3303";
    dispatch_run(&workspace.db, &workspace.root, other, None);
    crate::super_agent::tick::reconcile(
        &workspace.db,
        &settings(false),
        crate::super_agent::store::now_ms(),
        &journal,
        &mut empty_report(),
    );
    let run = workspace
        .db
        .router_run(&workspace.root, "TASK-1")
        .expect("run")
        .expect("row");
    assert_eq!(run.state, RunState::NeedsYou);
    assert!(run.detail.expect("detail").contains("没有退出记录"));
}

fn empty_report() -> crate::super_agent::model::TickReport {
    crate::super_agent::model::TickReport {
        trace_id: "t".into(),
        at: 0,
        trigger: "test".into(),
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
        shadow: false,
    }
}

/// 两个仓库都有 TASK-1：运行态必须分开记，否则一个仓库的派发会覆盖另一个。
#[test]
fn run_state_is_keyed_by_repository_not_only_task_id() {
    let first = workspace(1, "In Progress");
    let second = workspace(1, "In Progress");
    assert_ne!(first.root, second.root);

    first
        .db
        .set_router_state(&first.root, "TASK-1", RunState::Paused, None, 10)
        .expect("pause first");
    first
        .db
        .set_router_state(&second.root, "TASK-1", RunState::Working, None, 11)
        .expect("working second");

    let in_first = first
        .db
        .router_run(&first.root, "TASK-1")
        .expect("run")
        .expect("row");
    let in_second = first
        .db
        .router_run(&second.root, "TASK-1")
        .expect("run")
        .expect("row");
    assert_eq!(in_first.state, RunState::Paused);
    assert_eq!(in_second.state, RunState::Working);
    assert_eq!(in_first.root, first.root);
    assert_eq!(in_second.root, second.root);
}

/// 依赖没到 Done：先不动这张卡。
#[test]
fn blocked_dependencies_keep_the_card_queued() {
    let workspace = workspace(1, "In Progress");
    workspace
        .db
        .put_router_run(
            &workspace.root,
            "TASK-1",
            RunWrite {
                state: RunState::Idle,
                worker_app: None,
                session_id: None,
                attempts: 0,
                detail: None,
                card_fingerprint: None,
                shadow: false,
            },
            0,
        )
        .expect("run");
    // 直接测 prefilter：依赖 TASK-2 不存在 → blocked-by。
    let candidate = Candidate {
        task_id: "TASK-1".into(),
        root: workspace.root.clone(),
        title: "任务 1".into(),
        status: "In Progress".into(),
        file: "backlog/tasks/task-1.md".into(),
        fingerprint: "fp".into(),
        dependencies: vec!["TASK-2".into()],
        run: None,
    };
    let outcome = crate::super_agent::prefilter::apply(
        vec![candidate],
        &settings(false),
        &Default::default(),
        crate::super_agent::store::now_ms(),
    );
    assert!(outcome.survivors.is_empty());
    assert_eq!(outcome.filtered[0].reason, "blocked-by:TASK-2");
}
