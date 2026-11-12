//! 任务看板：直接读写仓库里的 Backlog.md 任务文件。
//!
//! 职责边界（阶段一）：
//! - 任务与配置属于用户仓库，格式与 `backlog` CLI 完全一致，双向可读写；
//! - phi 只提供看板视图、把任务一键变成终端会话、把会话与用量回挂到任务；
//! - 任务 ↔ 会话的关联是本机事实，存 sqlite（见 [`links`]），不进 git。

pub(crate) mod board;
pub(crate) mod commands;
pub(crate) mod document;
pub(crate) mod frontmatter;
mod links;
pub(crate) mod model;
pub(crate) mod repository;

/// 建表入口：由 `database::schema` 在初始化与迁移时调用。
pub(crate) fn create_tables(conn: &rusqlite::Connection) -> Result<(), crate::error::AppError> {
    links::create_tables(conn)
}
