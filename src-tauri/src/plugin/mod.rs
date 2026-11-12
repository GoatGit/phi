//! 插件系统：外部请求改写与宿主功能面板的宿主。
//!
//! 两类插件共用一套定义与启停机制：
//! - 请求插件（`rules` / `script`）：改写出站请求体，跑在代理热路径上；
//! - 功能插件（`feature`）：只在界面挂一个内置面板，不参与请求。
//!
//! 功能插件不携带前端代码，清单元数据里的 `panel.entry` 只能指向
//! [`manifest::BUILTIN_PANELS`] 里的内置面板，所以启用它不会扩大攻击面。
//!
//! ## 为什么是「阶段」而不是「回调」
//!
//! 插件要能在代理热路径上生效，就必须有一个宿主能理解、能隔离、能限流的形状。
//! 这里把它收成一个同步的 [`RequestStage`](stage::RequestStage)：拿请求体、原地改写、
//! 报告改了几处。脚本插件、声明式规则插件、内置的隐私脱敏都是同一个 trait 的实现，
//! 所以顺序、失败降级、日志口径只有一份。
//!
//! ## 分层
//!
//! - `manifest`：插件清单的类型与校验（纯数据，无 IO）
//! - `registry`：从磁盘发现插件、合并启用状态、构建阶段（只读快照）
//! - `sandbox`：脚本沙箱（内存/栈/时间上限，无宿主能力注入）
//! - `rules`：声明式规则引擎（路径遍历 + 正则替换）
//! - `stage`：`RequestStage` 与管线执行
//! - `runtime`：带 TTL 的快照缓存，供代理每请求读取
//!
//! ## 失败语义
//!
//! 插件是增强，不是依赖：任何一个插件加载失败、正则非法、脚本抛错或超时，
//! 都只让**那个阶段**本次不生效，请求照旧发往上游。错误通过
//! [`PluginRuntime::summary`](runtime::PluginRuntime::summary) 暴露给 UI。

pub mod manifest;
pub mod registry;
pub mod rules;
pub mod runtime;
pub mod sandbox;
pub mod session_exit;
pub mod stage;

pub use manifest::{
    DeclarativeOp, DeclarativeRule, PanelDeclaration, PluginHook, PluginKind, PluginManifest,
    PluginValidationError, BUILTIN_PANELS,
};
pub use registry::{
    LoadedPlugin, PluginLoadError, PluginOverrides, PluginRegistry, PluginSummary, STATE_FILE,
};
pub use runtime::{PluginRuntime, PluginRuntimeSummary};
pub use sandbox::{SandboxError, SandboxLimits};
pub use session_exit::{
    run_session_exit_hooks, SessionExitAction, SessionExitChoice, SessionExitDecision,
    SessionExitHook, SessionExitOutcome,
};
pub use stage::{
    run_request_stages, RequestStage, RuleStage, ScriptStage, StageContext, StageOutcome,
};
