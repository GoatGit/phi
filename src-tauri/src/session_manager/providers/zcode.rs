//! ZCode（OpenCode 衍生桌面端）会话提供方
//!
//! 会话存在 `~/.zcode/cli/db/db.sqlite` 的 `session` / `message` 表里，
//! 正文在 `part` 表。每个会话用「db 路径 + `:` + 会话 id」的虚拟路径表示
//! （SQLite 源约定，与 opencode/hermes 的 `sqlite:` 前缀同思路，这里沿用前缀形式）。
//!
//! 子会话（subagent）通过 `parent_id` 挂到宿主会话：列表里只展示无父的
//! 根会话；读取时按宿主 + 全部子会话合并消息（按时间排序）。

use rusqlite::Connection;
use std::collections::HashMap;
use std::path::PathBuf;

use crate::session_manager::providers::opencode::parse_sqlite_source;
use crate::session_manager::{SessionMessage, SessionMeta};

use super::blocks::assign_turn_ids;
use super::opencode_blocks::{message_from_parts, PartLocator};

pub fn zcode_db_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join(".zcode")
        .join("cli")
        .join("db")
}

pub fn zcode_db_path() -> PathBuf {
    zcode_db_dir().join("db.sqlite")
}

fn open_read_only(path: &PathBuf) -> Result<Connection, String> {
    Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("Failed to open ZCode database: {e}"))
}

/// 会话列表：只取根会话（parent_id 为空），标题缺失时回退首条用户消息
pub fn scan_sessions() -> Vec<SessionMeta> {
    let db_path = zcode_db_path();
    if !db_path.exists() {
        return Vec::new();
    }
    let conn = match open_read_only(&db_path) {
        Ok(conn) => conn,
        Err(e) => {
            log::warn!("[ZCODE-SESSIONS] {e}");
            return Vec::new();
        }
    };

    // `message` 表没有 role 列，角色在 data JSON 里；标题回收第一条真实用户
    // 文本（正文存在 `part` 表），合成输入（visibility=model-only）不参与。
    let sql = "SELECT s.id, \
               COALESCE(NULLIF(s.title, ''), SUBSTR(\
                   (SELECT json_extract(p.data, '$.text') \
                    FROM part p JOIN message d ON d.id = p.message_id \
                    WHERE p.session_id = s.id \
                      AND json_extract(d.data, '$.role') = 'user' \
                      AND json_extract(p.data, '$.type') = 'text' \
                      AND COALESCE(json_extract(d.data, '$.metadata.visibility'), '') \
                          <> 'model-only' \
                    ORDER BY p.time_created, p.sequence LIMIT 1), 1, 120), s.id) AS title, \
               s.directory, \
               MIN(m.time_created) AS created, \
               MAX(s.time_updated, COALESCE(MAX(m.time_updated), s.time_updated)) AS last_active \
               FROM session s \
               LEFT JOIN message m ON m.session_id = s.id \
               WHERE COALESCE(s.parent_id, '') = '' \
               GROUP BY s.id \
               ORDER BY last_active DESC";
    let mut stmt = match conn.prepare(sql) {
        Ok(stmt) => stmt,
        Err(e) => {
            log::warn!("[ZCODE-SESSIONS] 查询失败: {e}");
            return Vec::new();
        }
    };

    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, Option<i64>>(3)?,
            row.get::<_, Option<i64>>(4)?,
        ))
    });

    let mut sessions = Vec::new();
    if let Ok(rows) = rows {
        for row in rows.flatten() {
            let (id, title, directory, created, last_active) = row;
            // 会话可能没有消息（LEFT JOIN 产生 NULL）：过滤空会话
            if created.is_none() && last_active.is_none() {
                continue;
            }
            sessions.push(SessionMeta {
                provider_id: "zcode".to_string(),
                session_id: id.clone(),
                title: Some(title),
                summary: None,
                project_dir: directory,
                created_at: created.map(|ms| ms / 1000),
                last_active_at: last_active.map(|ms| ms / 1000),
                // SQLite 源用 "sqlite:<db>:<id>" 形式（parse_sqlite_source 的分隔符是
                // ":ses_"，写成"#"会让所有会话都读不出正文）
                source_path: Some(format!("sqlite:{}:{}", db_path.display(), id)),
                resume_command: None, // 桌面应用无 resume 命令
            });
        }
    }
    sessions
}

/// 读取某会话的全部消息（宿主 + 子会话按时间合并）
pub fn load_messages_sqlite(source: &str) -> Result<Vec<SessionMessage>, String> {
    let (db_path, session_id) = parse_sqlite_source(source)
        .ok_or_else(|| format!("Invalid SQLite source reference: {source}"))?;

    let conn = open_read_only(&db_path)?;

    // 找出该会话及其全部子会话（parent_id 直接挂宿主）
    let mut session_ids = vec![session_id.clone()];
    {
        let mut stmt = conn
            .prepare("SELECT id FROM session WHERE parent_id = ?1")
            .map_err(|e| e.to_string())?;
        let children: Vec<String> = stmt
            .query_map([&session_id], |row| row.get(0))
            .map_err(|e| e.to_string())?
            .flatten()
            .collect();
        session_ids.extend(children);
    }

    let mut messages: Vec<SessionMessage> = Vec::new();
    for sid in &session_ids {
        messages.extend(load_session_messages(&conn, sid)?);
    }

    messages.sort_by_key(|m| m.ts.unwrap_or(0));
    assign_turn_ids(&mut messages);
    Ok(messages)
}

/// 读一个会话的消息：`message` 表提供角色、时间与 meta，正文在 `part` 表。
///
/// `message` 表**没有** role 列（角色只在 data JSON 里），因此不能在 SQL 里按
/// role 过滤；正文也不能从 `message.data.parts` 取，那里根本没有 parts。
fn load_session_messages(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<SessionMessage>, String> {
    let mut parts_map: HashMap<String, Vec<(PartLocator, serde_json::Value)>> = HashMap::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT id, message_id, data FROM part WHERE session_id = ?1 \
                 ORDER BY time_created ASC, sequence ASC, id ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([session_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?;

        for row in rows.flatten() {
            let (part_id, message_id, data) = row;
            let Ok(part) = serde_json::from_str::<serde_json::Value>(&data) else {
                continue;
            };
            parts_map.entry(message_id).or_default().push((
                PartLocator::Sqlite {
                    table: "part",
                    id: part_id,
                    base: String::new(),
                },
                part,
            ));
        }
    }

    let mut stmt = conn
        .prepare(
            "SELECT id, time_created, data FROM message WHERE session_id = ?1 \
             ORDER BY time_created ASC, id ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([session_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    let mut messages: Vec<SessionMessage> = Vec::new();
    for row in rows.flatten() {
        let (message_id, created_ms, data_json) = row;
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&data_json) else {
            continue;
        };
        let role = value.get("role").and_then(|r| r.as_str()).unwrap_or("");
        if !matches!(role, "user" | "assistant") {
            continue;
        }
        // magpie 同款约定：跳过 ZCode 的合成输入（子代理回灌内容）
        if value
            .pointer("/semantics/origin")
            .and_then(|o| o.as_str())
            .is_some_and(|o| o != "real_user")
        {
            continue;
        }

        let parts = parts_map.remove(&message_id).unwrap_or_default();
        // ts 是毫秒（前端直接 new Date(ts)），与 opencode 的 SQLite 路径一致
        let message = message_from_parts(role, Some(message_id), Some(created_ms), &value, &parts);
        if !message.is_empty() {
            messages.push(message);
        }
    }

    Ok(messages)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 造一个与真实 `~/.zcode/cli/db/db.sqlite` 同形的库：`message` 无 role 列，
    /// 正文在 `part` 表。回归靶子：SQL 里按 role 过滤、或从 data.parts 取正文，
    /// 都会让会话列表/正文全部为空或报错。
    fn fixture_db() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("temp dir");
        let db_path = dir.path().join("db.sqlite");
        let conn = Connection::open(&db_path).expect("create db");
        conn.execute_batch(
            "CREATE TABLE session (
                 id text primary key,
                 parent_id text,
                 title text not null default '',
                 directory text not null default '',
                 time_created integer not null,
                 time_updated integer not null
             );
             CREATE TABLE message (
                 id text primary key,
                 session_id text not null,
                 time_created integer not null,
                 time_updated integer not null,
                 data text not null,
                 sequence integer
             );
             CREATE TABLE part (
                 id text primary key,
                 message_id text not null,
                 session_id text not null,
                 time_created integer not null,
                 time_updated integer not null,
                 data text not null,
                 sequence integer
             );",
        )
        .expect("create schema");
        conn.execute(
            "INSERT INTO session (id, parent_id, title, directory, time_created, time_updated) \
             VALUES ('ses_root', NULL, '', '/tmp/project', 1000, 4000)",
            [],
        )
        .expect("insert session");

        let insert_message = |id: &str, created: i64, data: serde_json::Value| {
            conn.execute(
                "INSERT INTO message (id, session_id, time_created, time_updated, data) \
                 VALUES (?1, 'ses_root', ?2, ?2, ?3)",
                rusqlite::params![id, created, data.to_string()],
            )
            .expect("insert message");
        };
        let insert_part = |id: &str, message_id: &str, created: i64, data: serde_json::Value| {
            conn.execute(
                "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) \
                 VALUES (?1, ?2, 'ses_root', ?3, ?3, ?4)",
                rusqlite::params![id, message_id, created, data.to_string()],
            )
            .expect("insert part");
        };

        insert_message(
            "msg_user",
            2000,
            json!({"role": "user", "time": {"created": 2000}, "semantics": {"origin": "real_user"}}),
        );
        insert_part(
            "prt_user",
            "msg_user",
            2000,
            json!({"type": "text", "text": "你好"}),
        );

        insert_message(
            "msg_agent",
            3000,
            json!({"role": "assistant", "time": {"created": 3000, "completed": 3500}, "modelId": "GLM-5.3-Flash"}),
        );
        insert_part(
            "prt_agent",
            "msg_agent",
            3000,
            json!({"type": "text", "text": "答复"}),
        );

        // 合成输入（子代理回灌）：不应当出现在正文里
        insert_message(
            "msg_synth",
            4000,
            json!({"role": "user", "time": {"created": 4000}, "semantics": {"origin": "subagent"}}),
        );
        insert_part(
            "prt_synth",
            "msg_synth",
            4000,
            json!({"type": "text", "text": "回灌"}),
        );

        drop(conn);
        (dir, db_path)
    }

    #[test]
    fn load_messages_sqlite_reads_parts_without_role_column() {
        let (_dir, db_path) = fixture_db();
        let source = format!("sqlite:{}:ses_root", db_path.display());

        let messages = load_messages_sqlite(&source).expect("正文读取不该因 role 列失败");

        assert_eq!(messages.len(), 2, "合成输入应当被跳过");
        assert_eq!(messages[0].role, "user");
        assert!(
            messages[0].content.contains("你好"),
            "{}",
            messages[0].content
        );
        assert_eq!(messages[0].ts, Some(2000), "ts 必须是毫秒");
        assert_eq!(messages[1].role, "assistant");
        assert!(
            messages[1].content.contains("答复"),
            "{}",
            messages[1].content
        );
        assert_eq!(messages[1].turn_id.as_deref(), Some("t1"));
    }

    #[test]
    fn scan_sessions_source_path_round_trips_through_parser() {
        // scan_sessions 拼出来的 source 必须能被 parse_sqlite_source 解析回来，
        // 否则前端拿到的每个会话都读不出正文。
        let source = format!("sqlite:{}:{}", "/tmp/zcode/db.sqlite", "ses_abc");
        let (path, id) = parse_sqlite_source(&source).expect("source 必须可解析");
        assert_eq!(path, PathBuf::from("/tmp/zcode/db.sqlite"));
        assert_eq!(id, "ses_abc");
    }
}
