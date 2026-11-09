//! 「已写入客户端的暴露名」账本。
//!
//! 只靠当前路由配置清理旧名字是不够的：用户把别名 `work-github` 改成 `gh`、
//! 或者直接删掉整条路由之后，配置里已经推不出那个旧名字了，而它仍然留在
//! 客户端的 live 文件里。所以同步时把「这次写进去的名字」记下来，下一次投影
//! 先按账本清掉上一轮的名字，再写新的。
//!
//! 账本是可丢的派生状态：损坏、缺失都按「没有历史」处理，最坏情况是某次改名
//! 留下一条旧条目，用户再触发一次同步即可清掉。

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::AppError;

/// 账本文件名（位于配置目录）。
pub const STATE_FILE: &str = "mcp-router-state.json";

const CURRENT_VERSION: u32 = 1;
const MAX_RECORDS_PER_APP: usize = 1024;

fn default_version() -> u32 {
    CURRENT_VERSION
}

/// 客户端 → 服务器 id → 上一轮写入的暴露名。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct AppliedExposures {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub applied: BTreeMap<String, BTreeMap<String, String>>,
}

impl Default for AppliedExposures {
    fn default() -> Self {
        Self {
            version: CURRENT_VERSION,
            applied: BTreeMap::new(),
        }
    }
}

impl AppliedExposures {
    /// 读取账本；缺失、损坏、版本不认识都按空账本处理。
    pub fn load(path: &Path) -> Self {
        let Ok(raw) = fs::read_to_string(path) else {
            return Self::default();
        };
        match serde_json::from_str::<Self>(&raw) {
            Ok(state) if state.version == CURRENT_VERSION => state,
            Ok(state) => {
                log::warn!(
                    "MCP 路由账本版本为 {}，当前支持 {CURRENT_VERSION}，按空账本处理",
                    state.version
                );
                Self::default()
            }
            Err(err) => {
                log::warn!("MCP 路由账本无法解析，按空账本处理: {err}");
                Self::default()
            }
        }
    }

    /// 原子写盘。
    pub fn save(&self, path: &Path) -> Result<(), AppError> {
        let serialized = serde_json::to_string_pretty(self)
            .map_err(|source| AppError::JsonSerialize { source })?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|err| AppError::io(parent, err))?;
        }
        crate::config::atomic_write(path, format!("{serialized}\n").as_bytes())
    }

    /// 上一轮写入这个客户端/服务器的名字。
    pub fn previous(&self, app: &str, server_id: &str) -> Option<&str> {
        self.applied
            .get(app)
            .and_then(|servers| servers.get(server_id))
            .map(String::as_str)
    }

    /// 记录这一轮写入的名字。
    pub fn record(&mut self, app: &str, server_id: &str, exposed_id: &str) {
        let servers = self.applied.entry(app.to_string()).or_default();
        if servers.len() >= MAX_RECORDS_PER_APP && !servers.contains_key(server_id) {
            log::warn!("MCP 路由账本条目过多，忽略 {server_id} 的记录");
            return;
        }
        servers.insert(server_id.to_string(), exposed_id.to_string());
    }

    /// 删除一个服务器在单个客户端上的记录。
    pub fn forget(&mut self, app: &str, server_id: &str) {
        if let Some(servers) = self.applied.get_mut(app) {
            servers.remove(server_id);
            if servers.is_empty() {
                self.applied.remove(app);
            }
        }
    }

    /// 删除一个服务器在所有客户端上的记录（服务器被删除时用）。
    pub fn forget_server(&mut self, server_id: &str) {
        for servers in self.applied.values_mut() {
            servers.remove(server_id);
        }
        self.applied.retain(|_, servers| !servers.is_empty());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_and_reports_previous_names_per_app() {
        let mut applied = AppliedExposures::default();
        assert_eq!(applied.previous("claude", "github"), None);
        applied.record("claude", "github", "work-github");
        applied.record("codex", "github", "github");
        assert_eq!(applied.previous("claude", "github"), Some("work-github"));
        assert_eq!(applied.previous("codex", "github"), Some("github"));
        assert_eq!(applied.previous("gemini", "github"), None);
    }

    #[test]
    fn record_overwrites_and_forget_clears_every_app() {
        let mut applied = AppliedExposures::default();
        applied.record("claude", "github", "work-github");
        applied.record("claude", "github", "gh");
        applied.record("codex", "github", "github");
        applied.record("codex", "fs", "fs");
        assert_eq!(applied.previous("claude", "github"), Some("gh"));
        applied.forget_server("github");
        assert_eq!(applied.previous("claude", "github"), None);
        assert_eq!(applied.previous("codex", "github"), None);
        assert_eq!(applied.previous("codex", "fs"), Some("fs"));
    }

    #[test]
    fn roundtrips_through_disk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(STATE_FILE);
        let mut applied = AppliedExposures::default();
        applied.record("claude", "github", "gh");
        applied.save(&path).unwrap();
        assert_eq!(AppliedExposures::load(&path), applied);
    }

    #[test]
    fn broken_state_is_an_empty_ledger() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(STATE_FILE);
        fs::write(&path, "{nope").unwrap();
        assert_eq!(AppliedExposures::load(&path), AppliedExposures::default());
        fs::write(&path, r#"{"version":9,"applied":{"claude":{"a":"b"}}}"#).unwrap();
        assert_eq!(AppliedExposures::load(&path), AppliedExposures::default());
    }
}
