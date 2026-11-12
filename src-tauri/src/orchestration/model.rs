//! 编排接力对前端暴露的数据结构。
//!
//! 这些结构既是 Tauri 命令的返回值，也是落库的证据 JSON，改字段等于改契约，
//! 前端 `src/lib/api/orchestration.ts` 必须同步。

use serde::{Deserialize, Serialize};

/// 门判定结果。`invalid` 专门留给「证据不成立」，与「跑了但没过」区分开。
pub const PASS: &str = "pass";
pub const FAIL: &str = "fail";
pub const INVALID: &str = "invalid";

/// 卡片 `phi.accept` 里的一条验收命令。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcceptStep {
    pub cmd: String,
    /// 期望的退出码，默认 0
    pub expect_exit: i32,
    /// 单条命令的超时，缺省走 `phi.max_minutes` 或内置默认
    #[serde(default)]
    pub timeout_minutes: Option<u64>,
}

/// 从卡片 `phi:` 块解析出来的实现契约。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Contract {
    pub accept: Vec<AcceptStep>,
    /// 允许改动的路径；为空表示卡片没声明边界
    pub touched: Vec<String>,
    /// 一行都不许碰的路径
    pub forbidden: Vec<String>,
    /// plan / implement / review
    pub role: Option<String>,
    /// 本轮的基线提交，缺省由门 2 自己取
    pub base: Option<String>,
    pub max_tokens: Option<u64>,
    pub max_minutes: Option<u64>,
    /// 解析时读不懂的地方，给前端提示用
    pub warnings: Vec<String>,
    /// accept 与 touched 都齐了，门 2 才有意义
    pub ready: bool,
}

impl Contract {
    /// 契约是否足以支撑门 2：有可执行的验收命令，且声明了改动边界。
    pub fn is_ready(&self) -> bool {
        !self.accept.is_empty() && !self.touched.is_empty()
    }
}

/// 单条验收命令的执行结果。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepResult {
    pub cmd: String,
    pub expect_exit: i32,
    /// 超时被杀或起不来时为 None
    #[serde(default)]
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub timed_out: bool,
    #[serde(default)]
    pub duration_ms: i64,
    /// 合并后的输出尾部，给人和复查 agent 看，不追求完整日志
    #[serde(default)]
    pub output_tail: String,
}

/// 越界改动。`rule` 为 `forbidden` 或 `out-of-scope`。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Violation {
    pub path: String,
    pub rule: String,
}

/// 复查意见里一条证据锚点的核对结果。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimCheck {
    pub file: String,
    pub line: usize,
    pub quote: String,
    pub ok: bool,
    /// 那一行的真实内容（截断），核对不上时给人看
    #[serde(default)]
    pub actual: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
}

/// 一次门判定的证据。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GateEvidence {
    #[serde(default)]
    pub steps: Vec<StepResult>,
    /// 相对基线改动过的文件
    #[serde(default)]
    pub changed: Vec<String>,
    #[serde(default)]
    pub violations: Vec<Violation>,
    #[serde(default)]
    pub claims: Vec<ClaimCheck>,
    #[serde(default)]
    pub note: Option<String>,
}

/// 一次门判定，落库后即成绩单的一行。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GateRun {
    pub id: String,
    /// 2 = 实现是否成立，3 = 复查是否成立
    pub gate: u8,
    pub status: String,
    #[serde(default)]
    pub base_commit: Option<String>,
    pub created_at: i64,
    pub duration_ms: i64,
    pub evidence: GateEvidence,
}

impl GateRun {
    pub fn passed(&self) -> bool {
        self.status == PASS
    }
}

/// 卡片 `phi_verdict` 块：卡片是唯一事实源，这里只记最近一次的结论。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Verdict {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gate2: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gate3: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
}

/// 任务详情里的「接力」视图。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayView {
    pub task_id: String,
    pub contract: Contract,
    pub verdict: Verdict,
    /// 最近几次门判定，新的在前
    pub runs: Vec<GateRun>,
    /// 卡片里能解析出的复查条目数
    pub review_claims: usize,
    /// 当前工作区相对基线的改动，只作提示
    pub changed: Vec<String>,
    /// 基线解析失败之类的问题
    pub warnings: Vec<String>,
}
