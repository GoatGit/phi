//! 插件系统的端到端验证：磁盘发现 → 启用状态 → 请求体改写。
//!
//! 单元测试证明各部件自己的契约；这里只证明「装到配置目录里就真的生效」，
//! 包括脚本插件在沙箱里跑、坏插件不拖垮好插件。

use std::fs;

use serde_json::{json, Value};

use phi_lib::plugin::{PluginOverrides, PluginRuntime, STATE_FILE};

#[path = "support.rs"]
mod support;
use support::{ensure_test_home, reset_test_fs, test_mutex};

fn config_dir() -> std::path::PathBuf {
    ensure_test_home().join(".phi")
}

fn write_plugin_dir(name: &str, manifest: Value, script: Option<&str>) {
    let dir = config_dir().join("plugins").join(name);
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("plugin.json"), manifest.to_string()).unwrap();
    if let Some(script) = script {
        fs::write(dir.join("main.js"), script).unwrap();
    }
}

#[test]
fn declarative_rule_plugin_rewrites_the_request_body() {
    let _guard = test_mutex().lock().unwrap();
    reset_test_fs();

    write_plugin_dir(
        "demo",
        json!({
            "id": "demo",
            "name": "Demo",
            "hooks": ["request"],
            "rules": [{"op": "mask", "path": "note", "replacement": "[PLUGIN]"}]
        }),
        None,
    );

    let runtime = PluginRuntime::from_config_dir();
    let stage_ids: Vec<String> = runtime
        .stages()
        .iter()
        .map(|stage| stage.id().to_string())
        .collect();
    assert_eq!(stage_ids, ["demo"]);

    let mut body = json!({"note": "raw", "keep": 1});
    let outcomes = runtime.apply_request_stages("claude", "/v1/messages", &mut body);
    assert_eq!(outcomes.len(), 1);
    assert_eq!(outcomes[0].result, Ok(1));
    assert_eq!(body, json!({"note": "[PLUGIN]", "keep": 1}));
}

#[test]
fn script_plugin_runs_inside_the_sandbox() {
    let _guard = test_mutex().lock().unwrap();
    reset_test_fs();

    write_plugin_dir(
        "scripted",
        json!({
            "id": "scripted",
            "name": "Scripted",
            "kind": "script",
            "hooks": ["request"],
            "entry": "main.js"
        }),
        Some(
            "function onRequest(request) {\n  request.model = String(request.model).toUpperCase();\n  return request;\n}",
        ),
    );

    let runtime = PluginRuntime::from_config_dir();
    let mut body = json!({"model": "gpt"});
    runtime.apply_request_stages("claude", "/v1/messages", &mut body);
    assert_eq!(body["model"], json!("GPT"));
}

#[test]
fn broken_plugin_is_reported_without_disabling_the_others() {
    let _guard = test_mutex().lock().unwrap();
    reset_test_fs();

    write_plugin_dir("broken", json!({"id": "Broken", "name": ""}), None);
    write_plugin_dir(
        "healthy",
        json!({
            "id": "healthy",
            "name": "Healthy",
            "hooks": ["request"],
            "rules": [{"op": "remove", "path": "secret"}]
        }),
        None,
    );

    let runtime = PluginRuntime::from_config_dir();
    let summary = runtime.summary();
    assert_eq!(summary.plugins.len(), 1);
    assert_eq!(summary.plugins[0].id, "healthy");
    assert_eq!(summary.errors.len(), 1);
    assert_eq!(summary.errors[0].plugin_dir, "broken");

    let mut body = json!({"secret": 1, "keep": 2});
    runtime.apply_request_stages("claude", "/v1/messages", &mut body);
    assert_eq!(body, json!({"keep": 2}));
}

#[test]
fn plugin_can_be_disabled_without_touching_its_manifest() {
    let _guard = test_mutex().lock().unwrap();
    reset_test_fs();

    write_plugin_dir(
        "off",
        json!({
            "id": "off.demo",
            "name": "Off",
            "hooks": ["request"],
            "rules": [{"op": "remove", "path": "secret"}]
        }),
        None,
    );

    let mut overrides = PluginOverrides::default();
    overrides.set("off.demo", false);
    overrides.save(&config_dir().join(STATE_FILE)).unwrap();

    let runtime = PluginRuntime::from_config_dir();
    assert!(runtime.stages().is_empty());
    let summary = runtime.summary();
    assert_eq!(summary.plugins.len(), 1);
    assert!(!summary.plugins[0].enabled);

    // 干跑不受启用状态影响：作者要先能看到效果再决定开不开。
    let mut body = json!({"secret": 1, "keep": 2});
    let preview = runtime.preview("off.demo", &mut body).unwrap();
    assert_eq!(preview.result, Ok(1));
    assert_eq!(body, json!({"keep": 2}));
}
