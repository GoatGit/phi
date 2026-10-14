//! Read-only diagnostics. Reports contain codes and metadata, never config contents.
use crate::{error::AppError, store::AppState};
use futures::{stream, StreamExt};
use serde::Serialize;
use std::{
    io::Read,
    path::{Path, PathBuf},
    sync::atomic::Ordering,
    time::Duration,
};
mod adapters;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub id: String,
    pub subject: String,
    pub state: &'static str,
    pub code: String,
    pub latency_ms: Option<u64>,
}
fn check(
    id: &str,
    subject: impl Into<String>,
    state: &'static str,
    code: impl Into<String>,
) -> Check {
    Check {
        id: id.into(),
        subject: subject.into(),
        state,
        code: code.into(),
        latency_ms: None,
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub checked_at: i64,
    pub checks: Vec<Check>,
}

pub async fn gateway(state: &AppState, upstreams: bool) -> Result<Report, String> {
    let status = state.proxy_service.get_status().await?;
    let config = state.proxy_service.get_config().await?;
    let mut checks = vec![check(
        "ledger",
        "PHI",
        if state.db.ledger_available.load(Ordering::Acquire) {
            "ok"
        } else {
            "error"
        },
        if state.db.ledger_available.load(Ordering::Acquire) {
            "ledgerReady"
        } else {
            "ledgerUnavailable"
        },
    )];
    if status.running {
        let ip = crate::proxy::ingress::listen_ip(&status.address)?;
        let url = format!(
            "http://{}/health",
            std::net::SocketAddr::new(ip, status.port)
        );
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(2))
            .build()
            .map_err(|_| "diagnostic client unavailable")?;
        let alive = match client.get(url).send().await {
            Ok(response) if response.status().is_success() => response
                .json::<serde_json::Value>()
                .await
                .ok()
                .is_some_and(|v| v["status"] == "healthy"),
            _ => false,
        };
        checks.push(check(
            "listener",
            format!("{}:{}", status.address, status.port),
            if alive { "ok" } else { "error" },
            if alive {
                "listenerReady"
            } else {
                "listenerUnreachable"
            },
        ));
    } else {
        checks.push(check(
            "listener",
            "PHI",
            if status.listener_state == "failed" {
                "error"
            } else {
                "warning"
            },
            match status.listener_state.as_str() {
                "failed" => "listenerFailed",
                "restarting" => "listenerRestarting",
                _ => "listenerStopped",
            },
        ));
        if let Ok(ip) = crate::proxy::ingress::listen_ip(&config.listen_address) {
            let free = tokio::net::TcpListener::bind((ip, config.listen_port))
                .await
                .is_ok();
            checks.push(check(
                "port",
                format!("{}:{}", config.listen_address, config.listen_port),
                if free { "ok" } else { "warning" },
                if free { "portFree" } else { "portBusy" },
            ));
        }
    }
    checks.push(check(
        "supervisor",
        format!("{}", status.listener_restarts),
        "info",
        "listenerRestarts",
    ));
    let catalog = state
        .db
        .gateway_catalog_snapshot()
        .map_err(|_| "cannot read routing catalog")?;
    checks.push(check(
        "suppliers",
        catalog.suppliers.len().to_string(),
        if catalog.suppliers.is_empty() {
            "warning"
        } else {
            "ok"
        },
        if catalog.suppliers.is_empty() {
            "supplierMissing"
        } else {
            "supplierConfigured"
        },
    ));
    for app in ["claude", "codex", "gemini", "grokbuild"] {
        let aliases = crate::gateway::routing::published_aliases(&catalog, app);
        checks.push(check(
            &format!("routes:{app}"),
            app,
            if aliases.is_empty() { "info" } else { "ok" },
            if aliases.is_empty() {
                "noPublishedRoutes"
            } else {
                "routesPublished"
            },
        ));
    }
    let page = state
        .db
        .ledger_page(crate::ledger::LedgerQuery {
            since: Some(chrono::Utc::now().timestamp_millis() - 86_400_000),
            ..Default::default()
        })
        .map_err(|_| "cannot read ledger diagnostics")?;
    for reason in page
        .records
        .iter()
        .flat_map(|r| r.reason_codes.iter())
        .collect::<std::collections::BTreeSet<_>>()
    {
        // Only enumerated reason codes enter a diagnostic export.
        let code = reason.rsplit(':').next().unwrap_or_default();
        if matches!(
            code,
            "BUDGET_BLOCK" | "UNPRICED" | "USAGE_UNKNOWN" | "PROJECT_BINDING_REQUIRED"
        ) {
            checks.push(check("budget", "PHI", "warning", code));
        }
    }
    if upstreams {
        let client = reqwest::Client::builder()
            .use_rustls_tls()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(4))
            .build()
            .map_err(|_| "TLS diagnostic client unavailable")?;
        let jobs = catalog.suppliers.into_iter().map(|supplier| {
            let client = client.clone();
            async move {
                let started = std::time::Instant::now();
                let mut result = check(&supplier.id, supplier.name, "error", "endpointInvalid");
                if let Ok(mut url) = reqwest::Url::parse(&supplier.endpoint.base_url) {
                    let _ = url.set_username("");
                    let _ = url.set_password(None);
                    url.set_query(None);
                    url.set_fragment(None);
                    if matches!(url.scheme(), "https" | "http") {
                        match client.head(url).send().await {
                            Ok(response) => {
                                result.state = "ok";
                                result.code = format!("HTTP {}", response.status().as_u16());
                            }
                            Err(error) => {
                                result.code = if error.is_timeout() {
                                    "endpointTimeout"
                                } else if error.is_connect() {
                                    "endpointConnectFailed"
                                } else {
                                    "endpointTlsOrTransportFailed"
                                }
                                .into();
                            }
                        }
                    }
                }
                result.latency_ms = Some(started.elapsed().as_millis() as u64);
                result
            }
        });
        checks.extend(
            stream::iter(jobs)
                .buffer_unordered(4)
                .collect::<Vec<_>>()
                .await,
        );
    }
    Ok(Report {
        checked_at: chrono::Utc::now().timestamp_millis(),
        checks,
    })
}

const MAX_CONFIG_BYTES: u64 = 5 * 1024 * 1024;

fn read_bounded(path: &Path) -> Result<Vec<u8>, &'static str> {
    let file = std::fs::File::open(path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "fileMissing"
        } else {
            "fileUnreadable"
        }
    })?;
    if !file.metadata().map_err(|_| "fileUnreadable")?.is_file() {
        return Err("fileTooLarge");
    }
    let mut bytes = Vec::new();
    file.take(MAX_CONFIG_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "fileUnreadable")?;
    if bytes.len() as u64 > MAX_CONFIG_BYTES {
        return Err("fileTooLarge");
    }
    Ok(bytes)
}

fn file_check(app: &str, path: &Path, format: &str) -> Check {
    let subject = format!("{app}: {}", path.display());
    let metadata = match std::fs::metadata(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return check(app, subject, "info", "fileMissing")
        }
        Err(_) => return check(app, subject, "error", "fileUnreadable"),
    };
    if !metadata.is_file() || metadata.len() > MAX_CONFIG_BYTES {
        return check(app, subject, "error", "fileTooLarge");
    }
    let text =
        match read_bounded(path).and_then(|b| String::from_utf8(b).map_err(|_| "fileInvalid")) {
            Ok(value) => value,
            Err(code) => return check(app, subject, "error", code),
        };
    let valid = match format {
        "toml" => toml::from_str::<toml::Value>(&text).is_ok(),
        "yaml" => serde_yaml::from_str::<serde_yaml::Value>(&text).is_ok(),
        "env" => text.lines().all(|line| {
            let line = line.trim();
            line.is_empty() || line.starts_with('#') || line.contains('=')
        }),
        _ => json5::from_str::<serde_json::Value>(&text).is_ok(),
    };
    if !valid {
        return check(app, subject, "error", "fileInvalid");
    }
    check(
        app,
        subject,
        if metadata.permissions().readonly() {
            "warning"
        } else {
            "ok"
        },
        if metadata.permissions().readonly() {
            "fileReadOnly"
        } else {
            "fileReadable"
        },
    )
}
pub fn adapters(
    catalog: &crate::gateway::Catalog,
    proxy_url: Option<&str>,
) -> Result<Report, AppError> {
    let mut files: Vec<(&str, PathBuf, &str)> = vec![
        ("claude", crate::config::get_claude_settings_path(), "json"),
        (
            "codex",
            crate::codex_config::get_codex_config_path(),
            "toml",
        ),
        ("codex", crate::codex_config::get_codex_auth_path(), "json"),
        ("gemini", crate::gemini_config::get_gemini_env_path(), "env"),
        (
            "gemini",
            crate::gemini_config::get_gemini_settings_path(),
            "json",
        ),
        (
            "grokbuild",
            crate::grok_config::get_grok_config_path(),
            "toml",
        ),
        (
            "openclaw",
            crate::openclaw_config::get_openclaw_config_path(),
            "json",
        ),
        (
            "hermes",
            crate::hermes_config::get_hermes_config_path(),
            "yaml",
        ),
        (
            "opencode",
            crate::opencode_config::get_opencode_config_path()?,
            "json",
        ),
        ("pi", crate::pi_config::get_pi_models_path()?, "json"),
        ("pi", crate::pi_config::get_pi_settings_path()?, "json"),
    ];
    files.push(("mcode", crate::mcode_config::config_path(), "json"));
    files.sort_by(|a, b| a.0.cmp(b.0));
    let mut checks = vec![];
    let mut paths = std::collections::HashSet::new();
    for (app, path, format) in &files {
        let resolved = std::fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
        if !paths.insert(resolved) {
            checks.push(check(
                app,
                path.display().to_string(),
                "warning",
                "sharedFile",
            ));
        }
        checks.push(file_check(app, path, format));
    }
    // Do not use state::load here: it moves malformed files aside for recovery.
    let store = crate::live::engine::DeviceStore::for_device();
    match adapters::read_state(&store) {
        Ok(live) => checks.extend(adapters::inspect(&live, &files, catalog, proxy_url)),
        Err(code) => checks.push(check(
            "live-state",
            store.state_path().display().to_string(),
            "error",
            code,
        )),
    }
    Ok(Report {
        checked_at: chrono::Utc::now().timestamp_millis(),
        checks,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn diagnostics_do_not_return_secret_values_or_parser_errors() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(&path, "{\"api_key\":\"private-value\", BROKEN}").unwrap();
        let result = file_check("test", &path, "json");
        assert_eq!(result.code, "fileInvalid");
        assert!(!serde_json::to_string(&result)
            .unwrap()
            .contains("private-value"));
        assert_eq!(
            file_check("test", &dir.path().join("missing"), "json").state,
            "info"
        );
    }
}
