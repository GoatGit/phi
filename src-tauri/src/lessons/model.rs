//! 教训库的对外数据结构（DTO 单一来源：前端 `src/lib/api/lessons.ts` 与这里一一对应）。

use serde::Serialize;

/// 一条教训 = 一处「禁区」。
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Lesson {
    pub id: String,
    /// 仓库相对路径标签；空表示这条教训没法归因到具体文件（只能全局看）
    pub paths: Vec<String>,
    /// 现象：一句话说明哪一步炸了
    pub trigger: String,
    /// 证据：来自哪个应用的哪个会话、什么退出码
    pub evidence: String,
    /// 下次怎么做
    pub next_step: String,
    /// 命中次数（不同会话各算一次）
    pub hits: i64,
    pub first_seen: i64,
    pub last_seen: i64,
    /// 出现过这条失败的应用 id
    pub apps: Vec<String>,
    /// 被用户删掉的教训：留在库里但不再注入，删除理由也留着（防止下次重算又长回来）
    pub dismissed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dismiss_reason: Option<String>,
}

/// `AGENTS.md` 里那一块的现状。
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InjectionState {
    /// 用户是否允许 phi 往 `AGENTS.md` 写这一块
    pub enabled: bool,
    /// 仓库根下的文件名（目前只有 `AGENTS.md`）
    pub file: String,
    pub version: i64,
    /// 当前块占用的字符数（块不存在时为 0）
    pub used_chars: usize,
    pub budget_chars: usize,
    /// 文件里的块是否与「按当前教训算出来的块」一致
    pub applied: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LessonState {
    pub root: String,
    pub lessons: Vec<Lesson>,
    pub injection: InjectionState,
    /// 上次扫描完成的时间（毫秒）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_scan_at: Option<i64>,
    /// 上次扫描实际解析的会话数
    pub scanned_sessions: usize,
    /// 还没扫到的会话数（超过单次上限时非 0，再点一次刷新即可继续）
    pub pending_sessions: usize,
    /// 上次扫描得到的失败事件数
    pub failures: usize,
}

/// 注入块预览：先给用户看清楚要写进仓库的到底是什么。
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InjectionPreview {
    pub file: String,
    pub block: String,
    pub used_chars: usize,
    pub budget_chars: usize,
    pub lesson_count: usize,
    pub version: i64,
}
