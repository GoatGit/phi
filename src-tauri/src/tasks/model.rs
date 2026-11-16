//! 任务看板的对外数据结构（DTO 单一来源：前端 `src/lib/api/tasks.ts` 与这里一一对应）。

use serde::{Deserialize, Serialize};

/// 看板上的一张卡片。
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub title: String,
    pub status: String,
    pub assignees: Vec<String>,
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
    /// 用户要拿走的产物，按卡片里列的顺序
    pub artifacts: Vec<TaskArtifact>,
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
