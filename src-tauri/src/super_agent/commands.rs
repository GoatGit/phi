//! 自动调度的 Tauri 命令层。
//!
//! 这里只有四个动作需要人按：开/关、暂停、恢复、立刻开始。其余判断都在 tick 里，
//! 前端不参与调度——否则「自动」就又变成「点了才动」。

use tauri::State;

use crate::store::AppState;
use crate::super_agent::model::{DispatchSpec, RouterSettings, RouterStatus, RunState, TickReport};
use crate::super_agent::runtime;
use crate::super_agent::store::{self, RunWrite};
use crate::super_agent::tick::{self, TickContext};
use crate::super_agent::{episode::RuleEpisode, judge::SystemOneJudge};

#[tauri::command]
pub fn router_settings(state: State<'_, AppState>) -> Result<RouterSettings, String> {
    state.db.router_settings().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn router_save_settings(
    state: State<'_, AppState>,
    settings: RouterSettings,
) -> Result<RouterSettings, String> {
    state
        .db
        .save_router_settings(&settings)
        .map_err(|e| e.to_string())?;
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
    let dispatcher = runtime::dispatcher_for(&app);
    let episode = RuleEpisode;
    let outcome = tick::run(
        TickContext {
            db: db.as_ref(),
            judge: &judge,
            dispatcher: dispatcher.as_ref(),
            episode: &episode,
            now: store::now_ms(),
        },
        trigger.as_deref().unwrap_or("manual"),
    )
    .await?;
    Ok(outcome.report)
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

/// 暂停一张卡：先停进程，再写状态。进程停不掉也照样写状态——
/// 否则「按了没反应」会让人反复点。
#[tauri::command]
pub fn router_pause_task(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    root: String,
    task_id: String,
) -> Result<(), String> {
    // 运行态按仓库定位：不同仓库都会有 TASK-1 这种 id。
    let run = state
        .db
        .router_run(&root, &task_id)
        .map_err(|e| e.to_string())?;
    let dispatcher = runtime::dispatcher_for(&app);
    if let Some(session) = run.as_ref().and_then(|run| run.session_id.as_deref()) {
        let _ = dispatcher.cancel(session);
    }
    let root = run
        .as_ref()
        .map(|run| run.root.clone())
        .filter(|value| !value.is_empty())
        .unwrap_or(root);
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
pub fn router_resume_task(
    state: State<'_, AppState>,
    root: String,
    task_id: String,
) -> Result<(), String> {
    state
        .db
        .set_router_state(&root, &task_id, RunState::Queued, None, store::now_ms())
        .map_err(|e| e.to_string())
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
    let settings = state.db.router_settings().map_err(|e| e.to_string())?;
    let candidate = tick::resolve_task(&state.db, Some(&root), &task_id)
        .ok_or_else(|| "task-not-found".to_string())?;
    let app_id = candidate
        .run
        .as_ref()
        .and_then(|run| run.worker_app.clone())
        .or_else(|| settings.default_worker().map(str::to_string))
        .ok_or_else(|| "no-worker-configured".to_string())?;
    if !settings
        .worker_apps
        .iter()
        .any(|allowed| allowed == &app_id)
    {
        return Err("worker-not-allowed".into());
    }

    // 人按「开始」时把卡片挪进触发列：之后 tick 才会把它当作自己的任务，
    // 否则它只是一次孤立派发，跑完也没人收尾。写之前比对指纹，卡片被外部改过
    // 就放弃写入，不覆盖别人的改动。
    if candidate.status != settings.trigger_status {
        let workspace = crate::tasks::commands::open(&state, &candidate.root)?;
        crate::tasks::repository::set_status(
            &workspace,
            &task_id,
            &settings.trigger_status,
            &candidate.fingerprint,
        )
        .map_err(|error| format!("status-move-failed:{error}"))?;
    }

    let now = store::now_ms();
    let holder = format!("manual:{now}");
    let acquired = state
        .db
        .acquire_router_lease(
            &candidate.root,
            &task_id,
            &holder,
            now + settings.lease_seconds.max(1) * 1000,
        )
        .map_err(|e| e.to_string())?;
    if !acquired {
        return Err("lease-busy".into());
    }

    let dispatcher = runtime::dispatcher_for(&app);
    let spec = DispatchSpec {
        task_id: task_id.clone(),
        root: candidate.root.clone(),
        app_id: app_id.clone(),
        file: candidate.file.clone(),
        title: candidate.title.clone(),
    };
    let result = dispatcher.dispatch(&spec);
    let _ = state.db.release_router_lease(&candidate.root, &task_id);

    match result {
        Ok(outcome) => {
            state
                .db
                .put_router_run(
                    &candidate.root,
                    &task_id,
                    RunWrite {
                        state: RunState::Dispatched,
                        worker_app: Some(&app_id),
                        session_id: Some(&outcome.session_id),
                        attempts: candidate.attempts() + 1,
                        detail: None,
                        card_fingerprint: Some(&candidate.fingerprint),
                        // 人按下的「开始」不是影子：它确实派了进程。
                        shadow: false,
                    },
                    now,
                )
                .map_err(|e| e.to_string())?;
            state
                .db
                .insert_router_dispatch(&task_id, &candidate.root, &app_id, now)
                .map_err(|e| e.to_string())?;
            // 人按下的「开始」意味着这张卡现在就动：tick 之后不用再等节拍。
            runtime::kick(&app);
            Ok(())
        }
        Err(error) => {
            let attempts = candidate.attempts() + 1;
            let root = candidate
                .run
                .as_ref()
                .map(|run| run.root.clone())
                .unwrap_or(root);
            state
                .db
                .put_router_run(
                    &root,
                    &task_id,
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
