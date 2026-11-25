//! 任务看板的对外数据结构（DTO 单一来源：前端 `src/lib/api/tasks.ts` 与这里一一对应）。

use serde::{Deserialize, Serialize};

/// 普通任务：要交给执行者做出一份交付物。
pub const KIND_TASK: &str = "task";
/// 讨论卡：只收敛结论，不占执行槽位、不派 worker、不产出交付物。
pub const KIND_DISCUSSION: &str = "discussion";

/// 看板上的一张卡片。
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    /// `task`（要执行）或 `discussion`（讨论卡）。
    pub kind: String,
    /// 讨论卡从哪张已完成的任务派生出来；普通任务为空。
    pub source_task: Option<String>,
    /// 同一张源任务派生出的第几轮讨论。
    pub round: Option<u32>,
    /// 这张卡正在讨论阶段：不参与自动派发，也不会被「新建即派发」带走。
    pub discussion_hold: bool,
    /// 卡面上那一句「待决定的问题」；讨论清楚之前它就是这张卡的全部内容。
    pub discussion_question: Option<String>,
    pub id: String,
    pub title: String,
    pub status: String,
    pub assignees: Vec<String>,
    /// 这张卡要续接哪一个 CLI 会话（frontmatter 的 `session`）；为空表示每次新起一个。
    ///
    /// 存的是 CLI 自己的会话 id（claude 的 UUID、opencode 的 `ses_…`），不是 phi 的
    /// worker 会话。派发时按应用翻译成各自的 resume 参数；应用不支持或 id 不合法时不派，
    /// 不会「悄悄新起一个」。
    pub session: Option<String>,
    pub priority: Option<String>,
    pub labels: Vec<String>,
    pub dependencies: Vec<String>,
    pub created_date: Option<String>,
    pub updated_date: Option<String>,
    pub acceptance_total: usize,
    pub acceptance_done: usize,
    /// 卡片里「产物」段落列出的条数。看板只在有产物时显示一个小标记。
    pub artifact_count: usize,
    /// 持续 / 定时任务；普通任务为 `null`。
    pub schedule: Option<TaskSchedule>,
    /// 解析后的排期，供调度器直接用（不进 JSON：前端要的是 `schedule`）。
    #[serde(skip)]
    pub schedule_spec: Option<crate::tasks::schedule::Spec>,
    /// 相对仓库根的文件路径，用于「在文件管理器中显示」与排错
    pub file: String,
    /// 内容指纹：写回前比对，文件被外部改过就拒绝写入
    pub fingerprint: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSchedule {
    /// `interval`（每隔一段时间）/ `daily`（每天）/ `once`（指定时刻一次）
    pub kind: String,
    /// 间隔任务的分钟数
    pub minutes: Option<u32>,
    /// 每日任务的时间（本地时区，`HH:MM`）
    pub time: Option<String>,
    /// 一次性任务的时间（本地时区，`YYYY-MM-DD HH:MM`）
    pub at: Option<String>,
    /// 上一次被调度器触发的时刻（毫秒）；没跑过就是 `null`
    pub last_run_at: Option<i64>,
    /// 下一次该跑的时刻（毫秒）。已经过去的时刻表示「现在就该跑」。
    pub next_run_at: Option<i64>,
}

/// 一张卡交付的一个产物。
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskArtifact {
    /// 给人看的名字
    pub label: String,
    /// 卡片里写的原始路径或链接
    pub path: String,
    /// 文件是否真的在仓库里（链接一律算存在）
    pub exists: bool,
    /// 文件大小（字节）；链接与找不到的文件为 `null`
    pub size: Option<u64>,
    /// 外部链接
    pub url: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcceptanceItem {
    pub text: String,
    pub done: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSection {
    pub title: String,
    pub body: String,
}

/// 任务 ↔ 会话的关联。用量在读取时按会话聚合，关联本身只存三个标识。
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskLink {
    pub session_id: String,
    pub app_id: String,
    pub created_at: i64,
    pub cost_usd: f64,
    pub requests: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDetail {
    pub task: Task,
    pub body: String,
    pub sections: Vec<TaskSection>,
    pub acceptance: Vec<AcceptanceItem>,
    pub links: Vec<TaskLink>,
    /// 结果摘要（卡片里的「结果 / Outcome」段落，老卡片退回 `Conclusion`）
    pub outcome: Option<String>,
    /// 讨论后写回同一张卡、已由人确认的需求与约束。
    pub confirmed: Option<String>,
    /// 由这张任务派生出的讨论卡，按轮次升序。历史只做反向引用，不搬进本卡。
    pub derived: Vec<DerivedDiscussion>,
    /// 用户要拿走的产物，按卡片里列的顺序
    pub artifacts: Vec<TaskArtifact>,
    /// 这一轮讨论的对话记录，按时间先后。发言者只有用户与 Router。
    pub discussion_turns: Vec<DiscussionTurn>,
}

/// 讨论的一轮发言。
///
/// 讨论记录存 sqlite 而不是任务文件：它是 phi 的运行事实（这一轮谁说了什么），
/// 卡片里只留结论（`discussion_question` / `confirmed`），用户的任务资产不被
/// 聊天记录撑大，也不会因为讨论而被改写。
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscussionTurn {
    /// `user`（用户）或 `router`（Router）
    pub role: String,
    pub text: String,
    /// 毫秒时间戳
    pub created_at: i64,
    /// Router 这一轮抛给用户填写的表单，从回复里的 `phi-form` 块解析。
    /// `text` 已经去掉那段块，所以前端能把「话」和「可填的表单」分开渲染。
    pub form: Option<DiscussionForm>,
}

/// 讨论里的一张表单：把「还需要你定什么」变成可以直接填的几项。
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscussionForm {
    pub title: Option<String>,
    pub fields: Vec<DiscussionFormField>,
}

/// 表单里的一项。`kind` 序列化成 `type`，取值只有 `text` 与 `choice`。
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscussionFormField {
    pub id: String,
    pub label: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub placeholder: Option<String>,
    pub options: Vec<String>,
    pub required: bool,
}

/// 一张派生出去的讨论卡。原任务只读这份摘要，不读它的正文。
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DerivedDiscussion {
    pub id: String,
    pub title: String,
    pub status: String,
    pub round: Option<u32>,
    pub created_date: Option<String>,
    /// 这张讨论卡上还没定的问题
    pub question: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardColumn {
    pub status: String,
    pub tasks: Vec<Task>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Board {
    pub root: String,
    pub project_name: String,
    pub default_status: String,
    pub task_prefix: String,
    /// config.yml 里配置的列（不含因未知状态临时多出来的列）
    pub statuses: Vec<String>,
    pub columns: Vec<BoardColumn>,
}

/// 已登记的工作区。`valid=false` 时 `error` 说明缺什么，看板页据此提示而不是白屏。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    pub root: String,
    pub name: String,
    pub project_name: Option<String>,
    pub statuses: Vec<String>,
    pub default_status: Option<String>,
    pub task_prefix: Option<String>,
    pub valid: bool,
    pub error: Option<String>,
}

/// 新建任务的输入。缺省值由当前 config 补齐（状态、优先级、前缀）。
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NewTask {
    #[serde(default)]
    pub discussion_hold: bool,
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub priority: Option<String>,
    #[serde(default)]
    pub assignees: Option<Vec<String>>,
    #[serde(default)]
    pub labels: Option<Vec<String>>,
    #[serde(default)]
    pub dependencies: Option<Vec<String>>,
    #[serde(default)]
    pub acceptance: Option<Vec<String>>,
    /// 持续任务：每隔多久跑一次（`2h` / `30m` / `1d`）
    #[serde(default)]
    pub recurrence: Option<String>,
    /// 定时任务：每天的时刻（`09:30`）或一次性的时刻（`2026-11-20 09:30`）
    #[serde(default)]
    pub schedule: Option<String>,
}
