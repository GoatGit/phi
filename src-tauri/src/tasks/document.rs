//! `backlog/` 目录的结构与约定：配置、任务文件命名、ID 分配。
//!
//! 这里刻意只认 Backlog.md 已经公开的那套布局（`backlog/config.yml` +
//! `backlog/tasks/<prefix>-<n> - <slug>.md` + `backlog/archive/tasks/`），
//! 不自己发明文件名规则——名字一旦不一致，`backlog` CLI 就找不到任务。

use serde_yaml::Value;
use std::fs;
use std::path::{Path, PathBuf};

const DEFAULT_STATUSES: [&str; 3] = ["To Do", "In Progress", "Done"];

/// `backlog/config.yml` 里看板真正要用的那几项。其余字段不解析、原样留在文件里。
#[derive(Clone, Debug, PartialEq)]
pub struct Config {
    pub project_name: String,
    pub default_status: String,
    pub statuses: Vec<String>,
    pub task_prefix: String,
}

/// 一个打开的 backlog 工作区。`dir` 通常是 `<repo>/backlog`。
#[derive(Clone, Debug)]
pub struct Workspace {
    pub root: PathBuf,
    pub dir: PathBuf,
    pub config: Config,
}

fn yaml_scalar(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

fn lookup<'a>(map: &'a serde_yaml::Mapping, key: &str) -> Option<&'a Value> {
    map.get(Value::String(key.to_string()))
}

/// 解析 config.yml。缺失或写坏的字段用 Backlog.md 的默认值兜底。
pub fn parse_config(text: &str, fallback_name: &str) -> Config {
    let map = match serde_yaml::from_str::<Value>(text) {
        Ok(Value::Mapping(map)) => map,
        _ => serde_yaml::Mapping::new(),
    };

    let mut statuses: Vec<String> = lookup(&map, "statuses")
        .and_then(|value| match value {
            Value::Sequence(items) => Some(items.iter().filter_map(yaml_scalar).collect()),
            _ => None,
        })
        .unwrap_or_default();
    statuses.retain(|status| !status.trim().is_empty());
    let mut seen = std::collections::HashSet::new();
    statuses.retain(|status| seen.insert(status.clone()));
    if statuses.is_empty() {
        statuses = DEFAULT_STATUSES.iter().map(|s| s.to_string()).collect();
    }

    let default_status = lookup(&map, "default_status")
        .and_then(yaml_scalar)
        .filter(|status| statuses.contains(status))
        .unwrap_or_else(|| statuses[0].clone());

    let task_prefix = lookup(&map, "task_prefix")
        .and_then(yaml_scalar)
        .map(|prefix| prefix.trim().to_lowercase())
        .filter(|prefix| !prefix.is_empty())
        .unwrap_or_else(|| "task".to_string());

    let project_name = lookup(&map, "project_name")
        .and_then(yaml_scalar)
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| fallback_name.to_string());

    Config {
        project_name,
        default_status,
        statuses,
        task_prefix,
    }
}

/// 打开一个工作区。找不到 `config.yml` 时返回 `no-backlog`，由命令层翻译成人话。
pub fn open(root: &Path) -> Result<Workspace, String> {
    let root = root
        .canonicalize()
        .map_err(|_| "invalid-directory".to_string())?;
    if !root.is_dir() {
        return Err("invalid-directory".into());
    }
    let name = root_name(&root);

    for candidate in [root.join("backlog"), root.join(".backlog")] {
        if candidate.join("config.yml").is_file() {
            return Ok(workspace_at(root, candidate, name));
        }
    }

    // 自定义目录：`backlog.config.yml` 在仓库根，`backlog_directory` 指向真实目录
    for config_name in ["backlog.config.yml", "backlog.config.yaml"] {
        let config_path = root.join(config_name);
        if !config_path.is_file() {
            continue;
        }
        let text = fs::read_to_string(&config_path).map_err(|_| "no-backlog".to_string())?;
        let map = match serde_yaml::from_str::<Value>(&text) {
            Ok(Value::Mapping(map)) => map,
            _ => return Err("no-backlog".into()),
        };
        let directory = lookup(&map, "backlog_directory")
            .and_then(yaml_scalar)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "backlog".to_string());
        let dir = root.join(directory.trim());
        if !dir.is_dir() {
            return Err("no-backlog".into());
        }
        if dir.join("config.yml").is_file() {
            return Ok(workspace_at(root, dir, name));
        }
        // 只有根上的 config 文件也算数（上游允许这种布局）
        let config = parse_config(&text, &name);
        return Ok(Workspace { root, dir, config });
    }

    Err("no-backlog".into())
}

fn workspace_at(root: PathBuf, dir: PathBuf, fallback_name: String) -> Workspace {
    let config = fs::read_to_string(dir.join("config.yml"))
        .map(|text| parse_config(&text, &fallback_name))
        .unwrap_or_else(|_| parse_config("", &fallback_name));
    Workspace { root, dir, config }
}

fn root_name(root: &Path) -> String {
    root.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "backlog".to_string())
}

impl Workspace {
    pub fn tasks_dir(&self) -> PathBuf {
        self.dir.join("tasks")
    }

    pub fn archive_dir(&self) -> PathBuf {
        self.dir.join("archive").join("tasks")
    }

    /// 相对仓库根的路径，写进 DTO 让前端能显示/复制。
    pub fn relative(&self, path: &Path) -> String {
        path.strip_prefix(&self.root)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/")
    }
}

/// 初始化一个空的 backlog 目录（配置 + tasks + archive/tasks）。
///
/// 只保证 phi 自己能读写，也不写 AGENTS.md 之类的 agent 说明——那属于
/// `backlog init` 的职责，两边各管各的。
pub fn initialize(root: &Path, project_name: &str) -> Result<Workspace, String> {
    let root = root
        .canonicalize()
        .map_err(|_| "invalid-directory".to_string())?;
    if !root.is_dir() {
        return Err("invalid-directory".into());
    }
    let dir = root.join("backlog");
    fs::create_dir_all(dir.join("tasks")).map_err(|e| e.to_string())?;
    fs::create_dir_all(dir.join("archive").join("tasks")).map_err(|e| e.to_string())?;
    let config_path = dir.join("config.yml");
    if !config_path.is_file() {
        let name = if project_name.trim().is_empty() {
            root_name(&root)
        } else {
            project_name.trim().to_string()
        };
        fs::write(&config_path, default_config(&name)).map_err(|e| e.to_string())?;
    }
    open(&root)
}

fn default_config(project_name: &str) -> String {
    let escaped = project_name.replace('"', "'");
    format!(
        "project_name: \"{escaped}\"\ndefault_status: \"To Do\"\nstatuses: [\"To Do\", \"In Progress\", \"Done\"]\nlabels: []\ndate_format: yyyy-mm-dd hh:mm\ntask_prefix: \"task\"\n"
    )
}

/// 当前时间，格式与上游默认 `date_format: yyyy-mm-dd hh:mm` 一致。
pub fn timestamp() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M").to_string()
}

/// 任务 ID：`<PREFIX>-<n>`，大写显示、文件名小写（与上游一致）。
pub fn next_id(workspace: &Workspace) -> Result<String, String> {
    let prefix = workspace.config.task_prefix.to_lowercase();
    let mut max = 0u64;
    for name in read_task_file_names(&workspace.tasks_dir())? {
        if let Some(number) = id_number(&name, &prefix) {
            max = max.max(number);
        }
    }
    Ok(format!("{}-{}", prefix.to_uppercase(), max + 1))
}

fn read_task_file_names(dir: &Path) -> Result<Vec<String>, String> {
    let mut names = Vec::new();
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(names),
        Err(error) => return Err(error.to_string()),
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.to_lowercase().ends_with(".md") {
            names.push(name);
        }
    }
    Ok(names)
}

/// 从文件名里取任务号：`back-208 - xxx.md` → `208`。
pub fn id_number(file_name: &str, prefix: &str) -> Option<u64> {
    let stem = file_name.trim_end_matches(".md");
    let id_part = stem.split(" - ").next()?;
    let (file_prefix, number) = id_part.rsplit_once('-')?;
    if !file_prefix.eq_ignore_ascii_case(prefix) {
        return None;
    }
    number.parse::<u64>().ok()
}

/// 文件名里的 ID 部分：`BACK-208` → `BACK-208`；缺 frontmatter 时也能用。
pub fn id_from_file_name(file_name: &str) -> Option<String> {
    let stem = file_name.trim_end_matches(".md");
    let id_part = stem.split(" - ").next()?;
    if id_part.is_empty() || !id_part.contains('-') {
        return None;
    }
    Some(id_part.to_uppercase())
}

/// `<prefix>-<n> - <slug>.md`。slug 只去掉文件名非法字符，保留原始大小写。
pub fn file_name(id: &str, title: &str) -> String {
    format!("{} - {}.md", id.to_lowercase(), slug(title))
}

fn slug(title: &str) -> String {
    let mut result = String::with_capacity(title.len());
    for ch in title.chars() {
        match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\n' | '\r' | '\t' => {
                result.push(' ')
            }
            ch if ch.is_control() => result.push(' '),
            ch => result.push(ch),
        }
    }
    let collapsed = result.split_whitespace().collect::<Vec<_>>().join("-");
    let trimmed = collapsed.trim_matches('-');
    if trimmed.is_empty() {
        return "task".to_string();
    }
    // 长标题会撞上文件系统 255 字节上限，留出 ID 与扩展名的空间
    trimmed.chars().take(80).collect::<String>()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_config_with_defaults() {
        let config = parse_config(
            "project_name: \"phi\"\ndefault_status: \"To Do\"\nstatuses: [\"To Do\", \"In Progress\", \"Done\"]\ntask_prefix: \"back\"\n",
            "fallback",
        );
        assert_eq!(config.project_name, "phi");
        assert_eq!(config.default_status, "To Do");
        assert_eq!(config.statuses, vec!["To Do", "In Progress", "Done"]);
        assert_eq!(config.task_prefix, "back");
    }

    #[test]
    fn falls_back_when_config_is_partial() {
        let config = parse_config("project_name: phi\n", "fallback");
        assert_eq!(config.statuses, vec!["To Do", "In Progress", "Done"]);
        assert_eq!(config.default_status, "To Do");
        assert_eq!(config.task_prefix, "task");
        assert_eq!(config.project_name, "phi");
    }

    #[test]
    fn unknown_default_status_falls_back_to_first_column() {
        let config = parse_config(
            "statuses: [\"Todo\", \"Doing\"]\ndefault_status: \"Nope\"\n",
            "x",
        );
        assert_eq!(config.default_status, "Todo");
    }

    #[test]
    fn builds_upstream_style_file_names() {
        assert_eq!(
            file_name("BACK-208", "Add paste-as-markdown support in Web UI"),
            "back-208 - Add-paste-as-markdown-support-in-Web-UI.md"
        );
    }

    #[test]
    fn slug_strips_path_separators_and_empty_titles() {
        assert_eq!(file_name("TASK-1", "a/b:c"), "task-1 - a-b-c.md");
        assert_eq!(file_name("TASK-1", "   "), "task-1 - task.md");
    }

    #[test]
    fn reads_numbers_from_file_names() {
        assert_eq!(id_number("back-208 - x.md", "back"), Some(208));
        assert_eq!(id_number("back-208 - x.md", "task"), None);
        assert_eq!(id_number("notes.md", "back"), None);
        assert_eq!(
            id_from_file_name("back-208 - x.md").as_deref(),
            Some("BACK-208")
        );
    }

    #[test]
    fn initializes_layout_and_allocates_next_id() {
        let temp = tempfile::tempdir().expect("tempdir");
        let workspace = initialize(temp.path(), "phi").expect("init");
        assert_eq!(workspace.config.project_name, "phi");
        assert!(workspace.tasks_dir().is_dir());
        assert!(workspace.archive_dir().is_dir());
        assert_eq!(next_id(&workspace).expect("id"), "TASK-1");

        fs::write(
            workspace.tasks_dir().join("task-7 - seven.md"),
            "---\nid: TASK-7\n---\n",
        )
        .expect("write");
        assert_eq!(next_id(&workspace).expect("id"), "TASK-8");
    }

    #[test]
    fn opens_existing_backlog_and_custom_directory() {
        let temp = tempfile::tempdir().expect("tempdir");
        initialize(temp.path(), "demo").expect("init");
        assert!(open(temp.path()).is_ok());

        let custom = tempfile::tempdir().expect("tempdir");
        fs::create_dir_all(custom.path().join("plan/tasks")).expect("mkdir");
        fs::write(
            custom.path().join("plan/config.yml"),
            "project_name: plan\nstatuses: [\"A\", \"B\"]\n",
        )
        .expect("write");
        fs::write(
            custom.path().join("backlog.config.yml"),
            "backlog_directory: plan\n",
        )
        .expect("write");
        let workspace = open(custom.path()).expect("open");
        assert_eq!(workspace.config.statuses, vec!["A", "B"]);
        assert!(workspace.tasks_dir().ends_with("plan/tasks"));
    }

    #[test]
    fn rejects_directory_without_backlog() {
        let temp = tempfile::tempdir().expect("tempdir");
        assert_eq!(
            open(temp.path()).expect_err("should fail"),
            "no-backlog".to_string()
        );
    }
}
