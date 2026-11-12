//! 教训库（Failure Museum）：把失败会话沉淀成仓库级的「禁区清单」。
//!
//! 四段流水线，前三段完全不调模型：
//! - 采集 [`detect`]：从本机会话记录里捞出「工具调用失败」这一事实，顺带带上同一会话
//!   里改过的文件路径；
//! - 判定 + 提炼 [`render`]：按固定模板写成一句人话，同一条反复出现就只累加命中次数；
//! - 注入 [`inject`]：写进仓库 `AGENTS.md` 的受控块，默认关闭，开着才动用户的文件。
//!
//! 三个阀门都在 [`render`] 里：路径标签只在命中时用（[`render::matches`]）、注入有字符
//! 预算、块内顺序按首次出现的顺序追加而不是每次重排（prompt cache 靠前缀稳定）。
//!
//! 教训本身属于本机事实（哪次会话炸的），存 sqlite 而不进 git；写进 `AGENTS.md` 的那
//! 一小块是唯一会落到仓库里的东西。

pub(crate) mod commands;
mod detect;
mod inject;
pub(crate) mod model;
mod render;
mod store;

/// 建表入口：由 `database::schema` 在初始化与迁移时调用。
pub(crate) fn create_tables(conn: &rusqlite::Connection) -> Result<(), crate::error::AppError> {
    store::create_tables(conn)
}
