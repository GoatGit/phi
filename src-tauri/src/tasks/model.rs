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
    /// 相对仓库根的文件路径，用于「在文件管理器中显示」与排错
    pub file: String,
    /// 内容指纹：写回前比对，文件被外部改过就拒绝写入
    pub fingerprint: String,
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
}
