//! 讨论回复里的结构化表单。
//!
//! Router 有时需要在同一条回复里问两三个具体取值（「从哪取」「写到哪」）。
//! 让用户对着一段散文再手打一遍，等于把问题抄进输入框；所以回复里可以带一块
//! 围栏代码：
//!
//! ````text
//! ```phi-form
//! {"title":"还需要你定两件事","fields":[
//!   {"id":"source","label":"新闻从哪里取？","type":"text"},
//!   {"id":"target","label":"整理结果写到哪","type":"choice","options":["追加到这张卡","单独一个文件"]}
//! ]}
//! ```
//! ````
//!
//! 解析放在这里而不是前端：模型写歪了的东西不该原样进界面，字段类型、选项、
//! 长度都要有一道确定的收敛。解析结果只用于显示——卡片上的结论仍然只认
//! [`crate::super_agent::discussion::parse_conclusion`] 那两行固定标记。
//!
//! 存库的仍然是模型的原始回复，读出来时才切分（`text` 去掉表单块，`form` 单独给
//! 前端）。这样老库不用迁移，解析规则改了也会对历史记录一起生效。

use crate::tasks::model::{DiscussionForm, DiscussionFormField};

/// 围栏的开头。后面允许跟空格或语言说明，但必须紧接换行才开始 JSON。
const OPEN: &str = "```phi-form";

const MAX_FIELDS: usize = 6;
const MAX_LABEL: usize = 200;
const MAX_TITLE: usize = 200;
const MAX_PLACEHOLDER: usize = 120;
const MAX_OPTION: usize = 120;
const MAX_OPTIONS: usize = 5;

/// 把一段回复切成「给人看的文字」和「可填写的表单」。
///
/// 所有 `phi-form` 块都从文字里摘掉（模型偶尔会重复给两块），表单只取第一块
/// 能解析出来的。解析不出来就只当它是普通代码块，用户至少还能看到原文。
pub(crate) fn take(reply: &str) -> (String, Option<DiscussionForm>) {
    let mut text = String::new();
    let mut form = None;
    let mut rest = reply;

    while let Some(start) = rest.find(OPEN) {
        text.push_str(&rest[..start]);
        let after_open = &rest[start + OPEN.len()..];
        // 开头这一行只允许空白或语言说明，JSON 从下一行开始。
        let Some(line_end) = after_open.find('\n') else {
            text.push_str(&rest[start..]);
            rest = "";
            break;
        };
        if !after_open[..line_end].trim().is_empty() {
            // ```phi-formx 这种不是我们的块：原样保留，继续往后找。
            text.push_str(&rest[start..start + OPEN.len()]);
            rest = &rest[start + OPEN.len()..];
            continue;
        }
        let body = &after_open[line_end + 1..];
        let Some(end) = body.find("```") else {
            // 没有闭合的围栏：不猜，整段留成文字。
            text.push_str(&rest[start..]);
            rest = "";
            break;
        };
        let consumed = OPEN.len() + line_end + 1 + end + 3;
        match parse(body[..end].trim()) {
            Some(found) => {
                if form.is_none() {
                    form = Some(found);
                }
            }
            // 写歪的块不吞掉：用户至少还能看到 Router 原本写的那段。
            None if form.is_none() => text.push_str(&rest[start..start + consumed]),
            None => {}
        }
        rest = &body[end + 3..];
    }

    text.push_str(rest);
    (tidy(&text), form)
}

/// 只去掉表单块，留下文字。结论解析用它：结论两行不能读进 JSON 里的括号。
pub(crate) fn without_blocks(reply: &str) -> String {
    take(reply).0
}

/// 空行收成一空行，行尾空白去掉，首尾不留空行。
fn tidy(text: &str) -> String {
    let mut out = String::new();
    let mut blank = false;
    for line in text.lines() {
        if line.trim().is_empty() {
            blank = !out.is_empty();
            continue;
        }
        if !out.is_empty() {
            out.push('\n');
            if blank {
                out.push('\n');
            }
        }
        blank = false;
        out.push_str(line.trim_end());
    }
    out
}

fn parse(raw: &str) -> Option<DiscussionForm> {
    let value: serde_json::Value = serde_json::from_str(raw).ok()?;
    let (title, fields) = match &value {
        serde_json::Value::Array(items) => (None, items.clone()),
        serde_json::Value::Object(object) => (
            object
                .get("title")
                .and_then(text_value)
                .map(|title| clip(title.trim(), MAX_TITLE))
                .filter(|title| !title.is_empty()),
            object
                .get("fields")
                .and_then(|value| value.as_array())
                .cloned()
                .unwrap_or_default(),
        ),
        _ => return None,
    };

    let mut seen = std::collections::HashSet::new();
    let mut parsed = Vec::new();
    for (index, item) in fields.iter().take(MAX_FIELDS).enumerate() {
        let Some(mut field) = parse_field(item, index) else {
            continue;
        };
        // id 是提交时拼消息用的键；重复会让人填一项、另一项跟着变。
        let mut id = field.id.clone();
        let mut suffix = 2;
        while !seen.insert(id.clone()) {
            id = format!("{}-{suffix}", field.id);
            suffix += 1;
        }
        field.id = id;
        parsed.push(field);
    }

    if parsed.is_empty() {
        return None;
    }
    Some(DiscussionForm {
        title,
        fields: parsed,
    })
}

fn parse_field(value: &serde_json::Value, index: usize) -> Option<DiscussionFormField> {
    let object = value.as_object()?;
    let label = clip(object.get("label").and_then(text_value)?.trim(), MAX_LABEL);
    if label.is_empty() {
        return None;
    }

    let id = object
        .get("id")
        .and_then(text_value)
        .map(|raw| sanitize_id(&raw))
        .filter(|id| !id.is_empty())
        .unwrap_or_else(|| format!("f{}", index + 1));

    let options: Vec<String> = object
        .get("options")
        .and_then(|value| value.as_array())
        .map(|items| {
            let mut seen = std::collections::HashSet::new();
            items
                .iter()
                .filter_map(text_value)
                .map(|item| clip(item.trim(), MAX_OPTION))
                .filter(|item| !item.is_empty())
                // 同一个选项写两遍在前端就是两个同值的下拉项：既会警告，也只
                // 实际上留下一种选择。去重之后再看够不够两项，别把「重复两次」
                // 当成「有两个选项」。
                .filter(|item| seen.insert(item.clone()))
                .take(MAX_OPTIONS)
                .collect()
        })
        .unwrap_or_default();

    let declared = object
        .get("type")
        .and_then(text_value)
        .unwrap_or_default()
        .to_ascii_lowercase();
    let wants_choice = matches!(declared.as_str(), "choice" | "select" | "single");
    // 选项不足两个的下拉框没法选，降级成一行文本而不是给一个空下拉。
    let (kind, options) = if wants_choice && options.len() >= 2 {
        ("choice", options)
    } else {
        ("text", Vec::new())
    };

    let placeholder = object
        .get("placeholder")
        .and_then(text_value)
        .map(|text| clip(text.trim(), MAX_PLACEHOLDER))
        .filter(|text| !text.is_empty());

    Some(DiscussionFormField {
        id,
        label,
        kind: kind.to_string(),
        placeholder,
        options,
        required: object
            .get("required")
            .and_then(|value| value.as_bool())
            .unwrap_or(true),
    })
}

fn text_value(value: &serde_json::Value) -> Option<String> {
    value.as_str().map(str::to_string)
}

/// id 只留能安全拼进 HTML 与消息里的字符，避免前端拿它当选择器时出岔子。
fn sanitize_id(raw: &str) -> String {
    raw.trim()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
        .take(32)
        .collect()
}

fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    text.chars().take(max).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_form_block_becomes_structure_and_leaves_the_prose_alone() {
        let reply = "做法 A 更稳，但缺两个信息。\n\n\
```phi-form\n\
{\"title\":\"还需要你定两件事\",\"fields\":[\
{\"id\":\"source\",\"label\":\"新闻从哪里取？\",\"type\":\"text\",\"placeholder\":\"订阅源 / 目录\"},\
{\"id\":\"target\",\"label\":\"整理结果写到哪\",\"type\":\"choice\",\"options\":[\"追加到这张卡\",\"单独一个文件\"]}]}\n\
```\n\n\
【还没定的问题】新闻从哪里取？\n【已确认的需求】无\n";

        let (text, form) = take(reply);
        let form = form.expect("form");

        assert_eq!(form.title.as_deref(), Some("还需要你定两件事"));
        assert_eq!(form.fields.len(), 2);
        assert_eq!(form.fields[0].kind, "text");
        assert_eq!(form.fields[0].placeholder.as_deref(), Some("订阅源 / 目录"));
        assert_eq!(form.fields[1].kind, "choice");
        assert_eq!(form.fields[1].options, ["追加到这张卡", "单独一个文件"]);
        assert!(form.fields[1].required);

        // 正文里不能留下 JSON 与围栏：用户看到的是话，不是协议
        assert!(!text.contains("phi-form"));
        assert!(!text.contains("source"));
        assert!(text.starts_with("做法 A 更稳"));
        assert!(text.ends_with("【已确认的需求】无"));
        // 摘掉块之后不留下三连空行
        assert!(!text.contains("\n\n\n"));
    }

    #[test]
    fn a_broken_block_leaves_the_text_as_written() {
        // 解析不出来时不能把内容吞掉：用户至少还能看到 Router 写了什么。
        let broken = "先说结论。\n```phi-form\n{不是 JSON}\n```\n结束。";
        let (text, form) = take(broken);
        assert!(form.is_none());
        assert!(text.contains("{不是 JSON}"));

        let unclosed = "先说结论。\n```phi-form\n{\"fields\":[]}";
        let (text, form) = take(unclosed);
        assert!(form.is_none());
        assert!(text.contains("```phi-form"));
    }

    #[test]
    fn a_choice_without_options_degrades_to_text() {
        let reply = "```phi-form\n{\"fields\":[{\"label\":\"到哪\",\"type\":\"choice\",\"options\":[\"只有一个\"]}]}\n```";
        let (_, form) = take(reply);
        let form = form.expect("form");
        assert_eq!(form.fields[0].kind, "text");
        assert!(form.fields[0].options.is_empty());
    }

    #[test]
    fn a_choice_with_repeated_options_is_deduplicated_before_counting() {
        // 同一个选项写两遍不是「两个选项」：去重后只剩一项，只能降级成文本。
        let reply = "```phi-form\n{\"fields\":[{\"label\":\"写到哪\",\"type\":\"choice\",\"options\":[\"这张卡\",\"这张卡\"]}]}\n```";
        let (_, form) = take(reply);
        let form = form.expect("form");
        assert_eq!(form.fields[0].kind, "text");
        assert!(form.fields[0].options.is_empty());

        // 有重复也有不同项时，保留下拉但每个选项只出现一次。
        let reply = "```phi-form\n{\"fields\":[{\"label\":\"写到哪\",\"type\":\"choice\",\"options\":[\"这张卡\",\"单独一个文件\",\"这张卡\"]}]}\n```";
        let (_, form) = take(reply);
        let form = form.expect("form");
        assert_eq!(form.fields[0].kind, "choice");
        assert_eq!(form.fields[0].options, ["这张卡", "单独一个文件"]);
    }

    #[test]
    fn fields_are_capped_and_ids_stay_unique() {
        let fields: Vec<String> = (0..10)
            .map(|index| format!("{{\"id\":\"same\",\"label\":\"问题 {index}\"}}"))
            .collect();
        let reply = format!("```phi-form\n{{\"fields\":[{}]}}\n```", fields.join(","));

        let (_, form) = take(&reply);
        let form = form.expect("form");
        assert_eq!(form.fields.len(), MAX_FIELDS);
        // 同一个 id 出现两次时，后面那个必须换个键，否则填一项两项一起变
        assert_eq!(form.fields[0].id, "same");
        assert_eq!(form.fields[1].id, "same-2");
        assert_eq!(form.fields[2].id, "same-3");
    }

    #[test]
    fn only_the_first_form_is_kept_and_every_block_is_stripped() {
        let reply = "A\n```phi-form\n{\"fields\":[{\"label\":\"一\"}]}\n```\n\
B\n```phi-form\n{\"fields\":[{\"label\":\"二\"}]}\n```\nC";
        let (text, form) = take(reply);
        let form = form.expect("form");
        assert_eq!(form.fields[0].label, "一");
        assert_eq!(text, "A\n\nB\n\nC");
    }

    #[test]
    fn without_blocks_keeps_the_conclusion_lines_readable() {
        let reply = "```phi-form\n{\"fields\":[{\"label\":\"【还没定的问题】假的\"}]}\n```\n\
【还没定的问题】真的那一句\n【已确认的需求】\n- 只改待办列";
        assert_eq!(
            without_blocks(reply),
            "【还没定的问题】真的那一句\n【已确认的需求】\n- 只改待办列"
        );
    }

    #[test]
    fn an_id_with_unsafe_characters_is_stripped() {
        let reply = "```phi-form\n{\"fields\":[{\"id\":\"a b\\\"c<d>\",\"label\":\"问\"}]}\n```";
        let (_, form) = take(reply);
        assert_eq!(form.expect("form").fields[0].id, "abcd");
    }
}
