//! Worker 运行时：Router 唯一的一双手。
//!
//! 分层只有两句：
//!
//! 1. **谁来起、谁来停、还在不在** — 这一层；
//! 2. **任务算不算完成** — 永远看退出记账（`exit_hook` 的 journal），不看进程、
//!    更不看 pane 是否还在。zellij 的 session 活着不能证明任务在跑，反过来
//!    也不能证明它跑完了。
//!
//! 两个实现：
//!
//! - [`ZellijWorkers`]：后台派发的 worker 放进一个共享的 zellij session，
//!   一个 worker 一个 pane。关终端、关应用都不会把它们杀掉，重开应用能接回去。
//! - [`TerminalWorker`]：旧路径，直接开 phi 自己的托管终端。zellij 不在
//!   （没随包带上、也没装）时用它，行为与以前一致。

mod terminal;
#[cfg(target_os = "macos")]
mod zellij;

pub(crate) use terminal::TerminalWorker;
#[cfg(target_os = "macos")]
pub(crate) use zellij::ZellijWorkers;

/// 非 macOS：zellij 后端不存在。
///
/// 保留同名同方法的占位实现，是为了让上面那套路由代码不必在四处写 cfg；
/// 它永远 `detect` 不到，调用点照旧落到托管终端或如实报 unsupported-platform。
#[cfg(not(target_os = "macos"))]
#[allow(dead_code)]
pub(crate) struct ZellijWorkers;

#[cfg(not(target_os = "macos"))]
impl ZellijWorkers {
    fn detect(_app: &tauri::AppHandle) -> Option<Self> {
        None
    }

    fn dispatch(&self, _spec: &DispatchSpec) -> Result<DispatchOutcome, String> {
        Err("unsupported-platform".into())
    }

    fn cancel(&self, _session_id: &str) -> Result<(), String> {
        Err("zellij-missing".into())
    }

    fn probe(&self, _session_id: &str) -> WorkerState {
        WorkerState::Unknown
    }

    fn viewer(&self, _session_id: &str) -> Result<Option<ViewerPlan>, String> {
        Err("zellij-missing".into())
    }
}

use std::collections::BTreeMap;

use tauri::Manager;

use crate::super_agent::model::{DispatchOutcome, DispatchSpec};
use crate::super_agent::store::{WorkerBackend, WorkerRecord};

/// 一个 worker 现在怎么样了。
///
/// `Unknown` 是「查不到」而不是「还活着」：查不到时结算路径会转人工，
/// 不能当成成功。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum WorkerState {
    Alive,
    /// 已经退出，带退出码（zellij 的 pane 记得住，托管 PTY 记不住）。
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    Exited(i32),
    /// 运行时查不到这个 worker：pane 没了、session 没了，或者根本没有归属记录。
    Unknown,
}

/// 怎么把 worker 显示给人看。
///
/// zellij 的 worker 不在 phi 的终端表里，所以要现开一个「查看器」窗格
/// 挂上去；关掉它只是断开查看。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Clone, Debug)]
pub(crate) struct ViewerPlan {
    /// 挂到哪个应用的终端页签下：worker 本来就是那个 CLI，查看器也跟着它走，
    /// 这样「打开终端」在界面上还是同一个应用。
    pub app_id: String,
    /// 页签标题。必须一眼看出这是「查看」而不是一个新会话。
    pub title: String,
    pub cwd: String,
    pub argv: Vec<String>,
    pub environment: BTreeMap<String, String>,
}

pub(crate) trait WorkerRuntime: Send + Sync {
    /// 派发一个 worker。返回值只代表进程起来了，不代表任务完成。
    fn dispatch(&self, spec: &DispatchSpec) -> Result<DispatchOutcome, String>;
    /// 停掉自己派发的 worker。找不到视为已停。
    fn cancel(&self, session_id: &str) -> Result<(), String>;
    /// 它现在还在不在。
    fn probe(&self, session_id: &str) -> WorkerState;
    /// 打开查看器的命令；没有查看器概念的实现返回 `None`。
    fn viewer(&self, _session_id: &str) -> Result<Option<ViewerPlan>, String> {
        Ok(None)
    }
}

/// 装配后的运行时：按「这个 worker 当初落在哪」路由，而不是按「现在哪个后端可用」。
///
/// 这条区别很重要：先装 zellij 派发了一批、后来 zellij 不见了，那些 worker
/// 仍然要让 zellij 那边去问，不能一把丢给终端去查然后统统判成「已结束」。
pub(crate) struct Workers {
    app: tauri::AppHandle,
}

impl Workers {
    pub(crate) fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }

    fn record(&self, session_id: &str) -> Option<WorkerRecord> {
        let state = self.app.state::<crate::store::AppState>();
        match state.db.worker(session_id) {
            Ok(record) => record,
            Err(error) => {
                log::warn!("router worker lookup failed session={session_id}: {error}");
                None
            }
        }
    }

    /// 有 zellij 就用它。没有（没随包带上、系统里也没装）就退回托管终端：
    /// Windows / Linux 上后一步会如实报 unsupported-platform，和改动前一致。
    ///
    /// phi 的终端子系统本身只有 macOS 实现，所以 zellij 后端也只在 macOS 编译。
    fn zellij(&self) -> Option<ZellijWorkers> {
        #[cfg(target_os = "macos")]
        {
            ZellijWorkers::detect(&self.app)
        }
        #[cfg(not(target_os = "macos"))]
        {
            None
        }
    }
}

impl WorkerRuntime for Workers {
    fn dispatch(&self, spec: &DispatchSpec) -> Result<DispatchOutcome, String> {
        // 随包带上的 zellij 优先：worker 要活过窗口和这次运行。
        if let Some(zellij) = self.zellij() {
            return zellij.dispatch(spec);
        }
        log::warn!("router: zellij 不可用，worker 退回托管终端（应用退出即结束）");
        TerminalWorker::new(self.app.clone()).dispatch(spec)
    }

    fn cancel(&self, session_id: &str) -> Result<(), String> {
        match self.record(session_id).map(|record| record.backend) {
            Some(WorkerBackend::Zellij) => match self.zellij() {
                Some(zellij) => zellij.cancel(session_id),
                None => Err("zellij-missing".into()),
            },
            Some(WorkerBackend::Terminal) => {
                TerminalWorker::new(self.app.clone()).cancel(session_id)
            }
            // 升级前派发的 worker 没有归属记录：交给托管终端，找不到就当已停。
            None => TerminalWorker::new(self.app.clone()).cancel(session_id),
        }
    }

    fn probe(&self, session_id: &str) -> WorkerState {
        match self.record(session_id).map(|record| record.backend) {
            Some(WorkerBackend::Zellij) => match self.zellij() {
                Some(zellij) => zellij.probe(session_id),
                // zellij 没了：查不到，不是「还活着」。
                None => WorkerState::Unknown,
            },
            Some(WorkerBackend::Terminal) => {
                TerminalWorker::new(self.app.clone()).probe(session_id)
            }
            None => {
                // 没有归属记录：可能是升级前派发的托管终端会话。
                if crate::terminal::session_exists(session_id) {
                    WorkerState::Alive
                } else {
                    WorkerState::Unknown
                }
            }
        }
    }

    fn viewer(&self, session_id: &str) -> Result<Option<ViewerPlan>, String> {
        match self.record(session_id).map(|record| record.backend) {
            Some(WorkerBackend::Zellij) => match self.zellij() {
                Some(zellij) => zellij.viewer(session_id),
                None => Err("zellij-missing".into()),
            },
            // 托管终端本身就是查看器：前端直接打开那个会话。
            Some(WorkerBackend::Terminal) => Ok(None),
            None => Ok(None),
        }
    }
}
