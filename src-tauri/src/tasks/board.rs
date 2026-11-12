//! 把任务文件投影成看板列。列顺序来自 `backlog/config.yml` 的 `statuses`。

use super::document::{self, Workspace};
use super::model::{Board, BoardColumn, Task, WorkspaceInfo};
use std::path::Path;

fn priority_rank(task: &Task) -> u8 {
    match task.priority.as_deref().map(|value| value.to_lowercase()) {
        Some(priority) if priority == "high" => 0,
        Some(priority) if priority == "medium" => 1,
        Some(priority) if priority == "low" => 2,
        Some(_) => 3,
        None => 4,
    }
}

fn task_number(id: &str) -> u64 {
    id.rsplit_once('-')
        .and_then(|(_, number)| number.parse::<u64>().ok())
        .unwrap_or(u64::MAX)
}

/// 同一列内按「优先级 → 任务号」排，避免同优先级时顺序随机（文件系统不保证）。
pub fn project(workspace: &Workspace, mut tasks: Vec<Task>) -> Board {
    tasks.sort_by(|a, b| {
        priority_rank(a)
            .cmp(&priority_rank(b))
            .then_with(|| task_number(&a.id).cmp(&task_number(&b.id)))
            .then_with(|| a.id.cmp(&b.id))
    });

    let mut statuses = workspace.config.statuses.clone();
    for task in &tasks {
        if !statuses.iter().any(|status| status == &task.status) {
            statuses.push(task.status.clone());
        }
    }

    let columns = statuses
        .into_iter()
        .map(|status| BoardColumn {
            tasks: tasks
                .iter()
                .filter(|task| task.status == status)
                .cloned()
                .collect(),
            status,
        })
        .collect();

    Board {
        root: workspace.root.to_string_lossy().into_owned(),
        project_name: workspace.config.project_name.clone(),
        default_status: workspace.config.default_status.clone(),
        task_prefix: workspace.config.task_prefix.clone(),
        statuses: workspace.config.statuses.clone(),
        columns,
    }
}

/// 已登记工作区的当前状态。目录被删、config 被改坏时不报错，只标 `valid=false`。
pub fn info(root: &Path) -> WorkspaceInfo {
    let name = root
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    match document::open(root) {
        Ok(workspace) => WorkspaceInfo {
            root: workspace.root.to_string_lossy().into_owned(),
            name,
            project_name: Some(workspace.config.project_name.clone()),
            statuses: workspace.config.statuses.clone(),
            default_status: Some(workspace.config.default_status.clone()),
            task_prefix: Some(workspace.config.task_prefix.clone()),
            valid: true,
            error: None,
        },
        Err(error) => WorkspaceInfo {
            root: root.to_string_lossy().into_owned(),
            name,
            project_name: None,
            statuses: Vec::new(),
            default_status: None,
            task_prefix: None,
            valid: false,
            error: Some(error),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tasks::document::initialize;

    fn task(id: &str, status: &str, priority: Option<&str>) -> Task {
        Task {
            id: id.into(),
            title: id.into(),
            status: status.into(),
            assignees: Vec::new(),
            priority: priority.map(|value| value.to_string()),
            labels: Vec::new(),
            dependencies: Vec::new(),
            created_date: None,
            updated_date: None,
            acceptance_total: 0,
            acceptance_done: 0,
            file: format!("backlog/tasks/{}.md", id.to_lowercase()),
            fingerprint: String::new(),
        }
    }

    #[test]
    fn keeps_configured_column_order_and_sorts_cards() {
        let temp = tempfile::tempdir().expect("tempdir");
        let workspace = initialize(temp.path(), "phi").expect("init");
        let board = project(
            &workspace,
            vec![
                task("TASK-3", "To Do", Some("low")),
                task("TASK-2", "To Do", Some("high")),
                task("TASK-10", "In Progress", None),
            ],
        );
        let names: Vec<&str> = board
            .columns
            .iter()
            .map(|column| column.status.as_str())
            .collect();
        assert_eq!(names, vec!["To Do", "In Progress", "Done"]);
        assert_eq!(
            board.columns[0]
                .tasks
                .iter()
                .map(|task| task.id.as_str())
                .collect::<Vec<_>>(),
            vec!["TASK-2", "TASK-3"]
        );
        assert_eq!(board.columns[1].tasks[0].id, "TASK-10");
    }

    #[test]
    fn unknown_status_gets_its_own_column_instead_of_disappearing() {
        let temp = tempfile::tempdir().expect("tempdir");
        let workspace = initialize(temp.path(), "phi").expect("init");
        let board = project(&workspace, vec![task("TASK-1", "Blocked", None)]);
        assert_eq!(board.columns.len(), 4);
        assert_eq!(board.columns[3].status, "Blocked");
        assert_eq!(board.columns[3].tasks.len(), 1);
    }

    #[test]
    fn reports_invalid_workspace_without_failing() {
        let temp = tempfile::tempdir().expect("tempdir");
        let info = info(temp.path());
        assert!(!info.valid);
        assert_eq!(info.error.as_deref(), Some("no-backlog"));
    }
}
