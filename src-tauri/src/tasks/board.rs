//! 把任务文件投影成看板列。列顺序来自 `backlog/config.yml` 的 `statuses`。

use super::document::{self, Workspace};
use super::model::{Board, BoardColumn, Task, WorkspaceInfo};
use std::path::Path;

fn task_number(id: &str) -> u64 {
    id.rsplit_once('-')
        .and_then(|(_, number)| number.parse::<u64>().ok())
        .unwrap_or(u64::MAX)
}

/// 同一列内按任务号排。
///
/// 曾经按优先级排序，但新建任务默认就是 `medium`，每张卡都一样，排序从来不起作用；
/// 现在看板不展示这个字段，新建任务也不再写它。老卡片里可能还留着 `priority`，
/// 一律忽略，列内保持「任务号从小到大」这一个确定顺序。
pub fn project(workspace: &Workspace, mut tasks: Vec<Task>) -> Board {
    tasks.sort_by(|a, b| {
        task_number(&a.id)
            .cmp(&task_number(&b.id))
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
            kind: crate::tasks::model::KIND_TASK.into(),
            source_task: None,
            round: None,
            id: id.into(),
            title: id.into(),
            status: status.into(),
            assignees: Vec::new(),
            session: None,
            priority: priority.map(|value| value.to_string()),
            labels: Vec::new(),
            dependencies: Vec::new(),
            created_date: None,
            updated_date: None,
            acceptance_total: 0,
            acceptance_done: 0,
            artifact_count: 0,
            schedule: None,
            schedule_spec: None,
            discussion_hold: false,
            discussion_question: None,
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
        // 老卡片上残留的 priority 不再影响顺序：同一列永远按任务号排
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
