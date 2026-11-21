//! 需求讨论：在任务详情页跟 Router 谈，不派 worker。
//!
//! 讨论是决策动作，不是执行动作。它产出的不是交付物，而是一个必须被立刻消费的
//! 结论——改验收、拆子任务、换执行者、补约束，或者「这件事不做」。这些只有
//! Router 有权限消费，所以承载讨论的是 Router，而不是某个 worker 的终端会话。
//!
//! 这个文件负责三件事：
//! 1. 把一轮对话记进 sqlite（详情页 timeline 的持久化）；卡片里只留结论。
//! 2. 拼出 Router 这一轮该看到的事实：卡片、已确认结论、此前几轮。
//! 3. 把卡标成「讨论中」——讨论与运行互斥，调度器这一轮不会把它派走。
//!
//! 「讨论阶段不动手」不靠提示词保证：Router 的讨论分支没有工具表
//! （见 [`crate::super_agent::discussion`]），它唯一能做的事是回答。

use crate::error::AppError;
use crate::store::AppState;
use crate::tasks::commands::{detail_with_links, open};
use crate::tasks::model::{DiscussionTurn, TaskDetail};
use crate::tasks::repository;
use crate::Database;
use rusqlite::params;
use tauri::{AppHandle, Manager, State};

/// 谁在说话。发言者只有两方：用户与 Router。
pub(crate) const ROLE_USER: &str = "user";
pub(crate) const ROLE_ROUTER: &str = "router";

/// 一句发言的上限。讨论不是往卡片里塞文档，超长的输入先让人自己删一半。
const MAX_TURN_CHARS: usize = 8000;

fn error(e: impl std::fmt::Display) -> AppError {
    AppError::Database(format!("Tasks: {e}"))
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

/// 讨论表与任务文件是两套数据：文件随 git 走，对话记录是本机事实。
///
/// 用 `CREATE TABLE IF NOT EXISTS` 建表而不是新开一版迁移：这里只新增表，
/// 老库启动时同样会跑到这段。
pub(crate) fn create_tables(conn: &rusqlite::Connection) -> Result<(), AppError> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS task_discussion_turns (
            root TEXT NOT NULL,
            task_id TEXT NOT NULL,
            seq INTEGER NOT NULL,
            role TEXT NOT NULL,
            text TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY (root, task_id, seq)
        );",
    )
    .map_err(error)
}

impl Database {
    /// 一张卡的全部讨论发言，按时间先后。
    pub fn discussion_turns(
        &self,
        root: &str,
        task_id: &str,
    ) -> Result<Vec<DiscussionTurn>, AppError> {
        let conn = crate::database::lock_conn!(self.conn);
        let mut statement = conn
            .prepare(
                "SELECT role, text, created_at FROM task_discussion_turns
                 WHERE root = ?1 AND task_id = ?2 ORDER BY seq",
            )
            .map_err(error)?;
        let rows = statement
            .query_map(params![root, task_id], |row| {
                // 存库的是模型原样回复；读的时候才切成「话」与「表单」。
                // 解析放在这里而不是写入时：解析规则变了，历史记录一起受益，
                // 老库也不用迁移。
                let raw: String = row.get(1)?;
                let (text, form) = crate::tasks::form::take(&raw);
                Ok(DiscussionTurn {
                    role: row.get(0)?,
                    text,
                    created_at: row.get(2)?,
                    form,
                })
            })
            .map_err(error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(error)
    }

    /// 追加一句发言。序号在同一条 SQL 里算，避免两条并发发言拿到同一个 seq。
    pub fn append_discussion_turn(
        &self,
        root: &str,
        task_id: &str,
        role: &str,
        text: &str,
    ) -> Result<DiscussionTurn, AppError> {
        let created_at = now();
        let conn = crate::database::lock_conn!(self.conn);
        conn.execute(
            "INSERT INTO task_discussion_turns (root, task_id, seq, role, text, created_at)
             SELECT ?1, ?2, COALESCE(MAX(seq), 0) + 1, ?3, ?4, ?5
             FROM task_discussion_turns WHERE root = ?1 AND task_id = ?2",
            params![root, task_id, role, text, created_at],
        )
        .map_err(error)?;
        // 原样存，返回的这份按展示口径切好，省得调用方再解一次。
        let (text, form) = crate::tasks::form::take(text);
        Ok(DiscussionTurn {
            role: role.to_string(),
            text,
            created_at,
            form,
        })
    }

    /// 删掉一张卡的全部讨论记录。派生出去的那一轮被关掉时用它。
    pub fn clear_discussion_turns(&self, root: &str, task_id: &str) -> Result<(), AppError> {
        let conn = crate::database::lock_conn!(self.conn);
        conn.execute(
            "DELETE FROM task_discussion_turns WHERE root = ?1 AND task_id = ?2",
            params![root, task_id],
        )
        .map_err(error)?;
        Ok(())
    }
}

/// 写回讨论结论：还没定的问题与已确认的需求。返回写回后的卡片。
///
/// 正常路径不需要人调它：`task_discussion_say` 每轮都会把 Router 给出的结论解析后
/// 写回。保留这条命令是为了给「写回结论」一个独立的原子动作，校验与写盘逻辑
/// 与讨论轮次完全一致。
///
/// 两个字段都传：`None` 表示不动，空字符串表示清掉。只服务还在待办列上的卡，
/// 已经开工或完成的卡由 `discussion-not-pending` 拒绝。
#[tauri::command]
pub fn task_discussion_update(
    state: State<'_, AppState>,
    root: String,
    task_id: String,
    question: Option<String>,
    confirmed: Option<String>,
    fingerprint: String,
) -> Result<TaskDetail, String> {
    let workspace = open(&state, &root)?;
    repository::discuss(
        &workspace,
        &task_id,
        &fingerprint,
        question.as_deref(),
        confirmed.as_deref(),
    )?;
    detail_with_links(&state, &workspace, &task_id)
}

/// 跟 Router 说一句，等它回一句，并把这一轮记进 timeline。
///
/// 顺序是有意的：先把用户这句话记下来，再调 Router。模型超时或网关没起来时，
/// 用户刚打的这段话不会跟着一起丢——重发一次就行，而不是重新写一遍。
#[tauri::command]
pub async fn task_discussion_say(
    app: AppHandle,
    root: String,
    task_id: String,
    message: String,
    fingerprint: String,
) -> Result<TaskDetail, String> {
    let message = checked_message(&message)?;

    // 同步段：标记讨论中、读卡、读历史。State 不能跨 await 持有。
    //
    // 记录用的键取工作区根目录的规范形式：详情页读 timeline 用的就是这个键，
    // 若这里用前端传来的原字符串写入，同一条发言会「写进去了但看不见」。
    let (detail, history, key) = {
        let state = app.state::<AppState>();
        let workspace = open(&state, &root)?;
        let key = workspace.root.to_string_lossy().into_owned();
        repository::discuss(&workspace, &task_id, &fingerprint, None, None)?;
        let detail = detail_with_links(&state, &workspace, &task_id)?;
        let history = state
            .db
            .discussion_turns(&key, &task_id)
            .map_err(|e| e.to_string())?;
        (detail, history, key)
    };

    let db = { app.state::<AppState>().db.clone() };
    db.append_discussion_turn(&key, &task_id, ROLE_USER, &message)
        .map_err(|e| e.to_string())?;

    let reply = crate::super_agent::discussion::reply(&app, &detail, &history, &message).await?;
    db.append_discussion_turn(&key, &task_id, ROLE_ROUTER, &reply)
        .map_err(|e| e.to_string())?;

    // 结论从对话里来，不让人再手抄一遍：Router 每一轮末尾按固定格式给出结论，
    // 这里解析后写回同一张卡。写不进去（模型没按格式、卡片被外部改过）只影响
    // 卡片上的结论，不该把已经拿到的这一轮回复一起丢掉。
    let conclusion = crate::super_agent::discussion::parse_conclusion(&reply);
    if conclusion.question.is_some() || conclusion.confirmed.is_some() {
        let state = app.state::<AppState>();
        match open(&state, &root) {
            Ok(workspace) => {
                if let Err(error) = repository::discuss(
                    &workspace,
                    &task_id,
                    &detail.task.fingerprint,
                    conclusion.question.as_deref(),
                    conclusion.confirmed.as_deref(),
                ) {
                    log::warn!("discussion conclusion not written back: {error}");
                }
            }
            Err(error) => log::warn!("discussion conclusion skipped: {error}"),
        }
    }

    let state = app.state::<AppState>();
    let workspace = open(&state, &root)?;
    detail_with_links(&state, &workspace, &task_id)
}

/// 一句话不能空、不能超长。
fn checked_message(message: &str) -> Result<String, String> {
    let text = message.trim();
    if text.is_empty() {
        return Err("empty-discussion-message".into());
    }
    if text.chars().count() > MAX_TURN_CHARS {
        return Err("invalid-discussion-message".into());
    }
    Ok(text.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn turns_are_appended_in_order_and_scoped_to_one_card() {
        let db = Database::memory().expect("memory db");

        db.append_discussion_turn("/repo", "TASK-1", ROLE_USER, "先讨论清楚")
            .expect("first");
        db.append_discussion_turn("/repo", "TASK-1", ROLE_ROUTER, "可以这样做")
            .expect("second");
        db.append_discussion_turn("/repo", "TASK-2", ROLE_USER, "另一张卡")
            .expect("other card");

        let turns = db.discussion_turns("/repo", "TASK-1").expect("turns");
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].role, ROLE_USER);
        assert_eq!(turns[0].text, "先讨论清楚");
        assert_eq!(turns[1].role, ROLE_ROUTER);
        assert_eq!(turns[1].text, "可以这样做");

        let other = db.discussion_turns("/repo", "TASK-2").expect("other");
        assert_eq!(other.len(), 1);
        assert_eq!(other[0].text, "另一张卡");
    }

    #[test]
    fn clearing_one_card_keeps_the_other() {
        let db = Database::memory().expect("memory db");
        db.append_discussion_turn("/repo", "TASK-1", ROLE_USER, "a")
            .expect("a");
        db.append_discussion_turn("/repo", "TASK-2", ROLE_USER, "b")
            .expect("b");

        db.clear_discussion_turns("/repo", "TASK-1").expect("clear");

        assert!(db
            .discussion_turns("/repo", "TASK-1")
            .expect("t")
            .is_empty());
        assert_eq!(db.discussion_turns("/repo", "TASK-2").expect("t").len(), 1);
    }

    #[test]
    fn a_router_turn_carries_its_form_out_of_the_database() {
        let db = Database::memory().expect("memory db");
        db.append_discussion_turn(
            "/repo",
            "TASK-1",
            ROLE_ROUTER,
            "还缺两个信息。\n```phi-form\n{\"fields\":[{\"id\":\"source\",\"label\":\"新闻从哪里取？\"}]}\n```\n【还没定的问题】新闻从哪里取？",
        )
        .expect("turn");

        let turns = db.discussion_turns("/repo", "TASK-1").expect("turns");
        assert_eq!(turns.len(), 1);
        // 存的是原样回复，读出来的是「话 + 表单」两段，不再带着围栏与 JSON
        assert!(!turns[0].text.contains("phi-form"));
        assert!(turns[0].text.contains("【还没定的问题】"));
        let form = turns[0].form.as_ref().expect("form");
        assert_eq!(form.fields[0].label, "新闻从哪里取？");
    }

    #[test]
    fn an_empty_or_oversized_message_is_rejected_before_anything_is_written() {
        assert_eq!(
            checked_message("   "),
            Err("empty-discussion-message".into())
        );
        let long = "字".repeat(MAX_TURN_CHARS + 1);
        assert_eq!(
            checked_message(&long),
            Err("invalid-discussion-message".into())
        );
        assert_eq!(checked_message(" 讨论 ").as_deref(), Ok("讨论"));
    }
}
