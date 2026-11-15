//! 插件协议快照：把插件作者需要知道的常量从实现里导出来。
//!
//! 起因很具体：协议一旦在文档里手抄一遍，上限、版本号、内置面板这些数字就会
//! 悄悄和实现分叉——文档说 150 ms，代码改成 200 ms，谁也不会记得去改文档。
//! 所以插件中心那一页协议读的是这里，只在「怎么说」上加文案，不在「是什么」上
//! 另抄一份。
//!
//! 这里只导出**纯数据**：没有 IO、没有运行时状态，改实现时跟着变，调用方拿到的
//! 永远是当前这次构建的口径。

use serde::Serialize;

use super::manifest::{
    DeclarativeOp, PluginHook, PluginKind, BUILTIN_PANELS, CURRENT_MANIFEST_VERSION, MANIFEST_FILE,
    MAX_MANIFEST_BYTES, MAX_PLUGINS, MAX_RULES, MAX_SCRIPT_BYTES,
};
use super::registry::STATE_FILE;
use super::sandbox::{SandboxLimits, ENTRY_FUNCTION, SESSION_EXIT_FUNCTION};

/// 插件作者要遵守的完整协议。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginProtocol {
    /// 清单文件名，固定 `plugin.json`。
    pub manifest_file: &'static str,
    /// 当前支持的清单结构版本。
    pub manifest_version: u32,
    /// 启用状态覆盖文件名，位于配置目录而非插件目录。
    pub state_file: &'static str,
    /// 请求钩子的入口函数名。
    pub request_entry: &'static str,
    /// 接棒钩子的入口函数名。
    pub session_exit_entry: &'static str,
    /// 可以挂的钩子点。
    pub hooks: Vec<PluginHook>,
    /// 可以声明的插件类型。
    pub kinds: Vec<PluginKind>,
    /// 声明式规则支持的操作。
    pub rule_ops: Vec<DeclarativeOp>,
    /// 功能插件能引用的内置面板。
    pub builtin_panels: Vec<&'static str>,
    pub limits: ProtocolLimits,
    pub sandbox: ProtocolSandbox,
}

/// 清单层面的硬上限。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolLimits {
    pub manifest_bytes: u64,
    pub script_bytes: u64,
    pub max_plugins: usize,
    pub max_rules: usize,
}

/// 脚本沙箱的执行上限。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolSandbox {
    pub timeout_ms: u64,
    pub memory_bytes: usize,
    pub stack_bytes: usize,
    pub payload_chars: usize,
}

/// 当前构建的协议快照。
pub fn protocol() -> PluginProtocol {
    let sandbox = SandboxLimits::default();
    PluginProtocol {
        manifest_file: MANIFEST_FILE,
        manifest_version: CURRENT_MANIFEST_VERSION,
        state_file: STATE_FILE,
        request_entry: ENTRY_FUNCTION,
        session_exit_entry: SESSION_EXIT_FUNCTION,
        hooks: vec![
            PluginHook::Request,
            PluginHook::SessionExit,
            PluginHook::Panel,
        ],
        kinds: vec![PluginKind::Rules, PluginKind::Script, PluginKind::Feature],
        rule_ops: vec![DeclarativeOp::Remove, DeclarativeOp::Mask],
        builtin_panels: BUILTIN_PANELS.to_vec(),
        limits: ProtocolLimits {
            manifest_bytes: MAX_MANIFEST_BYTES,
            script_bytes: MAX_SCRIPT_BYTES,
            max_plugins: MAX_PLUGINS,
            max_rules: MAX_RULES,
        },
        sandbox: ProtocolSandbox {
            timeout_ms: sandbox.timeout.as_millis() as u64,
            memory_bytes: sandbox.memory_bytes,
            stack_bytes: sandbox.stack_bytes,
            payload_chars: sandbox.max_payload_chars,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn protocol_matches_the_implementation_not_a_copy() {
        let protocol = protocol();
        assert_eq!(protocol.manifest_file, MANIFEST_FILE);
        assert_eq!(protocol.manifest_version, CURRENT_MANIFEST_VERSION);
        assert_eq!(protocol.state_file, STATE_FILE);
        assert_eq!(protocol.request_entry, ENTRY_FUNCTION);
        assert_eq!(protocol.session_exit_entry, SESSION_EXIT_FUNCTION);
        assert_eq!(protocol.limits.manifest_bytes, MAX_MANIFEST_BYTES);
        assert_eq!(protocol.limits.script_bytes, MAX_SCRIPT_BYTES);
        assert_eq!(protocol.limits.max_plugins, MAX_PLUGINS);
        assert_eq!(protocol.limits.max_rules, MAX_RULES);
        assert_eq!(
            protocol.builtin_panels.as_slice(),
            BUILTIN_PANELS,
            "内置面板清单必须和功能插件能引用的一致"
        );

        let sandbox = SandboxLimits::default();
        assert_eq!(
            protocol.sandbox.timeout_ms,
            sandbox.timeout.as_millis() as u64
        );
        assert_eq!(protocol.sandbox.memory_bytes, sandbox.memory_bytes);
        assert_eq!(protocol.sandbox.payload_chars, sandbox.max_payload_chars);
    }

    // 仓库里那两个示例是文档的一部分（插件中心那一页会让人照抄），所以它们必须真的
    // 是一份能加载、能跑出结果的插件，而不是看起来像插件的 JSON。
    #[test]
    fn shipped_examples_load_and_behave_as_documented() {
        use crate::plugin::{PluginRuntime, SessionExitAction};

        let examples =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins-sdk/examples");
        let state = tempfile::tempdir().unwrap();
        let runtime = PluginRuntime::new(&examples, state.path().join("plugins-state.json"));

        let summary = runtime.summary();
        assert!(summary.errors.is_empty(), "{:?}", summary.errors);
        // 宿主自带的面板插件也会出现在快照里，这里只看磁盘上那两个示例。
        let ids: Vec<&str> = summary
            .plugins
            .iter()
            .map(|plugin| plugin.id.as_str())
            .filter(|id| *id == "baton-policy" || *id == "mask-emails")
            .collect();
        assert_eq!(ids, ["baton-policy", "mask-emails"]);

        // 规则示例：把 messages 里的邮箱换成 <email>
        let mut body = json!({
            "messages": [{ "content": "mail a.b@example.com please" }]
        });
        let outcome = runtime.preview("mask-emails", &mut body).unwrap();
        assert_eq!(outcome.result, Ok(1));
        assert_eq!(body["messages"][0]["content"], "mail <email> please");

        // 脚本示例：只对 context 表态，其他失败弃权
        let decision = runtime
            .preview_session_exit("baton-policy", &json!({ "failureKind": "context" }))
            .expect("脚本能跑")
            .expect("context 应当接棒");
        assert_eq!(decision.action, SessionExitAction::Resume);
        assert_eq!(decision.mode.as_deref(), Some("fresh-session"));
        assert!(runtime
            .preview_session_exit("baton-policy", &json!({ "failureKind": "quota" }))
            .expect("脚本能跑")
            .is_none());
    }

    #[test]
    fn protocol_serializes_to_the_ids_the_manifest_accepts() {
        // 页面按这里列出的 id 写示例；它们必须就是清单里能解析的那几个字符串。
        let value = serde_json::to_value(protocol()).unwrap();
        assert_eq!(value["hooks"], json!(["request", "session-exit", "panel"]));
        assert_eq!(value["kinds"], json!(["rules", "script", "feature"]));
        assert_eq!(value["ruleOps"], json!(["remove", "mask"]));
        assert_eq!(value["manifestFile"], json!("plugin.json"));
        assert_eq!(value["requestEntry"], json!("onRequest"));
        assert_eq!(value["sessionExitEntry"], json!("onSessionExit"));
        // 驼峰字段是前端契约，漏一个会让页面静默显示空值。
        assert!(value.get("stateFile").is_some());
        assert!(value.get("builtinPanels").is_some());
        assert!(value.get("sandbox").unwrap().get("timeoutMs").is_some());
    }
}
