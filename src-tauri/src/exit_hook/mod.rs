//! `session-exit` 钩子的宿主实现：接棒（Session Baton）的能力侧。
//!
//! ## 为什么能力在宿主、策略在插件
//!
//! 「跑到 80% 挂了」的关键事实是**托管进程自己的退出码**：只有握着 PTY 的人
//! 才分得清 agent 是跑完了还是刚死。插件沙箱里没有进程、没有文件系统、没有
//! 终端句柄，所以它拿不到这个事实，也无法重启会话。
//!
//! 因此分工是固定的：
//! - 宿主（本模块）：记账 → 收证据 → 判决 → 写交接单 → 重启会话，全部是能力；
//! - 插件（`session-exit` 钩子）：拿到结构化事件，决定「接不接、怎么接」，是策略。
//!
//! 插件可以做取舍，但不能越权：宿主的次数上限、无进展保护、目标存在性校验
//! 在插件决策之后仍然生效。没装插件时回落到内置策略，功能不会因此消失。
//!
//! ## 分层
//!
//! - [`journal`]：托管终端里 CLI 的退出记账（唯一事实来源）；
//! - [`evidence`]：退出记账 + 代理侧失败 + 会话侧错误标记；
//! - [`classify`]：证据 → 跑完了 / 被中断 / 挂了（额度、上下文、供应商、崩溃）；
//! - [`plan`]：策略与历史 → 续跑还是停；
//! - [`handoff`]：交接单（已改文件、已验证结论、卡住的步骤、剩余待办）；
//! - [`service`]：监听 journal、问插件、落库、拉起续跑会话、发事件；
//! - [`store`]：记录与代理侧只读查询。

pub(crate) mod classify;
pub(crate) mod commands;
pub(crate) mod evidence;
pub(crate) mod handoff;
pub(crate) mod journal;
pub(crate) mod plan;
pub(crate) mod service;
pub(crate) mod store;

use serde::{Deserialize, Serialize};

/// 托管终端启动时注入的三个环境变量，由 `terminal/session.sh` 读取。
pub(crate) const JOURNAL_ENV: &str = "PHI_BATON_JOURNAL";
pub(crate) const TERMINAL_ENV: &str = "PHI_BATON_ID";
pub(crate) const APP_ENV: &str = "PHI_BATON_APP";

/// journal 监听周期。退出是低频事件，2 秒足够快又不会烧 CPU。
pub(crate) const POLL_INTERVAL_MS: u64 = 2_000;
/// 单行上限：超过就不认（cwd 里有换行等异常情况），避免脏行撑爆内存。
pub(crate) const MAX_JOURNAL_LINE_BYTES: usize = 8_192;
/// journal 文件超过这个大小就整体截断重来（只保留最近的记账）。
pub(crate) const MAX_JOURNAL_BYTES: u64 = 1_048_576;
/// 代理侧证据回看窗口：会话退出前 30 分钟内的失败请求才算同一次事故。
pub(crate) const PROXY_WINDOW_SECS: i64 = 1_800;
/// 会话文件回看的最大跨度（秒）：找「这个目录最近一次的会话」。
pub(crate) const SESSION_LOOKBACK_SECS: i64 = 86_400;
/// 只读会话文件尾部的字节数，够覆盖最后几条消息。
pub(crate) const SESSION_TAIL_BYTES: u64 = 131_072;
/// 代理侧失败证据最多取多少条。
pub(crate) const PROXY_FAILURE_LIMIT: usize = 20;
/// 交接单里最多列多少个改动文件，超出只写计数。
pub(crate) const MAX_HANDOFF_FILES: usize = 40;
/// 交接单里最多列几条证据。
pub(crate) const MAX_HANDOFF_EVIDENCE: usize = 6;
/// 读交接单的上限（字节），防止界面被巨大文件拖垮。
pub(crate) const MAX_HANDOFF_BYTES: u64 = 262_144;
/// git 查询的超时。工作区可能是网络盘，不能让一次接棒卡死。
pub(crate) const GIT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
/// 内置策略插件：没有它，接棒也照常工作（回落到本模块的默认策略）。
pub(crate) const BUNDLED_PLUGIN_ID: &str = "session-baton";

/// 内置策略插件的两个文件，编译进二进制后再落地到用户插件目录。
const BUNDLED_PLUGIN_FILES: [(&str, &str); 2] = [
    (
        "plugin.json",
        include_str!("../../resources/plugins/session-baton/plugin.json"),
    ),
    (
        "main.js",
        include_str!("../../resources/plugins/session-baton/main.js"),
    ),
];

/// 接棒策略。`auto_resume=false` 时只记录不重启（由 UI 或插件决定要不要手动接）。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Policy {
    pub auto_resume: bool,
    pub max_attempts: u32,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            auto_resume: true,
            max_attempts: 2,
        }
    }
}

impl Policy {
    /// 上限本身也要有界：策略来自 sqlite，可能被手改过。
    pub fn sanitized(self) -> Self {
        Self {
            auto_resume: self.auto_resume,
            max_attempts: self.max_attempts.clamp(1, 5),
        }
    }
}

/// 一次「跑挂了」的完整记录。前端据此展示，也据此决定手动接棒。
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attempt {
    pub id: String,
    pub terminal_id: String,
    pub app_id: String,
    pub cwd: String,
    pub exit_code: i32,
    /// `quota` / `context` / `provider` / `crash`
    pub failure_kind: String,
    /// 人话原因，直接展示。
    pub reason: String,
    /// 是否已经接棒。
    pub resumed: bool,
    /// 接棒后新开的终端会话 id。
    pub resume_terminal_id: Option<String>,
    pub handoff_path: Option<String>,
    /// 采纳了哪个插件的决策（`None` 表示走内置策略）。
    pub decided_by: Option<String>,
    pub created_at: i64,
}

/// 供 UI 展示的一次查询结果。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub policy: Policy,
    pub attempts: Vec<Attempt>,
}

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

/// journal、交接单、插件都在应用配置目录下，跟数据库同源，换机不跟仓库走。
pub(crate) fn data_dir() -> std::path::PathBuf {
    crate::config::get_app_config_dir().join("baton")
}

pub(crate) fn journal_path() -> std::path::PathBuf {
    data_dir().join("journal.log")
}

pub(crate) fn handoff_dir() -> std::path::PathBuf {
    data_dir().join("handoff")
}

pub(crate) fn plugins_dir() -> std::path::PathBuf {
    crate::config::get_app_config_dir().join("plugins")
}

/// 把内置策略插件落到用户插件目录。
///
/// 只补缺，不覆盖：用户改过或停用过的插件目录原样保留。装不上不是错误——
/// 接棒没有插件也能跑，只是没有插件那层策略。
pub(crate) fn install_bundled_plugin() {
    install_bundled_plugin_into(&plugins_dir());
}

fn install_bundled_plugin_into(root: &std::path::Path) {
    let directory = root.join(BUNDLED_PLUGIN_ID);
    if directory.join("plugin.json").exists() {
        return;
    }
    if let Err(error) = std::fs::create_dir_all(&directory) {
        log::warn!("[baton] 内置插件目录创建失败，继续用内置策略: {error}");
        return;
    }
    for (name, content) in BUNDLED_PLUGIN_FILES {
        if let Err(error) = std::fs::write(directory.join(name), content) {
            log::warn!("[baton] 内置插件文件写入失败（{name}）: {error}");
            return;
        }
    }
    log::info!("[baton] 已安装内置策略插件 {BUNDLED_PLUGIN_ID}");
}

/// 建表入口：由 `database::schema` 在初始化与迁移时调用。
pub(crate) fn create_tables(conn: &rusqlite::Connection) -> Result<(), crate::error::AppError> {
    store::create_tables(conn)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn policy_defaults_are_bounded() {
        let policy = Policy::default();
        assert_eq!(policy.clone().sanitized(), policy);
        assert_eq!(
            Policy {
                auto_resume: true,
                max_attempts: 0
            }
            .sanitized()
            .max_attempts,
            1
        );
        assert_eq!(
            Policy {
                auto_resume: true,
                max_attempts: u32::MAX
            }
            .sanitized()
            .max_attempts,
            5
        );
    }

    #[test]
    fn bundled_plugin_ships_a_manifest_and_a_script() {
        let manifest = crate::plugin::PluginManifest::parse(BUNDLED_PLUGIN_FILES[0].1)
            .expect("内置插件清单必须能通过校验");
        assert_eq!(manifest.id, BUNDLED_PLUGIN_ID);
        assert!(manifest.hooks_session_exit());
        assert!(!manifest.hooks_request());
        assert!(BUNDLED_PLUGIN_FILES[1].1.contains("onSessionExit"));
    }

    #[test]
    fn installing_the_bundled_plugin_never_overwrites_user_edits() {
        let dir = tempfile::tempdir().unwrap();
        let directory = dir.path().join(BUNDLED_PLUGIN_ID);
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("plugin.json"), "{\"id\":\"mine\"}").unwrap();

        install_bundled_plugin_into(dir.path());
        assert_eq!(
            std::fs::read_to_string(directory.join("plugin.json")).unwrap(),
            "{\"id\":\"mine\"}",
            "用户改过的清单不能被覆盖"
        );
        assert!(!directory.join("main.js").exists());

        std::fs::remove_dir_all(&directory).unwrap();
        install_bundled_plugin_into(dir.path());
        assert!(directory.join("plugin.json").exists());
        assert!(directory.join("main.js").exists());
    }
}
