//! 交接单：把「上次跑到哪、改了哪些文件、验证过什么、下一步是什么」写成一段
//! 人和 agent 都读得懂的文字，随续跑的会话一起带进去。
//!
//! 只写事实，不写猜测：没有 git 就没有「已改文件」这一节，别编。

use super::classify::FailureKind;
use super::{MAX_HANDOFF_EVIDENCE, MAX_HANDOFF_FILES};

#[derive(Clone, Debug, Default)]
pub(crate) struct HandoffInput {
    pub app_id: String,
    pub cwd: String,
    pub exit_code: i32,
    pub kind: Option<FailureKind>,
    pub reason: String,
    /// 失败证据（命中标记、上游状态码等），已由调用方截断成短句。
    pub evidence: Vec<String>,
    pub branch: Option<String>,
    /// `git status --porcelain` 的文件名（相对仓库根）。
    pub changed_files: Vec<String>,
    /// 退出前已经被验证过的事情，比如成功调用次数。
    pub verified: Vec<String>,
}

fn section(title: &str, lines: &[String]) -> String {
    if lines.is_empty() {
        return String::new();
    }
    let mut text = format!("## {title}\n");
    for line in lines {
        text.push_str("- ");
        text.push_str(line);
        text.push('\n');
    }
    text.push('\n');
    text
}

pub(crate) fn render(input: &HandoffInput) -> String {
    let directory = std::path::Path::new(&input.cwd)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| input.cwd.clone());
    let mut text = format!("# 交接单 · {directory} · {}\n\n", input.app_id);

    text.push_str("## 上次怎么停的\n");
    text.push_str(&format!("- 应用：{}\n", input.app_id));
    text.push_str(&format!("- 目录：{}\n", input.cwd));
    text.push_str(&format!("- 退出码：{}\n", input.exit_code));
    match input.kind {
        Some(kind) => text.push_str(&format!("- 判断：{}（{}）\n", kind.as_str(), input.reason)),
        None => text.push_str(&format!("- 判断：{}\n", input.reason)),
    }
    text.push('\n');

    let evidence: Vec<String> = input
        .evidence
        .iter()
        .take(MAX_HANDOFF_EVIDENCE)
        .cloned()
        .collect();
    text.push_str(&section("证据", &evidence));

    let mut workspace = Vec::new();
    if let Some(branch) = input.branch.as_deref().filter(|value| !value.is_empty()) {
        workspace.push(format!("当前分支：{branch}"));
    }
    if input.changed_files.is_empty() {
        workspace.push("工作区没有未提交改动".to_string());
    } else {
        for file in input.changed_files.iter().take(MAX_HANDOFF_FILES) {
            workspace.push(format!("改动：{file}"));
        }
        if input.changed_files.len() > MAX_HANDOFF_FILES {
            workspace.push(format!(
                "另有 {} 个改动文件未列出",
                input.changed_files.len() - MAX_HANDOFF_FILES
            ));
        }
    }
    text.push_str(&section("工作区现状", &workspace));
    text.push_str(&section("已验证", &input.verified));

    let mut next = Vec::new();
    match input.kind {
        Some(FailureKind::Quota) => next.push("先确认这次走的链路可用，再继续同一件事".to_string()),
        Some(FailureKind::Context) => {
            next.push("上下文已经满了，不要再沿用旧会话的推理，按本单重建任务状态".to_string())
        }
        Some(FailureKind::Provider) => {
            next.push("上游刚抖过一次，先跑最小验证确认链路恢复".to_string())
        }
        Some(FailureKind::Crash) => {
            next.push("进程是硬崩的，先确认上一步的文件写入没有半截".to_string())
        }
        None => {}
    }
    next.push("用 `git status` 核对上面列出的改动确实还在".to_string());
    next.push("从上次卡住的那一步继续，不要重头再来".to_string());
    text.push_str(&section("接下来", &next));

    text
}

/// 开新会话时的首条提示：只说一件事——先读交接单。
///
/// 不把整张单塞进 argv：命令行长度和引号都是麻烦，单子本身写在磁盘上。
pub(crate) fn prompt(cwd: &str, reason: &str, path: &str) -> String {
    format!(
        "刚刚在 {cwd} 跑到一半挂了（{reason}）。请先读交接单 {path}，用 git status 核对改动，然后从「接下来」的第一条继续，不要重头做。"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input() -> HandoffInput {
        HandoffInput {
            app_id: "claude".into(),
            cwd: "/tmp/demo".into(),
            exit_code: 1,
            kind: Some(FailureKind::Quota),
            reason: "命中 quota 标记：usage limit".into(),
            evidence: vec!["上游 429".into()],
            branch: Some("feat/session-baton".into()),
            changed_files: vec!["src/a.rs".into(), "src/b.rs".into()],
            verified: vec!["3 次成功调用".into()],
        }
    }

    #[test]
    fn handoff_records_the_facts_that_matter() {
        let text = render(&input());
        assert!(text.contains("# 交接单 · demo · claude"));
        assert!(text.contains("feat/session-baton"));
        assert!(text.contains("src/a.rs"));
        assert!(text.contains("上游 429"));
        assert!(text.contains("3 次成功调用"));
        assert!(text.contains("退出码：1"));
        assert!(text.contains("quota"));
    }

    #[test]
    fn empty_workspace_is_stated_instead_of_left_blank() {
        let mut empty = input();
        empty.changed_files.clear();
        empty.branch = None;
        let text = render(&empty);
        assert!(text.contains("工作区没有未提交改动"));
        assert!(!text.contains("当前分支"));
    }

    #[test]
    fn long_change_lists_are_truncated_with_a_count() {
        let mut many = input();
        many.changed_files = (0..MAX_HANDOFF_FILES + 5)
            .map(|i| format!("f{i}.rs"))
            .collect();
        let text = render(&many);
        assert_eq!(
            text.matches("- 改动：").count(),
            MAX_HANDOFF_FILES,
            "must not paste an unbounded file list"
        );
        assert!(text.contains("另有 5 个改动文件未列出"));
    }

    #[test]
    fn every_failure_kind_gets_a_concrete_next_step() {
        for kind in [
            FailureKind::Quota,
            FailureKind::Context,
            FailureKind::Provider,
            FailureKind::Crash,
        ] {
            let mut case = input();
            case.kind = Some(kind);
            let text = render(&case);
            assert!(text.contains("## 接下来"), "{kind:?} 缺下一步");
            assert!(
                text.contains("从上次卡住的那一步继续"),
                "{kind:?} 缺收尾指令"
            );
        }
    }

    #[test]
    fn prompt_points_at_the_file_instead_of_inlining_it() {
        let text = prompt(
            "/tmp/demo",
            "命中 quota 标记",
            "/tmp/phi/baton/handoff/x.md",
        );
        assert!(text.contains("/tmp/phi/baton/handoff/x.md"));
        assert!(text.contains("/tmp/demo"));
        assert!(!text.contains("## 工作区现状"));
    }
}
