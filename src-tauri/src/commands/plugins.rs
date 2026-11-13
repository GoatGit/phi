#![allow(non_snake_case)]

use serde::Serialize;
use serde_json::Value;

use crate::plugin::{PluginOverrides, PluginRuntime, PluginRuntimeSummary, STATE_FILE};

/// 插件目录名（位于配置目录）。
const PLUGINS_DIR: &str = "plugins";

fn runtime() -> PluginRuntime {
    PluginRuntime::from_config_dir()
}

fn plugins_root() -> std::path::PathBuf {
    crate::config::get_app_config_dir().join(PLUGINS_DIR)
}

fn state_path() -> std::path::PathBuf {
    crate::config::get_app_config_dir().join(STATE_FILE)
}

/// 插件干跑结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginPreviewResponse {
    pub plugin_id: String,
    /// 阶段返回的命中次数；`None` 表示阶段本次跳过。
    pub hits: Option<usize>,
    pub error: Option<String>,
    /// 改写后的请求体（失败时等于输入）。
    pub payload: Value,
}

/// 列出插件：磁盘发现结果、启用状态、加载错误。
#[tauri::command]
pub async fn list_plugins() -> Result<PluginRuntimeSummary, String> {
    Ok(runtime().summary())
}

/// 启用/停用插件。覆盖写进 `plugins-state.json`，清单默认值不动。
#[tauri::command]
pub async fn set_plugin_enabled(id: String, enabled: bool) -> Result<PluginRuntimeSummary, String> {
    let runtime = runtime();
    {
        let registry = runtime.registry();
        if registry.get(&id).is_none() {
            return Err(format!("插件 '{id}' 不存在"));
        }
    }

    let state_path = state_path();
    let mut overrides = PluginOverrides::load(&state_path);
    overrides.set(&id, enabled);
    overrides.save(&state_path).map_err(|err| err.to_string())?;

    let reloaded = PluginRuntime::new(plugins_root(), state_path);
    Ok(reloaded.summary())
}

/// 用给定 payload 干跑一个插件（不受启用状态影响）。
#[tauri::command]
pub async fn preview_plugin_request(
    id: String,
    payload: Value,
) -> Result<PluginPreviewResponse, String> {
    let mut body = payload;
    let runtime = runtime();
    match runtime.preview(&id, &mut body) {
        Ok(outcome) => Ok(PluginPreviewResponse {
            plugin_id: outcome.id,
            hits: outcome.result.as_ref().ok().copied(),
            error: outcome.result.err(),
            payload: body,
        }),
        Err(err) => Err(err.to_string()),
    }
}

/// `session-exit` 钩子的试跑结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionExitPreviewResponse {
    pub plugin_id: String,
    /// 决策：`action` / `mode` / `reason`；`None` 表示插件弃权。
    pub decision: Option<Value>,
}

/// 用一段示例事件试跑接棒钩子（不受启用状态影响，也不会真的重启任何会话）。
#[tauri::command]
pub async fn preview_plugin_session_exit(
    id: String,
    event: Value,
) -> Result<SessionExitPreviewResponse, String> {
    let decision = runtime()
        .preview_session_exit(&id, &event)
        .map_err(|error| format!("试跑失败：{error}"))?;
    Ok(SessionExitPreviewResponse {
        plugin_id: id,
        decision: decision.map(|decision| {
            serde_json::json!({
                "action": match decision.action {
                    crate::plugin::SessionExitAction::Resume => "resume",
                    crate::plugin::SessionExitAction::Record => "record",
                },
                "mode": decision.mode,
                "reason": decision.reason,
            })
        }),
    })
}
