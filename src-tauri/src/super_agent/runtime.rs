//! 后台定时器：每隔一段时间跑一次 tick。
//!
//! 只有一条原则：**调度器自己不做判断**。它只负责按节拍调用 [`crate::super_agent::tick::run`]，
//! 开关、配额、暂停全在那条链路里判断。它也不重试失败——重试是 tick 里退避规则的事。

use std::sync::Arc;
use std::time::Duration;

use tauri::Manager;

use crate::store::AppState;
use crate::super_agent::episode::{Episode, FallbackEpisode, RuleEpisode};
use crate::super_agent::judge::SystemOneJudge;
use crate::super_agent::model::{DEFAULT_MONITOR_SECONDS, MIN_MONITOR_SECONDS};
use crate::super_agent::sidecar::SidecarEpisode;
use crate::super_agent::store;
use crate::super_agent::tick::{self, TickContext};
use crate::super_agent::worker::Workers;

/// 巡检节拍用户可调（默认 2 分钟）：读一次设置，下一次睡眠就能跟着变，不用重启调度器。
pub(crate) fn spawn(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            if let Err(reason) = tick_once(&app).await {
                log::warn!("super-agent tick failed: {reason}");
            }
            tokio::time::sleep(monitor_interval(&app)).await;
        }
    });
}

/// 两次巡检之间等多久。读不到设置就按默认值走：一个设置表读失败不该让调度停摆。
fn monitor_interval(app: &tauri::AppHandle) -> Duration {
    let state = app.state::<AppState>();
    let seconds = match state.db.router_settings() {
        Ok(settings) => settings.monitor_interval_seconds,
        Err(error) => {
            log::warn!("router settings read failed, using default interval: {error}");
            DEFAULT_MONITOR_SECONDS
        }
    };
    Duration::from_secs(seconds.max(MIN_MONITOR_SECONDS) as u64)
}

async fn tick_once(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let db = state.db.clone();
    let judge = SystemOneJudge::new(db.clone());
    let workers = Workers::new(app.clone());
    let episode = episode_for(app);
    tick::run(
        TickContext {
            db: db.as_ref(),
            judge: &judge,
            workers: &workers,
            episode: &episode,
            now: store::now_ms(),
        },
        "timer",
    )
    .await
    .map(|_| ())
}

/// 选这一轮用哪个 episode。
///
/// 侧车没随包带上（或脚本不在）就是规则版；带上了就让它当主实现，出任何问题退回规则版。
/// 命令层（手动跑一轮）也走这里：手跑与定时必须用同一套判断，否则「点一下看看会派谁」
/// 看到的不是真的会派谁。
pub(crate) fn episode_for(app: &tauri::AppHandle) -> Box<dyn Episode> {
    let episode: Box<dyn Episode> = match SidecarEpisode::bundled(app) {
        Some(sidecar) => {
            let sidecar = match episode_model(app) {
                Some(model) => sidecar.with_model(model),
                None => sidecar,
            };
            log_choice_once("sidecar");
            Box::new(FallbackEpisode {
                primary: Box::new(sidecar),
                fallback: Box::new(RuleEpisode),
            })
        }
        None => {
            log_choice_once("rules (没有随包带侧车)");
            Box::new(RuleEpisode)
        }
    };
    episode
}

/// 交给侧车去问的模型名。没配就只用确定性策略。
///
/// 两个来源，前一个只给开发用：环境变量 `PHI_ROUTER_MODEL`，以及设置里的
/// `episodeModel`（界面写的是路由组别名 `group/<组名>`，网关自己展开成组内成员）。
///
/// 讨论也读这一份：讨论与派发用的是同一个 Router 模型，只是走另一条没有工具表的路径。
pub(crate) fn episode_model(app: &tauri::AppHandle) -> Option<String> {
    if let Ok(model) = std::env::var("PHI_ROUTER_MODEL") {
        let model = model.trim();
        if !model.is_empty() {
            return Some(model.to_string());
        }
    }

    let state = app.state::<AppState>();
    let settings = state.db.router_settings().ok()?;
    let model = settings.episode_model.trim();
    (!model.is_empty()).then(|| model.to_string())
}

/// 只在第一次说一句用哪条路径。每 30 秒重复一次会把日志刷满，而这件事一辈子只需要知道一次。
fn log_choice_once(choice: &str) {
    use std::sync::atomic::{AtomicBool, Ordering};
    static LOGGED: AtomicBool = AtomicBool::new(false);
    if !LOGGED.swap(true, Ordering::Relaxed) {
        log::info!("router episode: {choice}");
    }
}

/// 供命令层复用：拿一份「真实实现」的运行时。
///
/// 里层会自己选 zellij 还是托管终端，命令层不需要知道。
pub(crate) fn workers_for(app: &tauri::AppHandle) -> Workers {
    Workers::new(app.clone())
}

/// 任务开始跑时立刻 tick 一次，不用等下一个节拍。
pub(crate) fn kick(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(reason) = tick_once(&app).await {
            log::warn!("super-agent kick failed: {reason}");
        }
    });
}

/// `Arc<Database>` 在这里只用来推导类型，避免上层再 import 一次。
#[allow(dead_code)]
fn _assert_db_shared(db: &Arc<crate::Database>) -> usize {
    Arc::strong_count(db)
}
