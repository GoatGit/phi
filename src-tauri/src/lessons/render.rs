//! 判定与提炼：把失败事件写成一句人话，并按预算挑出要注入的那几条。
//!
//! 全程用固定模板，不调模型。模板的好处不只是省钱：措辞稳定，注入块才不会天天变，
//! prompt cache 的前缀才保得住。

use crate::lessons::detect::FailureEvent;
use crate::lessons::model::Lesson;
use crate::session_manager::model::ToolKind;
use chrono::{Local, TimeZone};

/// 注入块的字符预算（设计口径：全局 500 字）。
pub(crate) const BUDGET_CHARS: usize = 500;
/// 单条教训的字符上限：超了截断，省得一条就把预算吃光。
const LINE_MAX_CHARS: usize = 140;
const TITLE_MAX_CHARS: usize = 72;

/// 待写入的一条教训（还没进库）。
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Candidate {
    pub id: String,
    pub paths: Vec<String>,
    pub trigger: String,
    pub evidence: String,
    pub next_step: String,
}

pub(crate) fn candidate(event: &FailureEvent) -> Candidate {
    Candidate {
        id: lesson_id(&event.paths, &event.title),
        paths: event.paths.clone(),
        trigger: trigger_text(event.kind, &event.title, event.exit_code),
        evidence: format!(
            "{} 会话 {}（{}）",
            event.app,
            short_session(&event.session_id),
            date_of(event.ts)
        ),
        next_step: next_step(event.kind, &event.title),
    }
}

/// 现象：一句「哪一步炸了」。
fn trigger_text(kind: ToolKind, title: &str, exit_code: Option<i32>) -> String {
    let short = shorten(title, TITLE_MAX_CHARS);
    match kind {
        ToolKind::Shell => match exit_code {
            Some(code) if code != 0 => format!("`{short}` 退出码 {code}"),
            _ => format!("`{short}` 报告失败"),
        },
        ToolKind::Edit | ToolKind::Write => format!("改 `{short}` 时失败"),
        ToolKind::Search => format!("搜 `{short}` 时失败"),
        ToolKind::Read => format!("读 `{short}` 时失败"),
        _ => format!("`{short}` 失败"),
    }
}

fn looks_like_check(title: &str) -> bool {
    const WORDS: [&str; 8] = [
        "test", "check", "lint", "clippy", "build", "tsc", "verify", "typecheck",
    ];
    let lowered = title.to_lowercase();
    WORDS.iter().any(|word| lowered.contains(word))
}

/// 下次怎么做：只给能从失败本身推出来的建议，不编。
fn next_step(kind: ToolKind, title: &str) -> String {
    match kind {
        ToolKind::Shell if looks_like_check(title) => {
            format!(
                "下次：动手前先跑 `{}` 确认基线。",
                shorten(title, TITLE_MAX_CHARS)
            )
        }
        ToolKind::Shell => "下次：先只跑这一步看完整输出，再改代码。".to_string(),
        ToolKind::Edit | ToolKind::Write => format!(
            "下次：改 `{}` 前先读全文，并确认引用位置都已更新。",
            shorten(title, TITLE_MAX_CHARS)
        ),
        _ => "下次：重试前先读完整输出，别凭猜改。".to_string(),
    }
}

/// 教训 id：只由「路径 + 命令」决定，同一处失败换了个退出码仍然算同一条。
pub(crate) fn lesson_id(paths: &[String], title: &str) -> String {
    let seed = format!("{}|{}", paths.join(","), shorten(title, TITLE_MAX_CHARS));
    // FNV-1a：只要稳定，不求抗碰撞
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in seed.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{hash:016x}")
}

pub(crate) fn date_of(ts_ms: i64) -> String {
    Local
        .timestamp_millis_opt(ts_ms.max(0))
        .single()
        .map(|time| time.format("%Y-%m-%d").to_string())
        .unwrap_or_else(|| "---- -- --".to_string())
}

fn short_session(session_id: &str) -> String {
    session_id.chars().take(8).collect()
}

fn shorten(text: &str, max: usize) -> String {
    let cleaned = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if cleaned.chars().count() <= max {
        return cleaned;
    }
    let mut out: String = cleaned.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

fn char_len(text: &str) -> usize {
    text.chars().count()
}

/// 一条教训在注入块里的那一行。
fn line_for(lesson: &Lesson) -> String {
    let where_ = if lesson.paths.is_empty() {
        "（没能归因到具体文件）".to_string()
    } else {
        lesson
            .paths
            .iter()
            .map(|path| format!("`{path}`"))
            .collect::<Vec<_>>()
            .join("、")
    };
    let line = format!(
        "- [{}] {}：{} {}",
        date_of(lesson.first_seen),
        where_,
        lesson.trigger,
        lesson.next_step
    );
    if char_len(&line) <= LINE_MAX_CHARS {
        return line;
    }
    let mut out: String = line.chars().take(LINE_MAX_CHARS.saturating_sub(1)).collect();
    out.push('…');
    out
}

fn header(version: i64) -> String {
    format!("## 禁区清单 · lessons v{version}")
}

/// 按预算挑出要注入的教训：命中次数优先，其次最近性；渲染时仍按首次出现的顺序。
fn select(lessons: &[Lesson], budget: usize, version: i64) -> Vec<&Lesson> {
    let mut scored: Vec<(i64, i64, &Lesson)> = lessons
        .iter()
        .filter(|lesson| !lesson.dismissed)
        .map(|lesson| (lesson.hits, lesson.last_seen, lesson))
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));

    // 头部与标记本身也占预算，先扣掉
    let mut used = char_len(&header(version)) + 4;
    let mut picked: Vec<&Lesson> = Vec::new();
    for (_, _, lesson) in scored {
        if picked.len() >= 10 {
            break;
        }
        let cost = char_len(&line_for(lesson)) + 1;
        if used + cost > budget {
            continue;
        }
        used += cost;
        picked.push(lesson);
    }
    picked.sort_by_key(|lesson| lesson.first_seen);
    picked
}

/// 生成注入块（不含标记外的一切内容）。没有可注入的教训时返回空串。
pub(crate) fn render_block(lessons: &[Lesson], version: i64) -> String {
    let picked = select(lessons, BUDGET_CHARS, version);
    if picked.is_empty() {
        return String::new();
    }
    let mut out = String::new();
    out.push_str("<!-- phi:lessons:begin -->\n");
    out.push_str(&header(version));
    out.push_str("\n\n");
    out.push_str("以下是从失败会话里沉淀的禁区，动相关文件前先看这一条。\n\n");
    for lesson in picked {
        out.push_str(&line_for(lesson));
        out.push('\n');
    }
    out.push_str("<!-- phi:lessons:end -->");
    out
}

pub(crate) fn block_chars(block: &str) -> usize {
    char_len(block)
}

/// 阈一：路径命中。标签可以写成 `src/billing/**` 这种前缀形式。
pub(crate) fn matches(tag: &str, path: &str) -> bool {
    let tag = tag.trim().trim_start_matches("./");
    let path = path.trim().trim_start_matches("./");
    if tag.is_empty() {
        return false;
    }
    if tag == "**" {
        return true;
    }
    if let Some(prefix) = tag.strip_suffix("/**") {
        return path == prefix || path.starts_with(&format!("{prefix}/"));
    }
    path == tag || path.starts_with(&format!("{tag}/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(paths: &[&str], title: &str, exit_code: Option<i32>) -> FailureEvent {
        FailureEvent {
            app: "codex".into(),
            session_id: "abcdef1234567890".into(),
            ts: 1_760_000_000_000,
            kind: ToolKind::Shell,
            title: title.into(),
            exit_code,
            paths: paths.iter().map(|path| (*path).to_string()).collect(),
        }
    }

    fn lesson(id: &str, path: &str, hits: i64, first_seen: i64) -> Lesson {
        Lesson {
            id: id.into(),
            paths: vec![path.into()],
            trigger: format!("`cargo test` 退出码 1"),
            evidence: "codex 会话 abcdef12（2026-10-08）".into(),
            next_step: "下次：动手前先跑 `cargo test` 确认基线。".into(),
            hits,
            first_seen,
            last_seen: first_seen,
            apps: vec!["codex".into()],
            dismissed: false,
            dismiss_reason: None,
        }
    }

    #[test]
    fn templates_say_what_broke_and_what_to_do_next() {
        let candidate = candidate(&event(&["src/billing/invoice.rs"], "cargo test -- billing", Some(1)));
        assert_eq!(candidate.trigger, "`cargo test -- billing` 退出码 1");
        assert_eq!(
            candidate.next_step,
            "下次：动手前先跑 `cargo test -- billing` 确认基线。"
        );
        assert!(candidate.evidence.contains("codex 会话 abcdef12"));
        assert_eq!(candidate.paths, vec!["src/billing/invoice.rs"]);
    }

    #[test]
    fn the_same_file_and_command_always_map_to_the_same_lesson() {
        let a = lesson_id(&["src/a.rs".into()], "cargo test");
        let b = lesson_id(&["src/a.rs".into()], "cargo test");
        let c = lesson_id(&["src/b.rs".into()], "cargo test");
        assert_eq!(a, b);
        assert_ne!(a, c);
    }

    #[test]
    fn budget_limits_the_block_and_keeps_first_seen_order() {
        let lessons = vec![
            lesson("a", "src/a.rs", 1, 100),
            lesson("b", "src/b.rs", 9, 200),
            lesson("c", "src/c.rs", 5, 300),
        ];

        let block = render_block(&lessons, 1);
        assert!(block_chars(&block) <= BUDGET_CHARS);
        assert!(block.starts_with("<!-- phi:lessons:begin -->"));
        assert!(block.ends_with("<!-- phi:lessons:end -->"));
        // 渲染顺序按首次出现，而不是命中次数
        let a = block.find("src/a.rs").expect("a");
        let b = block.find("src/b.rs").expect("b");
        let c = block.find("src/c.rs").expect("c");
        assert!(a < b && b < c);
    }

    #[test]
    fn dismissed_lessons_never_reach_the_block() {
        let mut lessons = vec![lesson("a", "src/a.rs", 3, 100)];
        assert!(!render_block(&lessons, 1).is_empty());

        lessons[0].dismissed = true;
        lessons[0].dismiss_reason = Some("误报".into());
        assert!(render_block(&lessons, 1).is_empty());
    }

    #[test]
    fn path_tags_match_exactly_or_by_directory_prefix() {
        assert!(matches("src/billing/invoice.rs", "src/billing/invoice.rs"));
        assert!(matches("src/billing/**", "src/billing/invoice.rs"));
        assert!(matches("src/billing", "src/billing/invoice.rs"));
        assert!(!matches("src/billing/invoice.rs", "src/billing/credit.rs"));
        assert!(!matches("src/billing/**", "src/billings/x.rs"));
        assert!(matches("**", "anything.rs"));
    }
}
