//! 任务文件的扫描、读取与写回。
//!
//! 写操作只有三个：新建、改状态、归档。每个写操作都先比对内容指纹——
//! 文件在 phi 打开期间被 `backlog` CLI 或别的 agent 改过时，宁可让用户刷新，
//! 也不要用一份过期的内存快照把它覆盖掉。

use super::document::{self, Workspace};
use super::frontmatter::{acceptance, sections, Document, FieldValue};
use super::model::{AcceptanceItem, NewTask, Task, TaskDetail, TaskSection};
use super::{result, schedule};
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
    let spec = schedule_of(&doc);

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
        artifact_count: result::artifacts(doc.body()).len(),
        schedule: spec.clone().map(|spec| spec.to_dto(None)),
        schedule_spec: spec,
        file: workspace.relative(path),
        fingerprint: fingerprint(raw),
    })
}

/// 卡片上声明的排期。写错了只当没有——一张卡的排期笔误不该让看板打不开。
fn schedule_of(doc: &Document) -> Option<schedule::Spec> {
    let recurrence = doc.string("recurrence");
    let moment = doc.string("schedule");
    match schedule::parse(recurrence.as_deref(), moment.as_deref()) {
        Ok(spec) => spec,
        Err(error) => {
            log::warn!(
                "task schedule ignored: {error} recurrence={recurrence:?} schedule={moment:?}"
            );
            None
        }
    }
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
    // 结果与产物在详情页有专门的位置：正文里再列一遍只是重复。
    // 只去掉「真的被当成结果展示」的那一段，其它段落（含 Conclusion 过程记录）保留。
    let outcome = result::outcome_section(doc.body());
    let sections = sections(doc.body())
        .into_iter()
        .filter(|section| {
            outcome
                .as_ref()
                .is_none_or(|(title, _)| title != &section.title)
                && !result::is_artifact_section(&section.title)
        })
        .map(|section| TaskSection {
            title: section.title,
            body: section.body,
        })
        .collect();

    Ok(TaskDetail {
        task,
        outcome: outcome.map(|(_, body)| body),
        artifacts: Vec::new(),
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
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    // 排期先校验再落盘：写进去却解析不了，卡片上看起来跟没配一样，用户会以为
    // 已经生效了。set_schedule 出于同样的理由先解析再写。
    let recurrence = input
        .recurrence
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let moment = input
        .schedule
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    schedule::parse(recurrence, moment)?;

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
    // 优先级看板已经不展示也不排序，新卡不写这个字段；调用方显式给了才落盘。
    if let Some(priority) = priority {
        text.push_str(&format!("priority: {}\n", scalar(&priority)));
    }
    if let Some(recurrence) = recurrence {
        text.push_str(&format!("recurrence: {}\n", scalar(recurrence)));
    }
    if let Some(moment) = moment {
        text.push_str(&format!("schedule: {}\n", scalar(moment)));
    }
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

/// 改排期。只重写 `recurrence` / `schedule` 两行。
///
/// 不动 `updated_date`：改的是「什么时候跑」，不是任务内容；跟 `updated_date`
/// 会让看板误以为卡片被别人改过，从而清掉重试预算。
pub fn set_schedule(
    workspace: &Workspace,
    id: &str,
    recurrence: Option<&str>,
    moment: Option<&str>,
    expected_fingerprint: &str,
) -> Result<TaskDetail, String> {
    // 先校验写下去的东西能不能解析：一个写错的排期在界面上看起来跟生效了一样，
    // 而调度器那里实际上已经忽略了它。
    schedule::parse(recurrence, moment)?;
    let path = find_file(workspace, id)?;
    let raw = read_to_string(&path)?;
    if fingerprint(&raw) != expected_fingerprint {
        return Err(STALE.into());
    }
    let mut text = raw.clone();
    for (key, value) in [("recurrence", recurrence), ("schedule", moment)] {
        let doc = Document::parse(&text).ok_or_else(|| "invalid-task-file".to_string())?;
        text = match value.map(str::trim).filter(|item| !item.is_empty()) {
            Some(value) => doc.with_field(key, FieldValue::Scalar(value)),
            None => doc.without_field(key),
        };
    }
    write_atomic(&path, &text)?;
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
        assert_eq!(detail.task.priority, None);
        assert_eq!(detail.acceptance.len(), 2);
        let raw = fs::read_to_string(workspace.root.join(&detail.task.file)).expect("read");
        assert!(raw.starts_with("---\nid: TASK-1\ntitle: Second task\nstatus: To Do\n"));
        // 优先级对每张卡都是同一个值、又不影响排序，新卡不再写这个字段
        assert!(!raw.contains("priority:"));
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
    fn a_broken_schedule_is_rejected_before_the_card_is_written() {
        let (_temp, workspace) = workspace();
        // 写错的排期落盘之后只会被调度器静默忽略，卡片上看起来跟没配一样：
        // 与其让人对着一个「设了但没生效」的卡发愁，不如当场拒绝。
        let broken = create(
            &workspace,
            &NewTask {
                title: "Bad interval".into(),
                recurrence: Some("soon".into()),
                ..Default::default()
            },
        );
        assert_eq!(broken.unwrap_err(), "invalid-recurrence");
        // 两个字段都给是写法冲突，不替用户猜。
        let conflicting = create(
            &workspace,
            &NewTask {
                title: "Two schedules".into(),
                recurrence: Some("2h".into()),
                schedule: Some("09:30".into()),
                ..Default::default()
            },
        );
        assert_eq!(conflicting.unwrap_err(), "conflicting-schedule");
        assert!(
            list(&workspace).expect("list").is_empty(),
            "被拒的卡不该落盘"
        );

        // 合法的排期照旧写进卡片，并立刻能读出来。
        let created = create(
            &workspace,
            &NewTask {
                title: "Every two hours".into(),
                recurrence: Some("2h".into()),
                ..Default::default()
            },
        )
        .expect("create");
        let schedule = created.task.schedule.expect("schedule");
        assert_eq!(schedule.kind, "interval");
        assert_eq!(schedule.minutes, Some(120));
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

    #[test]
    fn schedules_round_trip_through_the_card() {
        let (_temp, workspace) = workspace();
        write_task(&workspace, "task-1 - First-task.md", SAMPLE);
        let print = list(&workspace).expect("list")[0].fingerprint.clone();

        let detail = set_schedule(&workspace, "TASK-1", Some("2h"), None, &print).expect("set");
        let schedule = detail.task.schedule.clone().expect("schedule");
        assert_eq!(schedule.kind, "interval");
        assert_eq!(schedule.minutes, Some(120));

        let raw =
            fs::read_to_string(workspace.tasks_dir().join("task-1 - First-task.md")).expect("read");
        assert!(raw.contains("recurrence: 2h\n"));

        // 换类型：旧的 recurrence 要先删掉，否则两行同时存在会被判成写法冲突。
        let print = detail.task.fingerprint.clone();
        let detail = set_schedule(&workspace, "TASK-1", None, Some("09:30"), &print).expect("set");
        assert_eq!(detail.task.schedule.expect("schedule").kind, "daily");
        let raw =
            fs::read_to_string(workspace.tasks_dir().join("task-1 - First-task.md")).expect("read");
        assert!(!raw.contains("recurrence:"), "{raw}");
        assert!(raw.contains("schedule: '09:30'") || raw.contains("schedule: 09:30"));
    }

    #[test]
    fn clearing_a_schedule_removes_the_field() {
        let (_temp, workspace) = workspace();
        write_task(&workspace, "task-1 - First-task.md", SAMPLE);
        let print = list(&workspace).expect("list")[0].fingerprint.clone();
        let detail = set_schedule(&workspace, "TASK-1", Some("30m"), None, &print).expect("set");
        let cleared = set_schedule(&workspace, "TASK-1", None, None, &detail.task.fingerprint)
            .expect("clear");
        assert!(cleared.task.schedule.is_none());
        let raw =
            fs::read_to_string(workspace.tasks_dir().join("task-1 - First-task.md")).expect("read");
        assert!(!raw.contains("recurrence:"), "{raw}");
    }

    #[test]
    fn an_invalid_schedule_is_rejected_before_it_is_written() {
        let (_temp, workspace) = workspace();
        write_task(&workspace, "task-1 - First-task.md", SAMPLE);
        let print = list(&workspace).expect("list")[0].fingerprint.clone();
        assert_eq!(
            set_schedule(&workspace, "TASK-1", Some("soon"), None, &print).unwrap_err(),
            "invalid-recurrence"
        );
        let raw =
            fs::read_to_string(workspace.tasks_dir().join("task-1 - First-task.md")).expect("read");
        assert_eq!(raw, SAMPLE, "写坏了就不该落盘");
    }

    #[test]
    fn the_result_and_artifacts_are_read_from_the_card() {
        let (_temp, workspace) = workspace();
        let body = "---\nid: TASK-1\ntitle: First\nstatus: In Progress\n---\n\n## 结果\n\n整理完 7 条新闻。\n\n## 产物\n\n- `daily/report.md` — 今日简报\n\n## Conclusion\n\n跑了很久。\n";
        write_task(&workspace, "task-1 - First.md", body);
        fs::create_dir_all(workspace.root.join("daily")).expect("mkdir");
        fs::write(workspace.root.join("daily/report.md"), "hi").expect("file");

        let detail = read(&workspace, "TASK-1").expect("read");
        assert_eq!(detail.outcome.as_deref(), Some("整理完 7 条新闻。"));
        assert_eq!(detail.task.artifact_count, 1);
        // 结果与产物段落不再重复出现在正文段落里。
        assert!(detail
            .sections
            .iter()
            .all(|s| s.title != "结果" && s.title != "产物"));
        assert!(detail.sections.iter().any(|s| s.title == "Conclusion"));

        let resolved = crate::tasks::result::resolve(
            &workspace.root,
            &crate::tasks::result::artifacts(&detail.body),
        );
        assert_eq!(resolved.len(), 1);
        assert!(resolved[0].exists);
    }
}
