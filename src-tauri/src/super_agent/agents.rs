use super::model::{
    task_prompt, RouterAgent, RouterSettings, AGENT_ASK_USER_LIMIT, AGENT_AVATAR_COUNT,
    AGENT_CONSTRAINTS_LIMIT, AGENT_EVIDENCE_LIMIT, AGENT_HARNESS_LIMIT, AGENT_LIST_ITEM_LIMIT,
    AGENT_STEPS_LIMIT, AGENT_TEXT_LIMIT,
};
use crate::{app_config::AppType, Database};
use std::collections::HashSet;

/// 模型 id 的长度上限。它会被拼进启动参数，太长就只能依赖 `parse_arguments`
/// 的 16384 字符上限了。
const MAX_MODEL_CHARS: usize = 128;

/// 模型 id 必须是一个能原样放进 `--model` 的记号：CLI 按空白切参数，带空格的
/// 名字会被拆成两段，后面那段就成了 prompt。
fn valid_model_id(model: &str) -> bool {
    model.chars().count() <= MAX_MODEL_CHARS
        && !model.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// 模型能不能用：带 Stack 保留前缀的 id 必须在现在的发布名单里（前缀解不出来时
/// 网关会直接拒掉），普通模型名交给应用自己认。
pub(crate) fn model_ready(app: &AppType, model: &str, available: &[String]) -> Result<(), String> {
    match crate::mode::stack::decode(app, model) {
        crate::mode::stack::Decoded::Malformed => Err("invalid-agent-model".into()),
        crate::mode::stack::Decoded::Stack { .. } if !available.iter().any(|id| id == model) => {
            Err(format!("agent-model-unpublished: {model}"))
        }
        _ => Ok(()),
    }
}

/// 从名称派生一个可读 id：`文档写手` → `文档写手`，`Doc Editor` → `doc-editor`。
///
/// 卡片上的 `assignee: [doc-editor]` 是人也要读的，随机 id 做不到这件事。
/// 只用「字母数字 + 连字符」，中日韩文字算字母，所以不会被折成空串。
pub(crate) fn slugify(name: &str) -> String {
    let mut out = String::new();
    let mut pending_dash = false;
    for ch in name.chars() {
        if ch.is_alphanumeric() {
            if pending_dash && !out.is_empty() {
                out.push('-');
            }
            pending_dash = false;
            out.extend(ch.to_lowercase());
        } else {
            pending_dash = true;
        }
    }
    let clipped: String = out.chars().take(40).collect();
    if clipped.is_empty() {
        "agent".into()
    } else {
        clipped
    }
}

fn text_ok(value: &str, max: usize) -> bool {
    value.chars().count() <= max && !value.contains('\0')
}

/// 头像只能是空（按 id 派生）或 `avatar-01`…`avatar-16` 里的一张。
///
/// 键名会原样落盘并决定显示哪张图：认不出来的值在前端会静默退回哈希，存进库
/// 就成了「设置了但看不出效果」的错，所以在保存时就拦住。
fn avatar_ok(avatar: &str) -> bool {
    if avatar.is_empty() {
        return true;
    }
    let Some(digits) = avatar.strip_prefix("avatar-") else {
        return false;
    };
    match digits.parse::<usize>() {
        // 同时要求规范写法：`avatar-7` 与界面上选的 `avatar-07` 不是同一个键。
        Ok(index) if (1..=AGENT_AVATAR_COUNT).contains(&index) => {
            format!("avatar-{index:02}") == avatar
        }
        _ => false,
    }
}

fn list_ok(items: &[String], max_items: usize, max_chars: usize) -> bool {
    items.len() <= max_items && items.iter().all(|item| text_ok(item, max_chars))
}

fn has_items(items: &[String]) -> bool {
    items.iter().any(|item| !item.trim().is_empty())
}

/// 追加一段「标题：正文」。
fn push_text(text: &mut String, label: &str, value: &str) {
    let value = value.trim();
    if value.is_empty() {
        return;
    }
    if !text.is_empty() {
        text.push('\n');
    }
    text.push_str(&format!("{label}：{value}"));
}

/// 追加一段「标题 + 列表」，`dash` 决定用 `- ` 还是 `1. `。
fn push_list(text: &mut String, label: &str, items: &[String], tail: Option<&str>) {
    let kept: Vec<&str> = items
        .iter()
        .map(|item| item.trim())
        .filter(|item| !item.is_empty())
        .collect();
    if kept.is_empty() {
        return;
    }
    if !text.is_empty() {
        text.push('\n');
    }
    let ordered = matches!(label, "执行步骤");
    text.push_str(&format!("{label}："));
    for (index, item) in kept.iter().enumerate() {
        if ordered {
            text.push_str(&format!("\n{}. {item}", index + 1));
        } else {
            text.push_str(&format!("\n- {item}"));
        }
    }
    if let Some(tail) = tail {
        text.push_str(&format!("\n{tail}"));
    }
}

impl RouterAgent {
    /// 五段式里是否写了任何一句。空 = 老智能体，harness 退回角色提示词。
    pub fn has_definition(&self) -> bool {
        !self.outcome.trim().is_empty()
            || !self.boundary.trim().is_empty()
            || has_items(&self.ask_user_when)
            || has_items(&self.steps)
            || has_items(&self.constraints)
            || !self.completion.result.trim().is_empty()
            || has_items(&self.completion.evidence)
    }

    /// 把五段式定义编译成一段带标题的上下文；老的角色提示词接在最后。
    ///
    /// 顺序是固定的：你是谁 → 负责什么 → 先问谁 → 怎么做 → 必须遵守 → 算不算完成。
    /// 拼接只在这一处，前端只预览不拼，避免两条入口说法分叉。
    pub fn harness(&self) -> String {
        let mut text = String::new();
        if self.has_definition() {
            let name = self.name.trim();
            let summary = self.description.trim();
            if summary.is_empty() {
                text.push_str(&format!("你是「{name}」。"));
            } else {
                text.push_str(&format!("你是「{name}」：{summary}"));
            }
            push_text(&mut text, "你负责的结果", &self.outcome);
            push_text(&mut text, "负责边界", &self.boundary);
            push_list(
                &mut text,
                "需要先问用户",
                &self.ask_user_when,
                Some("遇到上面这些情况，先问用户再动手；其余可逆选择自行决定。"),
            );
            push_list(&mut text, "执行步骤", &self.steps, None);
            push_list(&mut text, "必须遵守", &self.constraints, None);
            push_text(&mut text, "完成时", &self.completion.result);
            push_list(&mut text, "完工自查", &self.completion.evidence, None);
            text.push_str("\n若不能完成，说明原因以及下一步由谁处理。");
        }
        let prompt = self.prompt.trim();
        if !prompt.is_empty() {
            if !text.is_empty() {
                text.push_str("\n\n");
            }
            text.push_str(prompt);
        }
        text
    }

    pub fn task_prompt(&self, file: &str) -> String {
        let harness = self.harness();
        if harness.is_empty() {
            task_prompt(file)
        } else {
            format!("{harness}\n\n{}", task_prompt(file))
        }
    }

    fn validate(&self) -> Result<(), String> {
        let app = self
            .app_id
            .parse::<AppType>()
            .map_err(|_| "invalid-agent-app")?;
        if app.as_str() != self.app_id
            || self.app_id == "claude-desktop"
            || self.id.is_empty()
            || self.id.chars().count() > 80
            // 卡片上要写 `assignee: [doc-editor]`：id 得是人也能读、能写的记号。
            // 字母数字（含中日韩文字）加连字符/下划线，空格与标点一律不要。
            || !self
                .id
                .chars()
                .all(|c| c.is_alphanumeric() || c == '-' || c == '_')
            || self.name.trim().is_empty()
            // 按字符数限长，与界面上的 maxLength 同一个量纲：用字节数会让
            // 「60 个汉字的名称」在界面上合法、保存时却被判无效。
            || self.name.chars().count() > 160
            || !avatar_ok(&self.avatar)
            || self.description.chars().count() > 400
            || self.prompt.chars().count() > 8192
            || self.prompt.contains('\0')
            || self.description.contains('\0')
            || !text_ok(&self.outcome, AGENT_TEXT_LIMIT)
            || !text_ok(&self.boundary, AGENT_TEXT_LIMIT)
            || !list_ok(&self.ask_user_when, AGENT_ASK_USER_LIMIT, AGENT_LIST_ITEM_LIMIT)
            || !list_ok(&self.steps, AGENT_STEPS_LIMIT, AGENT_LIST_ITEM_LIMIT)
            || !list_ok(
                &self.constraints,
                AGENT_CONSTRAINTS_LIMIT,
                AGENT_LIST_ITEM_LIMIT,
            )
            || !text_ok(&self.completion.result, AGENT_TEXT_LIMIT)
            || !list_ok(
                &self.completion.evidence,
                AGENT_EVIDENCE_LIMIT,
                AGENT_LIST_ITEM_LIMIT,
            )
        {
            return Err("invalid-agent".into());
        }
        // harness 超长只会在派发时变成 CLI 的 invalid-arguments：那一步人看不到
        // 错误，只看到一张永远停在「运行中」的卡，所以必须在保存时拦住。
        if self.harness().chars().count() > AGENT_HARNESS_LIMIT {
            return Err("agent-harness-too-large".into());
        }
        // 允许列表是前端 `agentArguments.ts` 的镜像：界面上能点的，这里必须收；
        // 不在这里的写法，保存时就拒掉，不留「填得进去、跑起来才炸」的口子。
        //
        // 审批类开关（`--dangerously-skip-permissions` 等）也在列表里：它们是人在界面上
        // 明确点的一项，不是 phi 悄悄改的默认值。沙箱、并发、超时这些 phi 自己的边界
        // 一项都没放开——沙箱类只收了更严格的那一档（`--sandbox read-only`）。
        let mut args = self.arguments.iter().map(String::as_str);
        while let Some(flag) = args.next() {
            match (app.as_str(), flag) {
                ("claude", "--verbose")
                | ("claude", "--strict-mcp-config")
                | ("claude", "--dangerously-skip-permissions")
                | ("codex", "--ephemeral")
                | ("codex", "--ignore-user-config")
                | ("codex", "--ignore-rules")
                | ("codex", "--dangerously-bypass-approvals-and-sandbox")
                | ("gemini", "--sandbox")
                | ("gemini", "--skip-trust")
                | ("gemini", "--yolo")
                | ("opencode", "--pure")
                | ("opencode", "--auto") => (),
                ("claude", "--effort")
                    if matches!(args.next(), Some("low" | "medium" | "high")) => {}
                // 只放开更严格的那一档：写边界与网络策略仍按 phi 派发时的设定。
                ("codex", "--sandbox") if matches!(args.next(), Some("read-only")) => {}
                _ => return Err(format!("unsupported-agent-argument: {flag}")),
            }
        }
        if !self.model.is_empty() && !crate::mode::stack::supports_session_model(&app) {
            return Err("agent-model-override-unsupported".into());
        }
        if !self.model.is_empty() && !valid_model_id(&self.model) {
            return Err("invalid-agent-model".into());
        }
        Ok(())
    }
    pub fn ready(&self, db: &Database) -> Result<(), String> {
        self.validate()?;
        if self.model.is_empty() {
            return Ok(());
        }
        let app = self.app_id.parse().map_err(|_| "invalid-agent-app")?;
        let available = crate::mode::stack::worker_models(db, &app).map_err(|e| e.to_string())?;
        model_ready(&app, &self.model, &available)
    }
    /// 交给 CLI 的完整参数。`session` 是这张卡要续接的 CLI 会话 id：
    /// 只有支持按 id 续接的应用才会被翻译成参数，其余情况由派发前的那道检查拦住。
    pub fn launch_arguments(&self, file: &str, session: Option<&str>) -> String {
        let mut args = self.arguments.clone();
        if !self.model.is_empty() {
            args.extend(["--model".into(), self.model.clone()]);
        }
        let resume: Vec<String> = session
            .and_then(|id| crate::terminal::resume_arguments(&self.app_id, id))
            .unwrap_or_default();
        crate::terminal::worker_arguments(&self.app_id, &args, &resume, &self.task_prompt(file))
    }

    /// 这张卡选的会话能不能在这个应用上续接。派发前先问一遍，别到 CLI 那一层才失败。
    pub fn can_resume(&self, session: Option<&str>) -> bool {
        match session {
            None => true,
            Some(id) => crate::terminal::resume_arguments(&self.app_id, id).is_some(),
        }
    }
}

impl RouterSettings {
    /// 保存前归一：新智能体（id 为空）从名称派生可读 id，并默认进入允许名单。
    ///
    /// id 一旦有了就不再改：改名不改 id，卡片上写着的归属才不会失效。
    pub fn normalize_agents(&self) -> RouterSettings {
        let mut next = self.clone();
        let mut taken: HashSet<String> = next
            .agents
            .iter()
            .map(|agent| agent.id.trim().to_string())
            .filter(|id| !id.is_empty())
            .collect();
        taken.extend(next.worker_apps.iter().map(|id| id.trim().to_string()));
        let mut created: Vec<String> = Vec::new();
        for agent in &mut next.agents {
            let current = agent.id.trim().to_string();
            if !current.is_empty() {
                agent.id = current;
                continue;
            }
            let base = slugify(&agent.name);
            let mut candidate = base.clone();
            let mut suffix = 2;
            // 与已有 id 或应用 id 撞名都退让：`claude` 这种 id 会被 `agent()`
            // 当成「跟随应用」的老写法读，派生出来的新 id 不该落进那个歧义里。
            while taken.contains(&candidate) || candidate.parse::<AppType>().is_ok() {
                candidate = format!("{base}-{suffix}");
                suffix += 1;
            }
            taken.insert(candidate.clone());
            agent.id = candidate.clone();
            created.push(candidate);
        }
        if !created.is_empty() {
            next.worker_apps.extend(created);
            let mut seen = HashSet::new();
            next.worker_apps.retain(|id| seen.insert(id.clone()));
        }
        next
    }

    pub fn validate_agents(&self) -> Result<(), String> {
        // Router 的头像与智能体的头像同一组键：存进一个认不出来的值，前端会静默
        // 退回按 id 派生，人只会觉得「设了跟没设一样」。
        if !avatar_ok(&self.router_avatar) {
            return Err("invalid-router-avatar".into());
        }
        let mut ids = HashSet::new();
        for a in &self.agents {
            a.validate()?;
            if !ids.insert(&a.id) || (a.id.parse::<AppType>().is_ok() && a.id != a.app_id) {
                return Err("invalid-agent-id".into());
            }
        }
        if self.worker_apps.iter().any(|id| self.agent(id).is_none()) {
            return Err("unknown-router-agent".into());
        }
        Ok(())
    }
}
