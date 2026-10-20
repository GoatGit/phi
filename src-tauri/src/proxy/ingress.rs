//! Local access identities. Tokens are generated once and kept in `~/.phi`, so
//! restarting PHI no longer invalidates the identities already written into each
//! client's native configuration. Attaching a client still rewrites its config.
use axum::{
    extract::Request,
    http::StatusCode,
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use std::sync::LazyLock;

const APPS: [&str; 17] = [
    "claude",
    "codex",
    "gemini",
    "grokbuild",
    "claude-desktop",
    "opencode",
    "openclaw",
    "hermes",
    "pi",
    "mcode",
    // 路由专用应用：只经本地网关接入路由组，不在侧栏出现。
    "commandcode",
    "crush",
    "droid",
    "kimi",
    "atomcode",
    "omo",
    // System One 虚拟应用：只经 /typesafe/v1/systemone 进入决策组。
    "typesafe",
];
/// Written next to the other PHI state so a restart reuses the same identities.
const TOKEN_FILE: &str = "local-tokens.json";

static TOKENS: LazyLock<Vec<String>> = LazyLock::new(|| load_tokens());

fn generate(app: &str) -> String {
    // Three independent UUID v4 values provide more than 256 bits of entropy.
    let seed = format!(
        "{}{}{}",
        uuid::Uuid::new_v4(),
        uuid::Uuid::new_v4(),
        uuid::Uuid::new_v4()
    );
    format!("phi-local-v1:{app}:{:x}", Sha256::digest(seed.as_bytes()))
}

fn token_path() -> std::path::PathBuf {
    crate::config::get_app_config_dir().join(TOKEN_FILE)
}

/// Reads the stored identities, keeping the ones that still look like our own and
/// minting the rest. A missing, unreadable or damaged file falls back to fresh
/// tokens instead of failing the gateway.
fn load_tokens() -> Vec<String> {
    let stored: std::collections::HashMap<String, String> = std::fs::read_to_string(token_path())
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    let mut changed = false;
    let tokens: Vec<String> = APPS
        .iter()
        .map(|app| match stored.get(*app) {
            Some(value) if value.starts_with(&format!("phi-local-v1:{app}:")) => value.clone(),
            _ => {
                changed = true;
                generate(app)
            }
        })
        .collect();
    if changed {
        store_tokens(&tokens);
    }
    tokens
}

fn store_tokens(tokens: &[String]) {
    let map: std::collections::BTreeMap<&str, &str> = APPS
        .iter()
        .copied()
        .zip(tokens.iter().map(String::as_str))
        .collect();
    let path = token_path();
    if let Some(parent) = path.parent() {
        if let Err(error) = std::fs::create_dir_all(parent) {
            log::warn!("无法创建本地令牌目录: {error}");
            return;
        }
    }
    match serde_json::to_vec_pretty(&map) {
        Ok(bytes) => {
            if let Err(error) = write_private(&path, &bytes) {
                log::warn!("无法保存本地令牌，重启后需要重新连接客户端: {error}");
            }
        }
        Err(error) => log::warn!("无法序列化本地令牌: {error}"),
    }
}

/// The file grants local gateway access, so it is owner-only and replaced atomically.
fn write_private(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let temporary = path.with_extension("json.tmp");
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(&temporary, path)
}

pub fn token(app: &str) -> &'static str {
    &TOKENS[APPS
        .iter()
        .position(|value| *value == app)
        .expect("supported ingress app")]
}

pub fn is_local_credential(value: &str) -> bool {
    value == "PROXY_MANAGED"
        || value.starts_with("phi-local-v1:")
        || value.starts_with("phi-binding-v1:")
}

pub fn listen_ip(address: &str) -> Result<std::net::IpAddr, String> {
    let ip = if address == "localhost" {
        std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST)
    } else {
        address
            .parse()
            .map_err(|_| "Invalid loopback address".to_string())?
    };
    if !ip.is_loopback() {
        return Err(
            "PHI only accepts loopback listeners; use an encrypted tunnel for remote access".into(),
        );
    }
    Ok(ip)
}

fn equal(expected: &str, supplied: &str) -> bool {
    let mut mac =
        Hmac::<Sha256>::new_from_slice(expected.as_bytes()).expect("HMAC accepts any key");
    mac.update(b"phi-local-ingress");
    let tag = mac.finalize().into_bytes();
    let mut mac =
        Hmac::<Sha256>::new_from_slice(supplied.as_bytes()).expect("HMAC accepts any key");
    mac.update(b"phi-local-ingress");
    mac.verify_slice(&tag).is_ok()
}

fn permitted(app: &str, path: &str) -> bool {
    if path == "/status" {
        return true;
    }
    if matches!(path, "/models" | "/v1/models") {
        return matches!(app, "claude" | "codex");
    }
    if path.starts_with("/typesafe/") {
        return app == crate::gateway::typesafe::APP_ID;
    }
    // 路由专用应用：入口前缀就是它的命名空间。
    if let Some(spec) = crate::gateway::local_apps::LOCAL_APPS
        .iter()
        .find(|spec| path.starts_with(&format!("{}/", spec.ingress)))
    {
        return app == spec.id;
    }
    let expected = if path.starts_with("/claude-desktop/") {
        "claude-desktop"
    } else if path.starts_with("/grokbuild/") {
        "grokbuild"
    } else if path.starts_with("/gemini/") || path.starts_with("/v1beta/") {
        "gemini"
    } else if path.starts_with("/opencode/") {
        "opencode"
    } else if path.starts_with("/openclaw/") {
        "openclaw"
    } else if path.starts_with("/hermes/") {
        "hermes"
    } else if path.starts_with("/pi/") {
        "pi"
    } else if path.starts_with("/mcode/") {
        "mcode"
    } else if path.starts_with("/claude/") || path == "/v1/messages" {
        "claude"
    } else {
        "codex"
    };
    app == expected
}

/// 外部接入（`tool = external`）的入口协议 → 路由身份。
///
/// 同一个令牌可以用任何一种协议进来，所以这里不按应用发牌，而是让入口路径决定
/// 这次请求以哪个应用的协议身份参与选组与转换：Chat 入口沿用聊天应用（它已经能
/// 一跳转发到 Anthropic），Responses 用 Codex，Messages 用 Claude，Gemini 用
/// Gemini，System One 走它自己的决策入口。返回 `None` 表示该路径不属于外部接入。
pub fn external_app(path: &str) -> Option<&'static str> {
    if path == "/status" {
        return Some(crate::access::EXTERNAL_TOOL);
    }
    if matches!(path, "/models" | "/v1/models") {
        return Some(crate::access::EXTERNAL_TOOL);
    }
    if path == "/typesafe/v1/systemone" {
        return Some(crate::gateway::typesafe::APP_ID);
    }
    if path.starts_with("/v1beta/") {
        return Some("gemini");
    }
    if path == "/v1/messages" {
        return Some("claude");
    }
    if matches!(
        path,
        "/responses"
            | "/v1/responses"
            | "/v1/v1/responses"
            | "/responses/compact"
            | "/v1/responses/compact"
            | "/v1/v1/responses/compact"
    ) {
        return Some("codex");
    }
    if matches!(
        path,
        "/chat/completions" | "/v1/chat/completions" | "/v1/v1/chat/completions"
    ) {
        return Some("opencode");
    }
    None
}

#[cfg(test)]
pub async fn authenticate(request: Request, next: Next) -> Response {
    authenticate_inner(None, request, next).await
}
pub async fn authenticate_bound(
    axum::extract::State(state): axum::extract::State<super::server::ProxyState>,
    request: Request,
    next: Next,
) -> Response {
    authenticate_inner(Some(&state.db), request, next).await
}

async fn authenticate_inner(
    db: Option<&crate::Database>,
    mut request: Request,
    next: Next,
) -> Response {
    if request.uri().path() == "/health" {
        return next.run(request).await;
    }
    let reject = || {
        (StatusCode::UNAUTHORIZED, Json(serde_json::json!({
        "error": {"type": "authentication_error", "message": "A valid PHI local access token is required. Reconnect the client in PHI."}
    }))).into_response()
    };
    // Credentials in URLs can leak through history, logs and referrers.
    if request.uri().query().is_some_and(|query| {
        url::form_urlencoded::parse(query.as_bytes()).any(|(key, _)| {
            matches!(
                key.to_ascii_lowercase().as_str(),
                "key" | "api_key" | "access_token" | "token" | "x-phi-token"
            )
        })
    }) {
        return reject();
    }
    let headers = request.headers();
    let dedicated = headers
        .get("x-phi-token")
        .and_then(|value| value.to_str().ok());
    let names = [
        "x-phi-token",
        "authorization",
        "x-api-key",
        "x-goog-api-key",
    ];
    if names
        .iter()
        .any(|name| headers.get_all(*name).iter().count() > 1)
    {
        return reject();
    }
    let supplied: Vec<_> = names
        .iter()
        .filter_map(|name| {
            let value = headers.get(*name)?.to_str().ok()?;
            if *name == "authorization" {
                value.strip_prefix("Bearer ")
            } else {
                Some(value)
            }
        })
        .collect();
    // Dedicated local auth permits the official Codex bearer to remain distinct.
    let local = match dedicated {
        Some(local)
            if !headers.contains_key("x-api-key") && !headers.contains_key("x-goog-api-key") =>
        {
            local
        }
        None if supplied.len() == 1
            && names
                .iter()
                .filter(|name| headers.contains_key(**name))
                .count()
                == 1 =>
        {
            supplied[0]
        }
        _ => return reject(),
    };
    let local_app = APPS
        .iter()
        .find(|app| equal(token(app), local) && permitted(app, request.uri().path()))
        .copied();
    let binding = if local_app.is_none() {
        db.and_then(|db| db.authenticate_binding(local).ok().flatten())
    } else {
        None
    };
    let app = if let Some(app) = local_app {
        Some(app)
    } else if let Some(binding) = binding.as_ref() {
        if crate::access::is_external(&binding.tool) {
            external_app(request.uri().path())
        } else {
            crate::access::tool_app(&binding.tool)
                .filter(|app| permitted(app, request.uri().path()))
        }
    } else {
        None
    };
    let Some(app) = app else {
        return reject();
    };
    let preserve_official = dedicated.is_some() && app == "codex" && binding.is_none();
    if dedicated.is_some()
        && headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .is_some_and(is_local_credential)
    {
        return reject();
    }
    if dedicated.is_some() && headers.contains_key("authorization") && !preserve_official {
        return reject();
    }
    for name in names {
        if !(preserve_official && name == "authorization") {
            request.headers_mut().remove(name);
        }
    }
    // Discovery is bound to the authenticated client, never its self-reported UA.
    request.extensions_mut().insert(Identity { app, binding });
    next.run(request).await
}

#[derive(Clone)]
pub struct Identity {
    pub app: &'static str,
    pub binding: Option<crate::access::Binding>,
}

#[cfg(test)]
mod tests {
    #[test]
    fn external_access_opens_every_protocol_entry() {
        for (path, app) in [
            ("/v1/chat/completions", "opencode"),
            ("/chat/completions", "opencode"),
            ("/v1/responses", "codex"),
            ("/responses", "codex"),
            ("/v1/responses/compact", "codex"),
            ("/v1/v1/responses/compact", "codex"),
            ("/v1/messages", "claude"),
            ("/v1beta/models/gemini-3-pro:generateContent", "gemini"),
            ("/typesafe/v1/systemone", "typesafe"),
            ("/v1/models", crate::access::EXTERNAL_TOOL),
        ] {
            assert_eq!(super::external_app(path), Some(app), "{path}");
        }
        // 应用自己的命名空间不属于外部接入：那些路径有自己的本地令牌。
        for path in [
            "/pi/v1/models",
            "/opencode/v1/chat/completions",
            "/v1/images/edits",
        ] {
            assert_eq!(super::external_app(path), None, "{path}");
        }
    }

    #[test]
    fn a_local_token_only_opens_its_own_application_namespace() {
        assert!(super::permitted(
            "opencode",
            "/opencode/v1/chat/completions"
        ));
        assert!(super::permitted("mcode", "/mcode/v1/models"));
        assert!(!super::permitted(
            "opencode",
            "/openclaw/v1/chat/completions"
        ));
        assert!(!super::permitted("pi", "/mcode/v1/chat/completions"));
        assert!(!super::permitted("hermes", "/v1/chat/completions"));
    }

    use super::*;
    use axum::{body::Body, http::Request as HttpRequest, routing::any, Router};
    use tower::Service;

    #[tokio::test]
    async fn authentication_precedes_body_reads_and_strips_only_local_credentials() {
        let mut router = Router::new().fallback(any(|request: Request| async move {
            let identity = request.extensions().get::<Identity>().unwrap().app;
            assert!(!request.headers().contains_key("x-phi-token"));
            assert!(!request.headers().contains_key("x-api-key"));
            assert!(!request.headers().contains_key("x-goog-api-key"));
            Json(serde_json::json!({"app": identity, "authorization": request.headers().get("authorization").and_then(|h| h.to_str().ok())}))
        })).layer(axum::middleware::from_fn(authenticate));
        for path in [
            "/v1/messages",
            "/claude/v1/messages",
            "/responses",
            "/v1/responses",
            "/v1/v1/responses",
            "/codex/v1/responses",
            "/v1/chat/completions",
            "/v1/images/edits",
            "/v1/responses/compact",
            "/models",
            "/status",
            "/gemini/v1beta/models/a:generateContent",
            "/grokbuild/v1/responses",
            "/claude-desktop/v1/models",
        ] {
            for supplied in [
                None,
                Some("PROXY_MANAGED"),
                Some("phi-local-v1:codex:expired"),
            ] {
                let never_poll = futures::stream::poll_fn(
                    |_| -> std::task::Poll<Option<Result<bytes::Bytes, std::io::Error>>> {
                        panic!("unauthenticated body was read")
                    },
                );
                let mut request = HttpRequest::builder().uri(path);
                if let Some(supplied) = supplied {
                    request = request.header("authorization", format!("Bearer {supplied}"));
                }
                let response = router
                    .call(request.body(Body::from_stream(never_poll)).unwrap())
                    .await
                    .unwrap();
                assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{path}");
            }
        }
        for (app, path, header) in [
            ("claude", "/v1/messages", "x-api-key"),
            ("codex", "/v1/responses", "authorization"),
            (
                "gemini",
                "/gemini/v1beta/models/a:generateContent",
                "x-goog-api-key",
            ),
            ("grokbuild", "/grokbuild/v1/responses", "authorization"),
            (
                "claude-desktop",
                "/claude-desktop/v1/models",
                "authorization",
            ),
            ("opencode", "/opencode/v1/chat/completions", "authorization"),
            ("openclaw", "/openclaw/v1/models", "authorization"),
            ("hermes", "/hermes/v1/chat/completions", "authorization"),
            ("pi", "/pi/v1/chat/completions", "authorization"),
            ("mcode", "/mcode/v1/chat/completions", "authorization"),
            ("typesafe", "/typesafe/v1/systemone", "authorization"),
        ] {
            let value = if header == "authorization" {
                format!("Bearer {}", token(app))
            } else {
                token(app).into()
            };
            let response = router
                .call(
                    HttpRequest::builder()
                        .uri(path)
                        .header(header, value)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let body = axum::body::to_bytes(response.into_body(), 4096)
                .await
                .unwrap();
            let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(value["app"], app);
            assert!(value["authorization"].is_null());
        }
        let response = router
            .call(
                HttpRequest::builder()
                    .uri("/v1/responses")
                    .header("x-phi-token", token("codex"))
                    .header("authorization", "Bearer official-login")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap();
        let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["authorization"], "Bearer official-login");
        for request in [
            HttpRequest::builder()
                .uri("/v1/responses")
                .header("authorization", format!("Bearer {}", token("claude"))),
            HttpRequest::builder()
                .uri("/v1/responses?key=secret")
                .header("authorization", format!("Bearer {}", token("codex"))),
            HttpRequest::builder()
                .uri("/v1/responses")
                .header("authorization", format!("Bearer {}", token("codex")))
                .header("x-api-key", token("codex")),
            HttpRequest::builder()
                .uri("/v1/responses")
                .header("authorization", format!("Bearer {}", token("codex")))
                .header("authorization", "Bearer duplicate"),
        ] {
            assert_eq!(
                router
                    .call(request.body(Body::empty()).unwrap())
                    .await
                    .unwrap()
                    .status(),
                StatusCode::UNAUTHORIZED
            );
        }
    }

    #[test]
    fn only_loopback_listeners_are_accepted() {
        for address in ["127.0.0.1", "127.2.3.4", "::1", "localhost"] {
            assert!(listen_ip(address).is_ok());
        }
        for address in ["0.0.0.0", "::", "192.168.1.2", "example.com"] {
            assert!(listen_ip(address).is_err());
        }
    }
    #[test]
    fn stored_tokens_survive_a_restart_and_stay_owner_only() {
        let home = std::env::temp_dir().join(format!("phi-tokens-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&home).unwrap();
        let previous = std::env::var_os("PHI_TEST_HOME");
        std::env::set_var("PHI_TEST_HOME", &home);
        let first = super::load_tokens();
        // 重启等价于重新读取同一份文件：身份必须完全一致。
        let second = super::load_tokens();
        let path = super::token_path();
        match previous {
            Some(value) => std::env::set_var("PHI_TEST_HOME", value),
            None => std::env::remove_var("PHI_TEST_HOME"),
        }
        assert_eq!(first, second);
        assert_eq!(first.len(), APPS.len());
        assert!(first.iter().all(|value| value.starts_with("phi-local-v1:")));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "{path:?}");
        }
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn tokens_are_independent_and_comparison_rejects_legacy_placeholders() {
        for app in APPS {
            assert!(equal(token(app), token(app)));
            assert!(!equal(token(app), "PROXY_MANAGED"));
            assert!(token(app).len() > 64);
        }
        assert!(!equal(token("claude"), token("codex")));
        assert!(!permitted("claude", "/v1/responses"));
        assert!(!permitted("codex", "/gemini/v1beta/models"));
        // System One 只有自己的决策入口，不能借道聊天路径。
        assert!(permitted("typesafe", "/typesafe/v1/systemone"));
        assert!(!permitted("typesafe", "/v1/responses"));
        assert!(!permitted("codex", "/typesafe/v1/systemone"));
    }
}
