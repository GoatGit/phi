//! ZCode（OpenCode 衍生桌面端）会话提供方
//!
//! 会话存在 `~/.zcode/cli/db/db.sqlite` 的 `session` / `message` 表里，
//! 每个会话用「db 路径 + `#` + 会话 id」的虚拟路径表示（SQLite 源约定，
//! 与 opencode/hermes 的 `sqlite:` 前缀同思路，这里沿用前缀形式）。
//!
//! 子会话（subagent）通过 `parent_id` 挂到宿主会话：列表里只展示无父的
//! 根会话；读取时按宿主 + 全部子会话合并消息（按时间排序）。

use rusqlite::Connection;
use std::path::PathBuf;

use crate::session_manager::providers::opencode::parse_sqlite_source;
use crate::session_manager::{SessionMessage, SessionMeta};

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

    let sql = "SELECT s.id, \
               COALESCE(NULLIF(s.title, ''), SUBSTR(\
                   (SELECT d.data FROM message d \
                    WHERE d.session_id = s.id AND d.role = 'user' \
                    ORDER BY d.time_created LIMIT 1), 1, 120), s.id) AS title, \
               s.directory, \
               MIN(m.time_created) AS created, \
               MAX(s.time_updated, COALESCE(MAX(m.time_updated), s.time_updated)) AS last_active \
               FROM session s \
               LEFT JOIN message m ON m.session_id = s.id \
               WHERE COALESCE(s.parent_id, '') = '' \
               GROUP BY s.id \
               ORDER BY last_active DESC";
    let mut stmt = match conn.prepare(&sql) {
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
                // SQLite 源用 "sqlite:<db>#<id>" 形式（与 opencode/hermes 一致）
                source_path: Some(format!("sqlite:{}#{}", db_path.display(), id)),
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
        let mut stmt = conn
            .prepare(
                "SELECT data FROM message \
                 WHERE session_id = ?1 AND role IN ('user', 'assistant') \
                 ORDER BY time_created",
            )
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map([sid], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;

        for row in rows {
            let data_json = row.map_err(|e| e.to_string())?;
            let value: serde_json::Value = match serde_json::from_str(&data_json) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let role = value.get("role").and_then(|r| r.as_str()).unwrap_or("");
            // magpie 同款约定：跳过 ZCode 的合成输入（子代理回灌内容）
            if value
                .pointer("/semantics/origin")
                .and_then(|o| o.as_str())
                .is_some_and(|o| o != "real_user")
            {
                continue;
            }

            let created_ms = value
                .pointer("/time/created")
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            let ts = if created_ms > 0 {
                Some(created_ms / 1000)
            } else {
                None
            };
            // 内容投影：取 parts 里第一段 text（与 project_content 的简化口径一致）
            let content = value
                .pointer("/parts/0/text")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            messages.push(SessionMessage {
                role: role.to_string(),
                content,
                ts,
                ..Default::default()
            });
        }
    }

    messages.sort_by_key(|m| m.ts.unwrap_or(0));
    Ok(messages)
}
