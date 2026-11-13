//! 任务文件的扫描、读取与写回。
//!
//! 写操作只有三个：新建、改状态、归档。每个写操作都先比对内容指纹——
//! 文件在 phi 打开期间被 `backlog` CLI 或别的 agent 改过时，宁可让用户刷新，
//! 也不要用一份过期的内存快照把它覆盖掉。

use super::document::{self, Workspace};
use super::frontmatter::{acceptance, sections, Document, FieldValue};
use super::model::{AcceptanceItem, NewTask, Task, TaskDetail, TaskSection};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

const STALE: &str = "stale-fingerprint";

/// 内容指纹。用内容而不是 mtime：切分支、rebase 都会刷新 mtime，但内容没变。
pub fn fingerprint(raw: &str) -> String {
    let digest = Sha256::digest(raw.as_bytes());
    let head = digest[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("{}:{head}", raw.len())
}

fn read_to_string(path: &Path) -> Result<String, String> {
    fs::read_to_string(path).map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => "task-not-found".to_string(),
        _ => error.to_string(),
    })
}

/// 扫描 tasks 目录里的全部任务。单个文件坏掉只跳过它，不让整个看板打不开。
pub fn list(workspace: &Workspace) -> Result<Vec<Task>, String> {
    let dir = workspace.tasks_dir();
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };

    let mut tasks = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if !path
            .extension()
            .map(|ext| ext.eq_ignore_ascii_case("md"))
            .unwrap_or(false)
        {
            continue;
        }
        let Ok(raw) = fs::read_to_string(&path) else {
            continue;
        };
        if let Ok(task) = to_task(workspace, &path, &raw) {
            tasks.push(task);
        }
    }
    tasks.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(tasks)
}

fn to_task(workspace: &Workspace, path: &Path, raw: &str) -> Result<Task, String> {
    let doc = Document::parse(raw).ok_or_else(|| "invalid-task-file".to_string())?;
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let fallback_id = document::id_from_file_name(&file_name);
    let Some(id) = doc.string("id").or(fallback_id) else {
        return Err("invalid-task-file".into());
    };
    let title = doc
        .string("title")
        .or_else(|| title_from_file_name(&file_name))
        .unwrap_or_else(|| id.clone());
    let items = acceptance(doc.body());

    Ok(Task {
        id,
        title,
        status: doc
            .string("status")
            .unwrap_or_else(|| workspace.config.default_status.clone()),
        assignees: {
            let mut names = doc.list("assignee");
            names.extend(doc.list("assignees"));
            names
        },
        priority: doc.string("priority"),
        labels: doc.list("labels"),
        dependencies: doc.list("dependencies"),
        created_date: doc.string("created_date"),
        updated_date: doc.string("updated_date"),
        acceptance_total: items.len(),
        acceptance_done: items.iter().filter(|item| item.done).count(),
        file: workspace.relative(path),
        fingerprint: fingerprint(raw),
    })
}

fn title_from_file_name(file_name: &str) -> Option<String> {
    let stem = file_name.trim_end_matches(".md");
    let (_, title) = stem.split_once(" - ")?;
    Some(title.replace('-', " "))
}

/// 按 ID 找文件。先信 frontmatter，再看文件名里的 ID。
pub fn find_file(workspace: &Workspace, id: &str) -> Result<PathBuf, String> {
    let wanted = id.trim().to_uppercase();
    if wanted.is_empty() {
        return Err("invalid-task-id".into());
    }
    let dir = workspace.tasks_dir();
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err("task-not-found".into())
        }
        Err(error) => return Err(error.to_string()),
    };

    let mut candidates: Vec<PathBuf> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if document::id_from_file_name(&name).as_deref() == Some(wanted.as_str()) {
            return Ok(path);
        }
        candidates.push(path);
    }

    for path in candidates {
        let Ok(raw) = fs::read_to_string(&path) else {
            continue;
        };
        if let Some(doc) = Document::parse(&raw) {
            if doc
                .string("id")
                .map(|value| value.to_uppercase())
                .as_deref()
                == Some(wanted.as_str())
            {
                return Ok(path);
            }
        }
    }
    Err("task-not-found".into())
}

pub fn read(workspace: &Workspace, id: &str) -> Result<TaskDetail, String> {
    let path = find_file(workspace, id)?;
    let raw = read_to_string(&path)?;
    let doc = Document::parse(&raw).ok_or_else(|| "invalid-task-file".to_string())?;
    let task = to_task(workspace, &path, &raw)?;
    let body = doc.body().trim_start_matches('\n').to_string();
    let items = acceptance(doc.body())
        .into_iter()
        .map(|item| AcceptanceItem {
            text: item.text,
            done: item.done,
        })
        .collect();
    let sections = sections(doc.body())
        .into_iter()
        .map(|section| TaskSection {
            title: section.title,
            body: section.body,
        })
        .collect();

    Ok(TaskDetail {
        task,
        body,
        sections,
        acceptance: items,
        links: Vec::new(),
    })
}

/// 用 YAML 规则给标量加引号，`To Do` 不变，`@codex` 这类会加单引号。
fn scalar(text: &str) -> String {
    serde_yaml::to_string(&serde_yaml::Value::String(text.to_string()))
        .map(|value| value.trim_end_matches('\n').to_string())
        .unwrap_or_else(|_| format!("'{text}'"))
}

fn inline_list(items: &[String]) -> String {
    if items.is_empty() {
        return "[]".to_string();
    }
    let rendered = items
        .iter()
        .map(|item| scalar(item))
        .collect::<Vec<_>>()
        .join(", ");
    format!("[{rendered}]")
}

fn ensure_single_line(value: &str, code: &str) -> Result<(), String> {
    if value.contains('\n') || value.contains('\r') {
        return Err(code.to_string());
    }
    Ok(())
}

/// 新建任务。ID 按目录里已有的最大编号 +1，写入走临时文件 + rename。
pub fn create(workspace: &Workspace, input: &NewTask) -> Result<TaskDetail, String> {
    let title = input.title.trim();
    if title.is_empty() {
        return Err("empty-title".into());
    }
    ensure_single_line(title, "invalid-title")?;

    let status = input
        .status
        .clone()
        .unwrap_or_else(|| workspace.config.default_status.clone());
    if !workspace.config.statuses.contains(&status) {
        return Err("unknown-status".into());
    }

    let id = document::next_id(workspace)?;
    let description = input.description.clone().unwrap_or_default();
    let acceptance_items = input.acceptance.clone().unwrap_or_default();
    let priority = input
        .priority
        .clone()
        .unwrap_or_else(|| "medium".to_string());

    let mut text = String::new();
    text.push_str("---\n");
    text.push_str(&format!("id: {id}\n"));
    text.push_str(&format!("title: {}\n", scalar(title)));
    text.push_str(&format!("status: {}\n", scalar(&status)));
    text.push_str(&format!(
        "assignee: {}\n",
        inline_list(&input.assignees.clone().unwrap_or_default())
    ));
    text.push_str(&format!(
        "created_date: {}\n",
        scalar(&document::timestamp())
    ));
    text.push_str(&format!(
        "labels: {}\n",
        inline_list(&input.labels.clone().unwrap_or_default())
    ));
    text.push_str(&format!(
        "dependencies: {}\n",
        inline_list(&input.dependencies.clone().unwrap_or_default())
    ));
    text.push_str(&format!("priority: {}\n", scalar(&priority)));
    text.push_str("---\n\n");
    text.push_str("## Description\n\n");
    let description = description.trim();
    text.push_str(description);
    if !description.is_empty() {
        text.push_str("\n\n");
    }
    text.push_str("## Acceptance Criteria\n\n");
    for item in &acceptance_items {
        let item = item.trim();
        if item.is_empty() {
            continue;
        }
        text.push_str(&format!("- [ ] {item}\n"));
    }

    let path = workspace.tasks_dir().join(document::file_name(&id, title));
    if path.exists() {
        return Err("task-exists".into());
    }
    fs::create_dir_all(workspace.tasks_dir()).map_err(|e| e.to_string())?;
    write_atomic(&path, &text)?;
    read(workspace, &id)
}

pub(crate) fn write_atomic(path: &Path, contents: &str) -> Result<(), String> {
    let parent = path.parent().ok_or_else(|| "invalid-path".to_string())?;
    let temp = parent.join(format!(".phi-task-{}.tmp", uuid::Uuid::new_v4()));
    fs::write(&temp, contents).map_err(|e| {
        let _ = fs::remove_file(&temp);
        e.to_string()
    })?;
    if let Err(error) = fs::rename(&temp, path) {
        let _ = fs::remove_file(&temp);
        return Err(error.to_string());
    }
    Ok(())
}

/// 改状态。只重写 `status` 与 `updated_date` 两行。
pub fn set_status(
    workspace: &Workspace,
    id: &str,
    status: &str,
    expected_fingerprint: &str,
) -> Result<TaskDetail, String> {
    if !workspace.config.statuses.iter().any(|item| item == status) {
        return Err("unknown-status".into());
    }
    let path = find_file(workspace, id)?;
    let raw = read_to_string(&path)?;
    if fingerprint(&raw) != expected_fingerprint {
        return Err(STALE.into());
    }
    let doc = Document::parse(&raw).ok_or_else(|| "invalid-task-file".to_string())?;
    let with_status = doc.with_field("status", FieldValue::Scalar(status));
    let next = Document::parse(&with_status)
        .ok_or_else(|| "invalid-task-file".to_string())?
        .with_field("updated_date", FieldValue::Scalar(&document::timestamp()));
    write_atomic(&path, &next)?;
    read(workspace, id)
}

/// 归档：把文件移到 `archive/tasks/`。上游的归档就是换目录，不改 frontmatter。
pub fn archive(workspace: &Workspace, id: &str, expected_fingerprint: &str) -> Result<(), String> {
    let path = find_file(workspace, id)?;
    let raw = read_to_string(&path)?;
    if fingerprint(&raw) != expected_fingerprint {
        return Err(STALE.into());
    }
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .ok_or_else(|| "invalid-path".to_string())?;
    let archive_dir = workspace.archive_dir();
    fs::create_dir_all(&archive_dir).map_err(|e| e.to_string())?;
    fs::rename(&path, archive_dir.join(name)).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tasks::document::initialize;

    fn workspace() -> (tempfile::TempDir, Workspace) {
        let temp = tempfile::tempdir().expect("tempdir");
        let workspace = initialize(temp.path(), "phi").expect("init");
        (temp, workspace)
    }

    fn write_task(workspace: &Workspace, name: &str, text: &str) -> PathBuf {
        let path = workspace.tasks_dir().join(name);
        fs::write(&path, text).expect("write");
        path
    }

    const SAMPLE: &str = "---\nid: TASK-1\ntitle: First task\nstatus: To Do\nassignee: ['@codex']\ncreated_date: '2026-11-01 09:00'\nlabels:\n  - backend\ndependencies: []\npriority: high\n---\n\n## Description\n\nDo it.\n\n## Acceptance Criteria\n\n- [x] One\n- [ ] Two\n";

    #[test]
    fn lists_tasks_with_acceptance_progress() {
        let (_temp, workspace) = workspace();
        write_task(&workspace, "task-1 - First-task.md", SAMPLE);
        let tasks = list(&workspace).expect("list");
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].id, "TASK-1");
        assert_eq!(tasks[0].title, "First task");
        assert_eq!(tasks[0].assignees, vec!["@codex"]);
        assert_eq!(tasks[0].labels, vec!["backend"]);
        assert_eq!(tasks[0].acceptance_total, 2);
        assert_eq!(tasks[0].acceptance_done, 1);
        assert_eq!(tasks[0].file, "backlog/tasks/task-1 - First-task.md");
    }

    #[test]
    fn reads_sections_and_body() {
        let (_temp, workspace) = workspace();
        write_task(&workspace, "task-1 - First-task.md", SAMPLE);
        let detail = read(&workspace, "task-1").expect("read");
        assert_eq!(detail.sections.len(), 2);
        assert_eq!(detail.sections[0].title, "Description");
        assert_eq!(detail.acceptance.len(), 2);
        assert!(detail.body.starts_with("## Description"));
    }

    #[test]
    fn creates_task_in_upstream_layout() {
        let (_temp, workspace) = workspace();
        let detail = create(
            &workspace,
            &NewTask {
                title: "Second task".into(),
                description: Some("Body text".into()),
                acceptance: Some(vec!["A".into(), "B".into()]),
                assignees: Some(vec!["@codex".into()]),
                ..Default::default()
            },
        )
        .expect("create");
        assert_eq!(detail.task.id, "TASK-1");
        assert_eq!(detail.task.status, "To Do");
        assert_eq!(detail.task.priority.as_deref(), Some("medium"));
        assert_eq!(detail.acceptance.len(), 2);
        let raw = fs::read_to_string(workspace.root.join(&detail.task.file)).expect("read");
        assert!(raw.starts_with("---\nid: TASK-1\ntitle: Second task\nstatus: To Do\n"));
        assert!(raw.contains("## Description\n\nBody text\n"));
        assert!(raw.contains("- [ ] A\n- [ ] B\n"));

        let second = create(
            &workspace,
            &NewTask {
                title: "Third".into(),
                ..Default::default()
            },
        )
        .expect("create");
        assert_eq!(second.task.id, "TASK-2");
    }

    #[test]
    fn rejects_empty_title_and_unknown_status() {
        let (_temp, workspace) = workspace();
        assert_eq!(
            create(&workspace, &NewTask::default()).expect_err("empty"),
            "empty-title"
        );
        assert_eq!(
            create(
                &workspace,
                &NewTask {
                    title: "x".into(),
                    status: Some("Nope".into()),
                    ..Default::default()
                }
            )
            .expect_err("status"),
            "unknown-status"
        );
    }

    #[test]
    fn status_change_touches_only_two_lines() {
        let (_temp, workspace) = workspace();
        write_task(&workspace, "task-1 - First-task.md", SAMPLE);
        let before = list(&workspace).expect("list")[0].fingerprint.clone();
        let detail = set_status(&workspace, "TASK-1", "In Progress", &before).expect("set");
        assert_eq!(detail.task.status, "In Progress");
        assert!(detail.task.updated_date.is_some());

        let raw =
            fs::read_to_string(workspace.tasks_dir().join("task-1 - First-task.md")).expect("read");
        let expected = SAMPLE
            .replace("status: To Do", "status: In Progress")
            .replace(
                "priority: high\n---",
                &format!(
                    "priority: high\nupdated_date: {}\n---",
                    scalar(detail.task.updated_date.as_deref().unwrap())
                ),
            );
        assert_eq!(raw, expected);
    }

    #[test]
    fn stale_fingerprint_blocks_writes() {
        let (_temp, workspace) = workspace();
        write_task(&workspace, "task-1 - First-task.md", SAMPLE);
        let error = set_status(&workspace, "TASK-1", "Done", "stale").expect_err("stale");
        assert_eq!(error, STALE);
    }

    #[test]
    fn archives_task_into_archive_directory() {
        let (_temp, workspace) = workspace();
        write_task(&workspace, "task-1 - First-task.md", SAMPLE);
        let print = list(&workspace).expect("list")[0].fingerprint.clone();
        archive(&workspace, "TASK-1", &print).expect("archive");
        assert!(list(&workspace).expect("list").is_empty());
        assert!(workspace
            .archive_dir()
            .join("task-1 - First-task.md")
            .is_file());
        assert_eq!(
            read(&workspace, "TASK-1").expect_err("gone"),
            "task-not-found"
        );
    }

    #[test]
    fn skips_unparsable_files() {
        let (_temp, workspace) = workspace();
        write_task(&workspace, "task-1 - good.md", SAMPLE);
        write_task(&workspace, "notes.md", "just text\n");
        assert_eq!(list(&workspace).expect("list").len(), 1);
    }
}
