//! zellij 后端：后台 worker 放进一个共享 session，一个 worker 一个 pane。
//!
//! 为什么是「一个 session 多个 pane」而不是「一个 worker 一个 session」：
//! 每个 zellij session 都有自己的 server 常驻（实测单 pane 空会话约 90MB），
//! 按 session 分会随任务数线性涨；共享一个 session 只多一个 server。
//!
//! 三条边界写死在实现里：
//!
//! 1. **只认 `phi-` 前缀**：用户自己的 zellij session 用同样的 socket 目录时
//!    也不会被误杀，实现里没有 `kill-all-sessions` 这条路。
//! 2. **退出码有两份**：`worker.sh` 写 journal（唯一事实），pane 自己的
//!    `exit_status` 是旁证。journal 没写成功时还有的看。
//! 3. **不落回 shell**：pane 跟着 CLI 结束，否则 worker 会永远看起来在跑。

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use tauri::Manager;

use crate::super_agent::model::{DispatchOutcome, DispatchSpec};
use crate::super_agent::store::{WorkerBackend, WorkerRecord};
use crate::super_agent::worker::{ViewerPlan, WorkerRuntime, WorkerState};

/// 所有后台 worker 共用的 session 名。
pub(crate) const SESSION: &str = "phi-workers";
/// 覆盖 zellij 可执行文件（开发与排障用）。
const BINARY_ENV: &str = "PHI_ZELLIJ_BIN";
/// 随包分发时与主程序放在一起的那个名字。
const BINARY_NAME: &str = "zellij";
/// 启动等待：`attach --create-background` 返回后 server 还没登记完的窗口。
const READY_ATTEMPTS: usize = 40;
const READY_INTERVAL: std::time::Duration = std::time::Duration::from_millis(50);
/// 建会话用的最小布局：一个终端 pane，没有 tab 栏、没有状态栏。
///
/// 这不是审美选择：worker 的 session 是后台工作区，不是给人浏览的界面；
/// 默认布局还会额外塞一个「Welcome to Zellij」浮层，那东西会跟着 attach 出现。
const LAYOUT: &str = "layout { pane; }";
/// 默认布局里那个教程浮层的标题，建完会话要关掉它。
const WELCOME_TITLE: &str = "Welcome to Zellij";

/// 我们自己的 zellij 配置：去掉一切「zellij 界面」，只留终端里的程序。
///
/// 这不是审美选择，是体验差异的来源：后台 worker 是 `codex exec` 这类命令行，
/// 用户熟悉的是它自己的输出。默认的 zellij 会在外面套一圈 pane 标题、状态栏，
/// 并把按键先给 zellij 自己的模式——看起来就不是同一个东西了。
///
/// - `pane_frames false`：不画 pane 边框与标题；
/// - `simplified_ui true`：插件类 UI 用简版字形；
/// - `default_mode "locked"`：按键直接交给前台程序，不再先被 zellij 截一层；
/// - `mouse_mode true`：锁定的是键盘，滚轮与复制照旧；
/// - `scroll_buffer_size`：agent 的长输出要能往回翻。
const CONFIG: &str = "\
simplified_ui true
show_startup_tips false
show_release_notes false
pane_frames false
pane_frame_style \"none\"
default_mode \"locked\"
mouse_mode true
scroll_buffer_size 100000
copy_command \"pbcopy\"
";

pub(crate) struct ZellijWorkers {
    app: tauri::AppHandle,
    binary: PathBuf,
}

impl ZellijWorkers {
    /// 找一个能用的 zellij。三种来源按「越靠内越可信」排：显式指定、随包分发、
    /// 系统 PATH——用户自己装的版本也能跑，只是我们不为它的版本变化负责。
    pub(crate) fn detect(app: &tauri::AppHandle) -> Option<Self> {
        let binary = binary_candidates()
            .into_iter()
            .find(|path| path.is_file())?;
        Some(Self {
            app: app.clone(),
            binary,
        })
    }

    fn root_dir(&self) -> PathBuf {
        crate::config::get_app_config_dir().join("zellij")
    }

    fn config_dir(&self) -> PathBuf {
        self.root_dir().join("config")
    }

    fn data_dir(&self) -> PathBuf {
        self.root_dir().join("data")
    }

    fn socket_dir(&self) -> PathBuf {
        self.root_dir().join("socket")
    }

    /// 把我们的配置写下去。内容变了就覆盖：升级要能生效，不然只能靠用户手动删。
    fn ensure_config(&self) -> Result<PathBuf, String> {
        let directory = self.config_dir();
        std::fs::create_dir_all(&directory).map_err(|e| format!("zellij-config-dir:{e}"))?;
        let path = directory.join("config.kdl");
        let current = std::fs::read_to_string(&path).ok();
        if current.as_deref() != Some(CONFIG) {
            std::fs::write(&path, CONFIG).map_err(|e| format!("zellij-config-write:{e}"))?;
        }
        Ok(directory)
    }

    /// 一个配好隔离的客户端命令。
    ///
    /// 隔离要干净到「用户在 phi 里再开 zellij 也不串」：socket 目录、配置、
    /// 插件目录各归各的；同时把 `ZELLIJ*` 变量摘掉——phi 自己常常就跑在
    /// zellij 里，那些变量会让客户端去连**外面**那个 session。
    fn client(&self) -> Result<Command, String> {
        let config = self.ensure_config()?;
        let data = self.data_dir();
        let socket = self.socket_dir();
        std::fs::create_dir_all(&data).map_err(|e| format!("zellij-data-dir:{e}"))?;
        std::fs::create_dir_all(&socket).map_err(|e| format!("zellij-socket-dir:{e}"))?;
        let mut command = Command::new(&self.binary);
        command
            .arg("--config-dir")
            .arg(&config)
            .arg("--data-dir")
            .arg(&data)
            .env("ZELLIJ_SOCKET_DIR", &socket)
            .env_remove("ZELLIJ")
            .env_remove("ZELLIJ_SESSION_NAME")
            .env_remove("ZELLIJ_PANE_ID")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        Ok(command)
    }

    fn run(&self, args: &[&str]) -> Result<std::process::Output, String> {
        let mut command = self.client()?;
        command.args(args);
        command.output().map_err(|e| format!("zellij-spawn:{e}"))
    }

    /// 会话是不是**真在跑**。
    ///
    /// 这里不能用 `list-sessions`：它把「可以复活的历史会话」也列出来，
    /// 机器重启后 `phi-workers` 会以 `EXITED - attach to resurrect` 的身份出现，
    /// 拿它当「还在」会让第一次派发直接撞上 "There is no active session"。
    /// `list-panes` 只问活着的 server，答不上来就是没有。
    fn session_active(&self) -> bool {
        self.run(&["--session", SESSION, "action", "list-panes", "-a", "-j"])
            .map(|output| output.status.success())
            .unwrap_or(false)
    }

    fn panes(&self) -> Result<Vec<PaneState>, String> {
        let output = self.run(&["--session", SESSION, "action", "list-panes", "-a", "-j"])?;
        if !output.status.success() {
            return Err("zellij-session-missing".into());
        }
        parse_panes(&String::from_utf8_lossy(&output.stdout))
    }

    /// 保证 session 在。已经在了就什么都不做（不会抢用户当前的界面）。
    fn ensure_session(&self) -> Result<(), String> {
        if self.session_active() {
            return Ok(());
        }
        // 上一次运行留下的会话元数据会被当成「可复活会话」：直接 attach 会把
        // 一堆早就结束的 pane 接回来。先删干净再建。`delete-session` 在会话
        // 还活着时会被拒绝（要求 --force），所以这一步不会误杀正在跑的 worker。
        let _ = self.run(&["delete-session", SESSION]);
        let output = self.run(&[
            "--layout-string",
            LAYOUT,
            "attach",
            "--create-background",
            SESSION,
        ])?;
        if !output.status.success() {
            let reason = String::from_utf8_lossy(&output.stderr);
            return Err(format!("zellij-create-failed:{}", reason.trim()));
        }
        for _ in 0..READY_ATTEMPTS {
            if self.session_active() {
                self.close_welcome_panes();
                return Ok(());
            }
            std::thread::sleep(READY_INTERVAL);
        }
        Err("zellij-session-missing".into())
    }

    /// 关掉默认布局自带的教程浮层。它是给人第一次用 zellij 时看的，
    /// 在 phi 的 worker 会话里只会挡住 attach 之后的画面。
    fn close_welcome_panes(&self) {
        let Ok(output) = self.run(&["--session", SESSION, "action", "list-panes", "-a", "-j"])
        else {
            return;
        };
        for pane in welcome_panes(&String::from_utf8_lossy(&output.stdout)) {
            let _ = self.run(&[
                "--session",
                SESSION,
                "action",
                "close-pane",
                "--pane-id",
                &pane,
            ]);
        }
    }

    fn record(&self, session_id: &str) -> Option<WorkerRecord> {
        let state = self.app.state::<crate::store::AppState>();
        state.db.worker(session_id).ok().flatten()
    }
}

impl WorkerRuntime for ZellijWorkers {
    fn dispatch(&self, spec: &DispatchSpec) -> Result<DispatchOutcome, String> {
        crate::terminal::is_cli_app(&spec.app_id)?;
        let session_id = uuid::Uuid::new_v4().to_string();
        let journal = crate::exit_hook::journal_path();
        // 与托管终端同一句话、同一份参数：两条入口不能各说一套。
        let arguments = spec.agent.launch_arguments(&spec.file);
        let launch = crate::terminal::prepare_worker(
            &spec.app_id,
            &spec.root,
            &arguments,
            crate::terminal::ExitHookEnv {
                terminal_id: &session_id,
                journal: &journal,
            },
        )?;

        self.ensure_session()?;
        // 结束了的 pane 会留着给人看（这是有意的），但没人收就会一直堆下去。
        // 只保守清理：只动已经结束的，保留最近 8 个。
        self.prune_finished(8);
        let name = pane_name(&spec.app_id, &spec.task_id);
        let mut command = self.client()?;
        command
            .arg("--session")
            .arg(SESSION)
            .args(["action", "new-pane", "--name", &name, "--cwd"])
            .arg(&launch.cwd)
            // `--` 之后全是 pane 的 argv：不再经过任何 shell 拼接。
            .arg("--")
            .args(&launch.argv);
        let output = command.output().map_err(|e| format!("zellij-spawn:{e}"))?;
        if !output.status.success() {
            let reason = String::from_utf8_lossy(&output.stderr);
            return Err(format!("zellij-new-pane-failed:{}", reason.trim()));
        }
        let pane_id = parse_pane_id(&String::from_utf8_lossy(&output.stdout))?;

        let record = WorkerRecord {
            session_id: session_id.clone(),
            root: spec.root.clone(),
            task_id: spec.task_id.clone(),
            backend: WorkerBackend::Zellij,
            session_name: Some(SESSION.to_string()),
            pane_id: Some(pane_id.clone()),
            app_id: spec.app_id.clone(),
            created_at: crate::super_agent::store::now_ms(),
        };
        let state = self.app.state::<crate::store::AppState>();
        if let Err(error) = state.db.put_worker(&record) {
            // 归属写不下去就别留一个没人认领的 pane：它会一直占着一格，
            // 而调度器再怎么查也查不到它。
            log::error!("router worker record failed task={}: {error}", spec.task_id);
            let _ = self.close_pane(&pane_id);
            return Err(format!("worker-record-failed:{error}"));
        }
        Ok(DispatchOutcome { session_id })
    }

    fn cancel(&self, session_id: &str) -> Result<(), String> {
        let Some(record) = self.record(session_id) else {
            return Ok(());
        };
        if let Some(pane) = record.pane_id.as_deref() {
            self.close_pane(pane)?;
        }
        let state = self.app.state::<crate::store::AppState>();
        let _ = state.db.delete_worker(session_id);
        Ok(())
    }

    fn probe(&self, session_id: &str) -> WorkerState {
        let Some(record) = self.record(session_id) else {
            return WorkerState::Unknown;
        };
        let Some(pane) = record.pane_id.as_deref() else {
            return WorkerState::Unknown;
        };
        match self.panes() {
            Ok(panes) => match panes.iter().find(|state| state.pane_id == pane) {
                // pane 已经不在了：停了，但没有退出码。
                None => WorkerState::Unknown,
                // exited 但没有退出码时不能补个 0：调用方会把它当成「跑成功了」，
                // 一条真实的失败就变成完成。缺数就如实说不知道，交给 journal 判。
                Some(state) if state.exited => match state.exit_status {
                    Some(code) => WorkerState::Exited(code),
                    None => {
                        log::debug!("router probe exited pane without status pane={pane}");
                        WorkerState::Unknown
                    }
                },
                // held：命令结束了、pane 还留着（zellij 在我们没拿退出码时会这样）。
                // 它是「停了但没数」，交给 journal 去判，不要当成还在跑。
                Some(state) if state.held => WorkerState::Unknown,
                Some(_) => WorkerState::Alive,
            },
            Err(error) => {
                log::debug!("router probe failed session={session_id}: {error}");
                WorkerState::Unknown
            }
        }
    }

    fn viewer(&self, session_id: &str) -> Result<Option<ViewerPlan>, String> {
        let Some(record) = self.record(session_id) else {
            return Ok(None);
        };
        let Some(pane) = record.pane_id.as_deref() else {
            return Ok(None);
        };
        // 这个 worker 的 pane 已经不在了：不能把人挂到同一个 session 里**别的**
        // worker 的画面上，那样标题写着 A、里面演的是 B。
        let panes = self.panes().unwrap_or_default();
        if viewer_pane(&panes, pane).is_none() {
            log::debug!("router viewer: pane already gone pane={pane}");
            return Ok(None);
        }
        // `attach` 显示的是会话当前焦点的那块 pane，它自己不带「挂哪一块」的参数。
        // 所以先把焦点挪到目标上，否则点 A 任务的「打开终端」会看到 B 任务的画面。
        //
        // 失效的 pane 不会在这里被揭穿：实测 `focus-pane-id` 对不存在的 pane
        // 也返回 0、stderr 为空。真正起作用的是上面那次 `list-panes` 检查；
        // 这里的失败判断只当一道保险，zellij 将来改了行为也不会把人挂到错的 pane 上。
        let focused = self.run(&["--session", SESSION, "action", "focus-pane-id", pane])?;
        if !focused.status.success() {
            let reason = String::from_utf8_lossy(&focused.stderr);
            log::debug!("router viewer: focus failed pane={pane}: {}", reason.trim());
            return Ok(None);
        }
        let config = self.ensure_config()?;
        let mut environment = BTreeMap::new();
        environment.insert(
            "ZELLIJ_SOCKET_DIR".to_string(),
            self.socket_dir().to_string_lossy().into_owned(),
        );
        let mut argv = vec![self.binary.to_string_lossy().into_owned()];
        for arg in [
            "--config-dir",
            &config.to_string_lossy(),
            "--data-dir",
            &self.data_dir().to_string_lossy(),
            "attach",
            record.session_name.as_deref().unwrap_or(SESSION),
        ] {
            argv.push(arg.to_string());
        }
        Ok(Some(ViewerPlan {
            app_id: record.app_id.clone(),
            title: format!("zellij · {}", record.task_id),
            cwd: crate::config::get_app_config_dir()
                .to_string_lossy()
                .into_owned(),
            argv,
            environment,
            // 查看器只是旁路：界面的状态跟着 worker 走，不跟着这个窗格走。
            worker_session: record.session_id.clone(),
        }))
    }
}

impl ZellijWorkers {
    /// 关掉最老的那几块已经结束的 pane，最多保留 `keep` 块。
    ///
    /// 只碰 exited / held 的：正在跑的 worker 一块都不能动。失败只记日志——
    /// 清理是卫生问题，不该让一次派发因为清不掉旧 pane 而失败。
    fn prune_finished(&self, keep: usize) {
        let Ok(panes) = self.panes() else { return };
        let mut finished: Vec<&PaneState> = panes
            .iter()
            .filter(|pane| pane.exited || pane.held)
            .collect();
        if finished.len() <= keep {
            return;
        }
        finished.sort_by_key(|pane| pane_number(&pane.pane_id));
        let excess = finished.len() - keep;
        for pane in finished.into_iter().take(excess) {
            if let Err(error) = self.close_pane(&pane.pane_id) {
                log::debug!("router prune pane {} failed: {error}", pane.pane_id);
            }
        }
    }

    fn close_pane(&self, pane: &str) -> Result<(), String> {
        if !self.session_active() {
            // session 整个不在了：pane 自然也没了，不算失败。
            return Ok(());
        }
        let output = self.run(&[
            "--session",
            SESSION,
            "action",
            "close-pane",
            "--pane-id",
            pane,
        ])?;
        if output.status.success() {
            return Ok(());
        }
        // 已经不在的 pane 视作已停：这条路径要能被重入。
        //
        // 只认「pane 没了」与「session 没了」这两种说法。早先这里还认任意含
        // `Session` 的错误，等于把 zellij 的真实失败（连不上 server、参数不认）
        // 也当成已关闭——取消会假装成功，worker 其实还在后台跑。
        let reason = String::from_utf8_lossy(&output.stderr);
        if reason.contains("not found") || reason.contains("no active session") {
            return Ok(());
        }
        Err(format!("zellij-close-pane-failed:{}", reason.trim()))
    }
}

/// 查看器要挂到哪一块 pane 上。
///
/// 目标 pane 还在就挂它；不在了宁可什么都不挂（调用方报「会话已结束」），
/// 也不要落到 session 里当前焦点的另一块 pane 上。
fn viewer_pane(panes: &[PaneState], pane: &str) -> Option<String> {
    panes
        .iter()
        .find(|state| state.pane_id == pane)
        .map(|state| state.pane_id.clone())
}

/// 一个 pane 的可判定部分。
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PaneState {
    pub pane_id: String,
    pub exited: bool,
    /// 命令已经结束、pane 还留着给人看（zellij 的 held pane）。
    pub held: bool,
    pub exit_status: Option<i32>,
}

/// 可执行文件的候选来源，按可信度排列。
fn binary_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(value) = std::env::var(BINARY_ENV) {
        let value = value.trim();
        if !value.is_empty() {
            candidates.push(PathBuf::from(value));
        }
    }
    if let Ok(executable) = std::env::current_exe() {
        if let Some(directory) = executable.parent() {
            candidates.push(directory.join(BINARY_NAME));
        }
    }
    if let Some(path) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&path) {
            candidates.push(directory.join(BINARY_NAME));
        }
    }
    candidates
}

/// pane 名字只是给人看的标签，不进任何解析：把不安全字符换成 `-`。
pub(crate) fn pane_name(app_id: &str, task_id: &str) -> String {
    let raw = format!("{app_id}-{task_id}");
    let sanitized: String = raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    sanitized.chars().take(40).collect()
}

/// pane id 里的序号。zellij 的 id 单调递增，所以序号就是「谁先谁后」。
fn pane_number(pane_id: &str) -> u64 {
    pane_id
        .rsplit_once('_')
        .and_then(|(_, digits)| digits.parse().ok())
        .unwrap_or(0)
}

/// `new-pane` 成功时只打印一行 pane id（如 `terminal_3`）。
pub(crate) fn parse_pane_id(stdout: &str) -> Result<String, String> {
    let value = stdout.trim();
    let digits = value.strip_prefix("terminal_").unwrap_or("");
    if digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit()) {
        return Err("zellij-pane-id".into());
    }
    Ok(value.to_string())
}

/// 默认布局里的教程浮层在哪几块 plugin 上。
///
/// 只认标题，不认 id：plugin 的 id 随会话而变（tab 栏、状态栏也占号）。
pub(crate) fn welcome_panes(stdout: &str) -> Vec<String> {
    let Ok(rows) = serde_json::from_str::<Vec<PaneJson>>(stdout) else {
        return Vec::new();
    };
    rows.into_iter()
        .filter(|row| row.is_plugin && row.title.contains(WELCOME_TITLE))
        .map(|row| format!("plugin_{}", row.id))
        .collect()
}

#[derive(serde::Deserialize)]
struct PaneJson {
    id: u64,
    #[serde(default)]
    title: String,
    #[serde(default)]
    is_plugin: bool,
    #[serde(default)]
    exited: bool,
    #[serde(default)]
    is_held: bool,
    #[serde(default)]
    exit_status: Option<i32>,
}

pub(crate) fn parse_panes(stdout: &str) -> Result<Vec<PaneState>, String> {
    let rows: Vec<PaneJson> =
        serde_json::from_str(stdout).map_err(|_| "zellij-panes".to_string())?;
    Ok(rows
        .into_iter()
        .filter(|row| !row.is_plugin)
        .map(|row| PaneState {
            pane_id: format!("terminal_{}", row.id),
            exited: row.exited,
            held: row.is_held,
            exit_status: row.exit_status,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pane_names_are_labels_not_paths() {
        assert_eq!(pane_name("codex", "TASK-3"), "codex-TASK-3");
        // 空格、斜杠、引号都不该进 pane 名：它只是一行给人看的标题。
        assert_eq!(pane_name("claude", "TASK 1/../x"), "claude-TASK-1----x");
        assert!(pane_name("codex", &"T".repeat(80)).len() <= 40);
    }

    #[test]
    fn pane_ids_come_back_as_terminal_ids() {
        assert_eq!(parse_pane_id("terminal_3\n").unwrap(), "terminal_3");
        for junk in ["", "plugin_2", "terminal_", "terminal_x", "Pane #1"] {
            assert_eq!(parse_pane_id(junk).unwrap_err(), "zellij-pane-id");
        }
    }

    #[test]
    fn finished_panes_are_ordered_by_their_id() {
        // 剪枝靠这个顺序挑最老的；解析不出来的一律当最老（0），宁可多清一块。
        assert_eq!(pane_number("terminal_3"), 3);
        assert_eq!(pane_number("terminal_12"), 12);
        assert_eq!(pane_number("weird"), 0);
    }

    #[test]
    fn the_viewer_only_attaches_to_its_own_pane() {
        let listing = r#"[
          {"id": 1, "is_plugin": false, "exited": true, "exit_status": 0},
          {"id": 2, "is_plugin": false, "exited": false}
        ]"#;
        let panes = parse_panes(listing).unwrap();
        // 目标 pane 还在：挂它（哪怕它已经退出了——退出结果正是要给人看的）。
        assert_eq!(
            viewer_pane(&panes, "terminal_1").as_deref(),
            Some("terminal_1")
        );
        // 目标 pane 没了：别落到会话里别的 worker 上。
        assert_eq!(viewer_pane(&panes, "terminal_9"), None);
    }

    #[test]
    fn the_tutorial_overlay_is_found_by_title() {
        let listing = r#"[
          {"id": 2, "is_plugin": true, "title": "Welcome to Zellij"},
          {"id": 3, "is_plugin": true, "title": "zellij:status-bar"},
          {"id": 0, "is_plugin": false, "title": "Welcome to Zellij"}
        ]"#;
        // 只关 plugin 里的那一块；同名的终端 pane 不是教程。
        assert_eq!(welcome_panes(listing), ["plugin_2"]);
        assert!(welcome_panes("There is no active session!").is_empty());
    }

    #[test]
    fn panes_decode_exit_state_and_skip_plugin_rows() {
        let listing = r#"[
          {"id": 0, "is_plugin": true, "exited": false, "exit_status": null},
          {"id": 1, "is_plugin": false, "exited": false, "exit_status": null},
          {"id": 2, "is_plugin": false, "exited": true, "is_held": true, "exit_status": 3}
        ]"#;
        assert_eq!(
            parse_panes(listing).unwrap(),
            vec![
                PaneState {
                    pane_id: "terminal_1".into(),
                    exited: false,
                    held: false,
                    exit_status: None,
                },
                PaneState {
                    pane_id: "terminal_2".into(),
                    exited: true,
                    held: true,
                    exit_status: Some(3),
                },
            ]
        );
        assert_eq!(parse_panes("not json").unwrap_err(), "zellij-panes");
    }

    #[test]
    fn the_client_never_targets_the_users_own_zellij() {
        // 配置与 socket 都落在 phi 自己的目录下；`ZELLIJ*` 变量必须摘掉，
        // 否则 phi 自己跑在 zellij 里时会去连外面那个 session。
        assert!(CONFIG.contains("simplified_ui true"));
        // worker 的会话不画 tab 栏/状态栏：它是后台工作区，不是给人浏览的界面。
        assert_eq!(LAYOUT, "layout { pane; }");
        assert!(!CONFIG.contains("kill"));
        assert_eq!(SESSION, "phi-workers");
    }

    #[test]
    fn the_viewer_looks_like_the_cli_inside_it() {
        // 用户看到的是 codex / claude 的输出，不是一层 zellij 界面：
        // 不画 pane 边框，按键直接交给前台程序，滚轮与复制保留。
        assert!(CONFIG.contains("pane_frames false"));
        assert!(CONFIG.contains("default_mode \"locked\""));
        assert!(CONFIG.contains("mouse_mode true"));
        assert!(CONFIG.contains("scroll_buffer_size"));
    }
}
