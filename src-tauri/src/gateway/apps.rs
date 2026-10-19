//! 路由适配范围：哪些应用可以接入统一路由，以及每个应用的入口与配置形状。
//!
//! 网关、ingress 鉴权和前端流程图共用这一份清单。新增一个应用时只改这里和它的配置
//! 写入函数，不再在各处散落 `matches!(app, ...)`。
//!
//! 接入方式分两类：
//! - [`Attachment::ProxyMode`]：模式控制器写客户端契约（Claude Code、Codex、Gemini、
//!   Grok Build）；
//! - [`Attachment::Provider`]：路由以一个「PHI 路由」供应商行的形式写进应用原生配置
//!   （Claude Desktop、OpenCode、OpenClaw、Hermes、Pi、MCode）。

use serde_json::{json, Map, Value};

use crate::app_config::AppType;

/// 应用接入路由的方式。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Attachment {
    /// 模式控制器接管客户端配置（代理模式）。
    ProxyMode,
    /// 在应用原生配置里落一行指向本地网关的供应商。
    Provider,
}

/// 一个可路由应用的静态描述。
#[derive(Debug, Clone)]
pub struct RoutingApp {
    pub app: AppType,
    pub id: &'static str,
    pub label: &'static str,
    /// 本地网关的路径前缀（不含结尾 `/v1`）。
    pub ingress: &'static str,
    /// 应用原生消费、可直接直连的协议。`None` 表示只能走本地路由。
    pub direct_protocol: Option<&'static str>,
    /// 路由入口使用的协议。
    pub route_protocol: &'static str,
    pub attachment: Attachment,
}

/// 全部可路由应用。顺序与前端流程图一致。
pub const ROUTING_APPS: [RoutingApp; 10] = [
    RoutingApp {
        app: AppType::Claude,
        id: "claude",
        label: "Claude",
        ingress: "/claude",
        direct_protocol: Some("anthropic"),
        route_protocol: "anthropic",
        attachment: Attachment::ProxyMode,
    },
    RoutingApp {
        app: AppType::ClaudeDesktop,
        id: "claude-desktop",
        label: "Claude Desktop",
        ingress: "/claude-desktop",
        direct_protocol: Some("anthropic"),
        route_protocol: "anthropic",
        attachment: Attachment::Provider,
    },
    RoutingApp {
        app: AppType::Codex,
        id: "codex",
        label: "Codex",
        ingress: "/codex",
        direct_protocol: Some("openai_responses"),
        route_protocol: "openai_responses",
        attachment: Attachment::ProxyMode,
    },
    RoutingApp {
        app: AppType::Gemini,
        id: "gemini",
        label: "Gemini",
        ingress: "/gemini",
        direct_protocol: Some("gemini_native"),
        route_protocol: "gemini_native",
        attachment: Attachment::ProxyMode,
    },
    RoutingApp {
        app: AppType::GrokBuild,
        id: "grokbuild",
        label: "Grok Build",
        ingress: "/grokbuild",
        direct_protocol: Some("openai_responses"),
        route_protocol: "openai_responses",
        attachment: Attachment::ProxyMode,
    },
    RoutingApp {
        app: AppType::OpenCode,
        id: "opencode",
        label: "OpenCode",
        ingress: "/opencode",
        direct_protocol: Some("openai_chat"),
        route_protocol: "openai_chat",
        attachment: Attachment::Provider,
    },
    RoutingApp {
        app: AppType::OpenClaw,
        id: "openclaw",
        label: "OpenClaw",
        ingress: "/openclaw",
        direct_protocol: Some("openai_chat"),
        route_protocol: "openai_chat",
        attachment: Attachment::Provider,
    },
    RoutingApp {
        app: AppType::Hermes,
        id: "hermes",
        label: "Hermes",
        ingress: "/hermes",
        direct_protocol: Some("openai_chat"),
        route_protocol: "openai_chat",
        attachment: Attachment::Provider,
    },
    RoutingApp {
        app: AppType::Pi,
        id: "pi",
        label: "Pi",
        ingress: "/pi",
        direct_protocol: Some("openai_chat"),
        route_protocol: "openai_chat",
        attachment: Attachment::Provider,
    },
    RoutingApp {
        app: AppType::Mcode,
        id: "mcode",
        label: "MiniMax Code",
        ingress: "/mcode",
        direct_protocol: Some("openai_chat"),
        route_protocol: "openai_chat",
        attachment: Attachment::Provider,
    },
];

/// 路由接入产生的应用供应商行 id。
///
/// 只用字母、数字和连字符：MCode 的 supplier key 不接受冒号，其余应用也接受这个形状。
pub fn provider_id(app: &AppType) -> String {
    format!("phi-route-{}", app.as_str())
}

pub fn is_gateway_provider_id(id: &str) -> bool {
    id.starts_with("phi-route-")
}

pub fn spec(app: &AppType) -> Option<&'static RoutingApp> {
    ROUTING_APPS.iter().find(|spec| spec.app == *app)
}

pub fn spec_by_id(id: &str) -> Option<&'static RoutingApp> {
    ROUTING_APPS.iter().find(|spec| spec.id == id)
}

/// 该应用能否进入统一路由（供应商直连或路由组）。
pub fn routable(app: &AppType) -> bool {
    spec(app).is_some()
}

/// 经本地 OpenAI Chat 入口（`/<app>/v1/chat/completions`）接入的应用。
///
/// 这些应用原生只讲 Chat，但路由组成员可以是 Anthropic Messages 或 Responses
/// 上游：网关先把 Chat 请求归一成 Responses（`proxy::chat_bridge`），复用既有的
/// Responses → Anthropic 转换发出去，回包再转回 Chat（`proxy::chat_upstream`）。
pub fn chat_ingress(app: &AppType) -> bool {
    matches!(
        app,
        AppType::OpenCode | AppType::OpenClaw | AppType::Hermes | AppType::Pi | AppType::Mcode
    )
}

/// 路由供应商可用的协议。`None` 表示该应用不能配这个协议的路由成员。
pub fn accepts_protocol(app: &AppType, protocol: &str) -> bool {
    let Some(spec) = spec(app) else {
        return false;
    };
    match spec.app {
        AppType::Gemini => protocol == "gemini_native",
        // Claude 入口由 Claude 适配器转换到 anthropic / openai_chat /
        // openai_responses / gemini_native，四种上游都能用。
        AppType::Claude | AppType::ClaudeDesktop => {
            matches!(
                protocol,
                "anthropic" | "openai_chat" | "openai_responses" | "gemini_native"
            )
        }
        // Codex / Grok Build 是 Responses 入口，除 Gemini 原生与 System One
        // 这两种无法承载成文本生成的协议外，都能转换。
        // System One 是决策协议，不是文本生成协议，不能混进聊天路由组。
        AppType::Codex | AppType::GrokBuild => {
            matches!(protocol, "anthropic" | "openai_chat" | "openai_responses")
        }
        // Chat 入口的应用：Chat 直接送达，Responses 与 Anthropic 经 Responses
        // 中转转换；Gemini 原生没有对应的转换器，仍然不放进路由组。
        _ if chat_ingress(&spec.app) => {
            matches!(protocol, "openai_chat" | "openai_responses" | "anthropic")
        }
        _ => false,
    }
}

/// 构造应用原生的供应商配置，供「供应商直连」和路由接入共用。
///
/// `base_url` 是请求地址（直连时是供应商地址，路由时是本地网关），`api_key` 是
/// 对应凭据，`models` 是要在应用里发布的模型名单（可为空，为空时保留应用默认）。
pub fn provider_settings(
    app: &AppType,
    base_url: &str,
    api_key: &str,
    models: &[String],
) -> Option<Value> {
    let base_url = base_url.trim_end_matches('/');
    Some(match app {
        AppType::Claude => json!({
            "env": { "ANTHROPIC_BASE_URL": base_url, "ANTHROPIC_AUTH_TOKEN": api_key }
        }),
        AppType::ClaudeDesktop => json!({
            "env": { "ANTHROPIC_BASE_URL": base_url, "ANTHROPIC_AUTH_TOKEN": api_key }
        }),
        AppType::Gemini => {
            let mut env = Map::new();
            env.insert("GOOGLE_GEMINI_BASE_URL".into(), json!(base_url));
            env.insert("GEMINI_API_KEY".into(), json!(api_key));
            if let Some(model) = models.first() {
                env.insert("GEMINI_MODEL".into(), json!(model));
            }
            json!({ "env": env })
        }
        AppType::Codex | AppType::GrokBuild => json!({
            "auth": { "OPENAI_API_KEY": api_key },
            "base_url": base_url,
        }),
        AppType::OpenCode => {
            let mut map = Map::new();
            for model in models {
                map.insert(model.clone(), json!({ "name": model }));
            }
            json!({
                "npm": "@ai-sdk/openai-compatible",
                "name": "PHI",
                "options": { "baseURL": format!("{base_url}"), "apiKey": api_key },
                "models": map,
            })
        }
        AppType::OpenClaw => json!({
            "baseUrl": base_url,
            "apiKey": api_key,
            "api": "openai-completions",
            "models": models
                .iter()
                .map(|model| json!({ "id": model, "name": model }))
                .collect::<Vec<_>>(),
        }),
        AppType::Hermes => json!({
            "name": "PHI",
            "base_url": base_url,
            "api_key": api_key,
            "api_mode": "chat_completions",
            "models": models
                .iter()
                .map(|model| json!({ "id": model, "name": model }))
                .collect::<Vec<_>>(),
        }),
        AppType::Pi => json!({
            "name": "PHI",
            "baseUrl": base_url,
            "apiKey": api_key,
            "api": "openai-completions",
            "models": models
                .iter()
                .map(|model| json!({ "id": model, "name": model }))
                .collect::<Vec<_>>(),
        }),
        AppType::Mcode => {
            let mut map = Map::new();
            for model in models {
                map.insert(model.clone(), json!({}));
            }
            json!({
                "name": "PHI",
                "kind": "custom",
                "enabled": true,
                "api": "openai-completions",
                "options": { "baseURL": format!("{base_url}"), "apiKey": api_key },
                "models": map,
            })
        }
        AppType::Zcode => return None,
    })
}

/// 从应用原生供应商配置里取出 (base_url, api_key)，用于把已有配置导入资源池。
pub fn provider_credentials(app: &AppType, settings: &Value) -> Option<(String, String)> {
    let text = |value: Option<&Value>| {
        value
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    };
    let (base_url, api_key) = match app {
        AppType::Claude | AppType::ClaudeDesktop => {
            let env = settings.get("env");
            (
                text(env.and_then(|env| env.get("ANTHROPIC_BASE_URL"))),
                text(env.and_then(|env| env.get("ANTHROPIC_AUTH_TOKEN")))
                    .or_else(|| text(env.and_then(|env| env.get("ANTHROPIC_API_KEY")))),
            )
        }
        AppType::OpenCode | AppType::Mcode => (
            text(settings.pointer("/options/baseURL")),
            text(settings.pointer("/options/apiKey")),
        ),
        AppType::OpenClaw | AppType::Pi => {
            (text(settings.get("baseUrl")), text(settings.get("apiKey")))
        }
        AppType::Hermes => (
            text(settings.get("base_url")),
            text(settings.get("api_key")),
        ),
        AppType::Codex | AppType::GrokBuild | AppType::Gemini | AppType::Zcode => return None,
    };
    Some((base_url?, api_key?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_roster_covers_the_requested_apps_once() {
        for id in [
            "claude",
            "claude-desktop",
            "codex",
            "gemini",
            "grokbuild",
            "opencode",
            "openclaw",
            "hermes",
            "pi",
            "mcode",
        ] {
            assert_eq!(
                ROUTING_APPS.iter().filter(|spec| spec.id == id).count(),
                1,
                "{id}"
            );
            assert!(spec_by_id(id).is_some(), "{id}");
        }
        assert!(!routable(&AppType::Zcode));
    }

    #[test]
    fn provider_settings_publish_models_in_each_native_shape() {
        let models = vec!["glm-5".to_string(), "kimi-k3".to_string()];
        let base = "http://127.0.0.1:15721/opencode/v1";
        let key = "phi-local-v1:opencode:test";
        let opencode = provider_settings(&AppType::OpenCode, base, key, &models).unwrap();
        assert_eq!(opencode["options"]["baseURL"], base);
        assert_eq!(opencode["options"]["apiKey"], key);
        assert_eq!(opencode["models"]["glm-5"]["name"], "glm-5");
        assert_eq!(opencode["npm"], "@ai-sdk/openai-compatible");

        let openclaw = provider_settings(&AppType::OpenClaw, base, key, &models).unwrap();
        assert_eq!(openclaw["baseUrl"], base);
        assert_eq!(openclaw["models"][0]["id"], "glm-5");

        let hermes = provider_settings(&AppType::Hermes, base, key, &models).unwrap();
        assert_eq!(hermes["base_url"], base);
        assert_eq!(hermes["api_mode"], "chat_completions");

        let pi = provider_settings(&AppType::Pi, base, key, &models).unwrap();
        assert_eq!(pi["baseUrl"], base);
        assert_eq!(pi["models"][1]["id"], "kimi-k3");

        let mcode = provider_settings(&AppType::Mcode, base, key, &models).unwrap();
        assert_eq!(mcode["options"]["baseURL"], base);
        assert_eq!(mcode["models"]["kimi-k3"], json!({}));
    }

    #[test]
    fn gateway_rows_pass_each_writer_validation() {
        let models = vec!["glm-5".to_string()];
        let settings = |app: &AppType| {
            provider_settings(
                app,
                "http://127.0.0.1:15721/opencode/v1",
                "phi-local",
                &models,
            )
            .unwrap()
        };
        // OpenCode：V1 声明需要 npm + models，provider_fragment 推断为 V1。
        let opencode = settings(&AppType::OpenCode);
        let (_, format) =
            crate::opencode_config::provider_fragment("phi-route-opencode", &opencode, None)
                .unwrap();
        assert_eq!(format, crate::provider::OpenCodeConfigFormat::V1);

        // OpenClaw：必须能反序列化成它的 typed provider。
        serde_json::from_value::<crate::openclaw_config::OpenClawProviderConfig>(settings(
            &AppType::OpenClaw,
        ))
        .expect("OpenClaw accepts the row");

        // MCode：key 不能带冒号，api/options/models 必须齐全。
        crate::mcode_config::validate_provider("phi-route-mcode", &settings(&AppType::Mcode))
            .expect("MCode accepts the row");

        // Pi：models.json 的节点必须可写。
        crate::pi_config::validate_provider_node("phi-route-pi", &settings(&AppType::Pi))
            .expect("Pi accepts the row");

        // Hermes：custom_providers 使用 snake_case 字段。
        let hermes = settings(&AppType::Hermes);
        assert_eq!(hermes["name"], "PHI");
        assert_eq!(hermes["api_mode"], "chat_completions");
        assert!(hermes["models"]
            .as_array()
            .is_some_and(|rows| !rows.is_empty()));
    }

    #[test]
    fn credentials_round_trip_for_provider_rows() {
        let models = vec!["glm-5".to_string()];
        for app in [
            AppType::OpenCode,
            AppType::OpenClaw,
            AppType::Hermes,
            AppType::Pi,
            AppType::Mcode,
        ] {
            let settings =
                provider_settings(&app, "https://upstream.example/v1", "sk-test", &models).unwrap();
            assert_eq!(
                provider_credentials(&app, &settings),
                Some(("https://upstream.example/v1".into(), "sk-test".into())),
                "{:?}",
                app
            );
        }
    }

    #[test]
    fn protocols_follow_the_entry_each_client_speaks() {
        assert!(accepts_protocol(&AppType::ClaudeDesktop, "anthropic"));
        assert!(accepts_protocol(&AppType::ClaudeDesktop, "gemini_native"));
        assert!(accepts_protocol(&AppType::OpenCode, "openai_chat"));
        assert!(accepts_protocol(&AppType::Gemini, "gemini_native"));
        assert!(!accepts_protocol(&AppType::Gemini, "openai_chat"));
    }

    #[test]
    fn chat_ingress_apps_accept_every_bridged_protocol_but_gemini() {
        for app in [
            AppType::OpenCode,
            AppType::OpenClaw,
            AppType::Hermes,
            AppType::Pi,
            AppType::Mcode,
        ] {
            assert!(chat_ingress(&app), "{:?}", app);
            for protocol in ["openai_chat", "openai_responses", "anthropic"] {
                assert!(accepts_protocol(&app, protocol), "{:?} {protocol}", app);
            }
            assert!(!accepts_protocol(&app, "gemini_native"), "{:?}", app);
            assert!(!accepts_protocol(&app, "unknown"), "{:?}", app);
            // 直连仍只认应用原生协议：桥接只发生在本地路由里。
            assert_eq!(spec(&app).unwrap().direct_protocol, Some("openai_chat"));
        }
        assert!(!chat_ingress(&AppType::Codex));
    }
}
