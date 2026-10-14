//! Inspect wiring and pending operations without invoking a writer or recovery.
use super::{check, read_bounded, Check};
use crate::{
    gateway::Catalog,
    live::engine::DeviceStore,
    mode::state::{LiveState, Mode},
};
use serde_json::Value;
use std::{collections::BTreeMap, path::PathBuf};

pub(super) fn read_state(store: &DeviceStore) -> Result<LiveState, &'static str> {
    let bytes = match read_bounded(&store.state_path()) {
        Ok(bytes) => bytes,
        Err("fileMissing") => return Ok(LiveState::default()),
        Err(_) => return Err("stateUnreadable"),
    };
    let state: LiveState = serde_json::from_slice(&bytes).map_err(|_| "stateInvalid")?;
    if state.version != crate::mode::state::STATE_VERSION {
        return Err("stateVersionUnknown");
    }
    Ok(state)
}

fn document(path: &std::path::Path, format: &str) -> Option<Value> {
    let text = String::from_utf8(read_bounded(path).ok()?).ok()?;
    match format {
        "toml" => serde_json::to_value(toml::from_str::<toml::Value>(&text).ok()?).ok(),
        "env" => {
            let entries = crate::live::patch::dotenv::entries(&text);
            Some(Value::Object(
                entries
                    .into_iter()
                    .map(|(key, value)| {
                        let value = value
                            .strip_prefix('"')
                            .and_then(|v| v.strip_suffix('"'))
                            .or_else(|| value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')))
                            .unwrap_or(&value)
                            .to_owned();
                        (key, Value::String(value))
                    })
                    .collect(),
            ))
        }
        _ => json5::from_str(&text).ok(),
    }
}

fn same_endpoint(actual: Option<&str>, expected: &str) -> bool {
    let Some(actual) = actual.and_then(|v| url::Url::parse(v).ok()) else {
        return false;
    };
    let Ok(expected) = url::Url::parse(expected) else {
        return false;
    };
    actual.scheme() == expected.scheme()
        && actual.host() == expected.host()
        && actual.port_or_known_default() == expected.port_or_known_default()
        && actual.path().trim_end_matches('/') == expected.path().trim_end_matches('/')
        && actual.username().is_empty()
        && actual.password().is_none()
        && actual.query().is_none()
        && actual.fragment().is_none()
}

fn wiring(app: &str, value: &Value, extra: &Value, origin: &str) -> Vec<Check> {
    let token = crate::proxy::ingress::token(app);
    let (endpoint, expected, auth_ok, protocol_ok) = match app {
        "claude" => {
            let env = &value["env"];
            let auth: Vec<_> = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]
                .into_iter()
                .filter_map(|key| env[key].as_str())
                .filter(|v| !v.is_empty())
                .collect();
            (
                env["ANTHROPIC_BASE_URL"].as_str(),
                origin.to_owned(),
                auth.len() == 1 && auth[0] == token,
                ![
                    "CLAUDE_CODE_USE_BEDROCK",
                    "CLAUDE_CODE_USE_VERTEX",
                    "CLAUDE_CODE_USE_FOUNDRY",
                ]
                .iter()
                .any(|key| matches!(env[*key].as_str(), Some("1" | "true"))),
            )
        }
        "gemini" => (
            value["GOOGLE_GEMINI_BASE_URL"].as_str(),
            origin.to_owned(),
            value["GEMINI_API_KEY"].as_str() == Some(token),
            extra
                .pointer("/security/auth/selectedType")
                .and_then(Value::as_str)
                == Some("gemini-api-key"),
        ),
        "codex" => {
            let selector = value["model_provider"].as_str().unwrap_or("openai");
            let table = &value["model_providers"][selector];
            let endpoint = table["base_url"].as_str().or_else(|| {
                (selector == "openai")
                    .then(|| value["openai_base_url"].as_str())
                    .flatten()
            });
            let bearer = table["experimental_bearer_token"].as_str();
            let header = table
                .pointer("/http_headers/x-phi-token")
                .and_then(Value::as_str);
            (
                endpoint,
                format!("{origin}/v1"),
                (bearer == Some(token) && header.is_none())
                    || (header == Some(token) && bearer.is_none()),
                table["wire_api"].as_str().is_none_or(|v| v == "responses"),
            )
        }
        "grokbuild" => {
            let selector = value
                .pointer("/models/default")
                .and_then(Value::as_str)
                .unwrap_or("");
            let table = &value["model"][selector];
            (
                table["base_url"].as_str(),
                format!("{origin}/grokbuild/v1"),
                table["api_key"].as_str() == Some(token),
                table["api_backend"].as_str() == Some("responses"),
            )
        }
        _ => return vec![],
    };
    // Never export the old/new values: credentials may also appear inside a URL.
    let mut checks = vec![];
    for (part, ok, code) in [
        (
            "endpoint",
            same_endpoint(endpoint, &expected),
            "gatewayEndpointChanged",
        ),
        ("auth", auth_ok, "gatewayTokenChanged"),
        ("protocol", protocol_ok, "gatewayProtocolChanged"),
    ] {
        checks.push(check(
            &format!("{app}:{part}"),
            app,
            if ok { "ok" } else { "warning" },
            if ok { "gatewayFieldMatches" } else { code },
        ));
    }
    checks
}

fn model_references<'a>(app: &str, value: &'a Value, extra: &'a Value) -> Vec<&'a str> {
    match app {
        "claude" => [
            "ANTHROPIC_MODEL",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL",
            "ANTHROPIC_DEFAULT_SONNET_MODEL",
            "ANTHROPIC_DEFAULT_OPUS_MODEL",
            "CLAUDE_CODE_SUBAGENT_MODEL",
        ]
        .iter()
        .filter_map(|key| value["env"][*key].as_str())
        .chain(value["model"].as_str())
        .collect(),
        "codex" => value["model"].as_str().into_iter().collect(),
        "gemini" => value["GEMINI_MODEL"]
            .as_str()
            .into_iter()
            .chain(extra.pointer("/model/name").and_then(Value::as_str))
            .collect(),
        "grokbuild" => value
            .pointer("/models/default")
            .and_then(Value::as_str)
            .and_then(|name| value["model"][name]["model"].as_str())
            .into_iter()
            .collect(),
        _ => vec![],
    }
}

pub(super) fn inspect(
    live: &LiveState,
    files: &[(&str, PathBuf, &str)],
    catalog: &Catalog,
    proxy_url: Option<&str>,
) -> Vec<Check> {
    let mut checks = vec![];
    for (app, state) in &live.apps {
        if let Some(pending) = &state.pending {
            checks.push(check("operation", app, "warning", "pendingOperation"));
            for file in &pending.files {
                // An untrusted state file must not make diagnostics read arbitrary paths.
                if !files
                    .iter()
                    .any(|(owner, path, _)| *owner == app && path == &file.path)
                {
                    checks.push(check(
                        "operation",
                        app,
                        "warning",
                        "pendingFileUnrecognized",
                    ));
                    continue;
                }
                let current = match read_bounded(&file.path) {
                    Ok(bytes) => Some(crate::live::engine::sha256_hex(&bytes)),
                    Err("fileMissing") => None,
                    Err(_) => {
                        checks.push(check("operation", app, "error", "fileUnreadable"));
                        continue;
                    }
                };
                if current != file.pre && current != file.planned {
                    checks.push(check("operation", app, "warning", "pendingExternalChange"));
                }
            }
        }
        if state.mode != Some(Mode::Proxy) {
            continue;
        }
        if !state.attached {
            checks.push(check("wiring", app, "info", "gatewayDetached"));
            continue;
        }
        let Some(origin) = proxy_url else {
            checks.push(check("wiring", app, "warning", "gatewayAddressUnknown"));
            continue;
        };
        let docs: BTreeMap<_, _> = files
            .iter()
            .filter(|(owner, _, _)| *owner == app)
            .filter_map(|(_, path, format)| {
                Some((
                    path.file_name()?.to_str()?.to_owned(),
                    document(path, format)?,
                ))
            })
            .collect();
        let main = match app.as_str() {
            "claude" => "settings.json",
            "codex" | "grokbuild" => "config.toml",
            "gemini" => ".env",
            _ => continue,
        };
        let Some(doc) = docs.get(main) else {
            checks.push(check("wiring", app, "error", "gatewayConfigurationMissing"));
            continue;
        };
        let extra = docs.get("settings.json").unwrap_or(&Value::Null);
        checks.extend(wiring(app, doc, extra, origin.trim_end_matches('/')));
        let aliases = crate::gateway::routing::published_aliases(catalog, app);
        let stale_group = model_references(app, doc, extra).into_iter().any(|m| {
            let m = m.strip_suffix("[1m]").unwrap_or(m);
            m.starts_with("group/") && !aliases.iter().any(|(alias, _)| alias == m)
        });
        if stale_group {
            checks.push(check("models", app, "warning", "routeModelMissing"));
        }
    }
    checks
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn malformed_state_is_reported_without_moving_or_rewriting_it() {
        let dir = tempfile::tempdir().unwrap();
        let store = DeviceStore::at(dir.path());
        std::fs::write(store.state_path(), b"{broken state").unwrap();
        assert_eq!(read_state(&store).err(), Some("stateInvalid"));
        assert_eq!(std::fs::read(store.state_path()).unwrap(), b"{broken state");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn wiring_ignores_hooks_but_flags_changed_credentials_endpoints_and_protocol() {
        let url = "http://127.0.0.1:15721";
        let mut doc = json!({"env":{"ANTHROPIC_BASE_URL":url,"ANTHROPIC_API_KEY":crate::proxy::ingress::token("claude")},"hooks":{"user":true}});
        assert!(wiring("claude", &doc, &Value::Null, url)
            .iter()
            .all(|c| c.state == "ok"));
        doc["env"]["ANTHROPIC_BASE_URL"] = json!("http://secret-user:secret-key@127.0.0.1:15721");
        doc["env"]["ANTHROPIC_API_KEY"] = json!("private-secret");
        doc["env"]["CLAUDE_CODE_USE_VERTEX"] = json!("1");
        let result = wiring("claude", &doc, &Value::Null, url);
        assert!(result.iter().all(|c| c.state == "warning"));
        let report = serde_json::to_string(&result).unwrap();
        assert!(!report.contains("secret"));
        assert!(!same_endpoint(Some("http://127.0.0.1:15722"), url));
        assert!(!same_endpoint(Some("http://127.0.0.1:15721/other"), url));
    }

    #[test]
    fn codex_auth_checks_the_selected_provider_and_both_local_auth_forms() {
        let token = crate::proxy::ingress::token("codex");
        let url = "http://[::1]:15721";
        let mut doc = json!({"model_provider":"custom","model_providers":{"custom":{"base_url":format!("{url}/v1/"),"experimental_bearer_token":token,"wire_api":"responses"},"unused":{"base_url":"https://other.example","experimental_bearer_token":"old"}}});
        assert!(wiring("codex", &doc, &Value::Null, url)
            .iter()
            .all(|c| c.state == "ok"));
        doc["model_providers"]["custom"]
            .as_object_mut()
            .unwrap()
            .remove("experimental_bearer_token");
        doc["model_providers"]["custom"]["http_headers"] = json!({"x-phi-token":token});
        assert!(wiring("codex", &doc, &Value::Null, url)
            .iter()
            .all(|c| c.state == "ok"));
        doc["model_provider"] = json!("unused");
        assert_eq!(
            wiring("codex", &doc, &Value::Null, url)
                .iter()
                .filter(|c| c.state == "warning")
                .count(),
            2
        );
    }

    #[test]
    fn pending_conflicts_and_unpublished_group_models_are_reported_without_writes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        let text = "model = 'group/deleted'\nmodel_provider = 'custom'\n[model_providers.custom]\nbase_url = 'http://127.0.0.1:15721/v1'\nexperimental_bearer_token = 'changed'\n";
        std::fs::write(&path, text).unwrap();
        let state: LiveState = serde_json::from_value(json!({"apps":{"codex":{"mode":"proxy","attached":true,"pending":{"op":"apply","files":[{"path":path,"pre":"old","planned":"new"},{"path":"/not-a-config","pre":null}],"target":{}}}}})).unwrap();
        let checks = inspect(
            &state,
            &[("codex", path.clone(), "toml")],
            &Catalog::default(),
            Some("http://127.0.0.1:15721"),
        );
        for code in [
            "pendingOperation",
            "pendingExternalChange",
            "pendingFileUnrecognized",
            "routeModelMissing",
            "gatewayTokenChanged",
        ] {
            assert!(checks.iter().any(|c| c.code == code), "{code}");
        }
        assert_eq!(std::fs::read_to_string(path).unwrap(), text);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }
}
