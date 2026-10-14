//! Local access identities. Tokens live only for this application process;
//! attaching a client writes its identity into the client's native configuration.
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

const APPS: [&str; 5] = ["claude", "codex", "gemini", "grokbuild", "claude-desktop"];
static TOKENS: LazyLock<Vec<String>> = LazyLock::new(|| {
    APPS.iter()
        .map(|app| {
            // Three independent UUID v4 values provide more than 256 bits of entropy.
            let seed = format!(
                "{}{}{}",
                uuid::Uuid::new_v4(),
                uuid::Uuid::new_v4(),
                uuid::Uuid::new_v4()
            );
            format!("phi-local-v1:{app}:{:x}", Sha256::digest(seed.as_bytes()))
        })
        .collect()
});

pub fn token(app: &str) -> &'static str {
    &TOKENS[APPS
        .iter()
        .position(|value| *value == app)
        .expect("supported ingress app")]
}

pub fn is_local_credential(value: &str) -> bool {
    value == "PROXY_MANAGED" || value.starts_with("phi-local-v1:") || value.starts_with("phi-binding-v1:")
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
    let expected = if path.starts_with("/claude-desktop/") {
        "claude-desktop"
    } else if path.starts_with("/grokbuild/") {
        "grokbuild"
    } else if path.starts_with("/gemini/") || path.starts_with("/v1beta/") {
        "gemini"
    } else if path.starts_with("/claude/") || path == "/v1/messages" {
        "claude"
    } else {
        "codex"
    };
    app == expected
}

#[cfg(test)]
pub async fn authenticate(request: Request, next: Next) -> Response {
    authenticate_inner(None, request, next).await
}
pub async fn authenticate_bound(
    axum::extract::State(state): axum::extract::State<super::server::ProxyState>, request: Request, next: Next,
) -> Response { authenticate_inner(Some(&state.db), request, next).await }

async fn authenticate_inner(db: Option<&crate::Database>, mut request: Request, next: Next) -> Response {
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
        .find(|app| equal(token(app), local) && permitted(app, request.uri().path())).copied();
    let binding = if local_app.is_none() {
        db.and_then(|db|db.authenticate_binding(local).ok().flatten())
    } else { None };
    let Some(app) = local_app.or_else(|| binding.as_ref().and_then(|b|crate::access::tool_app(&b.tool)).filter(|app|permitted(app,request.uri().path()))) else {
        return reject();
    };
    let preserve_official = dedicated.is_some() && app == "codex" && binding.is_none();
    if dedicated.is_some() && headers.get("authorization").and_then(|v|v.to_str().ok()).and_then(|v|v.strip_prefix("Bearer ")).is_some_and(is_local_credential) {
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
    fn tokens_are_independent_and_comparison_rejects_legacy_placeholders() {
        for app in APPS {
            assert!(equal(token(app), token(app)));
            assert!(!equal(token(app), "PROXY_MANAGED"));
            assert!(token(app).len() > 64);
        }
        assert!(!equal(token("claude"), token("codex")));
        assert!(!permitted("claude", "/v1/responses"));
        assert!(!permitted("codex", "/gemini/v1beta/models"));
    }
}
