//! 任务文件的扫描、读取与写回。
//!
//! 写操作只有三个：新建、改状态、归档。每个写操作都先比对内容指纹——
//! 文件在 phi 打开期间被 `backlog` CLI 或别的 agent 改过时，宁可让用户刷新，
//! 也不要用一份过期的内存快照把它覆盖掉。

use super::document::{self, Workspace};
use super::frontmatter::{acceptance, sections, Document, FieldValue};
use super::model::{
    AcceptanceItem, DerivedDiscussion, NewTask, Task, TaskDetail, TaskSection, KIND_DISCUSSION,
    KIND_TASK,
};
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
    let kind = doc
        .string("phi_kind")
        .filter(|value| value == KIND_DISCUSSION)
        .unwrap_or_else(|| KIND_TASK.to_string());
    let discussion_hold = kind == KIND_DISCUSSION || is_true(doc.string("phi_discussion_hold"));

    Ok(Task {
        kind,
        source_task: doc
            .string("phi_source_task")
            .map(|value| value.trim().to_uppercase())
            .filter(|value| !value.is_empty()),
        round: doc
            .string("phi_round")
            .and_then(|value| value.trim().parse().ok()),
        discussion_hold,
        discussion_question: doc
            .string("phi_discussion_question")
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
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
        // 空串等于没设：手写 frontmatter 时很容易留一个 `session:`，那不是一次会话。
        session: doc
            .string("session")
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
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

fn is_true(value: Option<String>) -> bool {
    value.as_deref() == Some("true")
}

/// 看板上算「完成」的判据。Backlog.md 的默认终态就叫 Done，不为它加配置项。
pub fn is_done_status(status: &str) -> bool {
    status.eq_ignore_ascii_case("done")
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
    // 已确认的需求不是过程记录：它在详情里有自己的位置，正文里不再重复一遍。
    let confirmed = confirmed_in(doc.body());
    let sections = sections(doc.body())
        .into_iter()
        .filter(|section| {
            outcome
                .as_ref()
                .is_none_or(|(title, _)| title != &section.title)
                && !result::is_artifact_section(&section.title)
                && !is_confirmed_title(&section.title)
        })
        .map(|section| TaskSection {
            title: section.title,
            body: section.body,
        })
        .collect();

    Ok(TaskDetail {
        task,
        outcome: outcome.map(|(_, body)| body),
        confirmed,
        derived: derived(workspace, id).unwrap_or_default(),
        artifacts: Vec::new(),
        body,
        sections,
        acceptance: items,
        links: Vec::new(),
        discussion_turns: Vec::new(),
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
    if input.discussion_hold {
        // 讨论卡是一种独立的卡片类型，而不是普通卡上的一个临时标记：
        // 它不占执行槽位、不派 worker、不产出交付物。
        text.push_str(&format!("phi_kind: {}\n", KIND_DISCUSSION));
    }
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

/// 讨论问题的长度上限：它要显示在看板卡面上，一行装不下就没人读。
pub(crate) const DISCUSSION_QUESTION_LIMIT: usize = 200;
/// 已确认需求的长度上限。它会被拼进讨论会话的初始指令（`parse_arguments` 有
/// 16384 字符的总限），留出余量。
pub(crate) const CONFIRMED_LIMIT: usize = 8000;

/// 「已确认需求」段落的标题。第一个是写回去用的，其余都认。
const CONFIRMED_TITLES: [&str; 3] = ["已确认需求", "Confirmed requirements", "确认需求"];

fn is_confirmed_title(title: &str) -> bool {
    let title = title.trim();
    CONFIRMED_TITLES
        .iter()
        .any(|candidate| title.eq_ignore_ascii_case(candidate))
}

/// 人已经确认过的需求与约束。没有这一段就是 `None`。
pub fn confirmed_in(body: &str) -> Option<String> {
    sections(body)
        .into_iter()
        .find(|section| is_confirmed_title(&section.title))
        .map(|section| section.body.trim().to_string())
        .filter(|text| !text.is_empty())
}

/// 找一段 `## ` 标题的字节范围：从标题行开头到下一个标题之前。
///
/// 代码块里的 `## ` 不算标题，否则卡片里贴一段带小标题的日志会把后面的正文
/// 当成段落边界，写回时整段被裁掉。
fn section_range(body: &str, titles: &[&str]) -> Option<(usize, usize)> {
    let mut offset = 0usize;
    let mut start: Option<usize> = None;
    let mut in_fence = false;
    for line in body.split_inclusive('\n') {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
        } else if !in_fence {
            if let Some(title) = line.strip_prefix("## ") {
                let title = title.trim();
                match start {
                    None if titles.iter().any(|c| title.eq_ignore_ascii_case(c)) => {
                        start = Some(offset);
                    }
                    Some(begin) => return Some((begin, offset)),
                    _ => {}
                }
            }
        }
        offset += line.len();
    }
    start.map(|begin| (begin, body.len()))
}

/// 把正文里的「已确认需求」换成 `text`；`None` 表示删掉这一段。
///
/// 替换而不是追加：同一个问题讨论两轮，卡片里应该只有最后确认的那一版，
/// 而不是两份互相矛盾的需求叠在一起。
fn with_confirmed_section(body: &str, text: Option<&str>) -> String {
    let (head, tail) = match section_range(body, &CONFIRMED_TITLES) {
        Some((start, end)) => (&body[..start], &body[end..]),
        None => (body, ""),
    };
    let head = head.trim_end();
    let tail = tail.trim_matches('\n');
    let mut next = String::from(head);
    if let Some(text) = text {
        next.push_str("\n\n## ");
        next.push_str(CONFIRMED_TITLES[0]);
        next.push_str("\n\n");
        next.push_str(text.trim());
        next.push('\n');
    }
    if !tail.is_empty() {
        next.push('\n');
        next.push_str(tail);
        next.push('\n');
    } else if !next.ends_with('\n') {
        next.push('\n');
    }
    next
}

/// 讨论：卡片进入「讨论中」，把还没定的问题和已确认的结论写回同一张卡。
///
/// 只服务讨论卡：讨论是讨论卡的属性，普通执行卡即使在待办列也不能直接讨论。
/// 要在待办任务上讨论，先把它转成讨论卡（[`to_discussion`]），否则同一张卡会在
/// 「执行草稿」和「讨论现场」两种语义之间来回跳。
///
/// 也已经开工或已经完成的卡一律拒绝：再写「待决定的问题」读起来就像让 worker
/// 回头重做一遍；已完成的卡走 [`discussion_derive`] 派生新一轮。
///
/// `question` / `confirmed` 传 `None` 表示不动那一个，空字符串表示清掉。
/// 讨论记录本身不进卡片，只有谈定的结论才落盘。
///
/// 正常路径由 `tasks::discussion::task_discussion_say` 在每一轮 Router 回复后
/// 调用：结论从对话里解析出来，不需要人再手抄一遍（卡面上那两个框现在是只读的）。
pub fn discuss(
    workspace: &Workspace,
    id: &str,
    expected: &str,
    question: Option<&str>,
    confirmed: Option<&str>,
) -> Result<TaskDetail, String> {
    let path = find_file(workspace, id)?;
    let raw = read_to_string(&path)?;
    if fingerprint(&raw) != expected {
        return Err(STALE.into());
    }
    let task = to_task(workspace, &path, &raw)?;
    if task.kind != KIND_DISCUSSION {
        return Err("not-a-discussion".into());
    }
    if task.status != workspace.config.default_status {
        return Err("discussion-not-pending".into());
    }

    let question = question.map(|text| text.trim().to_string());
    if let Some(text) = question.as_deref().filter(|text| !text.is_empty()) {
        ensure_single_line(text, "invalid-discussion-question")?;
        if text.chars().count() > DISCUSSION_QUESTION_LIMIT {
            return Err("invalid-discussion-question".into());
        }
    }
    let confirmed = confirmed.map(|text| text.trim().to_string());
    if let Some(text) = confirmed.as_deref() {
        if text.chars().count() > CONFIRMED_LIMIT {
            return Err("invalid-discussion".into());
        }
    }

    let doc = Document::parse(&raw).ok_or_else(|| "invalid-task-file".to_string())?;
    // 写下任何一个字段都意味着这张卡进入讨论：在讨论清楚之前不该被自动调度派走。
    let mut next = doc.with_field("phi_discussion_hold", FieldValue::Scalar("true"));
    if let Some(text) = question.as_deref() {
        let doc = Document::parse(&next).ok_or_else(|| "invalid-task-file".to_string())?;
        next = if text.is_empty() {
            doc.without_field("phi_discussion_question")
        } else {
            doc.with_field("phi_discussion_question", FieldValue::Scalar(text))
        };
    }
    if let Some(text) = confirmed.as_deref() {
        let doc = Document::parse(&next).ok_or_else(|| "invalid-task-file".to_string())?;
        let body = next.len() - doc.body().len();
        let rebuilt = with_confirmed_section(doc.body(), (!text.is_empty()).then_some(text));
        next = format!("{}{}", &next[..body], rebuilt);
    }
    write_atomic(&path, &next)?;
    read(workspace, &task.id)
}

/// 把一张还停在待办列的执行卡就地转成讨论卡。
///
/// 讨论只在讨论卡里发生。普通待办卡不能直接讨论，但「把这张卡先想清楚」是
/// 真实需求，所以给它一次显式的类型转换：转换后卡片本身、标题与正文都不动，
/// 只是从执行草稿变成讨论现场。已经开工的卡不允许转换——它要么等跑完再派生
/// 新一轮讨论，要么另建一张讨论卡。
pub fn to_discussion(
    workspace: &Workspace,
    id: &str,
    expected: &str,
) -> Result<TaskDetail, String> {
    let path = find_file(workspace, id)?;
    let raw = read_to_string(&path)?;
    if fingerprint(&raw) != expected {
        return Err(STALE.into());
    }
    let task = to_task(workspace, &path, &raw)?;
    // 已经在待办列之外：讨论卡不能在半路出现，运行中还要谈就等它跑完。
    if task.status != workspace.config.default_status {
        return Err("discussion-not-pending".into());
    }
    // 已经是讨论卡就原样返回：重复点一次不该变成另一种错误。
    if task.kind == KIND_DISCUSSION {
        return read(workspace, &task.id);
    }
    let doc = Document::parse(&raw).ok_or_else(|| "invalid-task-file".to_string())?;
    let next = doc.with_field("phi_kind", FieldValue::Scalar(KIND_DISCUSSION));
    write_atomic(&path, &next)?;
    read(workspace, &task.id)
}

/// 由某张任务派生出的讨论卡，按轮次（缺失时按任务号）升序。
///
/// 原任务不搬到讨论卡里，讨论卡也不回写原任务：两者只靠 `phi_source_task`
/// 单向引用，所以原卡的结束时间与结论永远不会被后一轮讨论搅乱。
pub fn derived(workspace: &Workspace, id: &str) -> Result<Vec<DerivedDiscussion>, String> {
    let wanted = id.trim().to_uppercase();
    let mut items: Vec<DerivedDiscussion> = list(workspace)?
        .into_iter()
        .filter(|task| task.source_task.as_deref() == Some(wanted.as_str()))
        .map(|task| DerivedDiscussion {
            id: task.id,
            title: task.title,
            status: task.status,
            round: task.round,
            created_date: task.created_date,
            question: task.discussion_question,
        })
        .collect();
    items.sort_by(|a, b| a.round.cmp(&b.round).then_with(|| a.id.cmp(&b.id)));
    Ok(items)
}

/// 讨论笔记的长度上限。它会被原样写进新卡正文，也会占 Router 的上下文。
const DISCUSSION_NOTE_LIMIT: usize = 2000;
/// 派生出来的讨论卡标题上限。太长的标题在窄列里只剩省略号。
const DISCUSSION_TITLE_LIMIT: usize = 80;
/// 背景区块的总长度上限。超了就退化成「摘要 + 指针」，不额外花一次模型调用。
const BACKGROUND_LIMIT: usize = 2400;

fn clip(text: &str, limit: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= limit {
        return trimmed.to_string();
    }
    let mut out: String = trimmed.chars().take(limit).collect();
    out.push('…');
    out
}

/// 派生讨论卡要带的上下文：只带结论与约束，不带执行过程。
///
/// 带的是「下一步要定什么」需要的四样：目标、验收条件、最终状态与产出摘要、
/// 上一轮已确认的结论。worker 的中间尝试、命令输出、工具流水一律不进——
/// 它们只会淹没输入框，还会占满 Router 的上下文。
fn discussion_background(detail: &TaskDetail) -> String {
    let task = &detail.task;
    let goal = detail
        .sections
        .iter()
        .find(|section| {
            section.title.eq_ignore_ascii_case("description") || section.title.trim() == "目标"
        })
        .map(|section| clip(&section.body, 600))
        .unwrap_or_default();

    let mut text = format!(
        "## 讨论背景\n\n来自 {}「{}」。派生时的状态：{}。\n",
        task.id, task.title, task.status
    );
    if !goal.is_empty() {
        text.push_str("\n### 目标\n\n");
        text.push_str(&goal);
        text.push('\n');
    }
    if !detail.acceptance.is_empty() {
        text.push_str("\n### 验收条件\n\n");
        for item in detail.acceptance.iter().take(12) {
            text.push_str(&format!(
                "- [{}] {}\n",
                if item.done { "x" } else { " " },
                clip(&item.text, 120)
            ));
        }
        if detail.acceptance.len() > 12 {
            text.push_str("- （其余验收条件见原卡）\n");
        }
    }
    if let Some(outcome) = detail.outcome.as_deref().map(|text| clip(text, 800)) {
        if !outcome.is_empty() {
            text.push_str("\n### 执行结果\n\n");
            text.push_str(&outcome);
            text.push('\n');
        }
    }
    if let Some(confirmed) = detail.confirmed.as_deref().map(|text| clip(text, 800)) {
        if !confirmed.is_empty() {
            text.push_str("\n### 上一轮已确认\n\n");
            text.push_str(&confirmed);
            text.push('\n');
        }
    }
    if text.chars().count() > BACKGROUND_LIMIT {
        // 超了就不再拼细节：截到上限并明说去哪看全文，不静默丢信息。
        text = clip(&text, BACKGROUND_LIMIT);
        text.push_str(&format!("\n\n…完整内容见 {}。\n", task.id));
    }
    text
}

/// 从一张已完成的任务派生出一张新的讨论卡。
///
/// 已完成的任务不会回到讨论态：它的状态、结束时间与结论保持原样，只是多出
/// 一张指向它的讨论卡。这样审计线不被重新打开，需求变了也能沿同一件事继续谈。
///
/// `note` 是用户这一轮想讨论的那句话，会原样进入新卡的正文明细；卡面上那个
/// 单行的“还没定的问题”只是它的折叠摘要。
pub fn discussion_derive(
    workspace: &Workspace,
    source_id: &str,
    note: &str,
) -> Result<TaskDetail, String> {
    let note = note.trim();
    if note.is_empty() {
        return Err("empty-discussion-note".into());
    }
    if note.chars().count() > DISCUSSION_NOTE_LIMIT {
        return Err("invalid-discussion-note".into());
    }

    let source_path = find_file(workspace, source_id)?;
    let raw = read_to_string(&source_path)?;
    let source = to_task(workspace, &source_path, &raw)?;
    // 只有真的跑完的卡才能重新讨论：还在跑就派生，等于让两份结论同时生效。
    if source.kind == KIND_DISCUSSION || !is_done_status(&source.status) {
        return Err("discussion-source-not-done".into());
    }

    let detail = read(workspace, &source.id)?;
    let round = derived(workspace, &source.id)?
        .iter()
        .filter_map(|item| item.round)
        .max()
        .unwrap_or(0)
        + 1;
    let title = clip(&format!("讨论：{}", source.title), DISCUSSION_TITLE_LIMIT);
    let question = clip(&note.split_whitespace().collect::<Vec<_>>().join(" "), 200);
    let background = discussion_background(&detail);

    let id = document::next_id(workspace)?;
    let mut text = String::new();
    text.push_str("---\n");
    text.push_str(&format!("phi_kind: {KIND_DISCUSSION}\n"));
    text.push_str(&format!("phi_source_task: {}\n", source.id));
    text.push_str(&format!(
        "phi_source_title: {}\n",
        scalar(&clip(&source.title, 200))
    ));
    text.push_str(&format!("phi_round: {round}\n"));
    text.push_str(&format!("phi_discussion_question: {}\n", scalar(&question)));
    text.push_str(&format!("id: {id}\n"));
    text.push_str(&format!("title: {}\n", scalar(&title)));
    text.push_str(&format!(
        "status: {}\n",
        scalar(&workspace.config.default_status)
    ));
    text.push_str("assignee: []\n");
    text.push_str(&format!(
        "created_date: {}\n",
        scalar(&document::timestamp())
    ));
    text.push_str("labels: []\n");
    text.push_str("dependencies: []\n");
    text.push_str("---\n\n");
    text.push_str(&background);
    text.push_str("\n## 本轮讨论\n\n");
    text.push_str(note);
    text.push('\n');

    let path = workspace.tasks_dir().join(document::file_name(&id, &title));
    if path.exists() {
        return Err("task-exists".into());
    }
    fs::create_dir_all(workspace.tasks_dir()).map_err(|e| e.to_string())?;
    write_atomic(&path, &text)?;
    read(workspace, &id)
}

/// 删掉一张讨论卡。
///
/// 讨论卡还在待办列，就说明这一轮还没被采纳：删掉它只是丢掉一轮没定下来的记录。
/// 已经谈出的结论也会随卡片一起消失，所以界面上要人确认一次。
/// 想留着结论继续做，就走「发送任务」——那一步是把同一张卡转成执行卡，不是删除。
/// 已经离开待办列的卡不再是讨论卡（类型在挪列时就转成执行卡），它走归档而不是这条路径。
pub fn discard_discussion(workspace: &Workspace, id: &str, expected: &str) -> Result<(), String> {
    let path = find_file(workspace, id)?;
    let raw = read_to_string(&path)?;
    if fingerprint(&raw) != expected {
        return Err(STALE.into());
    }
    let doc = Document::parse(&raw).ok_or_else(|| "invalid-task-file".to_string())?;
    if doc.string("phi_kind").as_deref() != Some(KIND_DISCUSSION) {
        return Err("not-a-discussion".into());
    }
    fs::remove_file(&path).map_err(|error| error.to_string())
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
    let task = to_task(workspace, &path, &raw)?;
    // 讨论卡离开待办＝讨论结束，同一张卡转成执行卡；来源与轮次保留为出处。
    // 这是类型转换，不是在讨论卡上再叠一个状态：转换后输入框自然消失。
    let doc = if task.kind == KIND_DISCUSSION
        && task.status == workspace.config.default_status
        && status != workspace.config.default_status
    {
        let converted = doc.without_field("phi_kind");
        Document::parse(&converted).ok_or_else(|| "invalid-task-file".to_string())?
    } else {
        doc
    };
    // 离开待办 ＝ 讨论结束：卡片不再挂着「讨论中」，也不再在卡面重复一个已经
    // 处理过的问题。已确认的需求留在正文里，worker 能看到它。
    let released = doc.without_field("phi_discussion_hold");
    let released = Document::parse(&released)
        .ok_or_else(|| "invalid-task-file".to_string())?
        .without_field("phi_discussion_question");
    let doc = Document::parse(&released).ok_or("invalid-task-file")?;
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

/// 改归属人。只重写 `assignee` 一行。
///
/// 不动 `updated_date`：改的是「派给谁」，不是任务内容（与改排期同一条约定）。
/// 归属只影响派发，不该让看板以为这张卡被重写过一遍。
pub fn set_assignees(
    workspace: &Workspace,
    id: &str,
    assignees: &[String],
    expected_fingerprint: &str,
) -> Result<TaskDetail, String> {
    for value in assignees {
        ensure_single_line(value, "invalid-assignee")?;
        if value.trim().is_empty() {
            return Err("invalid-assignee".into());
        }
    }
    let path = find_file(workspace, id)?;
    let raw = read_to_string(&path)?;
    if fingerprint(&raw) != expected_fingerprint {
        return Err(STALE.into());
    }
    let doc = Document::parse(&raw).ok_or_else(|| "invalid-task-file".to_string())?;
    let rendered = inline_list(assignees);
    let next = doc.with_field("assignee", FieldValue::Raw(&rendered));
    write_atomic(&path, &next)?;
    read(workspace, id)
}

/// 续接哪一个 CLI 会话。`None` 表示取消，写回时把这个字段整个删掉。
///
/// 与改归属同一条约定：不动 `updated_date`，改的是「这活从哪接着干」，不是任务内容。
///
/// id 只放行 `[A-Za-z0-9._:-]` 且不超过 128 字：它会原样进命令行，一个带空白或引号的
/// 值会把后面的参数拆成两段。真正的「这个 id 是不是这个应用的会话」由 CLI 判断，
/// 派发失败会走现有的重试与转人工，不会静默换成新会话。
pub fn set_session(
    workspace: &Workspace,
    id: &str,
    session: Option<&str>,
    expected_fingerprint: &str,
) -> Result<TaskDetail, String> {
    let next = match session.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => {
            if !session_id_ok(value) {
                return Err("invalid-session".into());
            }
            Some(value.to_string())
        }
        None => None,
    };
    let path = find_file(workspace, id)?;
    let raw = read_to_string(&path)?;
    if fingerprint(&raw) != expected_fingerprint {
        return Err(STALE.into());
    }
    let doc = Document::parse(&raw).ok_or_else(|| "invalid-task-file".to_string())?;
    let text = match next.as_deref() {
        Some(value) => doc.with_field("session", FieldValue::Scalar(value)),
        None => doc.without_field("session"),
    };
    write_atomic(&path, &text)?;
    read(workspace, id)
}

/// CLI 会话 id 的字符集与长度。太宽松会让一个带空白的值把命令行拆坏。
/// 开头必须是字母或数字：`--resume` 这种写法字符集合法，放进命令行却会被当成开关。
pub fn session_id_ok(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    first.is_ascii_alphanumeric()
        && value.chars().count() <= 128
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':'))
}

/// 归档：把文件移到 `archive/tasks/`。上游的归档就是换目录，不改 frontmatter。
pub fn archive(workspace: &Workspace, id: &str, expected_fingerprint: &str) -> Result<(), String> {
    let path = find_file(workspace, id)?;
    let raw = read_to_string(&path)?;
    if fingerprint(&raw) != expected_fingerprint {
        return Err(STALE.into());
    }
    let doc = Document::parse(&raw).ok_or_else(|| "invalid-task-file".to_string())?;
    // 收起一张还在排期里的卡，等于让它静默停摆：调度器只扫 `backlog/tasks`，
    // 归档之后它再也不会被触发，而且不会有任何报错。
    if schedule_of(&doc).is_some() {
        return Err("archive-scheduled".into());
    }
    // 被下游依赖的卡一旦归档，下游会永久卡在 `blocked-by` 上——看板上只显示
    // 依赖编号，没人知道那是归档造成的。
    let archived_id = doc.string("id").unwrap_or_default();
    let depended = list(workspace)?.into_iter().any(|other| {
        !other.id.eq_ignore_ascii_case(&archived_id)
            && other
                .dependencies
                .iter()
                .any(|dependency| dependency.trim().eq_ignore_ascii_case(&archived_id))
    });
    if depended {
        return Err("archive-has-dependents".into());
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
    fn assignees_are_rewritten_inline_and_leave_the_date_alone() {
        let (_temp, workspace) = workspace();
        write_task(&workspace, "task-1 - First-task.md", SAMPLE);
        let before = list(&workspace).expect("list")[0].clone();
        let detail = set_assignees(
            &workspace,
            "TASK-1",
            &["文档写手".to_string(), "@codex".to_string()],
            &before.fingerprint,
        )
        .expect("assign");

        assert_eq!(detail.task.assignees, vec!["文档写手", "@codex"]);
        // 改归属不是改内容：updated_date 不动，重试预算也就不会因为一次指派被清零。
        assert_eq!(detail.task.updated_date, before.updated_date);
        let raw =
            fs::read_to_string(workspace.tasks_dir().join("task-1 - First-task.md")).expect("read");
        assert!(raw.contains("assignee: [文档写手, '@codex']"), "{raw}");
        // 只动了那一行，正文逐字保留。
        assert!(raw.contains("## Description\n\nDo it."));
    }

    #[test]
    fn clearing_the_assignee_writes_an_empty_list() {
        let (_temp, workspace) = workspace();
        write_task(&workspace, "task-1 - First-task.md", SAMPLE);
        let before = list(&workspace).expect("list")[0].fingerprint.clone();
        let detail = set_assignees(&workspace, "TASK-1", &[], &before).expect("clear");
        assert!(detail.task.assignees.is_empty());
        let raw =
            fs::read_to_string(workspace.tasks_dir().join("task-1 - First-task.md")).expect("read");
        assert!(raw.contains("assignee: []"), "{raw}");
    }

    #[test]
    fn the_session_is_written_to_frontmatter_and_can_be_cleared() {
        let (_temp, workspace) = workspace();
        write_task(&workspace, "task-1 - First-task.md", SAMPLE);
        let before = list(&workspace).expect("list")[0].fingerprint.clone();
        let detail =
            set_session(&workspace, "TASK-1", Some("6f1c8f0e-33c4"), &before).expect("set");
        assert_eq!(detail.task.session.as_deref(), Some("6f1c8f0e-33c4"));
        // 与改归属同一条约定：改「从哪接着干」不算改任务内容。
        assert_eq!(detail.task.updated_date, None);
        let raw =
            fs::read_to_string(workspace.tasks_dir().join("task-1 - First-task.md")).expect("read");
        assert!(raw.contains("session: 6f1c8f0e-33c4"), "{raw}");

        // 取消时把字段删掉，而不是留一个空的 session 行——那读起来像设了个空会话。
        let cleared = set_session(&workspace, "TASK-1", None, &detail.task.fingerprint.clone())
            .expect("clear");
        assert_eq!(cleared.task.session, None);
        let raw =
            fs::read_to_string(workspace.tasks_dir().join("task-1 - First-task.md")).expect("read");
        assert!(!raw.contains("session:"), "{raw}");
    }

    #[test]
    fn a_session_id_must_survive_the_command_line() {
        let (_temp, workspace) = workspace();
        write_task(&workspace, "task-1 - First-task.md", SAMPLE);
        let before = list(&workspace).expect("list")[0].fingerprint.clone();
        // 空白会把后面的参数拆成新的一段；引号同理。保存时就拒，不留到派发。
        for bad in ["bad id", "x; rm -rf /", "--resume"] {
            assert_eq!(
                set_session(&workspace, "TASK-1", Some(bad), &before).expect_err("bad id"),
                "invalid-session",
                "{bad:?} 不该被写进卡片"
            );
        }
        // 合法的两家 id 都放行。
        assert!(session_id_ok("6f1c8f0e-33c4-4c3a-9a2f-2b7f0d6a1b55"));
        assert!(session_id_ok("ses_2ab31:run-1"));
        assert!(!session_id_ok(&"a".repeat(129)));
        assert!(!session_id_ok(""));
    }

    #[test]
    fn a_stale_fingerprint_blocks_assigning() {
        let (_temp, workspace) = workspace();
        write_task(&workspace, "task-1 - First-task.md", SAMPLE);
        let error = set_assignees(&workspace, "TASK-1", &["x".into()], "stale").expect_err("stale");
        assert_eq!(error, STALE);
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

    fn discussion_card(workspace: &Workspace) -> TaskDetail {
        write_task(workspace, "task-1 - First-task.md", SAMPLE);
        let print = list(workspace).expect("list")[0].fingerprint.clone();
        to_discussion(workspace, "TASK-1", &print).expect("convert")
    }

    #[test]
    fn a_pending_task_can_become_a_discussion_card() {
        let (_temp, workspace) = workspace();
        let card = discussion_card(&workspace);

        assert_eq!(card.task.kind, KIND_DISCUSSION);
        assert!(card.task.discussion_hold, "讨论卡不该参与派发");
        // 转换只改类型：标题与正文不动，讨论从这张卡本身开始。
        assert_eq!(card.task.title, list(&workspace).expect("list")[0].title);
        assert!(card.body.contains("Do it."));
    }

    #[test]
    fn a_running_task_cannot_become_a_discussion_card() {
        let (_temp, workspace) = workspace();
        write_task(&workspace, "task-1 - First-task.md", SAMPLE);
        let print = list(&workspace).expect("list")[0].fingerprint.clone();
        set_status(&workspace, "TASK-1", "In Progress", &print).expect("move");
        let print = read(&workspace, "TASK-1").expect("read").task.fingerprint;

        assert_eq!(
            to_discussion(&workspace, "TASK-1", &print).expect_err("running"),
            "discussion-not-pending"
        );
    }

    #[test]
    fn only_a_discussion_card_can_be_discussed() {
        let (_temp, workspace) = workspace();
        write_task(&workspace, "task-1 - First-task.md", SAMPLE);
        let print = list(&workspace).expect("list")[0].fingerprint.clone();

        let error = discuss(&workspace, "TASK-1", &print, Some("A?"), None)
            .expect_err("ordinary pending card");
        assert_eq!(error, "not-a-discussion");
    }

    #[test]
    fn discussion_writes_the_question_and_the_confirmed_part_back() {
        let (_temp, workspace) = workspace();
        let card = discussion_card(&workspace);

        let detail = discuss(
            &workspace,
            "TASK-1",
            &card.task.fingerprint,
            Some("默认看最近 5 条，还是按日期分组？"),
            Some("其他列不动"),
        )
        .expect("discuss");

        assert!(detail.task.discussion_hold);
        assert_eq!(
            detail.task.discussion_question.as_deref(),
            Some("默认看最近 5 条，还是按日期分组？")
        );
        assert_eq!(detail.confirmed.as_deref(), Some("其他列不动"));
        // 已确认的需求有它自己的位置，不在过程记录段里再列一遍
        assert!(detail
            .sections
            .iter()
            .all(|item| item.title != "已确认需求"));
    }

    #[test]
    fn a_second_round_replaces_the_confirmed_part_instead_of_stacking_it() {
        let (_temp, workspace) = workspace();
        let card = discussion_card(&workspace);
        let first = discuss(
            &workspace,
            "TASK-1",
            &card.task.fingerprint,
            None,
            Some("先看倒序"),
        )
        .expect("first round");

        // 第二轮只改结论、不动问题：卡片里应该只有最后确认的那一版
        let second = discuss(
            &workspace,
            "TASK-1",
            &first.task.fingerprint,
            None,
            Some("倒序 + 只留最近 5 条"),
        )
        .expect("second round");

        assert_eq!(second.confirmed.as_deref(), Some("倒序 + 只留最近 5 条"));
        assert_eq!(second.body.matches("## 已确认需求").count(), 1);
    }

    #[test]
    fn a_question_must_stay_on_one_line() {
        let (_temp, workspace) = workspace();
        let card = discussion_card(&workspace);
        let error = discuss(
            &workspace,
            "TASK-1",
            &card.task.fingerprint,
            Some("A\nB"),
            None,
        )
        .expect_err("multi-line");
        assert_eq!(error, "invalid-discussion-question");
    }

    #[test]
    fn leaving_the_pending_column_ends_the_discussion() {
        let (_temp, workspace) = workspace();
        let card = discussion_card(&workspace);
        let error = discuss(
            &workspace,
            "TASK-1",
            &card.task.fingerprint,
            Some("A?"),
            None,
        )
        .expect("discuss");

        // 拖离待办是最短一次类型转换：讨论卡变成执行卡，因此不能再讨论。
        let moved =
            set_status(&workspace, "TASK-1", "In Progress", &error.task.fingerprint).expect("move");
        assert_eq!(moved.task.kind, "task");

        let error = discuss(
            &workspace,
            "TASK-1",
            &moved.task.fingerprint,
            Some("还想聊？"),
            None,
        )
        .expect_err("started");
        assert_eq!(error, "not-a-discussion");
    }

    #[test]
    fn leaving_the_pending_column_releases_the_discussion() {
        let (_temp, workspace) = workspace();
        let card = discussion_card(&workspace);
        let talking = discuss(
            &workspace,
            "TASK-1",
            &card.task.fingerprint,
            Some("A 还是 B？"),
            Some("其他列不动"),
        )
        .expect("discuss");

        let moved = set_status(
            &workspace,
            "TASK-1",
            "In Progress",
            &talking.task.fingerprint,
        )
        .expect("move");

        assert!(!moved.task.discussion_hold);
        assert_eq!(moved.task.discussion_question, None);
        // 已确认的需求跟着卡片走：worker 开工时要用到它
        assert_eq!(moved.confirmed.as_deref(), Some("其他列不动"));
    }

    const DONE_SAMPLE: &str = "---\nid: TASK-1\ntitle: 看板改版\nstatus: Done\nassignee: []\ncreated_date: '2026-11-01 09:00'\nlabels: []\ndependencies: []\n---\n\n## Description\n\n完成的任务多了很难找到刚跑完的结果。\n\n## Acceptance Criteria\n\n- [x] 倒序\n- [x] 默认 5 条\n\n## 结果\n\nDone 列改成紧凑行，13 张缩到半屏。\n\n## 已确认需求\n\n其他列不动。\n";

    fn derive_discussion(workspace: &Workspace, note: &str) -> TaskDetail {
        discussion_derive(workspace, "TASK-1", note).expect("derive")
    }

    #[test]
    fn a_finished_card_derives_a_discussion_without_moving_itself() {
        let (_temp, workspace) = workspace();
        write_task(&workspace, "task-1 - 看板改版.md", DONE_SAMPLE);

        let discussion = derive_discussion(&workspace, "验收条件要不要改？");

        assert_eq!(discussion.task.kind, KIND_DISCUSSION);
        assert_eq!(discussion.task.source_task.as_deref(), Some("TASK-1"));
        assert_eq!(discussion.task.round, Some(1));
        assert!(discussion.task.discussion_hold, "讨论卡不该参与派发");
        assert_eq!(
            discussion.task.status, workspace.config.default_status,
            "新讨论卡落在待办列"
        );
        // 用户这一轮写的话原样进了新卡，不是被折叠成的摘要
        assert!(discussion.body.contains("验收条件要不要改？"));
        assert_eq!(
            discussion.task.discussion_question.as_deref(),
            Some("验收条件要不要改？")
        );

        // 原卡一点没动：仍是 Done，结束与结论保持原样
        let source = read(&workspace, "TASK-1").expect("source");
        assert_eq!(source.task.status, "Done");
        assert_eq!(source.confirmed.as_deref(), Some("其他列不动。"));
        assert_eq!(source.task.kind, KIND_TASK);
        // 反向引用：从原卡能看到派生出去的那一轮
        assert_eq!(source.derived.len(), 1);
        assert_eq!(source.derived[0].id, discussion.task.id);
        assert_eq!(source.derived[0].round, Some(1));
    }

    #[test]
    fn the_background_carries_conclusions_not_the_command_log() {
        let (_temp, workspace) = workspace();
        write_task(&workspace, "task-1 - 看板改版.md", DONE_SAMPLE);

        let discussion = derive_discussion(&workspace, "要不要改验收？");

        // 带的是下一步要定什么：目标、验收、结果摘要、上一轮结论
        assert!(discussion
            .body
            .contains("完成的任务多了很难找到刚跑完的结果"));
        assert!(discussion.body.contains("默认 5 条"));
        assert!(discussion.body.contains("13 张缩到半屏"));
        assert!(discussion.body.contains("其他列不动"));
        // 背景与本轮输入分两段：前者是上一轮的事实，后者是用户这一轮说的话
        assert!(discussion.body.contains("## 讨论背景"));
        assert!(discussion.body.contains("## 本轮讨论"));
    }

    #[test]
    fn only_a_finished_card_can_be_rediscussed() {
        let (_temp, workspace) = workspace();
        write_task(&workspace, "task-1 - First-task.md", SAMPLE);
        // 待办卡直接派生讨论，等于让两份结论对同一件未完成的事同时生效
        assert_eq!(
            discussion_derive(&workspace, "TASK-1", "起步就谈？").expect_err("pending"),
            "discussion-source-not-done"
        );
        assert_eq!(
            discussion_derive(&workspace, "TASK-1", "   ").expect_err("blank"),
            "empty-discussion-note"
        );
    }

    #[test]
    fn every_round_gets_its_own_card_and_number() {
        let (_temp, workspace) = workspace();
        write_task(&workspace, "task-1 - 看板改版.md", DONE_SAMPLE);

        let first = derive_discussion(&workspace, "第一轮：要不要改验收？");
        let second = derive_discussion(&workspace, "第二轮：默认 5 条还是分组？");

        assert_eq!(first.task.round, Some(1));
        assert_eq!(second.task.round, Some(2));
        assert_ne!(first.task.id, second.task.id);
        // 两轮互不干扰：第二张不会把第一张的结论覆盖掉
        let source = read(&workspace, "TASK-1").expect("source");
        assert_eq!(source.derived.len(), 2);
        assert_eq!(
            source
                .derived
                .iter()
                .map(|item| item.round)
                .collect::<Vec<_>>(),
            vec![Some(1), Some(2)]
        );
    }

    #[test]
    fn a_discussion_card_becomes_an_execution_card_when_it_leaves_pending() {
        let (_temp, workspace) = workspace();
        write_task(&workspace, "task-1 - 看板改版.md", DONE_SAMPLE);
        let discussion = derive_discussion(&workspace, "结论：只留最近 5 条");
        let confirmed = discuss(
            &workspace,
            &discussion.task.id,
            &discussion.task.fingerprint,
            None,
            Some("其他列不动，只留最近 5 条"),
        )
        .expect("confirm");

        let started = set_status(
            &workspace,
            &discussion.task.id,
            "In Progress",
            &confirmed.task.fingerprint,
        )
        .expect("start");

        // 讨论结束＝类型转成执行卡；来源与轮次留着当出处，输入框随之关闭
        assert_eq!(started.task.kind, KIND_TASK);
        assert!(!started.task.discussion_hold);
        assert_eq!(started.task.discussion_question, None);
        assert_eq!(started.task.source_task.as_deref(), Some("TASK-1"));
        assert_eq!(started.task.round, Some(1));
        assert_eq!(
            started.confirmed.as_deref(),
            Some("其他列不动，只留最近 5 条")
        );
    }

    #[test]
    fn deleting_a_discussion_removes_the_card() {
        let (_temp, workspace) = workspace();
        write_task(&workspace, "task-1 - 看板改版.md", DONE_SAMPLE);
        let discussion = derive_discussion(&workspace, "随便问问");

        discard_discussion(
            &workspace,
            &discussion.task.id,
            &discussion.task.fingerprint,
        )
        .expect("discard");
        assert_eq!(read(&workspace, "TASK-1").expect("source").derived.len(), 0);
    }

    #[test]
    fn a_discussion_with_a_conclusion_can_still_be_deleted() {
        let (_temp, workspace) = workspace();
        write_task(&workspace, "task-1 - 看板改版.md", DONE_SAMPLE);
        let discussion = derive_discussion(&workspace, "定一下验收");
        let confirmed = discuss(
            &workspace,
            &discussion.task.id,
            &discussion.task.fingerprint,
            None,
            Some("验收改成两条"),
        )
        .expect("confirm");

        // 谈出结论但还没采纳的讨论，用户仍然可以把它删掉：确认框里已经说清会一起丢掉
        discard_discussion(&workspace, &confirmed.task.id, &confirmed.task.fingerprint)
            .expect("delete");
        assert_eq!(read(&workspace, "TASK-1").expect("source").derived.len(), 0);
        // 普通任务也不能被这个入口删掉
        assert_eq!(
            discard_discussion(
                &workspace,
                "TASK-1",
                &read(&workspace, "TASK-1").expect("read").task.fingerprint
            )
            .expect_err("not a discussion"),
            "not-a-discussion"
        );
    }

    #[test]
    fn archiving_refuses_a_scheduled_card() {
        let (_temp, workspace) = workspace();
        write_task(
            &workspace,
            "task-1 - First-task.md",
            &SAMPLE.replace("priority: high\n", "priority: high\nrecurrence: 2h\n"),
        );
        let print = list(&workspace).expect("list")[0].fingerprint.clone();
        assert_eq!(
            archive(&workspace, "TASK-1", &print).expect_err("scheduled"),
            "archive-scheduled"
        );
    }

    #[test]
    fn archiving_refuses_a_card_others_depend_on() {
        let (_temp, workspace) = workspace();
        write_task(&workspace, "task-1 - First-task.md", SAMPLE);
        write_task(
            &workspace,
            "task-2 - Depends-on-first.md",
            &SAMPLE
                .replace("id: TASK-1", "id: TASK-2")
                .replace("title: First task", "title: Second task")
                .replace("dependencies: []", "dependencies: ['TASK-1']"),
        );
        let print = list(&workspace)
            .expect("list")
            .into_iter()
            .find(|task| task.id == "TASK-1")
            .expect("first")
            .fingerprint;

        assert_eq!(
            archive(&workspace, "TASK-1", &print).expect_err("depended"),
            "archive-has-dependents"
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
