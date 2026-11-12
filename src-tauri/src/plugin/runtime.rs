//! 插件运行时：把磁盘上的插件快照缓存成可复用的阶段列表。
//!
//! 代理热路径每个请求都要问一次「现在有哪些阶段」，所以这里只读内存；磁盘变化
//! （新增/删除插件目录、改启用状态）通过短 TTL 刷新感知，而不是每个请求 stat。
//! TTL 的代价是「改完插件最多等一个 TTL」，收益是热路径没有锁竞争和系统调用。

use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use serde_json::Value;

use super::registry::{
    PluginLoadError, PluginOverrides, PluginRegistry, PluginSummary, STATE_FILE,
};
use super::session_exit::{run_session_exit_hooks, SessionExitChoice, SessionExitHook};
use super::stage::{run_request_stages, RequestStage, StageContext, StageOutcome};
use crate::error::AppError;

/// 快照最长复用时间。
pub const REFRESH_TTL: Duration = Duration::from_secs(2);

/// 接棒能力的可用状态。
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SessionExitState {
    /// 一个声明了 session-exit 的插件都没装：调用方用内置策略。
    NoPlugin,
    /// 装了但都被关掉了：这是用户明确的取舍，不要接。
    Disabled,
    /// 有启用的插件。
    Active,
}

struct CachedSnapshot {
    registry: Arc<PluginRegistry>,
    stages: Arc<Vec<Arc<dyn RequestStage>>>,
    session_exit: Arc<Vec<SessionExitHook>>,
    built_at: Instant,
}

/// 插件运行时。
pub struct PluginRuntime {
    root: PathBuf,
    state_path: PathBuf,
    /// 内置阶段工厂：每次重建都重新读一次内置能力（如隐私脱敏配置）。
    builtins: fn() -> Vec<Arc<dyn RequestStage>>,
    snapshot: RwLock<CachedSnapshot>,
}

impl std::fmt::Debug for PluginRuntime {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PluginRuntime")
            .field("root", &self.root)
            .field("state_path", &self.state_path)
            .finish_non_exhaustive()
    }
}

fn no_builtins() -> Vec<Arc<dyn RequestStage>> {
    Vec::new()
}

impl PluginRuntime {
    /// 用显式的插件目录与状态文件构造（测试与命令复用），不挂内置阶段。
    pub fn new(root: impl Into<PathBuf>, state_path: impl Into<PathBuf>) -> Self {
        Self::with_builtins(root, state_path, no_builtins)
    }

    /// 纯插件视图：`<config>/plugins` + `<config>/plugins-state.json`，不挂内置阶段。
    ///
    /// 插件管理命令只需要看到磁盘上的插件；内置能力（隐私脱敏）由代理运行时
    /// 用 [`Self::from_config_dir_with_builtins`] 显式组合，保证依赖方向是
    /// 「隐私 → 插件管线」而不是反过来。
    pub fn from_config_dir() -> Self {
        let config_dir = crate::config::get_app_config_dir();
        Self::with_builtins(
            config_dir.join("plugins"),
            config_dir.join(STATE_FILE),
            no_builtins,
        )
    }

    /// 生产用：插件阶段 + 内置阶段（内置阶段排在最后）。
    pub fn from_config_dir_with_builtins(builtins: fn() -> Vec<Arc<dyn RequestStage>>) -> Self {
        let config_dir = crate::config::get_app_config_dir();
        Self::with_builtins(
            config_dir.join("plugins"),
            config_dir.join(STATE_FILE),
            builtins,
        )
    }

    /// 允许注入内置阶段工厂，便于测试里隔离真实配置。
    pub fn with_builtins(
        root: impl Into<PathBuf>,
        state_path: impl Into<PathBuf>,
        builtins: fn() -> Vec<Arc<dyn RequestStage>>,
    ) -> Self {
        let runtime = Self {
            root: root.into(),
            state_path: state_path.into(),
            builtins,
            snapshot: RwLock::new(CachedSnapshot {
                registry: Arc::new(PluginRegistry::default()),
                stages: Arc::new(Vec::new()),
                session_exit: Arc::new(Vec::new()),
                built_at: Instant::now(),
            }),
        };
        runtime.rebuild();
        runtime
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn state_path(&self) -> &Path {
        &self.state_path
    }

    /// 当前快照（必要时刷新）。
    pub fn registry(&self) -> Arc<PluginRegistry> {
        self.refresh(false);
        self.read().registry.clone()
    }

    /// 当前阶段列表（必要时刷新）。
    pub fn stages(&self) -> Arc<Vec<Arc<dyn RequestStage>>> {
        self.refresh(false);
        self.read().stages.clone()
    }

    /// 强制重建，插件安装/启停后调用。
    pub fn reload(&self) -> Arc<PluginRegistry> {
        self.refresh(true);
        self.registry()
    }

    /// 在请求体上运行插件管线。调用方负责放在阻塞线程里跑（脚本沙箱是同步的）。
    pub fn apply_request_stages(
        &self,
        app: &str,
        endpoint: &str,
        body: &mut Value,
    ) -> Vec<StageOutcome> {
        let stages = self.stages();
        if stages.is_empty() {
            return Vec::new();
        }
        run_request_stages(stages.as_slice(), app, endpoint, body)
    }

    /// 插件摘要 + 全量错误，供命令返回。
    pub fn summary(&self) -> PluginRuntimeSummary {
        let registry = self.registry();
        PluginRuntimeSummary {
            root: self.root.to_string_lossy().to_string(),
            plugins: registry.plugins().iter().map(PluginSummary::from).collect(),
            errors: registry
                .errors()
                .iter()
                .chain(registry.build_errors().iter())
                .cloned()
                .collect(),
        }
    }

    /// 插件作者用的干跑：不受启用状态影响，直接跑一个插件的请求阶段。
    pub fn preview(&self, plugin_id: &str, body: &mut Value) -> Result<StageOutcome, AppError> {
        let registry = self.registry();
        let plugin = registry
            .get(plugin_id)
            .ok_or_else(|| AppError::InvalidInput(format!("插件 '{plugin_id}' 不存在")))?;
        let stage = super::registry::stage_for_plugin(plugin)
            .map_err(|err| AppError::InvalidInput(format!("插件 '{plugin_id}' 不可用: {err}")))?;
        let mut context = StageContext {
            app: "preview",
            endpoint: "/preview",
            body,
        };
        Ok(StageOutcome {
            id: stage.id().to_string(),
            result: stage.apply(&mut context),
        })
    }

    /// 接棒能力的当前状态：没装插件 / 被用户关掉 / 可用。
    ///
    /// 「装了但关掉」必须在调用方那边变成「不要接」——插件中心那个开关
    /// 是用户对这个功能的取舍，不能因为回落到内置策略就偷偷又打开。
    pub fn session_exit_state(&self) -> SessionExitState {
        let registry = self.registry();
        if registry.active_session_exit_plugins().next().is_some() {
            return SessionExitState::Active;
        }
        if registry.declared_session_exit_plugins() > 0 {
            return SessionExitState::Disabled;
        }
        SessionExitState::NoPlugin
    }

    /// 让插件对一次会话异常退出表态。
    ///
    /// 返回 `None` 表示没有插件（或全都弃权）：调用方回落到内置策略。
    /// 沙箱是同步的，这里和请求阶段一样应该在非热路径线程里调用。
    pub fn decide_session_exit(&self, event: &Value) -> Option<SessionExitChoice> {
        let hooks = self.session_exit_hooks();
        if hooks.is_empty() {
            return None;
        }
        let (decision, outcomes) = run_session_exit_hooks(hooks.as_slice(), event);
        for outcome in outcomes {
            log::debug!(
                "[baton] 插件 {} 的决策: {:?}",
                outcome.id,
                outcome
                    .decision
                    .as_ref()
                    .map(|decision| (decision.action, decision.mode.clone()))
            );
        }
        decision
    }

    pub fn session_exit_hooks(&self) -> Arc<Vec<SessionExitHook>> {
        self.refresh(false);
        self.read().session_exit.clone()
    }

    /// 插件中心的试跑：用一段示例事件跑指定插件的接棒钩子（不看启用状态）。
    ///
    /// `Ok(None)` 是插件弃权，`Err` 是插件缺失或脚本出错——两者在 UI 上含义不同。
    pub fn preview_session_exit(
        &self,
        plugin_id: &str,
        event: &Value,
    ) -> Result<Option<super::session_exit::SessionExitDecision>, String> {
        let registry = self.registry();
        let plugin = registry
            .get(plugin_id)
            .ok_or_else(|| format!("插件 '{plugin_id}' 不存在"))?;
        if !plugin.manifest.hooks_session_exit() {
            return Err(format!("插件 '{plugin_id}' 没有声明 session-exit 钩子"));
        }
        let hook = super::registry::session_exit_hook_for_plugin(plugin)
            .map_err(|error| format!("插件 '{plugin_id}' 不可用: {error}"))?;
        hook.decide(event)
    }

    fn read(&self) -> std::sync::RwLockReadGuard<'_, CachedSnapshot> {
        self.snapshot
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn refresh(&self, force: bool) {
        if !force && self.read().built_at.elapsed() < REFRESH_TTL {
            return;
        }
        self.rebuild();
    }

    fn rebuild(&self) {
        let overrides = PluginOverrides::load(&self.state_path);
        let mut registry = PluginRegistry::discover(&self.root, &overrides);
        let stages = registry.build_request_stages_with((self.builtins)());
        let session_exit = registry.build_session_exit_hooks();
        let mut snapshot = self
            .snapshot
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *snapshot = CachedSnapshot {
            registry: Arc::new(registry),
            stages: Arc::new(stages),
            session_exit: Arc::new(session_exit),
            built_at: Instant::now(),
        };
    }
}

/// 命令返回：插件清单 + 加载错误。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRuntimeSummary {
    pub root: String,
    pub plugins: Vec<PluginSummary>,
    pub errors: Vec<PluginLoadError>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin::manifest::MANIFEST_FILE;
    use serde_json::json;
    use std::fs;

    fn write_plugin(root: &Path, dir: &str, manifest: serde_json::Value) {
        let plugin_dir = root.join("plugins").join(dir);
        fs::create_dir_all(&plugin_dir).unwrap();
        fs::write(
            plugin_dir.join(MANIFEST_FILE),
            serde_json::to_string(&manifest).unwrap(),
        )
        .unwrap();
    }

    fn runtime(root: &Path) -> PluginRuntime {
        PluginRuntime::with_builtins(root.join("plugins"), root.join(STATE_FILE), no_builtins)
    }

    #[test]
    fn stages_apply_in_registry_order() {
        let dir = tempfile::tempdir().unwrap();
        write_plugin(
            dir.path(),
            "first",
            json!({
                "id":"first","name":"First","hooks":["request"],"priority":10,
                "rules":[{"op":"mask","path":"a","replacement":"first"}]
            }),
        );
        write_plugin(
            dir.path(),
            "second",
            json!({
                "id":"second","name":"Second","hooks":["request"],"priority":20,
                "rules":[{"op":"mask","path":"a","replacement":"second"}]
            }),
        );
        let runtime = runtime(dir.path());
        let mut body = json!({"a":"raw"});
        let outcomes = runtime.apply_request_stages("claude", "/v1/messages", &mut body);
        assert_eq!(outcomes.len(), 2);
        assert_eq!(body, json!({"a":"second"}));
    }

    #[test]
    fn no_plugins_means_no_stage_work() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = runtime(dir.path());
        let mut body = json!({"a":1});
        assert!(runtime
            .apply_request_stages("claude", "/v1/messages", &mut body)
            .is_empty());
        assert_eq!(body, json!({"a":1}));
    }

    #[test]
    fn preview_ignores_enabled_state() {
        let dir = tempfile::tempdir().unwrap();
        write_plugin(
            dir.path(),
            "off",
            json!({
                "id":"off","name":"Off","hooks":["request"],"enabled_by_default":false,
                "rules":[{"op":"remove","path":"secret"}]
            }),
        );
        let runtime = runtime(dir.path());
        assert_eq!(runtime.stages().len(), 0);
        let mut body = json!({"secret":1,"keep":2});
        let outcome = runtime.preview("off", &mut body).unwrap();
        assert_eq!(outcome.result, Ok(1));
        assert_eq!(body, json!({"keep":2}));
    }

    #[test]
    fn preview_unknown_plugin_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = runtime(dir.path());
        let mut body = json!({});
        assert!(runtime.preview("missing", &mut body).is_err());
    }

    #[test]
    fn toggle_in_state_file_is_picked_up_after_reload() {
        let dir = tempfile::tempdir().unwrap();
        write_plugin(
            dir.path(),
            "on",
            json!({
                "id":"on","name":"On","hooks":["request"],
                "rules":[{"op":"remove","path":"secret"}]
            }),
        );
        let runtime = runtime(dir.path());
        assert_eq!(runtime.stages().len(), 1);

        let mut overrides = PluginOverrides::default();
        overrides.set("on", false);
        overrides.save(runtime.state_path()).unwrap();
        runtime.reload();
        assert_eq!(runtime.stages().len(), 0);
    }

    fn write_session_exit_plugin(root: &Path, dir: &str, enabled_by_default: bool) {
        write_plugin(
            root,
            dir,
            json!({
                "id":dir,"name":dir,"hooks":["session-exit"],"kind":"script",
                "entry":"main.js","enabled_by_default":enabled_by_default
            }),
        );
        fs::write(
            root.join("plugins").join(dir).join("main.js"),
            r#"function onSessionExit(event) {
                 return { action: "resume", mode: "same-session", reason: "可恢复" };
               }"#,
        )
        .unwrap();
    }

    #[test]
    fn no_session_exit_plugin_means_the_host_falls_back() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = runtime(dir.path());
        assert_eq!(runtime.session_exit_state(), SessionExitState::NoPlugin);
        assert!(runtime
            .decide_session_exit(&json!({"failureKind":"quota"}))
            .is_none());
    }

    #[test]
    fn an_enabled_plugin_decides_and_is_named() {
        let dir = tempfile::tempdir().unwrap();
        write_session_exit_plugin(dir.path(), "baton", true);
        let runtime = runtime(dir.path());
        assert_eq!(runtime.session_exit_state(), SessionExitState::Active);
        let choice = runtime
            .decide_session_exit(&json!({"failureKind":"quota"}))
            .expect("decision");
        assert_eq!(choice.plugin_id, "baton");
        assert_eq!(choice.decision.mode.as_deref(), Some("same-session"));
    }

    #[test]
    fn a_disabled_plugin_is_an_explicit_opt_out_not_a_fallback() {
        // 插件中心关掉这个插件 = 用户不要这个功能；不能因为回落到内置策略又打开
        let dir = tempfile::tempdir().unwrap();
        write_session_exit_plugin(dir.path(), "baton", false);
        let runtime = runtime(dir.path());
        assert_eq!(runtime.session_exit_state(), SessionExitState::Disabled);
        assert!(runtime
            .decide_session_exit(&json!({"failureKind":"quota"}))
            .is_none());
    }

    #[test]
    fn previewing_a_session_exit_plugin_works_even_when_disabled() {
        let dir = tempfile::tempdir().unwrap();
        write_session_exit_plugin(dir.path(), "baton", false);
        let runtime = runtime(dir.path());
        let decision = runtime
            .preview_session_exit("baton", &json!({"failureKind":"quota"}))
            .expect("preview runs")
            .expect("decision");
        assert_eq!(decision.action, crate::plugin::SessionExitAction::Resume);
        // 声明了别的钩子的插件不能拿来接棒试跑
        assert!(runtime.preview_session_exit("missing", &json!({})).is_err());
    }
}
