//! 编排接力：把「谁实现、谁验收、谁复查」写进卡片，并由 PHI 判定结果。
//!
//! 这一版只做报告里的 MVP（L2 回写 + 门 2/门 3 判定，人工放行）：
//! - 契约写在卡片 `phi:` 块里（[contract]），卡片的 `phi_verdict` 块记当前结论；
//! - 门 2 跑卡片声明的验收命令并核对改动边界（[gate::run_gate2]）；
//! - 门 3 校验复查意见里的证据锚点（[gate::run_gate3] + [review]）；
//! - PHI 不调度 agent、不替人放行，也不另存一份任务状态。
//!
//! 没有做的部分（下一轮）：由 run 记录驱动的交接、并行分工、动态选模型，
//! 以及按 token 计的预算闸门。

pub(crate) mod commands;
pub(crate) mod contract;
mod gate;
mod glob;
pub(crate) mod model;
pub(crate) mod review;
mod verdict;

/// 建表入口：由 `database::schema` 在初始化与迁移时调用。
pub(crate) fn create_tables(conn: &rusqlite::Connection) -> Result<(), crate::error::AppError> {
    verdict::create_tables(conn)
}
