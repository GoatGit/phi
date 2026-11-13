//! 插件注册表：从磁盘发现插件、合并启用状态、按确定顺序构建阶段。
//!
//! 「定义」在插件的 `plugin.json` 与 `plugins-state.json` 里，「执行」在
//! [`super::runtime::PluginRuntime`] 里。注册表本身不缓存跨请求状态，构造一次
//! 就是一份不可变快照，便于热路径无锁读取与测试复现。

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use super::manifest::{
    PluginHook, PluginKind, PluginManifest, MANIFEST_FILE, MAX_PLUGINS, MAX_SCRIPT_BYTES,
};
use super::rules::CompiledRules;
use super::sandbox::SandboxLimits;
use super::session_exit::SessionExitHook;
use super::stage::{RequestStage, RuleStage, ScriptStage};

/// 启用状态覆盖文件名（位于配置目录，不在插件目录，避免被插件自己改掉）。
pub const STATE_FILE: &str = "plugins-state.json";

const CURRENT_STATE_VERSION: u32 = 1;

fn default_state_version() -> u32 {
    CURRENT_STATE_VERSION
}

/// 用户对插件启用状态的覆盖。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PluginOverrides {
    #[serde(default = "default_state_version")]
    pub version: u32,
    #[serde(default)]
    pub overrides: BTreeMap<String, bool>,
}

impl Default for PluginOverrides {
    fn default() -> Self {
        Self {
            version: CURRENT_STATE_VERSION,
            overrides: BTreeMap::new(),
        }
    }
}

impl PluginOverrides {
    /// 读取覆盖文件；不存在、损坏或版本不认识都当作「没有覆盖」。
    ///
    /// 这里不报错是刻意的：坏掉的启用状态不该让插件系统整体不可用，
    /// 退回到清单默认值比让代理起不来好。
    pub fn load(path: &Path) -> Self {
        let Ok(raw) = fs::read_to_string(path) else {
            return Self::default();
        };
        let Ok(parsed) = serde_json::from_str::<Self>(&raw) else {
            log::warn!(
                "插件启用状态文件无法解析，按清单默认值处理: {}",
                path.display()
            );
            return Self::default();
        };
        if parsed.version != CURRENT_STATE_VERSION {
            log::warn!(
                "插件启用状态文件版本为 {}，当前支持 {CURRENT_STATE_VERSION}，按默认值处理",
                parsed.version
            );
            return Self::default();
        }
        parsed
    }

    pub fn save(&self, path: &Path) -> Result<(), crate::error::AppError> {
        let serialized = serde_json::to_string_pretty(self)
            .map_err(|source| crate::error::AppError::JsonSerialize { source })?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|err| crate::error::AppError::io(parent, err))?;
        }
        crate::config::atomic_write(path, format!("{serialized}\n").as_bytes())
    }

    /// 设置一个插件的启用状态。
    pub fn set(&mut self, id: &str, enabled: bool) {
        self.overrides.insert(id.to_string(), enabled);
    }
}

/// 单个插件加载失败的原因。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginLoadError {
    /// 插件目录名（不暴露绝对路径，命令返回里够用）。
    pub plugin_dir: String,
    pub message: String,
}

/// 已加载的插件。
#[derive(Debug, Clone)]
pub struct LoadedPlugin {
    pub manifest: PluginManifest,
    pub dir: PathBuf,
    /// 脚本原文（仅脚本插件）。
    pub script: Option<String>,
    pub enabled: bool,
}

impl LoadedPlugin {
    pub fn id(&self) -> &str {
        &self.manifest.id
    }
}

/// 一份不可变的插件快照。
#[derive(Debug, Clone, Default)]
pub struct PluginRegistry {
    pub root: PathBuf,
    plugins: Vec<LoadedPlugin>,
    errors: Vec<PluginLoadError>,
    /// 构建阶段时发现的问题（正则非法、脚本缺失等）。
    build_errors: Vec<PluginLoadError>,
}

impl PluginRegistry {
    /// 扫描插件根目录。`root` 不存在时返回空快照，不写任何文件。
    pub fn discover(root: &Path, overrides: &PluginOverrides) -> Self {
        let mut registry = Self {
            root: root.to_path_buf(),
            ..Self::default()
        };
        let Ok(entries) = fs::read_dir(root) else {
            return registry;
        };

        let mut dirs: Vec<PathBuf> = entries
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .map(|entry| entry.path())
            .collect();
        dirs.sort();

        let mut seen_ids: HashSet<String> = HashSet::new();
        for dir in dirs {
            if registry.plugins.len() >= MAX_PLUGINS {
                registry.errors.push(PluginLoadError {
                    plugin_dir: dir_name(&dir),
                    message: format!("插件数量超过 {MAX_PLUGINS} 上限，其余目录被忽略"),
                });
                break;
            }
            match load_plugin_dir(&dir) {
                Ok(None) => {}
                Ok(Some(mut plugin)) => {
                    if !seen_ids.insert(plugin.manifest.id.clone()) {
                        registry.errors.push(PluginLoadError {
                            plugin_dir: dir_name(&dir),
                            message: format!(
                                "插件 id '{}' 重复，后出现的被忽略",
                                plugin.manifest.id
                            ),
                        });
                        continue;
                    }
                    plugin.enabled = overrides
                        .overrides
                        .get(&plugin.manifest.id)
                        .copied()
                        .unwrap_or(plugin.manifest.enabled_by_default);
                    registry.plugins.push(plugin);
                }
                Err(message) => registry.errors.push(PluginLoadError {
                    plugin_dir: dir_name(&dir),
                    message,
                }),
            }
        }

        // 顺序是契约的一部分：priority 升序、同值按 id 字典序。
        registry.plugins.sort_by(|left, right| {
            (left.manifest.priority, &left.manifest.id)
                .cmp(&(right.manifest.priority, &right.manifest.id))
        });
        registry
    }

    pub fn plugins(&self) -> &[LoadedPlugin] {
        &self.plugins
    }

    pub fn errors(&self) -> &[PluginLoadError] {
        &self.errors
    }

    pub fn build_errors(&self) -> &[PluginLoadError] {
        &self.build_errors
    }

    pub fn get(&self, id: &str) -> Option<&LoadedPlugin> {
        self.plugins.iter().find(|plugin| plugin.manifest.id == id)
    }

    /// 已启用、且真的会在请求体上生效的插件。
    pub fn active_request_plugins(&self) -> impl Iterator<Item = &LoadedPlugin> {
        self.plugins.iter().filter(|plugin| {
            plugin.enabled && plugin.manifest.hooks_request() && plugin.manifest.is_effective()
        })
    }

    /// 已启用、且声明了 `session-exit` 钩子的插件。
    pub fn active_session_exit_plugins(&self) -> impl Iterator<Item = &LoadedPlugin> {
        self.plugins.iter().filter(|plugin| {
            plugin.enabled && plugin.manifest.hooks_session_exit() && plugin.manifest.is_effective()
        })
    }

    /// 声明过 `session-exit` 钩子的插件数量（不管启用与否）。
    ///
    /// 用来区分「没装插件」和「装了但被用户关掉」：后者是用户的明确取舍，
    /// 不能因为回落到内置策略就把功能又打开。
    pub fn declared_session_exit_plugins(&self) -> usize {
        self.plugins
            .iter()
            .filter(|plugin| plugin.manifest.hooks_session_exit() && plugin.manifest.is_effective())
            .count()
    }

    /// 构建接棒钩子。声明了 `session-exit` 却没有脚本的插件在这里被记一次错误，
    /// 而不是静默地不生效——用户需要知道自己的策略插件没跑起来。
    pub fn build_session_exit_hooks(&mut self) -> Vec<SessionExitHook> {
        let plugins: Vec<LoadedPlugin> = self.active_session_exit_plugins().cloned().collect();
        let mut hooks = Vec::with_capacity(plugins.len());
        for plugin in plugins {
            match session_exit_hook_for_plugin(&plugin) {
                Ok(hook) => hooks.push(hook),
                Err(message) => self.build_errors.push(PluginLoadError {
                    plugin_dir: dir_name(&plugin.dir),
                    message: format!("插件 '{}' 未生效: {message}", plugin.manifest.id),
                }),
            }
        }
        hooks
    }

    /// 构建请求阶段。内置阶段（隐私脱敏）由调用方追加在插件之后，
    /// 保证「插件先改写、内置脱敏最后兜底」的固定顺序。
    pub fn build_request_stages_with(
        &mut self,
        builtin: Vec<Arc<dyn RequestStage>>,
    ) -> Vec<Arc<dyn RequestStage>> {
        let plugins: Vec<LoadedPlugin> = self.active_request_plugins().cloned().collect();
        let mut stages: Vec<Arc<dyn RequestStage>> =
            Vec::with_capacity(plugins.len() + builtin.len());
        for plugin in plugins {
            match stage_for_plugin(&plugin) {
                Ok(stage) => stages.push(stage),
                Err(message) => self.build_errors.push(PluginLoadError {
                    plugin_dir: dir_name(&plugin.dir),
                    message: format!("插件 '{}' 未生效: {message}", plugin.manifest.id),
                }),
            }
        }
        // 内置阶段（隐私脱敏）排在所有插件之后：插件引入的字段也要被兜底脱敏。
        stages.extend(builtin);
        stages
    }
}

pub(super) fn stage_for_plugin(plugin: &LoadedPlugin) -> Result<Arc<dyn RequestStage>, String> {
    match plugin.manifest.kind {
        PluginKind::Rules => {
            let rules = CompiledRules::compile(&plugin.manifest.rules)?;
            Ok(Arc::new(RuleStage::new(plugin.manifest.id.clone(), rules)))
        }
        PluginKind::Script => {
            let script = plugin
                .script
                .clone()
                .ok_or_else(|| "脚本内容缺失".to_string())?;
            Ok(Arc::new(ScriptStage::new(
                plugin.manifest.id.clone(),
                script,
                SandboxLimits::default(),
            )))
        }
    }
}

pub(super) fn session_exit_hook_for_plugin(
    plugin: &LoadedPlugin,
) -> Result<SessionExitHook, String> {
    if plugin.manifest.kind != PluginKind::Script {
        return Err("session-exit 钩子只支持脚本插件".to_string());
    }
    let script = plugin
        .script
        .clone()
        .ok_or_else(|| "脚本内容缺失".to_string())?;
    Ok(SessionExitHook::new(
        plugin.manifest.id.clone(),
        script,
        SandboxLimits::default(),
    ))
}

fn dir_name(dir: &Path) -> String {
    dir.file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| dir.display().to_string())
}

/// 读取一个插件目录；没有清单时返回 `Ok(None)`（不是每个子目录都是插件）。
fn load_plugin_dir(dir: &Path) -> Result<Option<LoadedPlugin>, String> {
    let manifest_path = dir.join(MANIFEST_FILE);
    if !manifest_path.is_file() {
        return Ok(None);
    }
    let metadata =
        fs::metadata(&manifest_path).map_err(|err| format!("读取清单元信息失败: {err}"))?;
    if metadata.len() > super::manifest::MAX_MANIFEST_BYTES {
        return Err(format!(
            "清单超过 {} 字节上限",
            super::manifest::MAX_MANIFEST_BYTES
        ));
    }
    let raw = fs::read_to_string(&manifest_path).map_err(|err| format!("读取清单失败: {err}"))?;
    let manifest = PluginManifest::parse(&raw).map_err(|err| err.to_string())?;
    let script = match manifest.entry_path().map_err(|err| err.to_string())? {
        Some(relative) => Some(read_script(dir, &relative)?),
        None => None,
    };
    Ok(Some(LoadedPlugin {
        manifest,
        dir: dir.to_path_buf(),
        script,
        enabled: false,
    }))
}

fn read_script(dir: &Path, relative: &Path) -> Result<String, String> {
    let path = dir.join(relative);
    let metadata = fs::metadata(&path)
        .map_err(|err| format!("读取脚本 '{}' 失败: {err}", relative.display()))?;
    if !metadata.is_file() {
        return Err(format!("脚本 '{}' 不是文件", relative.display()));
    }
    if metadata.len() > MAX_SCRIPT_BYTES {
        return Err(format!(
            "脚本 '{}' 超过 {MAX_SCRIPT_BYTES} 字节上限",
            relative.display()
        ));
    }
    // 软链接可能指向插件目录之外：规范化后必须仍在插件目录内。
    let canonical_dir = dir
        .canonicalize()
        .map_err(|err| format!("规范化插件目录失败: {err}"))?;
    let canonical_script = path
        .canonicalize()
        .map_err(|err| format!("规范化脚本路径失败: {err}"))?;
    if !canonical_script.starts_with(&canonical_dir) {
        return Err(format!("脚本 '{}' 逃出了插件目录", relative.display()));
    }
    fs::read_to_string(&canonical_script).map_err(|err| format!("读取脚本失败: {err}"))
}

/// 命令返回用的插件摘要（不含脚本正文）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSummary {
    pub id: String,
    pub name: String,
    pub version: String,
    pub kind: PluginKind,
    pub hooks: Vec<PluginHook>,
    pub priority: i32,
    pub enabled: bool,
    pub description: Option<String>,
    pub author: Option<String>,
    pub rule_count: usize,
    pub source_dir: String,
}

impl From<&LoadedPlugin> for PluginSummary {
    fn from(plugin: &LoadedPlugin) -> Self {
        let manifest = &plugin.manifest;
        Self {
            id: manifest.id.clone(),
            name: manifest.name.clone(),
            version: manifest.version.clone(),
            kind: manifest.kind,
            hooks: manifest.hooks.clone(),
            priority: manifest.priority,
            enabled: plugin.enabled,
            description: manifest.description.clone(),
            author: manifest.author.clone(),
            rule_count: manifest.rules.len(),
            source_dir: dir_name(&plugin.dir),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_plugin(root: &Path, dir: &str, manifest: serde_json::Value, script: Option<&str>) {
        let plugin_dir = root.join(dir);
        fs::create_dir_all(&plugin_dir).unwrap();
        fs::write(
            plugin_dir.join(MANIFEST_FILE),
            serde_json::to_string(&manifest).unwrap(),
        )
        .unwrap();
        if let Some(script) = script {
            fs::write(plugin_dir.join("main.js"), script).unwrap();
        }
    }

    fn rules_manifest(id: &str, priority: i32) -> serde_json::Value {
        serde_json::json!({
            "id": id,
            "name": id,
            "priority": priority,
            "hooks": ["request"],
            "rules": [{"op":"mask","path":"secret"}]
        })
    }

    #[test]
    fn missing_root_is_an_empty_snapshot() {
        let root = tempfile::tempdir().unwrap();
        let registry =
            PluginRegistry::discover(&root.path().join("nope"), &PluginOverrides::default());
        assert!(registry.plugins().is_empty());
        assert!(registry.errors().is_empty());
    }

    #[test]
    fn discovery_orders_by_priority_then_id() {
        let root = tempfile::tempdir().unwrap();
        write_plugin(root.path(), "b", rules_manifest("b.plugin", 200), None);
        write_plugin(root.path(), "a", rules_manifest("a.plugin", 100), None);
        write_plugin(root.path(), "c", rules_manifest("c.plugin", 100), None);
        let registry = PluginRegistry::discover(root.path(), &PluginOverrides::default());
        let ids: Vec<&str> = registry.plugins().iter().map(|p| p.id()).collect();
        assert_eq!(ids, ["a.plugin", "c.plugin", "b.plugin"]);
        assert!(registry.errors().is_empty());
    }

    #[test]
    fn directories_without_manifest_are_ignored() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("stray")).unwrap();
        let registry = PluginRegistry::discover(root.path(), &PluginOverrides::default());
        assert!(registry.plugins().is_empty());
        assert!(registry.errors().is_empty());
    }

    #[test]
    fn invalid_manifests_are_reported_without_stopping_others() {
        let root = tempfile::tempdir().unwrap();
        write_plugin(
            root.path(),
            "broken",
            serde_json::json!({"id":"B","name":""}),
            None,
        );
        write_plugin(root.path(), "good", rules_manifest("good", 100), None);
        let registry = PluginRegistry::discover(root.path(), &PluginOverrides::default());
        assert_eq!(registry.plugins().len(), 1);
        assert_eq!(registry.errors().len(), 1);
        assert_eq!(registry.errors()[0].plugin_dir, "broken");
    }

    #[test]
    fn duplicate_ids_keep_the_first_directory() {
        let root = tempfile::tempdir().unwrap();
        write_plugin(root.path(), "a", rules_manifest("same", 100), None);
        write_plugin(root.path(), "b", rules_manifest("same", 100), None);
        let registry = PluginRegistry::discover(root.path(), &PluginOverrides::default());
        assert_eq!(registry.plugins().len(), 1);
        assert_eq!(registry.plugins()[0].dir, root.path().join("a"));
        assert_eq!(registry.errors().len(), 1);
    }

    #[test]
    fn overrides_win_over_manifest_default() {
        let root = tempfile::tempdir().unwrap();
        write_plugin(root.path(), "a", rules_manifest("a", 100), None);
        let mut overrides = PluginOverrides::default();
        overrides.set("a", false);
        let registry = PluginRegistry::discover(root.path(), &overrides);
        assert!(!registry.plugins()[0].enabled);
        assert_eq!(registry.active_request_plugins().count(), 0);
    }

    #[test]
    fn script_plugins_load_their_entry_and_reject_escapes() {
        let root = tempfile::tempdir().unwrap();
        write_plugin(
            root.path(),
            "scripted",
            serde_json::json!({
                "id":"scripted","name":"Scripted","kind":"script",
                "hooks":["request"],"entry":"main.js"
            }),
            Some("function onRequest(r) { return r; }"),
        );
        let registry = PluginRegistry::discover(root.path(), &PluginOverrides::default());
        let plugin = registry.get("scripted").expect("loaded");
        assert!(plugin.script.as_deref().unwrap().contains("onRequest"));

        let escaping = tempfile::tempdir().unwrap();
        write_plugin(
            escaping.path(),
            "escape",
            serde_json::json!({
                "id":"escape","name":"Escape","kind":"script",
                "hooks":["request"],"entry":"../outside.js"
            }),
            None,
        );
        let registry = PluginRegistry::discover(escaping.path(), &PluginOverrides::default());
        assert!(registry.plugins().is_empty());
        assert_eq!(registry.errors().len(), 1);
    }

    #[test]
    fn invalid_regex_disables_only_that_plugin_at_build_time() {
        let root = tempfile::tempdir().unwrap();
        write_plugin(
            root.path(),
            "badregex",
            serde_json::json!({
                "id":"badregex","name":"Bad","hooks":["request"],
                "rules":[{"op":"mask","path":"a","pattern":"("}]
            }),
            None,
        );
        write_plugin(root.path(), "good", rules_manifest("good", 100), None);
        let mut registry = PluginRegistry::discover(root.path(), &PluginOverrides::default());
        let stages = registry.build_request_stages_with(Vec::new());
        assert_eq!(stages.len(), 1);
        assert_eq!(stages[0].id(), "good");
        assert_eq!(registry.build_errors().len(), 1);
    }

    #[test]
    fn builtin_stages_run_after_plugins() {
        let root = tempfile::tempdir().unwrap();
        write_plugin(root.path(), "a", rules_manifest("a.plugin", 100), None);
        let mut registry = PluginRegistry::discover(root.path(), &PluginOverrides::default());
        let builtin = Arc::new(RuleStage::new(
            "builtin.privacy",
            CompiledRules::compile(&[]).unwrap(),
        ));
        let stages = registry.build_request_stages_with(vec![builtin]);
        assert_eq!(stages.len(), 2);
        assert_eq!(stages[1].id(), "builtin.privacy");
    }

    #[test]
    fn overrides_roundtrip_through_disk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("plugins-state.json");
        let mut overrides = PluginOverrides::default();
        overrides.set("a", false);
        overrides.save(&path).unwrap();
        assert_eq!(PluginOverrides::load(&path), overrides);
    }

    #[test]
    fn broken_state_file_falls_back_to_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("plugins-state.json");
        fs::write(&path, "{not json").unwrap();
        assert_eq!(PluginOverrides::load(&path), PluginOverrides::default());
        fs::write(&path, r#"{"version":99,"overrides":{"a":false}}"#).unwrap();
        assert_eq!(PluginOverrides::load(&path), PluginOverrides::default());
    }
}
