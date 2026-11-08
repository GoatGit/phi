//! 隐私脱敏的端到端验证：错误摘要落库前脱敏、请求体脱敏作为内置插件阶段。
//!
//! 第二个用例同时守住三条契约：内置阶段排在插件之后、配置开关生效、
//! 脱敏结果与检测器标签稳定。

use std::fs;

use serde_json::json;

use phi_lib::plugin::PluginRuntime;
use phi_lib::privacy::{self, DetectorKind, PrivacyConfig, RedactionAction, RedactionRuleConfig};

#[path = "support.rs"]
mod support;
use support::{ensure_test_home, reset_test_fs, test_mutex};

fn config_dir() -> std::path::PathBuf {
    ensure_test_home().join(".phi")
}

fn write_plugin(name: &str, manifest: serde_json::Value) {
    let dir = config_dir().join("plugins").join(name);
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("plugin.json"), manifest.to_string()).unwrap();
}

#[test]
fn error_text_is_redacted_before_it_reaches_the_database() {
    let _guard = test_mutex().lock().unwrap();
    reset_test_fs();

    let original = "upstream 401: key sk-abcdefghijklmnopqrstuvwxyz rejected for alice@example.com";
    privacy::invalidate_cache();
    // 默认配置就开启错误摘要脱敏。
    let redacted = privacy::redact_error_message(original);
    assert!(
        !redacted.contains("abcdefghijklmnopqrstuvwxyz"),
        "{redacted}"
    );
    assert!(!redacted.contains("alice@example.com"), "{redacted}");
    assert!(redacted.contains("[REDACTED:api-key]"), "{redacted}");

    let disabled = PrivacyConfig {
        enabled: false,
        ..PrivacyConfig::default()
    };
    privacy::save_config(&disabled).unwrap();
    assert_eq!(privacy::redact_error_message(original), original);
}

#[test]
fn builtin_privacy_stage_runs_after_external_plugins() {
    let _guard = test_mutex().lock().unwrap();
    reset_test_fs();

    write_plugin(
        "demo",
        json!({
            "id": "demo",
            "name": "Demo",
            "hooks": ["request"],
            "rules": [{"op": "mask", "path": "note", "replacement": "[PLUGIN]"}]
        }),
    );

    let privacy = PrivacyConfig {
        apply_to_request_body: true,
        rules: vec![RedactionRuleConfig {
            detector: DetectorKind::Email,
            action: RedactionAction::Mask,
            replacement: None,
            custom_pattern: None,
        }],
        ..PrivacyConfig::default()
    };
    privacy::save_config(&privacy).unwrap();

    let runtime = PluginRuntime::from_config_dir_with_builtins(privacy::builtin_request_stages);
    let stage_ids: Vec<String> = runtime
        .stages()
        .iter()
        .map(|stage| stage.id().to_string())
        .collect();
    assert_eq!(stage_ids, ["demo", privacy::PRIVACY_STAGE_ID]);

    let mut body = json!({"note": "raw", "mail": "alice@example.com"});
    let outcomes = runtime.apply_request_stages("claude", "/v1/messages", &mut body);
    assert_eq!(outcomes.len(), 2);
    assert_eq!(body["note"], json!("[PLUGIN]"));
    assert_eq!(body["mail"], json!("[REDACTED:email]"));
}

#[test]
fn request_body_stage_stays_off_until_explicitly_enabled() {
    let _guard = test_mutex().lock().unwrap();
    reset_test_fs();

    // 默认配置：错误摘要脱敏开、请求体改写关。
    privacy::save_config(&PrivacyConfig::default()).unwrap();
    let runtime = PluginRuntime::from_config_dir_with_builtins(privacy::builtin_request_stages);
    assert!(runtime.stages().is_empty());
}
