//! Router 侧的讨论通道。
//!
//! 讨论与派发用同一个 Router 模型（设置里的 `episodeModel`），但走的是另一条
//! 路径：这里没有工具表、没有闸门、没有提名，Router 能做的只有回答。
//! 「讨论阶段不许动手」因此是能力上的不可能，而不是提示词里的一句请求。
//!
//! 上下文按每轮重放：讨论轮次本来不多，把历史摊平成一段文本比维护一份长驻
//! 会话更可复现，也和「一次 episode 一个进程」的既有选择一致。

use crate::super_agent::sidecar::SidecarEpisode;
use crate::tasks::model::{DiscussionTurn, TaskDetail};

/// 等 Router 回一句的上限。比 tick 宽松：这里等的是一个人正在等的回复。
const DEADLINE: std::time::Duration = std::time::Duration::from_secs(90);

/// 卡片正文给 Router 看多少字。讨论要引用背景，但不需要整份长文档。
const BODY_EXCERPT: usize = 1200;

/// 讨论的系统提示词。没有工具、没有写权限，这是「只讨论」的边界本身。
const SYSTEM: &str = "\
你是 phi Super Agent 里的 Lead。此刻不是派发，而是和用户讨论一张任务卡。

讨论的产物是结论：改验收条件、拆成几张卡、换执行者或模型、补一条约束，\
或者「这件事不做」。你不会去执行，也改不了任何文件——用户把结论写回卡片、\
按下开始之后，才轮到执行体。

要求：
- 先讲清可选做法与取舍，最后给出你建议的那一个；
- 需要用户拍板的地方，把问题写成一句具体的问句，不要用「你觉得呢」这类空问；
- 只用卡片与上面的对话里出现过的事实。缺信息就说缺什么，不要编造库里没有的内容；
- 不要声称自己已经改了卡片、跑了命令或派了人。

每次回复的最后两行，按固定格式给出这一轮的结论。程序会解析这两行直接写进卡片，
所以标记必须原样保留，也不要在别处把同样的内容再讲一遍：

【还没定的问题】一句话问清还需要用户拍板的那件事；该问的都问完了就写「无」。
【已确认的需求】到目前为止已经确认的全部约束（沿用之前确认过的，加上这一轮新定下来的），
每条一行、以「- 」开头；还没有就说「无」。你自己建议、用户还没表态的，算进上面的
问题，不要写进这里。";

/// 表单协议：把「还需要你定什么」变成可在 timeline 里直接填的几项。
///
/// 这段是给人省事的，不是解析的前提：模型不给表单，界面就当普通回复显示；
/// 模型给歪了，[`crate::tasks::form`] 会把它降级成文本。
const FORM_GUIDE: &str = r#"有些问题必须由用户给出具体值才能继续（例如「新闻从哪里取」「整理结果写到哪、什么格式」）。
这种情况给一张表单，让用户在对话里直接填写提交，不要只在文字里再列一遍同样的问句。
表单是一段围栏代码块，紧跟在你的解释之后、结论两行之前：

```phi-form
{"title":"还需要你定两件事","fields":[{"id":"source","label":"新闻从哪里取？","type":"text","placeholder":"订阅源 / 某个目录 / 不限来源"},{"id":"target","label":"整理结果写到哪","type":"choice","options":["追加到这张卡","单独一个文件"]}]}
```

规则：
- 字段 2–4 个；label 写成一句问句，用户看着它就能答；
- type 只能是 text 或 choice；choice 必须给 2–5 个 options；
- 能默认的给 placeholder，不要让用户猜格式；
- 一次回复最多一张表单。开放式的讨论不要给表单，直接说话。"#;

/// 结论段的标记。它们是程序与模型之间的接口，不是提示词里的一句建议：
/// 改这里就要同步改 [`SYSTEM`] 与解析测试。
pub(crate) const QUESTION_MARK: &str = "【还没定的问题】";
pub(crate) const CONFIRMED_MARK: &str = "【已确认的需求】";

/// 一轮回复里可以写回卡片的结论。
///
/// 两个字段的 `None` 含义不同，与 `repository::discuss` 的约定一致：
/// `question` 的 `Some("")` 表示「这一轮明确说了没有待定问题」，应当清掉卡面上那一句；
/// `confirmed` 的 `None` 表示这一轮没有新的确认，原值不动（清空旧确认只能靠人）。
#[derive(Debug, Default, PartialEq)]
pub(crate) struct Conclusion {
    pub(crate) question: Option<String>,
    pub(crate) confirmed: Option<String>,
}

/// 从 Router 的一轮回复里取出结论。
///
/// 模型没按格式回复时两边都是 `None`：宁可卡片停在上一版结论，也不要把一段
/// 散文塞进「已确认的需求」——那段文字会随任务一起交给执行者。
pub(crate) fn parse_conclusion(reply: &str) -> Conclusion {
    // 表单块里也可能出现这两个标记（比如某个 label 引用了问题），先摘掉再按行解析：
    // 否则一段 JSON 会被当成「已确认的需求」写进卡片，跟着任务交给执行者。
    let reply = crate::tasks::form::without_blocks(reply);
    let reply = reply.as_str();
    Conclusion {
        question: block(reply, QUESTION_MARK, &[CONFIRMED_MARK]).map(|text| {
            // 「问题」只占卡面一行：取第一段非空文本，别把后面的说明一起塞进去。
            let line = text
                .lines()
                .map(str::trim)
                .find(|line| !line.is_empty())
                .unwrap_or("");
            let line = strip_bullet(line);
            if is_nothing(line) {
                String::new()
            } else {
                clip(line, crate::tasks::repository::DISCUSSION_QUESTION_LIMIT)
            }
        }),
        confirmed: block(reply, CONFIRMED_MARK, &[]).and_then(|text| {
            let items: Vec<String> = text
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .map(strip_bullet)
                .filter(|line| !line.is_empty() && !is_nothing(line))
                .map(str::to_string)
                .collect();
            if items.is_empty() {
                // 「无」不是「清掉此前定下的东西」：确认只能一笔一笔加上去。
                None
            } else {
                Some(clip(
                    &items.join("\n"),
                    crate::tasks::repository::CONFIRMED_LIMIT,
                ))
            }
        }),
    }
}

/// 标记之后、下一个标记之前的正文。回复里没有这个标记时返回 `None`。
fn block<'a>(reply: &'a str, mark: &str, until: &[&str]) -> Option<&'a str> {
    let start = reply.find(mark)? + mark.len();
    let rest = &reply[start..];
    let end = until
        .iter()
        .filter_map(|other| rest.find(other))
        .min()
        .unwrap_or(rest.len());
    Some(&rest[..end])
}

/// 去掉列表符号与序号：模型有时写「- 」，有时写「1. 」，两者都要能读。
fn strip_bullet(line: &str) -> &str {
    let trimmed = line.trim_start();
    let rest = trimmed
        .strip_prefix("- ")
        .or_else(|| trimmed.strip_prefix("* "))
        .or_else(|| trimmed.strip_prefix("• "))
        .unwrap_or(trimmed);
    let digits = rest.len() - rest.trim_start_matches(|c: char| c.is_ascii_digit()).len();
    if digits > 0 {
        let after = &rest[digits..];
        for sep in ['.', ')', '、'] {
            if let Some(tail) = after.strip_prefix(sep) {
                return tail.trim_start();
            }
        }
    }
    rest.trim_start()
}

/// 「没有」的几种常见写法。归一化之后再比较，模型加个句号也认得。
fn is_nothing(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return true;
    }
    let head = trimmed.trim_end_matches(['。', '.', '，', ',', '；', ';', '！', '!', ' ']);
    matches!(
        head,
        "无" | "没有" | "暂无" | "none" | "None" | "N/A" | "n/a"
    )
}

fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    text.chars().take(max).collect()
}

/// 一次讨论回复。
pub(crate) async fn reply(
    app: &tauri::AppHandle,
    task: &TaskDetail,
    history: &[DiscussionTurn],
    message: &str,
) -> Result<String, String> {
    let model = crate::super_agent::runtime::episode_model(app)
        .ok_or_else(|| "router-model-missing".to_string())?;

    let sidecar = SidecarEpisode::bundled(app)
        .ok_or_else(|| "router-sidecar-missing".to_string())?
        .with_model(model)
        .with_deadline(DEADLINE);

    let prompt = compose(task, history, message);
    sidecar
        .chat(&format!("{SYSTEM}\n\n{FORM_GUIDE}"), &prompt)
        .await
}

/// 把卡片事实、此前几轮和用户刚说的这句拼成一次请求。
///
/// 用户这句单独放在最后，而不是只靠历史：拼错的顺序会让模型把这一轮当成
/// 「历史的一部分」继续复述，而不是回答它。
fn compose(task: &TaskDetail, history: &[DiscussionTurn], message: &str) -> String {
    let mut text = String::new();
    text.push_str(&format!(
        "【任务卡】{} {}\n当前列：{}",
        task.task.id, task.task.title, task.task.status
    ));
    if task.task.kind == crate::tasks::model::KIND_DISCUSSION {
        let round = task
            .task
            .round
            .map(|round| format!("第 {round} 轮"))
            .unwrap_or_else(|| "第 1 轮".into());
        text.push_str(&format!("\n类型：讨论卡（{round}）"));
        if let Some(source) = task.task.source_task.as_deref() {
            text.push_str(&format!("，来自 {source}"));
        }
    }
    text.push_str(&format!("\n文件：{}", task.task.file));

    if !task.acceptance.is_empty() {
        text.push_str("\n\n验收条件：");
        for item in &task.acceptance {
            text.push_str(&format!(
                "\n- [{}] {}",
                if item.done { "x" } else { " " },
                item.text
            ));
        }
    }

    if let Some(question) = task.task.discussion_question.as_deref() {
        text.push_str(&format!("\n\n还没定的问题：{question}"));
    }
    if let Some(confirmed) = task.confirmed.as_deref() {
        text.push_str(&format!("\n\n已确认的需求（沿用，不要推翻）：{confirmed}"));
    }
    if let Some(outcome) = task.outcome.as_deref() {
        text.push_str(&format!("\n\n上一轮结果：{}", excerpt(outcome)));
    }

    let body = excerpt(task.body.trim());
    if !body.is_empty() {
        text.push_str(&format!("\n\n卡片正文：\n{body}"));
    }

    if !history.is_empty() {
        text.push_str("\n\n此前讨论（从早到晚）：");
        for turn in history {
            let who = if turn.role == crate::tasks::discussion::ROLE_ROUTER {
                "你"
            } else {
                "用户"
            };
            text.push_str(&format!("\n{who}：{}", turn.text.trim()));
            // 表单块已经从正文里摘掉了，但「上一轮问过哪几项」是这一轮的事实：
            // 不补一句，模型会以为自己没问过，于是把同样的问题再提一遍。
            if let Some(form) = turn.form.as_ref() {
                let labels: Vec<&str> = form
                    .fields
                    .iter()
                    .map(|field| field.label.as_str())
                    .collect();
                text.push_str(&format!(
                    "\n（你这一轮给了一张表单：{}）",
                    labels.join("；")
                ));
            }
        }
    }

    text.push_str(&format!("\n\n用户刚说：\n{}", message.trim()));
    text
}

/// 按字符截断，不按字节切：中文按字节切会切出半个字。
fn excerpt(text: &str) -> String {
    if text.chars().count() <= BODY_EXCERPT {
        return text.to_string();
    }
    let head: String = text.chars().take(BODY_EXCERPT).collect();
    format!("{head}……（正文较长，后续已省略）")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tasks::model::*;

    fn card() -> TaskDetail {
        TaskDetail {
            task: Task {
                kind: KIND_DISCUSSION.into(),
                source_task: Some("TASK-3".into()),
                round: Some(2),
                discussion_hold: true,
                discussion_question: Some("默认看最近 5 条，还是按日期分组？".into()),
                id: "TASK-7".into(),
                title: "看板改版".into(),
                status: "To Do".into(),
                assignees: Vec::new(),
                priority: None,
                labels: Vec::new(),
                dependencies: Vec::new(),
                created_date: None,
                updated_date: None,
                acceptance_total: 1,
                acceptance_done: 0,
                artifact_count: 0,
                schedule: None,
                schedule_spec: None,
                file: "backlog/tasks/task-7 - 看板改版.md".into(),
                fingerprint: "fp".into(),
            },
            body: "## 讨论背景\n上一轮的做法是按更新时间倒序。".into(),
            sections: Vec::new(),
            acceptance: vec![AcceptanceItem {
                text: "其他列不动".into(),
                done: false,
            }],
            links: Vec::new(),
            outcome: None,
            confirmed: Some("其他列不动".into()),
            derived: Vec::new(),
            artifacts: Vec::new(),
            discussion_turns: Vec::new(),
        }
    }

    #[test]
    fn the_prompt_carries_the_card_the_settled_part_and_the_new_line() {
        let history = vec![DiscussionTurn {
            role: crate::tasks::discussion::ROLE_ROUTER.into(),
            text: "可以按日期分组".into(),
            created_at: 1,
            form: None,
        }];
        let prompt = compose(&card(), &history, "我更想看最近的");

        assert!(prompt.contains("TASK-7 看板改版"));
        assert!(prompt.contains("讨论卡（第 2 轮），来自 TASK-3"));
        assert!(prompt.contains("其他列不动"));
        assert!(prompt.contains("默认看最近 5 条"));
        assert!(prompt.contains("你：可以按日期分组"));
        // 这一句必须落在最后，而不是混进历史
        assert!(prompt.trim_end().ends_with("我更想看最近的"));
    }

    #[test]
    fn a_form_block_never_leaks_into_the_conclusion() {
        // 表单的 label 里也可能写着这两个标记；结论只能从正文那段读。
        let reply = "```phi-form\n{\"fields\":[{\"label\":\"【已确认的需求】假的\"}]}\n```\n\
【还没定的问题】新闻从哪里取？\n【已确认的需求】\n- 只改待办列";
        let conclusion = parse_conclusion(reply);
        assert_eq!(conclusion.question.as_deref(), Some("新闻从哪里取？"));
        assert_eq!(conclusion.confirmed.as_deref(), Some("只改待办列"));
    }

    #[test]
    fn the_prompt_reminds_the_model_which_form_it_already_asked() {
        let history = vec![DiscussionTurn {
            role: crate::tasks::discussion::ROLE_ROUTER.into(),
            text: "还缺两个信息。".into(),
            created_at: 1,
            form: Some(crate::tasks::model::DiscussionForm {
                title: Some("还需要你定两件事".into()),
                fields: vec![
                    crate::tasks::model::DiscussionFormField {
                        id: "source".into(),
                        label: "新闻从哪里取？".into(),
                        kind: "text".into(),
                        placeholder: None,
                        options: Vec::new(),
                        required: true,
                    },
                    crate::tasks::model::DiscussionFormField {
                        id: "target".into(),
                        label: "整理结果写到哪".into(),
                        kind: "choice".into(),
                        placeholder: None,
                        options: vec!["追加到这张卡".into(), "单独一个文件".into()],
                        required: true,
                    },
                ],
            }),
        }];
        let prompt = compose(&card(), &history, "订阅源，写到单独文件");
        assert!(prompt.contains("新闻从哪里取？；整理结果写到哪"));
    }

    #[test]
    fn the_excerpt_counts_characters_not_bytes() {
        let long = "看".repeat(BODY_EXCERPT + 10);
        let short = excerpt(&long);
        assert!(short.ends_with("后续已省略）"));
        assert_eq!(short.chars().filter(|c| *c == '看').count(), BODY_EXCERPT);
    }

    #[test]
    fn the_conclusion_comes_out_of_the_two_fixed_blocks() {
        let reply = "按日期分组更好，因为它跟你现在的翻看习惯一致。\n\n\
【还没定的问题】分组后默认展开哪一组？\n\
【已确认的需求】\n- 默认只留 5 条\n- 其他列不动\n";
        let conclusion = parse_conclusion(reply);
        assert_eq!(
            conclusion.question.as_deref(),
            Some("分组后默认展开哪一组？")
        );
        assert_eq!(
            conclusion.confirmed.as_deref(),
            Some("默认只留 5 条\n其他列不动")
        );
    }

    #[test]
    fn a_reply_without_the_marks_leaves_the_card_alone() {
        assert_eq!(
            parse_conclusion("我觉得应该按日期分组，你看呢？"),
            Conclusion::default()
        );
    }

    #[test]
    fn nothing_settled_clears_the_question_but_never_the_confirmed_part() {
        // 问题已经问完：「无」要把卡面上那一句清掉，否则它会一直挂着。
        let settled = parse_conclusion("【还没定的问题】无。\n【已确认的需求】\n- 按日期分组");
        assert_eq!(settled.question.as_deref(), Some(""));
        assert_eq!(settled.confirmed.as_deref(), Some("按日期分组"));

        // 这一轮什么都没定：已确认的需求保持原值，不能被一个「无」清掉。
        let empty = parse_conclusion("【还没定的问题】\n【已确认的需求】无");
        assert_eq!(empty.question.as_deref(), Some(""));
        assert_eq!(empty.confirmed, None);
    }

    #[test]
    fn numbered_and_dashed_items_are_both_readable() {
        let reply = "【已确认的需求】\n1. 只改待办列\n2) 其他列保持原样\n- 不做重构";
        assert_eq!(
            parse_conclusion(reply).confirmed.as_deref(),
            Some("只改待办列\n其他列保持原样\n不做重构")
        );
    }

    #[test]
    fn an_oversized_question_is_clipped_to_what_the_card_accepts() {
        let long = "问".repeat(crate::tasks::repository::DISCUSSION_QUESTION_LIMIT + 50);
        let reply = format!("【还没定的问题】{long}");
        let question = parse_conclusion(&reply).question.expect("question");
        assert_eq!(
            question.chars().count(),
            crate::tasks::repository::DISCUSSION_QUESTION_LIMIT
        );
    }
}
