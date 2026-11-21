//! 托管终端后端：直接把 worker 开在 phi 自己的 PTY 里。
//!
//! 这是 zellij 不可用时的退路，也是接棒与「手动开始会话」一直用的那条路。
//! 它的限制写在这里而不是注释里：PTY 属于 phi 进程，关掉窗格就 SIGHUP，
//! 应用退出也一起结束——所以 probe 只能回答「会话还在不在」，
//! 拿不到退出码（退出码在 journal 里）。

use tauri::Manager;

use crate::super_agent::model::{DispatchOutcome, DispatchSpec};
use crate::super_agent::store::{WorkerBackend, WorkerRecord};
use crate::super_agent::worker::{WorkerRuntime, WorkerState};

pub(crate) struct TerminalWorker {
    app: tauri::AppHandle,
}

impl TerminalWorker {
    pub(crate) fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }
}

impl WorkerRuntime for TerminalWorker {
    fn dispatch(&self, spec: &DispatchSpec) -> Result<DispatchOutcome, String> {
        crate::terminal::is_cli_app(&spec.app_id)?;
        let window = self
            .app
            .get_webview_window("main")
            .ok_or_else(|| "no-window".to_string())?;
        // 指令按 shell 规则转义后作为单个 argv 传给 CLI：worker 一启动就知道
        // 该读哪张卡，不需要人再打一遍。非交互参数也走同一份，跑完才带退出码退出。
        let arguments = spec.agent.launch_arguments(&spec.file);
        let snapshot = crate::terminal::terminal_create(
            window,
            spec.app_id.clone(),
            Some(spec.root.clone()),
            Some(arguments),
            uuid::Uuid::new_v4().to_string(),
            None,
            None,
        )?;
        let state = self.app.state::<crate::store::AppState>();
        if let Err(error) =
            state
                .db
                .link_task_session(&spec.root, &spec.task_id, &snapshot.id, &spec.app_id)
        {
            log::error!("router session link failed task={}: {error}", spec.task_id);
            let _ = crate::terminal::close_by_id(&snapshot.id);
            return Err(format!("session-link-failed:{error}"));
        }
        // 记下归属，让 probe 知道这个 id 该问托管终端而不是 zellij。
        let record = WorkerRecord {
            session_id: snapshot.id.clone(),
            root: spec.root.clone(),
            task_id: spec.task_id.clone(),
            backend: WorkerBackend::Terminal,
            session_name: None,
            pane_id: None,
            app_id: spec.app_id.clone(),
            created_at: crate::super_agent::store::now_ms(),
        };
        if let Err(error) = state.db.put_worker(&record) {
            log::warn!("router worker record failed task={}: {error}", spec.task_id);
        }
        Ok(DispatchOutcome {
            session_id: snapshot.id,
        })
    }

    fn cancel(&self, session_id: &str) -> Result<(), String> {
        crate::terminal::close_by_id(session_id)?;
        let state = self.app.state::<crate::store::AppState>();
        let _ = state.db.delete_worker(session_id);
        Ok(())
    }

    fn probe(&self, session_id: &str) -> WorkerState {
        // 托管终端分不清「跑完了」和「刚死」：只有 journal 知道退出码。
        if crate::terminal::session_exists(session_id) {
            WorkerState::Alive
        } else {
            WorkerState::Unknown
        }
    }
}
