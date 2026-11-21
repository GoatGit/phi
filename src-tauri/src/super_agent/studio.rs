//! 智能体工作室：用一段对话产出一份可编辑的智能体草稿。
//!
//! 写入口只有一个：模型在回复里给一段 `phi-agent` 围栏 JSON，Rust 侧解析、
//! 截断到各段上限，再交给编辑器。它没有文件写、没有进程，也没有数据库；
//! 草稿只有人点保存才落进设置，所以「模型不能自己造员工」是能力上的不可能，
//! 而不是提示词里的一句请求。

use super::model::{
    AgentCompletion, RouterAgent, AGENT_ASK_USER_LIMIT, AGENT_CONSTRAINTS_LIMIT,
    AGENT_EVIDENCE_LIMIT, AGENT_LIST_ITEM_LIMIT, AGENT_STEPS_LIMIT, AGENT_TEXT_LIMIT,
};
use super::sidecar::SidecarEpisode;
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// 等工作室回一句的上限。这里等的是一个人正在等的回复，比 tick 宽松。
const DEADLINE: Duration = Duration::from_secs(90);

/// 草稿块的起始标记。它是程序与模型之间的接口：改这里要同步改提示词与测试。
pub(crate) const DRAFT_MARK: &str = "\u{60}\u{60}\u{60}phi-agent";

const SYSTEM: &str = r#"你是 phi 任务看板的智能体工作室。用户在描述一个想要的手下：它该负责什么、不接什么、怎样算完成。你的任务是把这段描述收敛成一份可编辑的智能体草稿，而不是自己开始干活。

如果这次请求里带了一段「右栏当前这一版」，那就是人右边正在看着的那份草稿（可能是你上一轮给的，也可能人已经自己改过）。每轮都以它为准继续改：不要退回更早的版本，也不要丢掉人已经改好的内容。没有这段时，从零起草。应用、模型、追加参数与提示词由人自己定，草稿里不必填。

每轮回复分两部分：
1. 先用两三句话说清你补了什么、还缺什么；缺关键信息就问一句具体的问句，不要用「你觉得呢」这类空问。
2. 给出（或更新）一份完整草稿，放在一个 phi-agent 围栏代码块里，内容是一个 JSON 对象：

```phi-agent
{
  "name": "文档写手",
  "description": "改文档、补说明、把结论整理成人能读的段落",
  "outcome": "交付一份改动过的文档，并说明改了哪几节",
  "boundary": "不做架构改造；需要动代码时转给实现类智能体",
  "askUserWhen": ["要改的范围涉及对外承诺", "需要访问用户没有授权的目录"],
  "steps": ["先读卡片与相关文档，确认要改哪几节", "按既有文风改写，保留原结论", "在卡片写结果与产物路径"],
  "constraints": ["不删除他人已确认的结论", "不编造文档里没有的事实"],
  "completion": {
    "result": "文档已改完，卡片验收全部满足",
    "evidence": ["列出改动的章节", "说明验证方式（查阅/对比）"]
  }
}
```

规则：
- 字段必须给全；用户没提到的留空字符串或空数组，不要编造岗位细节；
- name 是岗位名（不超过 20 字），description 一句话说明什么任务派给它（不超过 80 字）；
- steps 3–6 条写「怎么做」，constraints 2–4 条写「不能做什么」，evidence 2–4 条写交付前自查什么；
- 围栏里只放这段 JSON，不要注释、不要多段 JSON。"#;

/// 工作室的一轮发言。`role` 只有 `user` 与 `router`。
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioTurn {
    pub role: String,
    pub text: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioReply {
    /// 去掉草稿块之后给人读的那段话。
    pub reply: String,
    /// 这一轮产出的草稿；模型没给或给歪了时为 `None`。
    pub draft: Option<RouterAgent>,
}

/// 和工作室聊一轮。`app_id` 由界面给：模型不知道这台机器装了哪些 CLI，
/// 让它猜只会猜出一个跑不起来的应用。
///
/// `current` 是右栏此刻正摆着的那一版。多轮优化靠它成立：只说「再加一条约束」时，
/// 模型得知道现在的约束是什么，否则它只能凭对话记忆重写，人已经改过的部分会被冲掉。
pub(crate) async fn reply(
    app: &tauri::AppHandle,
    app_id: &str,
    history: &[StudioTurn],
    message: &str,
    current: Option<&RouterAgent>,
) -> Result<StudioReply, String> {
    let model = crate::super_agent::runtime::episode_model(app)
        .ok_or_else(|| "router-model-missing".to_string())?;
    let sidecar = SidecarEpisode::bundled(app)
        .ok_or_else(|| "router-sidecar-missing".to_string())?
        .with_model(model)
        .with_deadline(DEADLINE);
    let prompt = compose(history, message, current);
    let reply = sidecar.chat(SYSTEM, &prompt).await?;
    Ok(split(reply, app_id))
}

/// 右栏这一版最多带多少字进提示词。五段式本身各有上限，这里只防一份异常值
/// 把每轮的请求撑爆：截断了也还能聊，模型至少看得到后半段之前的内容。
const CURRENT_LIMIT: usize = 8000;

/// 历史摊平成一段文本：一轮工作室对话本来就不长，比维护长驻会话好复现。
/// 用户这句单独放在最后，避免模型把它当成历史的一部分继续复述。
/// 右栏这一版排在历史之后、用户这句之前：「当前状态」比「上几轮说了什么」更该紧挨着问题。
fn compose(history: &[StudioTurn], message: &str, current: Option<&RouterAgent>) -> String {
    let mut text = String::new();
    for turn in history {
        let who = if turn.role == "user" { "用户" } else { "你" };
        text.push_str(&format!("{who}：{}\n\n", turn.text.trim()));
    }
    if let Some(form) = current.map(form_snapshot).filter(|text| !text.is_empty()) {
        text.push_str(&format!("右栏当前这一版（可能是人改过的）：\n{form}\n\n"));
    }
    text.push_str(&format!("用户：{}", message.trim()));
    text
}

/// 只把「它是什么样的人」这半边交给模型：应用、模型、参数、提示词属于人的选择，
/// 草稿里填了也会被 [`sanitize`] 清掉，带进去只会让模型以为那些字段它在管。
///
/// 用带标题的文本而不是 JSON：截断一段 JSON 会得到一个半截对象，模型很难看出停在哪；
/// 文本截断了仍然可读，人也不会因为一份异常值把每轮请求捧爆。
fn form_snapshot(agent: &RouterAgent) -> String {
    let lines = |items: &[String]| -> String {
        items
            .iter()
            .map(|item| item.trim())
            .filter(|item| !item.is_empty())
            .collect::<Vec<_>>()
            .join("\n- ")
    };
    let mut text = String::new();
    let mut push = |label: &str, body: &str| {
        let body = body.trim();
        if !body.is_empty() {
            text.push_str(&format!("{label}：\n{body}\n\n"));
        }
    };
    push("名称", &agent.name);
    push("用途", &agent.description);
    push("负责的结果", &agent.outcome);
    push("负责边界", &agent.boundary);
    let ask = lines(&agent.ask_user_when);
    if !ask.is_empty() {
        push("需要先问用户", &format!("- {ask}"));
    }
    let steps = lines(&agent.steps);
    if !steps.is_empty() {
        push("执行步骤", &format!("- {steps}"));
    }
    let constraints = lines(&agent.constraints);
    if !constraints.is_empty() {
        push("必须遵守", &format!("- {constraints}"));
    }
    push("完工标准", &agent.completion.result);
    let evidence = lines(&agent.completion.evidence);
    if !evidence.is_empty() {
        push("完工自查", &format!("- {evidence}"));
    }
    clip(&text, CURRENT_LIMIT)
}

/// 把回复拆成「给人读的话」和「草稿」。
pub(crate) fn split(reply: String, app_id: &str) -> StudioReply {
    let Some(start) = reply.find(DRAFT_MARK) else {
        return StudioReply {
            reply: reply.trim().to_string(),
            draft: None,
        };
    };
    let fence = "\u{60}\u{60}\u{60}";
    let after = &reply[start + DRAFT_MARK.len()..];
    let Some(end) = after.find(fence) else {
        return StudioReply {
            reply: reply.trim().to_string(),
            draft: None,
        };
    };
    let json = after[..end].trim();
    let spoken = format!("{}{}", &reply[..start], &after[end + fence.len()..]);
    let draft = serde_json::from_str::<RouterAgent>(json)
        .ok()
        .map(|draft| sanitize(draft, app_id))
        .filter(|draft| !draft.name.is_empty());
    StudioReply {
        reply: spoken.trim().to_string(),
        draft,
    }
}

/// 截断到各段上限，并把「谁能启动它」这半边留给人：应用由界面给，模型与
/// 追加参数一律清空，id 留空等保存时按名称派生。
fn sanitize(mut draft: RouterAgent, app_id: &str) -> RouterAgent {
    draft.id = String::new();
    draft.app_id = app_id.to_string();
    draft.model = String::new();
    draft.arguments = Vec::new();
    draft.prompt = String::new();
    draft.name = clip(&draft.name, 160);
    draft.description = clip(&draft.description, 400);
    draft.outcome = clip(&draft.outcome, AGENT_TEXT_LIMIT);
    draft.boundary = clip(&draft.boundary, AGENT_TEXT_LIMIT);
    draft.ask_user_when = clip_list(&draft.ask_user_when, AGENT_ASK_USER_LIMIT);
    draft.steps = clip_list(&draft.steps, AGENT_STEPS_LIMIT);
    draft.constraints = clip_list(&draft.constraints, AGENT_CONSTRAINTS_LIMIT);
    draft.completion = AgentCompletion {
        result: clip(&draft.completion.result, AGENT_TEXT_LIMIT),
        evidence: clip_list(&draft.completion.evidence, AGENT_EVIDENCE_LIMIT),
    };
    draft
}

fn clip(text: &str, max: usize) -> String {
    text.chars()
        .filter(|ch| *ch != '\u{0}')
        .take(max)
        .collect::<String>()
        .trim()
        .to_string()
}

fn clip_list(items: &[String], max_items: usize) -> Vec<String> {
    items
        .iter()
        .map(|item| clip(item, AGENT_LIST_ITEM_LIMIT))
        .filter(|item| !item.is_empty())
        .take(max_items)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn draft_json(extra: &str) -> String {
        format!(
            r#"先说两句话。

```phi-agent
{{"name":"文档写手","description":"改文档","outcome":"交付文档","steps":["读卡","改写"],"completion":{{"result":"改完","evidence":["列出章节"]}}}}{extra}
```
"#
        )
    }

    #[test]
    fn the_draft_block_never_leaks_into_the_spoken_reply() {
        let reply = split(draft_json(""), "claude");
        assert_eq!(reply.reply, "先说两句话。");
        let draft = reply.draft.expect("草稿应当被解析出来");
        assert_eq!(draft.name, "文档写手");
        assert_eq!(draft.app_id, "claude");
        assert_eq!(draft.steps, vec!["读卡", "改写"]);
        assert_eq!(draft.completion.evidence, vec!["列出章节"]);
    }

    #[test]
    fn a_draft_never_carries_its_own_id_model_or_arguments() {
        let json = draft_json("").replace(
            r#"{"name""#,
            r#"{"id":"evil","model":"best","arguments":["--yolo"],"name""#,
        );
        let draft = split(json, "claude").draft.expect("草稿");
        assert!(draft.id.is_empty(), "id 由保存时按名称派生");
        assert!(draft.model.is_empty(), "模型是人的选择，不是模型的选择");
        assert!(draft.arguments.is_empty());
    }

    #[test]
    fn a_reply_without_the_block_has_no_draft() {
        let reply = split("我先问一句：它要不要接手对外承诺？".into(), "claude");
        assert!(reply.draft.is_none());
        assert_eq!(reply.reply, "我先问一句：它要不要接手对外承诺？");
    }

    #[test]
    fn a_broken_block_keeps_the_reply_and_drops_the_draft() {
        let reply = split("说明\n```phi-agent\n{ not json }\n```\n".into(), "claude");
        assert!(reply.draft.is_none());
        assert!(reply.reply.starts_with("说明"));
    }

    #[test]
    fn an_oversized_list_is_clipped_to_what_save_accepts() {
        let many = (0..20)
            .map(|index| format!("\"第{index}步\""))
            .collect::<Vec<_>>()
            .join(",");
        let raw = format!(
            "\u{60}\u{60}\u{60}phi-agent\n{{\"name\":\"写手\",\"steps\":[{many}]}}\n\u{60}\u{60}\u{60}\n"
        );
        let draft = split(raw, "claude").draft.expect("草稿");
        assert_eq!(draft.steps.len(), AGENT_STEPS_LIMIT);
    }

    fn form() -> RouterAgent {
        RouterAgent {
            name: "文档写手".into(),
            description: "改文档".into(),
            app_id: "claude".into(),
            model: "glm-5".into(),
            arguments: vec!["--verbose".into()],
            prompt: "人写的提示词".into(),
            steps: vec!["读卡".into(), "改写".into()],
            ..RouterAgent::default()
        }
    }

    #[test]
    fn the_next_round_sees_what_is_currently_in_the_form() {
        let prompt = compose(&[], "再加一条约束", Some(&form()));
        // 右栏当前这一版紧贴着用户这句：多轮优化靠它，而不是靠对话记忆。
        assert!(prompt.contains("右栏当前这一版"));
        assert!(prompt.contains("名称：\n文档写手"));
        assert!(prompt.contains("- 读卡\n- 改写"));
        assert!(prompt.ends_with("用户：再加一条约束"));
    }

    #[test]
    fn the_form_snapshot_never_carries_how_it_is_launched() {
        let snapshot = form_snapshot(&form());
        assert!(!snapshot.contains("claude"), "应用由人选");
        assert!(!snapshot.contains("glm-5"), "模型由人选");
        assert!(!snapshot.contains("--verbose"), "追加参数由人选");
        assert!(!snapshot.contains("人写的提示词"), "提示词由人选");
    }

    #[test]
    fn an_empty_form_adds_nothing_to_the_prompt() {
        let prompt = compose(&[], "要一个改文档的人", Some(&RouterAgent::default()));
        assert!(!prompt.contains("右栏当前这一版"));
        assert_eq!(prompt, "用户：要一个改文档的人");
    }
}
