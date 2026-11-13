//! Task markdown 的 frontmatter 读写。
//!
//! Backlog.md 把任务存成「`---` YAML 头 + markdown 正文」的纯文件，`backlog`
//! CLI 与其它 agent 会同时读写同一批文件。所以这里的原则是**只改受控字段，
//! 其余字节原样保留**：解析只用来读值，写回走按行的定点替换，不重新序列化
//! 整份 frontmatter，也不碰正文。重排 YAML 会让每一行都出现在 diff 里，还会
//! 丢掉我们没建模的字段（ordinal、milestone、自定义键）的原始写法。

use serde_yaml::Value;

/// 一个任务文件：字节偏移量记住 frontmatter 的位置，正文保持原样。
#[derive(Clone, Debug)]
pub struct Document {
    raw: String,
    /// 开头 `---` 行之后的位置
    inner_start: usize,
    /// 结束 `---` 行的起始位置
    inner_end: usize,
    /// 结束 `---` 行之后的位置
    body_start: usize,
}

/// 写回时允许替换的字段取值。目前只改标量（状态、更新时间）——列表字段
/// （assignee/labels）由用户或 agent 自己维护，phi 不替他们做决定。
#[derive(Clone, Copy, Debug)]
pub enum FieldValue<'a> {
    Scalar(&'a str),
    /// 已经渲染好的多行块：首行是 `key:`，其余行自带缩进。
    /// 写回时整块替换该键及其续行，仍然不重新序列化其它字段。
    Block(&'a str),
}

impl Document {
    /// 解析一份任务文件。没有合法 frontmatter 时返回 `None`。
    pub fn parse(raw: &str) -> Option<Self> {
        let mut offset = 0usize;
        let mut inner_start = None;
        let mut inner_end = None;
        let mut body_start = None;

        for line in raw.split_inclusive('\n') {
            let trimmed = line.trim_end_matches(['\n', '\r']);
            match inner_start {
                None => {
                    if offset != 0 || trimmed != "---" {
                        return None;
                    }
                    inner_start = Some(offset + line.len());
                }
                Some(_) => {
                    if trimmed == "---" {
                        inner_end = Some(offset);
                        body_start = Some(offset + line.len());
                        break;
                    }
                }
            }
            offset += line.len();
        }

        Some(Self {
            raw: raw.to_string(),
            inner_start: inner_start?,
            inner_end: inner_end?,
            body_start: body_start?,
        })
    }

    /// frontmatter 的内部文本（两条 `---` 之间）。
    pub fn frontmatter(&self) -> &str {
        &self.raw[self.inner_start..self.inner_end]
    }

    /// 正文（结束 `---` 行之后），包含开头那一两个空行。
    pub fn body(&self) -> &str {
        &self.raw[self.body_start..]
    }

    /// 解析后的 frontmatter；YAML 坏掉时当作空映射，读方不会因此整页失败。
    pub fn mapping(&self) -> serde_yaml::Mapping {
        match serde_yaml::from_str::<Value>(self.frontmatter()) {
            Ok(Value::Mapping(map)) => map,
            _ => serde_yaml::Mapping::new(),
        }
    }

    /// 取一个字符串字段。数值 / 布尔按文本返回，避免不同任务写法不一致。
    pub fn string(&self, key: &str) -> Option<String> {
        self.mapping()
            .get(Value::String(key.to_string()))
            .and_then(yaml_scalar)
    }

    /// 取一个列表字段。标量写法（`assignee: @codex`）也接受。
    pub fn list(&self, key: &str) -> Vec<String> {
        match self.mapping().get(Value::String(key.to_string())) {
            Some(Value::Sequence(items)) => items.iter().filter_map(yaml_scalar).collect(),
            Some(value) => yaml_scalar(value).into_iter().collect(),
            None => Vec::new(),
        }
    }

    /// 返回替换了一个字段后的完整文件内容。
    ///
    /// 只重写这个键所在的行（或它的缩进块），其它行逐字节保留。
    pub fn with_field(&self, key: &str, value: FieldValue<'_>) -> String {
        let inner = self.frontmatter();
        let fragment = render_field(key, value);
        let replaced = replace_lines(inner, key, &fragment);
        format!(
            "{}{}{}",
            &self.raw[..self.inner_start],
            replaced,
            &self.raw[self.inner_end..]
        )
    }
}

fn yaml_scalar(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(flag) => Some(flag.to_string()),
        _ => None,
    }
}

/// 把字段值序列化成 `key: ...` 的一行。
fn render_field(key: &str, value: FieldValue<'_>) -> String {
    match value {
        FieldValue::Scalar(text) => format!("{key}: {}", render_scalar(text)),
        FieldValue::Block(text) => text.to_string(),
    }
}

/// 用 YAML 自己的规则决定要不要加引号（`To Do` 不加，`2026-11-08 19:42` 会加）。
fn render_scalar(text: &str) -> String {
    let rendered = serde_yaml::to_string(&Value::String(text.to_string()))
        .unwrap_or_else(|_| format!("{text}\n"));
    rendered.trim_end_matches('\n').to_string()
}

/// 在 frontmatter 内部文本里替换一个键。
fn replace_lines(inner: &str, key: &str, fragment: &str) -> String {
    let lines: Vec<&str> = inner.split_inclusive('\n').collect();
    // Windows 仓库里的 frontmatter 是 CRLF，新写的行也跟着用 CRLF
    let eol = if inner.contains("\r\n") { "\r\n" } else { "\n" };
    let mut output = String::with_capacity(inner.len() + fragment.len());
    let mut replaced = false;
    let mut index = 0usize;

    while index < lines.len() {
        let line = lines[index];
        if !replaced && starts_with_key(line, key) {
            output.push_str(fragment);
            output.push_str(eol);
            index += 1;
            // 键的续行（缩进块或 `- ` 列表）一并吃掉，否则会留下孤儿值
            while index < lines.len() && is_continuation(lines[index]) {
                index += 1;
            }
            replaced = true;
            continue;
        }
        output.push_str(line);
        index += 1;
    }

    if replaced {
        return trim_to_original_tail(inner, output);
    }

    // 键不存在：追加到末尾，仍然保持原有的收尾换行习惯
    let mut appended = inner.to_string();
    if !appended.is_empty() && !appended.ends_with('\n') {
        appended.push_str(eol);
    }
    appended.push_str(fragment);
    if inner.ends_with('\n') || !inner.is_empty() {
        appended.push_str(eol);
    }
    appended
}

/// 原本 frontmatter 结尾没有换行时，替换后也不要多出来。
fn trim_to_original_tail(inner: &str, output: String) -> String {
    if inner.ends_with('\n') || !output.ends_with('\n') {
        return output;
    }
    output[..output.len() - 1].to_string()
}

fn starts_with_key(line: &str, key: &str) -> bool {
    line.starts_with(key) && line.as_bytes().get(key.len()) == Some(&b':')
}

fn is_continuation(line: &str) -> bool {
    let trimmed = line.trim_start_matches(['\n', '\r']);
    if trimmed.is_empty() {
        return false;
    }
    line.starts_with(' ') || line.starts_with('\t') || line.starts_with("- ")
}

/// 正文里的 `- [x] 文本` 验收项。
#[derive(Clone, Debug, PartialEq)]
pub struct AcceptanceLine {
    pub text: String,
    pub done: bool,
}

/// 抽出正文里的勾选项。代码块里的示例不参与（否则会虚增进度）。
pub fn acceptance(body: &str) -> Vec<AcceptanceLine> {
    let mut items = Vec::new();
    let mut in_fence = false;
    for line in body.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        let Some(rest) = trimmed.strip_prefix("- [") else {
            continue;
        };
        let mut chars = rest.chars();
        let done = match chars.next() {
            Some('x') | Some('X') => true,
            Some(' ') => false,
            _ => continue,
        };
        let Some(rest) = chars.next() else {
            continue;
        };
        if rest != ']' {
            continue;
        }
        let text = chars.as_str().trim();
        if text.is_empty() {
            continue;
        }
        items.push(AcceptanceLine {
            text: text.to_string(),
            done,
        });
    }
    items
}

/// 正文按 `## 标题` 切段，供详情页分块展示。
#[derive(Clone, Debug, PartialEq)]
pub struct BodySection {
    pub title: String,
    pub body: String,
}

pub fn sections(body: &str) -> Vec<BodySection> {
    let mut result: Vec<BodySection> = Vec::new();
    let mut current_title: Option<String> = None;
    let mut current_body = String::new();
    let mut in_fence = false;

    for line in body.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
        }
        if !in_fence && line.starts_with("## ") {
            if let Some(title) = current_title.take() {
                result.push(BodySection {
                    title,
                    body: current_body
                        .trim_start_matches(['\n', '\r'])
                        .trim_end()
                        .to_string(),
                });
            }
            current_title = Some(line[3..].trim().to_string());
            current_body.clear();
            continue;
        }
        if current_title.is_some() {
            current_body.push_str(line);
            current_body.push('\n');
        }
    }
    if let Some(title) = current_title {
        result.push(BodySection {
            title,
            body: current_body
                .trim_start_matches(['\n', '\r'])
                .trim_end()
                .to_string(),
        });
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "---\nid: BACK-208\ntitle: Add paste-as-markdown support in Web UI\nstatus: To Do\nassignee: []\ncreated_date: '2025-07-26'\nlabels:\n  - web-ui\n  - markdown\ndependencies: []\npriority: medium\n---\n\n## Description\n\nPaste rich text.\n\n## Acceptance Criteria\n\n- [x] One\n- [ ] Two\n";

    fn parsed() -> Document {
        Document::parse(SAMPLE).expect("frontmatter")
    }

    #[test]
    fn reads_known_fields() {
        let doc = parsed();
        assert_eq!(doc.string("id").as_deref(), Some("BACK-208"));
        assert_eq!(doc.string("status").as_deref(), Some("To Do"));
        assert_eq!(doc.list("labels"), vec!["web-ui", "markdown"]);
        assert!(doc.list("assignee").is_empty());
        assert_eq!(doc.string("priority").as_deref(), Some("medium"));
    }

    #[test]
    fn body_starts_after_closing_fence() {
        let doc = parsed();
        assert!(doc.body().starts_with("\n## Description"));
        assert!(doc.body().contains("Paste rich text."));
    }

    #[test]
    fn replaces_only_the_target_line() {
        let doc = parsed();
        let next = doc.with_field("status", FieldValue::Scalar("In Progress"));
        assert!(next.contains("status: In Progress\n"));
        // 其它字段逐字节不动，包括缩进列表和带引号的日期
        assert!(next.contains("created_date: '2025-07-26'\n"));
        assert!(next.contains("labels:\n  - web-ui\n  - markdown\n"));
        assert!(next.ends_with("## Acceptance Criteria\n\n- [x] One\n- [ ] Two\n"));
        assert_eq!(next.replace("status: In Progress", "status: To Do"), SAMPLE);
    }

    #[test]
    fn replaces_scalar_without_touching_block_list() {
        let doc = parsed();
        let next = doc.with_field("priority", FieldValue::Scalar("high"));
        assert!(next.contains("priority: high\n"));
        // 列表字段保持原样（块式写法一个字节都不动）
        assert!(next.contains("labels:\n  - web-ui\n  - markdown\n"));
    }

    #[test]
    fn appends_missing_field() {
        let doc = Document::parse("---\nid: BACK-1\nstatus: To Do\n---\n\nbody\n").expect("doc");
        let next = doc.with_field("updated_date", FieldValue::Scalar("2026-11-08 19:42"));
        assert!(next.starts_with("---\nid: BACK-1\nstatus: To Do\nupdated_date: "));
        assert!(next.ends_with("---\n\nbody\n"));
        // 读回来仍然是字符串，没被当成时间戳
        let parsed = Document::parse(&next).expect("doc");
        assert_eq!(
            parsed.string("updated_date").as_deref(),
            Some("2026-11-08 19:42")
        );
        assert_eq!(parsed.string("status").as_deref(), Some("To Do"));
    }

    #[test]
    fn keeps_crlf_line_endings() {
        let doc = Document::parse("---\r\nid: TASK-1\r\nstatus: To Do\r\n---\r\n\r\nbody\r\n")
            .expect("doc");
        let next = doc.with_field("status", FieldValue::Scalar("Done"));
        assert_eq!(
            next,
            "---\r\nid: TASK-1\r\nstatus: Done\r\n---\r\n\r\nbody\r\n"
        );
    }

    #[test]
    fn rejects_missing_closing_fence() {
        let doc = Document::parse("---\nid: BACK-1,\nstatus: To Do---\n\nbody\n");
        // 缺结束行的文件不是合法任务文件
        assert!(doc.is_none());
    }

    #[test]
    fn parses_acceptance_ignoring_code_fences() {
        let body = "## Acceptance Criteria\n\n- [x] done\n- [ ] todo\n\n```\n- [ ] sample\n```\n- [X] upper\n";
        let items = acceptance(body);
        assert_eq!(items.len(), 3);
        assert!(items[0].done);
        assert!(!items[1].done);
        assert_eq!(items[2].text, "upper");
    }

    #[test]
    fn splits_sections() {
        let sections = sections("## Description\n\nA\n\n## Acceptance Criteria\n\n- [ ] B\n");
        assert_eq!(sections.len(), 2);
        assert_eq!(sections[0].title, "Description");
        assert_eq!(sections[0].body, "A");
        assert_eq!(sections[1].title, "Acceptance Criteria");
        assert_eq!(sections[1].body, "- [ ] B");
    }

    #[test]
    fn rejects_text_without_frontmatter() {
        assert!(Document::parse("## Description\n").is_none());
        assert!(Document::parse("---\nid: BACK-1\n").is_none());
    }
}
