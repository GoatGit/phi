//! 自动调度的 Tauri 命令层。
//!
//! 这里只有四个动作需要人按：开/关、暂停、恢复、立刻开始。其余判断都在 tick 里，
//! 前端不参与调度——否则「自动」就又变成「点了才动」。

use tauri::State;

use crate::store::AppState;
use crate::super_agent::judge::SystemOneJudge;
use crate::super_agent::model::{
    Candidate, DispatchSpec, RouterSettings, RouterStatus, RunState, TickReport,
};
use crate::super_agent::runtime;
use crate::super_agent::store::{self, RunWrite};
use crate::super_agent::tick::{self, TickContext};
use crate::super_agent::worker::{WorkerRuntime, WorkerState};

/// 智能体编辑器里能选的执行模型。
///
/// `overridable` 是「这个应用能不能按会话指定模型」，和 `models` 是不是空无关：
/// 支持的应用即使暂时一个模型也没列出来，也应该让人自己填一个。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentModels {
    pub models: Vec<String>,
    pub overridable: bool,
}

#[tauri::command]
pub fn router_agent_models(
    state: State<'_, AppState>,
    app_id: String,
) -> Result<AgentModels, String> {
    let app: crate::app_config::AppType = app_id.parse().map_err(|_| "invalid-agent-app")?;
    let models = crate::mode::stack::worker_models(&state.db, &app).map_err(|e| e.to_string())?;
    Ok(AgentModels {
        models,
        overridable: crate::mode::stack::supports_session_model(&app),
    })
}

#[tauri::command]
pub fn router_settings(state: State<'_, AppState>) -> Result<RouterSettings, String> {
    state.db.router_settings().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn router_save_settings(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    settings: RouterSettings,
) -> Result<RouterSettings, String> {
    // 先归一再校验：新智能体没有 id 时由后端从名称派生，前端的表单不必自己
    // 猜 uniqueness，也就不会出现「界面上的 id 与真正落盘的 id 不是同一个」。
    let settings = settings.normalize_agents();
    settings.validate_agents()?;
    for agent in &settings.agents {
        agent.ready(&state.db)?;
    }
    state
        .db
        .save_router_settings(&settings)
        .map_err(|e| e.to_string())?;
    runtime::kick(&app);
    state.db.router_settings().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn router_status(state: State<'_, AppState>) -> Result<RouterStatus, String> {
    let now = store::now_ms();
    Ok(RouterStatus {
        settings: state.db.router_settings().map_err(|e| e.to_string())?,
        runs: state.db.router_runs().map_err(|e| e.to_string())?,
        traces: state.db.router_traces(20).map_err(|e| e.to_string())?,
        today: state
            .db
            .router_quota_usage(now)
            .map_err(|e| e.to_string())?,
    })
}

/// 手动跑一次 tick。行为与定时 tick 完全一致（同样的开关、配额、影子模式），
/// 只是不等节拍——用它做「现在到底会派谁」的对照。
#[tauri::command]
pub async fn router_tick(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    trigger: Option<String>,
) -> Result<TickReport, String> {
    let db = state.db.clone();
    let judge = SystemOneJudge::new(db.clone());
    let workers = runtime::workers_for(&app);
    // 与定时 tick 用同一个 episode（含 sidecar 与降级链）：手跑一轮就是预览
    // 下一轮真的会发生什么，不能拿规则版冒充它。
    let episode = runtime::episode_for(&app);
    let outcome = tick::run(
        TickContext {
            db: db.as_ref(),
            judge: &judge,
            workers: &workers,
            episode: episode.as_ref(),
            now: store::now_ms(),
        },
        trigger.as_deref().unwrap_or("manual"),
    )
    .await?;
    Ok(outcome.report)
}

/// 手动「开始会话」要传给 CLI 的参数：与自动派发同一句话，并且已经在 Rust 侧
/// 转义成 `terminal_create` 认的那个 `arguments`，前端不拼指令、也不自己加引号。
///
/// 没有这条，从看板点「开始会话」只会开一个空会话：worker 起来了，但没人告诉它
/// 该读哪张卡，看起来就像「任务没发过去」。
#[tauri::command]
pub fn task_session_arguments(
    state: State<'_, AppState>,
    root: String,
    task_id: String,
) -> Result<String, String> {
    let candidate = tick::resolve_task(&state.db, Some(&root), &task_id)
        .ok_or_else(|| "task-not-found".to_string())?;
    // 人点的「开始」与自动派发要是同一份参数，包括非交互模式；否则同一个任务
    // 从机器派发会结束，从人手里派发会停在提示符，调度器还以为它在跑。
    let settings = state.db.router_settings().map_err(|e| e.to_string())?;
    // 与「开始」同一套解析：卡片归属优先，其次这张卡上次派给谁，最后才是默认；
    // 归属认不出来就报错，不换人——换个人干等于改了用户的指派。
    let agent_id = preferred_agent(&candidate, &settings)?;
    let agent = settings
        .agent(&agent_id)
        .ok_or_else(|| format!("unknown-router-agent:{agent_id}"))?;
    agent.ready(&state.db)?;
    Ok(agent.launch_arguments(&candidate.file))
}

/// 「打开 worker 的终端」的结果。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedWorker {
    pub session_id: String,
    /// 该切到哪个应用页签：就是 worker 自己那个 CLI。
    pub app_id: String,
}

/// 打开一个 worker 的终端。
///
/// 两个后端说法不同，所以由这里归一：
/// - 托管终端：worker 本身就是 phi 的一个会话，会话还在就原样把 id 交回去；
/// - zellij：worker 不在 phi 的终端表里，现开一个查看器窗格挂上去（关掉只是
///   断开查看，worker 照旧在 zellij 里跑）。
#[tauri::command]
pub fn task_open_worker(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    root: String,
    task_id: String,
) -> Result<OpenedWorker, String> {
    let run = state
        .db
        .router_run(&root, &task_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "run-not-found".to_string())?;
    let session = run
        .session_id
        .clone()
        .ok_or_else(|| "no-worker-session".to_string())?;
    let app_id = run.worker_app.clone().unwrap_or_default();
    let workers = runtime::workers_for(&app);
    match workers.viewer(&session)? {
        Some(plan) => Ok(OpenedWorker {
            session_id: crate::terminal::open_viewer(
                &app,
                &plan.app_id,
                &plan.title,
                &plan.cwd,
                plan.argv,
                plan.environment,
                &plan.worker_session,
            )?
            .id,
            app_id: plan.app_id,
        }),
        None if crate::terminal::session_exists(&session) => Ok(OpenedWorker {
            session_id: session,
            app_id,
        }),
        None => Err("session-ended".into()),
    }
}

/// 一个 worker 现在的状态，给「查看器」页脚用。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerSnapshot {
    /// `alive` | `exited` | `unknown`
    pub state: String,
    /// 只有真的知道时才给：补一个 0 会把失败说成成功。
    pub exit_code: Option<i32>,
}

/// 查一个 worker 自己的状态。
///
/// 为什么需要这条：跑在 zellij 里的 worker 在 phi 界面上是「查看器窗格」，
/// 那个窗格是 `zellij attach` 客户端，worker 退出了它也还挂着。拿窗格的 phase
/// 当任务状态，就会在一块写着 `EXIT CODE: 0` 的画面下面顶着「运行中」。
///
/// 退出记账是唯一事实，pane 的退出码只是旁证：两者顺序不能反。
#[tauri::command]
pub fn router_worker_state(
    app: tauri::AppHandle,
    session_id: String,
) -> Result<WorkerSnapshot, String> {
    let workers = runtime::workers_for(&app);
    let probe = workers.probe(&session_id);
    let journal =
        crate::exit_hook::journal::last_exit(&crate::exit_hook::journal_path(), &session_id)
            .map(|record| record.exit_code)
            .or(match probe {
                WorkerState::Exited(code) => Some(code),
                _ => None,
            });
    let state = match journal {
        Some(_) => "exited",
        None => match probe {
            WorkerState::Alive => "alive",
            // 查不到就是不知道：既不说「还在跑」，也不说「已经退出」。
            _ => "unknown",
        },
    };
    Ok(WorkerSnapshot {
        state: state.to_string(),
        exit_code: journal,
    })
}

/// 工作室一轮对话。
///
/// 模型只产出一份可编辑草稿：写入设置仍要人点保存，所以「模型自己造员工」
/// 这条路在能力上不存在（它没有数据库，也没有命令权限）。
/// `current` 是右栏此刻的那一版，多轮修改以它为准。
#[tauri::command]
pub async fn router_agent_draft(
    app: tauri::AppHandle,
    app_id: String,
    history: Vec<crate::super_agent::studio::StudioTurn>,
    message: String,
    current: Option<crate::super_agent::model::RouterAgent>,
) -> Result<crate::super_agent::studio::StudioReply, String> {
    if message.trim().is_empty() {
        return Err("empty-message".into());
    }
    let parsed: crate::app_config::AppType = app_id
        .parse()
        .map_err(|_| "invalid-agent-app".to_string())?;
    if parsed.as_str() != app_id || app_id == "claude-desktop" {
        return Err("invalid-agent-app".into());
    }
    crate::super_agent::studio::reply(&app, &app_id, &history, &message, current.as_ref()).await
}

/// 调度器提议：近 14 天同类已完成卡 ≥ 3 张、且还没有对应智能体时给一条预填建议。
///
/// 只提议、不落库：提议是「一条可以点开的草稿」，人改完点保存才算数。
#[tauri::command]
pub fn router_agent_suggestions(
    state: State<'_, AppState>,
) -> Result<Vec<crate::super_agent::proposals::AgentSuggestion>, String> {
    let settings = state.db.router_settings().map_err(|e| e.to_string())?;
    Ok(crate::super_agent::proposals::propose(&state.db, &settings))
}

/// 读一张卡的规划 DAG（`plan_task` 的产物）。规则版 episode 不拆任务，所以通常是空的；
/// sidecar 版接上之后，这里就是详情页画图的数据源。
#[tauri::command]
pub fn router_plan(
    state: State<'_, AppState>,
    task_id: String,
) -> Result<Vec<crate::super_agent::model::PlanNode>, String> {
    state.db.router_plan(&task_id).map_err(|e| e.to_string())
}

/// 暂停一张卡：先停进程，再写状态。停不掉就保留运行态，避免恢复后重复派发。
#[tauri::command]
pub async fn router_pause_task(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    root: String,
    task_id: String,
) -> Result<(), String> {
    let _guard = tick::TICK_LOCK.lock().await;
    // 运行态按仓库定位：不同仓库都会有 TASK-1 这种 id。
    let run = state
        .db
        .router_run(&root, &task_id)
        .map_err(|e| e.to_string())?;
    let workers = runtime::workers_for(&app);
    if let Some(session) = run.as_ref().and_then(|run| run.session_id.as_deref()) {
        workers.cancel(session).map_err(|error| {
            log::warn!("router pause failed task={task_id}: {error}");
            error
        })?;
    }
    let root = run
        .as_ref()
        .map(|run| run.root.clone())
        .filter(|value| !value.is_empty())
        .unwrap_or(root);
    state
        .db
        .release_router_lease(&root, &task_id)
        .map_err(|e| e.to_string())?;
    state
        .db
        .put_router_run(
            &root,
            &task_id,
            RunWrite {
                state: RunState::Paused,
                worker_app: run.as_ref().and_then(|run| run.worker_app.as_deref()),
                session_id: None,
                attempts: run.as_ref().map(|run| run.attempts).unwrap_or(0),
                detail: None,
                card_fingerprint: run.as_ref().and_then(|run| run.card_fingerprint.as_deref()),
                shadow: false,
            },
            store::now_ms(),
        )
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn router_resume_task(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    root: String,
    task_id: String,
) -> Result<(), String> {
    let _guard = tick::TICK_LOCK.lock().await;
    let run = state
        .db
        .router_run(&root, &task_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "run-not-found".to_string())?;
    if run.state != RunState::Paused {
        return Err("run-state-changed".into());
    }
    queue_again(&state.db, &run)?;
    runtime::kick(&app);
    Ok(())
}

/// 立刻开始一张卡：跳过冷却与「还在等配额」的判断，但**不跳过** worker 白名单和租约。
/// 这是人明确按下的动作，所以影子模式不拦——影子只拦自动派发。
#[tauri::command]
pub async fn router_start_task(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    root: String,
    task_id: String,
) -> Result<(), String> {
    let _guard = tick::TICK_LOCK.lock().await;
    start_task_locked(&app, &state.db, &root, &task_id).await
}

/// 「开始」的实际动作。调用方必须已经持有 [`tick::TICK_LOCK`]。
///
/// 抽出来只为一件事：指派并开工要在同一把锁里「先写归属、再立刻派发」，
/// 否则中间那一瞬间 tick 可能拿着旧归属再派一次。
pub(crate) async fn start_task_locked(
    app: &tauri::AppHandle,
    db: &crate::Database,
    root: &str,
    task_id: &str,
) -> Result<(), String> {
    let settings = db.router_settings().map_err(|e| e.to_string())?;
    let candidate =
        tick::resolve_task(db, Some(root), task_id).ok_or_else(|| "task-not-found".to_string())?;
    if candidate
        .run
        .as_ref()
        .is_some_and(|run| run.state.is_running())
    {
        log::warn!("router duplicate start rejected task={task_id}");
        return Err("task-already-running".into());
    }
    let agent_id = preferred_agent(&candidate, &settings)?;
    if !settings
        .worker_apps
        .iter()
        .any(|allowed| allowed == &agent_id)
    {
        return Err("worker-not-allowed".into());
    }

    let agent = settings
        .agent(&agent_id)
        .ok_or_else(|| format!("unknown-router-agent:{agent_id}"))?;
    agent.ready(db)?;
    let app_id = agent.app_id.clone();

    // 人按「开始」时把卡片挪进触发列：之后 tick 才会把它当作自己的任务，
    // 否则它只是一次孤立派发，跑完也没人收尾。写之前比对指纹，卡片被外部改过
    // 就放弃写入，不覆盖别人的改动。
    //
    // 挪列会改文件（status + updated_date），指纹随之变化，所以记进运行态的必须是
    // 挪完之后的指纹：拿旧指纹去对，「收尾」会把一次什么都没干的运行判成完成。
    let mut fingerprint = candidate.fingerprint.clone();
    if candidate.discussion_hold || candidate.status != settings.trigger_status {
        let workspace = crate::tasks::commands::open_in(db, &candidate.root)?;
        let moved = crate::tasks::repository::set_status(
            &workspace,
            task_id,
            &settings.trigger_status,
            &candidate.fingerprint,
        )
        .map_err(|error| format!("status-move-failed:{error}"))?;
        fingerprint = moved.task.fingerprint;
    }

    let now = store::now_ms();
    let holder = format!("manual:{now}");
    let acquired = db
        .acquire_router_lease(
            &candidate.root,
            task_id,
            &holder,
            now + settings.lease_seconds.max(1) * 1000,
        )
        .map_err(|e| e.to_string())?;
    if !acquired {
        return Err("lease-busy".into());
    }

    let workers = runtime::workers_for(app);
    let spec = DispatchSpec {
        agent,
        task_id: task_id.to_string(),
        root: candidate.root.clone(),
        app_id: app_id.clone(),
        file: candidate.file.clone(),
        title: candidate.title.clone(),
    };
    let result = workers.dispatch(&spec);
    // 成功时保留租约直到 TTL：写入运行态之前有一个窗口，并发的 tick 会再派一次。
    if result.is_err() {
        let _ = db.release_router_lease(&candidate.root, task_id);
    }

    match result {
        Ok(outcome) => {
            db.put_router_run(
                &candidate.root,
                task_id,
                RunWrite {
                    state: RunState::Dispatched,
                    worker_app: Some(&app_id),
                    session_id: Some(&outcome.session_id),
                    attempts: candidate.attempts() + 1,
                    detail: None,
                    card_fingerprint: Some(fingerprint.as_str()),
                    // 人按下的「开始」不是影子：它确实派了进程。
                    shadow: false,
                },
                now,
            )
            .map_err(|e| e.to_string())?;
            db.insert_router_dispatch(task_id, &candidate.root, &app_id, now)
                .map_err(|e| e.to_string())?;
            db.record_router_run_agent(&candidate.root, task_id, &spec.agent, now)
                .map_err(|e| e.to_string())?;
            // 人按下的「开始」意味着这张卡现在就动：tick 之后不用再等节拍。
            runtime::kick(app);
            Ok(())
        }
        Err(error) => {
            let attempts = candidate.attempts() + 1;
            let root = candidate
                .run
                .as_ref()
                .map(|run| run.root.clone())
                .unwrap_or_else(|| root.to_string());
            db.put_router_run(
                &root,
                task_id,
                RunWrite {
                    state: RunState::Failed,
                    worker_app: Some(&app_id),
                    session_id: None,
                    attempts,
                    detail: Some(&format!("dispatch-failed:{error}")),
                    card_fingerprint: candidate
                        .run
                        .as_ref()
                        .and_then(|run| run.card_fingerprint.as_deref()),
                    shadow: false,
                },
                now,
            )
            .map_err(|e| e.to_string())?;
            Err(error)
        }
    }
}

/// 「指派」与「指派并开工」的结果。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssignOutcome {
    /// 写回卡片后的归属人（空 = 未指派）。
    pub assignees: Vec<String>,
    /// 是否真的起了进程。只指派、影子模式或依赖未满足时都是 `false`。
    pub started: bool,
    pub detail: Option<String>,
}

/// 把一张卡指派给某个智能体，或清掉指派（`agent_id = None`）。
///
/// `start = true` 才是第二个动作「指派并开工」。拖放只做前半截：改归属与
/// 授权现在起跑是两件事，绑在一起的话，自动调度开着时手一滑就起了一个进程。
#[tauri::command]
pub async fn router_assign_task(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    root: String,
    task_id: String,
    agent_id: Option<String>,
    start: bool,
    fingerprint: String,
) -> Result<AssignOutcome, String> {
    let _guard = tick::TICK_LOCK.lock().await;
    let settings = state.db.router_settings().map_err(|e| e.to_string())?;
    // 只接受允许名单里的智能体：指派一个不参与派发的人，看起来像派了活，
    // 实际什么都不会发生，比直接报错更难查。
    if let Some(id) = agent_id.as_deref() {
        if !settings.worker_apps.iter().any(|allowed| allowed == id) {
            return Err(format!("agent-not-allowed:{id}"));
        }
        let agent = settings
            .agent(id)
            .ok_or_else(|| format!("unknown-router-agent:{id}"))?;
        agent.ready(&state.db)?;
    }
    let workspace = crate::tasks::commands::open(&state, &root)?;
    // 依赖检查放在写入之前：一个起不来的动作不该顺手改掉卡片。
    if start {
        if agent_id.is_none() {
            return Err("no-agent-to-start".into());
        }
        let tasks = crate::tasks::repository::list(&workspace).map_err(|e| e.to_string())?;
        let current = crate::tasks::repository::read(&workspace, &task_id)?;
        for dependency in &current.task.dependencies {
            let done = tasks
                .iter()
                .find(|task| &task.id == dependency)
                .is_some_and(|task| crate::tasks::repository::is_done_status(&task.status));
            if !done {
                return Err(format!("blocked-by:{dependency}"));
            }
        }
    }

    let assignees: Vec<String> = agent_id.iter().cloned().collect();
    let detail =
        crate::tasks::repository::set_assignees(&workspace, &task_id, &assignees, &fingerprint)?;

    let mut started = false;
    let mut note = None;
    if start {
        if settings.shadow {
            // 影子模式只记账：人确实按了，但这套配置还在观察期，不该真起进程。
            let now = store::now_ms();
            state
                .db
                .put_router_run(
                    &root,
                    &task_id,
                    RunWrite {
                        state: RunState::Queued,
                        worker_app: agent_id.as_deref(),
                        session_id: None,
                        attempts: 0,
                        detail: Some("影子模式：指派后只排队，没有派发进程"),
                        card_fingerprint: Some(&detail.task.fingerprint),
                        shadow: true,
                    },
                    now,
                )
                .map_err(|e| e.to_string())?;
            note = Some("shadow".to_string());
        } else {
            start_task_locked(&app, &state.db, &root, &task_id).await?;
            started = true;
        }
    }
    Ok(AssignOutcome {
        assignees: detail.task.assignees,
        started,
        detail: note,
    })
}

/// 这张卡现在该派给谁：卡片归属 → 上次运行快照 → 默认智能体。
///
/// 归属认不出来时直接报错，不退到「上次用的那个」：卡片上写着一个人的名字，
/// 机器不能自己换个人去干，也不能悄悄降级成「随便找个人跑」。
pub(crate) fn preferred_agent(
    candidate: &Candidate,
    settings: &RouterSettings,
) -> Result<String, String> {
    match candidate.assignee_agent(settings) {
        Some(Ok(id)) => Ok(id),
        Some(Err(id)) => Err(format!("unknown-assignee:{id}")),
        None => candidate
            .run
            .as_ref()
            .and_then(|run| settings.agent_for_run(run))
            .or_else(|| settings.default_worker().map(str::to_string))
            .ok_or_else(|| "no-worker-configured".to_string()),
    }
}

fn queue_again(
    db: &crate::Database,
    run: &crate::super_agent::model::TaskRun,
) -> Result<(), String> {
    db.put_router_run(
        &run.root,
        &run.task_id,
        RunWrite {
            state: RunState::Queued,
            worker_app: run.worker_app.as_deref(),
            session_id: None,
            attempts: 0,
            detail: Some("用户确认继续执行"),
            card_fingerprint: run.card_fingerprint.as_deref(),
            shadow: false,
        },
        store::now_ms(),
    )
    .map_err(|e| e.to_string())?;
    db.release_router_lease(&run.root, &run.task_id)
        .map_err(|e| e.to_string())
}

/// 决定只接受枚举；版本与指纹防止旧抽屉误确认已经变化的任务。
#[derive(Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HumanDecision {
    Continue,
    Complete,
    Pause,
}

pub(crate) fn resolve_confirmation(
    db: &crate::Database,
    root: &str,
    task_id: &str,
    decision: HumanDecision,
    expected_updated_at: i64,
    fingerprint: &str,
) -> Result<(), String> {
    let run = db
        .router_run(root, task_id)
        .map_err(|e| e.to_string())?
        .ok_or("run-not-found")?;
    if run.state != RunState::NeedsYou || run.updated_at != expected_updated_at {
        log::warn!("router stale confirmation rejected task={task_id}");
        return Err("run-state-changed".into());
    }
    let candidate = tick::resolve_task(db, Some(root), task_id).ok_or("task-not-found")?;
    if candidate.fingerprint != fingerprint {
        return Err("stale-fingerprint".into());
    }
    match decision {
        HumanDecision::Continue => {
            let settings = db.router_settings().map_err(|e| e.to_string())?;
            if candidate.status != settings.trigger_status {
                let workspace = crate::tasks::document::open(std::path::Path::new(root))
                    .map_err(|e| e.to_string())?;
                crate::tasks::repository::set_status(
                    &workspace,
                    task_id,
                    &settings.trigger_status,
                    fingerprint,
                )?;
            }
            queue_again(db, &run)
        }
        HumanDecision::Pause => db
            .set_router_state(
                root,
                task_id,
                RunState::Paused,
                Some("用户确认暂停"),
                store::now_ms(),
            )
            .map_err(|e| e.to_string()),
        HumanDecision::Complete => {
            let workspace = crate::tasks::document::open(std::path::Path::new(root))
                .map_err(|e| e.to_string())?;
            crate::tasks::repository::set_status(&workspace, task_id, "Done", fingerprint)
                .map_err(|e| e.to_string())?;
            db.set_router_state(
                root,
                task_id,
                RunState::Done,
                Some("用户确认任务完成"),
                store::now_ms(),
            )
            .map_err(|e| e.to_string())
        }
    }
}

#[tauri::command]
pub async fn router_resolve_task(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    root: String,
    task_id: String,
    decision: HumanDecision,
    expected_updated_at: i64,
    fingerprint: String,
) -> Result<(), String> {
    let _guard = tick::TICK_LOCK.lock().await;
    resolve_confirmation(
        &state.db,
        &root,
        &task_id,
        decision,
        expected_updated_at,
        &fingerprint,
    )?;
    runtime::kick(&app);
    Ok(())
}
