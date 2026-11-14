//! Auto-router（super-agent）的对外数据结构。
//!
//! 与前端 `src/lib/api/superAgent.ts` 一一对应；改字段时两边同时改。
//! 这里只有数据，没有任何判定逻辑：判定在 [`crate::super_agent::tick`]，
//! 谓词调用在 [`crate::super_agent::judge`]。

use serde::{Deserialize, Serialize};

/// 一次 tick 最多走过的候选任务数（超过就交给注意力分桶收窄）。
pub const DEFAULT_ATTENTION_THRESHOLD: usize = 8;
/// 单个任务连续失败多少次之后不再自动派发，转人工。
pub const DEFAULT_MAX_ATTEMPTS: u32 = 3;

/// Router 的开关、配额与阈值。整份存进 `router_settings` 一行 JSON。
///
/// 缺字段时按 `Default` 补，前端只传它关心的项也不会丢默认值。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RouterSettings {
    /// 总开关。关闭时 tick 直接空跑（不看任务、不调判官）。
    pub enabled: bool,
    /// 影子模式：照常判断、照常记账，但不派发任何 worker。
    /// 第一次开自动调度时建议先跑一周影子，确认判断对不对。
    pub shadow: bool,
    /// 哪一列的卡片会被派发。默认 `In Progress`。
    pub trigger_status: String,
    /// 同时运行的任务数上限。
    pub concurrency: usize,
    /// 单次 tick 最多派发几个。
    pub dispatches_per_tick: usize,
    /// 当天最多派发几次。
    pub dispatches_per_day: usize,
    /// 当天最多调用判官几次。
    pub judge_calls_per_day: usize,
    /// 候选超过这个数量时先让判官收窄。
    pub attention_threshold: usize,
    /// 允许被派发的 worker（应用 id），第一个作为默认值。
    pub worker_apps: Vec<String>,
    /// 连续失败多少次之后转人工。
    pub max_attempts: u32,
    /// 是否把「退出码 0 且卡片被改过」判为完成。关掉之后一律转人工确认。
    pub trust_exit_zero: bool,
    /// 租约有效期（秒）。过期后下一次 tick 自动回收，避免任务永远停在 dispatched。
    pub lease_seconds: i64,
    /// 失败后的冷却时间（秒），期间不再自动重派。
    pub cooldown_seconds: i64,
    /// 判官模型。留空表示用用户名下的默认路由。
    pub judge_model: String,
    /// 调度器自己用的模型。空 = 不用模型，只按确定性规则判断。
    ///
    /// 取值是 phi 网关认的模型名；界面上给的是路由组别名 `group/<组名>`，
    /// 由网关展开成组内成员。没配、或网关没在监听，就退回规则版。
    pub episode_model: String,
}

impl Default for RouterSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            shadow: true,
            trigger_status: "In Progress".into(),
            concurrency: 2,
            dispatches_per_tick: 2,
            dispatches_per_day: 40,
            judge_calls_per_day: 200,
            attention_threshold: DEFAULT_ATTENTION_THRESHOLD,
            worker_apps: vec!["claude".into(), "codex".into()],
            max_attempts: DEFAULT_MAX_ATTEMPTS,
            trust_exit_zero: true,
            lease_seconds: 90,
            cooldown_seconds: 120,
            judge_model: "jev-latest".into(),
            // 默认不用模型：先把确定性路径跑稳，模型是后来加上去的。
            episode_model: String::new(),
        }
    }
}

impl RouterSettings {
    /// 派发时用的默认 worker。`worker_apps` 为空时返回 None（谁来都不对）。
    pub fn default_worker(&self) -> Option<&str> {
        self.worker_apps.first().map(String::as_str)
    }
}

/// 任务的运行态。与看板列（markdown 里的 `status`）是两件事，不互相推导。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RunState {
    /// 还没进过 router。
    Idle,
    /// 已排队，等配额或等依赖。
    Queued,
    /// 已交给 worker，进程刚起。
    Dispatched,
    /// worker 正在干活（收到过会话活动）。
    Working,
    /// 正常结束。
    Done,
    /// 失败，等退避重试或转人工。
    Failed,
    /// 需要人给一个决定（判官判为「这事不该机器定」，或闸门拒绝）。
    NeedsYou,
    /// 用户按了暂停。
    Paused,
}

impl RunState {
    pub fn as_str(self) -> &'static str {
        match self {
            RunState::Idle => "idle",
            RunState::Queued => "queued",
            RunState::Dispatched => "dispatched",
            RunState::Working => "working",
            RunState::Done => "done",
            RunState::Failed => "failed",
            RunState::NeedsYou => "needs-you",
            RunState::Paused => "paused",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "idle" => RunState::Idle,
            "queued" => RunState::Queued,
            "dispatched" => RunState::Dispatched,
            "working" => RunState::Working,
            "done" => RunState::Done,
            "failed" => RunState::Failed,
            "needs-you" => RunState::NeedsYou,
            "paused" => RunState::Paused,
            _ => return None,
        })
    }

    /// 这个状态是否「机器正在处理」，占并发名额。
    pub fn is_running(self) -> bool {
        matches!(self, RunState::Dispatched | RunState::Working)
    }
}

/// 一个任务的运行态记录。
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRun {
    pub task_id: String,
    pub root: String,
    pub state: RunState,
    pub worker_app: Option<String>,
    pub session_id: Option<String>,
    pub attempts: u32,
    pub detail: Option<String>,
    /// 派发那一刻卡片的内容指纹。收尾时用它判断 worker 到底有没有动过这张卡。
    pub card_fingerprint: Option<String>,
    /// 这条记录来自影子模式（只记「本来会派谁」，没有真的派发）。
    pub shadow: bool,
    pub updated_at: i64,
}

/// 一个候选任务：看板上的卡片加上它当前的运行态。
#[derive(Clone, Debug, PartialEq)]
pub struct Candidate {
    pub task_id: String,
    pub root: String,
    pub title: String,
    pub status: String,
    /// 相对仓库根的任务文件路径，派发时交给 worker。
    pub file: String,
    pub fingerprint: String,
    /// frontmatter 里声明的依赖。任何依赖没到 Done 就先不动这张卡。
    pub dependencies: Vec<String>,
    pub run: Option<TaskRun>,
}

impl Candidate {
    pub fn state(&self) -> RunState {
        self.run
            .as_ref()
            .map(|run| run.state)
            .unwrap_or(RunState::Idle)
    }

    pub fn attempts(&self) -> u32 {
        self.run.as_ref().map(|run| run.attempts).unwrap_or(0)
    }
}

/// 候选被剔除的原因。写进 trace 供排障，不影响判定。
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilteredOut {
    pub task_id: String,
    pub reason: String,
}

/// Router 唯一能产出的三种动作。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    /// 派给一个 worker。
    Dispatch,
    /// 问人。
    Ask,
    /// 这一轮不动它。
    Skip,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    pub task_id: String,
    pub action: Action,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub question: Option<String>,
}

impl Decision {
    pub fn dispatch(
        task_id: impl Into<String>,
        app_id: impl Into<String>,
        reason: impl Into<String>,
    ) -> Self {
        Self {
            task_id: task_id.into(),
            action: Action::Dispatch,
            app_id: Some(app_id.into()),
            reason: Some(reason.into()),
            question: None,
        }
    }

    pub fn ask(task_id: impl Into<String>, question: impl Into<String>) -> Self {
        Self {
            task_id: task_id.into(),
            action: Action::Ask,
            app_id: None,
            reason: None,
            question: Some(question.into()),
        }
    }

    pub fn skip(task_id: impl Into<String>, reason: impl Into<String>) -> Self {
        Self {
            task_id: task_id.into(),
            action: Action::Skip,
            app_id: None,
            reason: Some(reason.into()),
            question: None,
        }
    }
}

/// 一轮 episode 的产出。`unfinished` 表示模型没有调 `finish`；
/// 这不算失败，只把已观测到的决策降级采用。
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionSet {
    pub decisions: Vec<Decision>,
    pub unfinished: bool,
}

/// 一次 tick 的结果。命令层直接把它交给前端。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TickReport {
    pub trace_id: String,
    pub at: i64,
    pub trigger: String,
    /// 空跑原因（关闭、配额用尽、没有候选）。
    pub skipped: Option<String>,
    pub scanned: usize,
    pub candidates: usize,
    pub filtered: Vec<FilteredOut>,
    pub narrowed: bool,
    /// 判官调用失败等降级事实，逐条写清。
    pub degraded: Vec<String>,
    pub decisions: Vec<Decision>,
    pub dispatched: Vec<String>,
    pub needs_you: Vec<String>,
    pub judge_calls: usize,
    pub duration_ms: i64,
    pub shadow: bool,
}

/// 当天已经用掉的配额。
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaUsage {
    pub dispatches: usize,
    pub judge_calls: usize,
}

/// 看板侧需要的整体状态。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouterStatus {
    pub settings: RouterSettings,
    pub runs: Vec<TaskRun>,
    pub traces: Vec<RouterTrace>,
    pub today: QuotaUsage,
}

/// 一次 tick 的事实记录。只写不读（除排障与配额统计）。
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouterTrace {
    pub id: String,
    pub root: Option<String>,
    pub created_at: i64,
    pub trigger: String,
    pub candidates: usize,
    pub narrowed: bool,
    pub degraded: Vec<String>,
    pub decisions: Vec<Decision>,
    pub judge_calls: usize,
    pub duration_ms: i64,
    pub unfinished: bool,
    pub shadow: bool,
}

/// 规划 DAG 的一个节点：`plan_task` 的产物，落在 `router_plan_nodes`。
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanNode {
    pub task_id: String,
    pub node_id: String,
    pub title: String,
    pub worker_app: Option<String>,
    pub depends_on: Vec<String>,
    pub state: String,
}

/// 派发规格：worker 要知道「哪个仓库、哪张卡、干什么」。
#[derive(Clone, Debug, PartialEq)]
pub struct DispatchSpec {
    pub task_id: String,
    pub root: String,
    pub app_id: String,
    /// 相对仓库根的任务文件路径。
    pub file: String,
    pub title: String,
}

impl DispatchSpec {
    /// 交给 CLI 的初始指令。一句话，不做花活：worker 自己会读卡片。
    pub fn prompt(&self) -> String {
        format!(
            "读 {} 这张任务卡，完成任务。改完在卡片正文里补一句结论（改了什么、验证了什么）；\
             如果缺只有人才能给的信息，不要猜，把问题写进正文并停下。",
            self.file
        )
    }
}

/// 派发结果：成功时带会话 id，失败时带原因。
#[derive(Clone, Debug, PartialEq)]
pub struct DispatchOutcome {
    pub session_id: String,
}
