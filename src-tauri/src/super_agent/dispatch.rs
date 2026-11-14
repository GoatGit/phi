//! 派发：把「提名」变成真的一个进程。
//!
//! 这一层是 Router 唯一一双手，而且只在 Rust 侧。默认实现走 phi 自己的托管终端，
//! 因此 macOS 上的 worker 是可见、可接管的；没有窗口（轻量模式）或不是 macOS 时
//! 明确返回错误，让上层把任务转成「等你看」，而不是假装派发成功。

use crate::super_agent::model::{DispatchOutcome, DispatchSpec};

pub(crate) trait Dispatcher: Send + Sync {
    /// 派发一个 worker。返回值只代表进程起来了，不代表任务完成。
    fn dispatch(&self, spec: &DispatchSpec) -> Result<DispatchOutcome, String>;
    /// 停掉自己派发的会话。找不到会话视为已停。
    fn cancel(&self, session_id: &str) -> Result<(), String>;
}

/// 托管终端派发器。
pub(crate) struct TerminalDispatcher {
    app: tauri::AppHandle,
}

impl TerminalDispatcher {
    pub(crate) fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }
}

impl Dispatcher for TerminalDispatcher {
    fn dispatch(&self, spec: &DispatchSpec) -> Result<DispatchOutcome, String> {
        use tauri::Manager;

        crate::terminal::is_cli_app(&spec.app_id)?;
        let window = self
            .app
            .get_webview_window("main")
            .ok_or_else(|| "no-window".to_string())?;
        // 指令按 shell 规则转义后作为单个 argv 传给 CLI：worker 一启动就知道
        // 该读哪张卡，不需要人再打一遍。
        let arguments = crate::terminal::quote_argument(&spec.prompt());
        let snapshot = crate::terminal::terminal_create(
            window,
            spec.app_id.clone(),
            Some(spec.root.clone()),
            Some(arguments),
            uuid::Uuid::new_v4().to_string(),
            None,
            None,
        )?;
        Ok(DispatchOutcome {
            session_id: snapshot.id,
        })
    }

    fn cancel(&self, session_id: &str) -> Result<(), String> {
        crate::terminal::close_by_id(session_id)
    }
}
