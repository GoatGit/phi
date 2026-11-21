//! Auto-router（super-agent）：看板任务的自动调度。
//!
//! 分层与职责：
//!
//! | 层 | 文件 | 有什么 |
//! |---|---|---|
//! | 数据 | [`model`] / [`store`] | DTO 与 sqlite 事实（运行态、租约、trace） |
//! | 读 | [`snapshot`] / [`prefilter`] | 把看板压成候选，再按确定性规则剔除 |
//! | 判断 | [`judge`] / [`episode`] / [`sidecar`] | 谓词（Jev）、规则版循环、pi sidecar 的协议与闸门 |
//! | 执行 | [`tick`] / [`worker`] | 结算决策、起停 worker、写运行态 |
//! | 边界 | [`commands`] / [`runtime`] | 前端命令与后台定时器 |
//!
//! 设计依据见 `docs/design/super-agent-router.md`。

mod agents;
pub(crate) mod commands;
pub(crate) mod discussion;
pub(crate) mod episode;
pub(crate) mod judge;
pub(crate) mod model;
pub(crate) mod prefilter;
pub(crate) mod proposals;
pub(crate) mod runtime;
pub(crate) mod sidecar;
pub(crate) mod snapshot;
pub(crate) mod store;
pub(crate) mod studio;
pub(crate) mod tick;
pub(crate) mod worker;

#[cfg(test)]
mod tests;

/// 建表入口：由 `database::schema` 在初始化与迁移时调用。
pub(crate) fn create_tables(conn: &rusqlite::Connection) -> Result<(), crate::error::AppError> {
    store::create_tables(conn)
}
