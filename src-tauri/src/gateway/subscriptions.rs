//! Magpie subscription engine, isolated from application/provider config.
use super::{Catalog, Endpoint, SupplierSecret, SupplierUpsert};
use crate::{database::Database, error::AppError};
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader},
    process::{Child, Command, Stdio},
    sync::{Mutex, OnceLock},
    time::Duration,
};

pub const BASE: &str = "https://subscriptions.phi.invalid/";

pub fn subscription_id(base: &str) -> Option<&str> {
    let id = base.strip_prefix(BASE)?;
    (!id.is_empty()
        && id.len() <= 100
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'))
    .then_some(id)
}

struct Runtime {
    child: Child,
    address: String,
    token: String,
}
static RUNTIME: OnceLock<Mutex<Option<Runtime>>> = OnceLock::new();

fn start() -> Result<(String, String), String> {
    let mut held = RUNTIME
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| "Subscription runtime lock failed")?;
    if let Some(runtime) = held.as_mut() {
        if runtime
            .child
            .try_wait()
            .map_err(|e| e.to_string())?
            .is_none()
        {
            return Ok((runtime.address.clone(), runtime.token.clone()));
        }
    }
    *held = None;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let name = if cfg!(windows) {
        "phi-subscriptions.exe"
    } else {
        "phi-subscriptions"
    };
    let bundled = exe
        .parent()
        .ok_or("Missing executable directory")?
        .join(name);
    let binary = if bundled.is_file() {
        bundled
    } else {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(format!(
                "phi-subscriptions-{}{}",
                env!("PHI_TARGET_TRIPLE"),
                if cfg!(windows) { ".exe" } else { "" }
            ))
    };
    if !binary.is_file() {
        return Err("Subscription engine is missing. Run node scripts/build-subscriptions.mjs and rebuild Phi.".into());
    }
    let root = crate::config::get_app_config_dir().join("subscriptions");
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let mut command = Command::new(binary);
    command
        .env("PHI_SUBSCRIPTION_TOKEN", &token)
        .env("XDG_CONFIG_HOME", root.join("config"))
        .env("XDG_CACHE_HOME", root.join("cache"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("Cannot start subscription engine: {e}"))?;
    let stdout = child.stdout.take().ok_or("Missing runtime stdout")?;
    let (send, recv) = std::sync::mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut line = String::new();
        let result = BufReader::new(stdout).read_line(&mut line).map(|_| line);
        let _ = send.send(result);
    });
    let ready = recv
        .recv_timeout(Duration::from_secs(15))
        .ok()
        .and_then(Result::ok)
        .and_then(|line| serde_json::from_str::<Value>(&line).ok())
        .and_then(|value| {
            value
                .get("address")
                .and_then(Value::as_str)
                .map(str::to_owned)
        });
    let address = match ready.and_then(|address| address.parse::<std::net::SocketAddr>().ok()) {
        Some(address)
            if address.ip() == std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST)
                && address.port() != 0 =>
        {
            format!("http://{address}")
        }
        _ => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Subscription engine did not become ready".into());
        }
    };
    *held = Some(Runtime {
        child,
        address: address.clone(),
        token: token.clone(),
    });
    Ok((address, token))
}

/// 预热订阅引擎。启动后在后台线程调用，避免首个路由请求在异步 worker 上
/// 同步等待子进程启动（最长 15 秒）。
pub fn prewarm() -> Result<(), String> {
    start().map(|_| ())
}

/// 只有目录里真的存在订阅供应商时才需要启动/预热引擎。
pub fn catalog_has_subscription(catalog: &Catalog) -> bool {
    catalog
        .suppliers
        .iter()
        .any(|supplier| subscription_id(&supplier.endpoint.base_url).is_some())
}

pub async fn action(action: &str, input: Value) -> Result<Value, String> {
    if ![
        "types", "prepare", "prompt", "login", "status", "callback", "cancel", "models",
    ]
    .contains(&action)
    {
        return Err("Unknown subscription action".into());
    }
    let (address, token) = tokio::task::spawn_blocking(start)
        .await
        .map_err(|e| e.to_string())??;
    let response = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|e| e.to_string())?
        .post(format!("{address}/manage/{action}"))
        .bearer_auth(token)
        .json(&input)
        .send()
        .await
        .map_err(|_| "Cannot reach subscription engine".to_string())?;
    let status = response.status();
    let value: Value = response
        .json()
        .await
        .map_err(|_| "Invalid subscription engine response".to_string())?;
    if !status.is_success() {
        return Err(value
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("Subscription operation failed")
            .into());
    }
    Ok(value)
}

/// Resolve the stable logical address at request time. Runtime ports and tokens
/// never enter the catalog, exports, renderer or application configuration.
pub fn resolve(base: &str, secret: SupplierSecret) -> Result<(String, SupplierSecret), AppError> {
    let Some(id) = subscription_id(base) else {
        return Ok((base.into(), secret));
    };
    let (address, token) = start().map_err(AppError::Message)?;
    Ok((
        format!("{address}/provider/{id}/v1"),
        SupplierSecret {
            api_key: token,
            auth_field: "OPENAI_API_KEY".into(),
        },
    ))
}

pub async fn connect(db: &Database, id: &str, revision: u64) -> Result<Catalog, String> {
    // Names and models come from the engine; the renderer cannot invent a
    // subscription endpoint, paste a temporary access token or import secrets.
    let types = action("types", json!({})).await?;
    let entry = types
        .as_array()
        .and_then(|types| types.iter().find(|p| p["id"].as_str() == Some(id)))
        .ok_or("Unknown subscription type")?;
    let name = entry["name"]
        .as_str()
        .ok_or("Invalid subscription name")?
        .to_owned();
    let base = format!("{BASE}{id}");
    if subscription_id(&base).is_none() {
        return Err("Invalid subscription ID".into());
    }
    let models = listed_models(&action("models", json!({"id": id})).await?)?;
    let catalog = db.gateway_catalog().map_err(|e| e.to_string())?;
    if catalog.revision != revision {
        return Err("gateway.staleRevision".into());
    }
    if catalog
        .suppliers
        .iter()
        .any(|s| s.endpoint.base_url == base)
    {
        return Err("This subscription is already in the resource pool".into());
    }
    db.create_gateway_supplier(SupplierUpsert {
        name: Some(name),
        endpoint: Some(Endpoint {
            protocol: "openai_chat".into(),
            base_url: base,
        }),
        models: Some(models.into_iter().take(200).collect()),
        revision: Some(revision),
        api_key: Some("managed-subscription".into()),
        auth_field: Some("OPENAI_API_KEY".into()),
    })
    .map_err(|e| e.to_string())
}

/// The engine's model listing: the models the signed-in account can use, and
/// why the vendor couldn't be asked when it couldn't (the list is then the one
/// the account had before).
fn listed_models(listed: &Value) -> Result<Vec<String>, String> {
    let models: Vec<String> = listed
        .get("models")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    if !models.is_empty() {
        return Ok(models);
    }
    let why = listed
        .get("warning")
        .and_then(Value::as_str)
        .unwrap_or_default();
    Err(if why.is_empty() {
        "The subscription has no available models. Complete login and retry.".into()
    } else {
        format!("The subscription listed no models: {why}")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn logical_ids_are_bounded_and_cannot_escape_the_runtime_route() {
        assert_eq!(
            subscription_id(&format!("{BASE}qoder-cn")),
            Some("qoder-cn")
        );
        for id in [
            "",
            "../codex",
            "codex/other",
            "codex?key=x",
            "codex#x",
            "codex%2fother",
        ] {
            assert!(subscription_id(&format!("{BASE}{id}")).is_none());
        }
        assert!(subscription_id("https://subscriptions.phi.invalid.evil/codex").is_none());
        assert!(subscription_id("http://subscriptions.phi.invalid/codex").is_none());
    }
    #[test]
    fn only_subscription_base_urls_need_the_engine() {
        let mut catalog: Catalog = serde_json::from_value(json!({
            "revision": 1,
            "suppliers": [{"id":"normal","name":"Normal",
                "endpoint":{"protocol":"openai_chat","baseUrl":"https://api.example.com/v1"},
                "models":["m"]}],
            "policies": [],
            "groups": []
        }))
        .unwrap();
        assert!(!catalog_has_subscription(&catalog));
        catalog.suppliers.push(
            serde_json::from_value(json!({
                "id":"sub","name":"Sub",
                "endpoint":{"protocol":"openai_chat","baseUrl":format!("{BASE}codex")},
                "models":["m"]
            }))
            .unwrap(),
        );
        assert!(catalog_has_subscription(&catalog));
    }
    #[test]
    fn the_engines_list_is_what_the_account_has_now() {
        // The list the engine's own account discovery answered: what the
        // signed-in account can use, in the vendor's order.
        let listed = json!({
            "models": ["gpt-5.1-codex", "gpt-5.1"],
            "source": "vendor",
            "fetchedAt": "2026-10-19T18:00:00Z"
        });
        assert_eq!(
            listed_models(&listed).unwrap(),
            vec!["gpt-5.1-codex", "gpt-5.1"]
        );
        // A vendor that couldn't be asked leaves the list the account had, and
        // the reason travels with it; an empty answer never becomes a supplier.
        let stale = json!({
            "models": ["gpt-5.1"],
            "source": "cached",
            "warning": "ChatGPT models: 401 Unauthorized"
        });
        assert_eq!(listed_models(&stale).unwrap(), vec!["gpt-5.1"]);
        let none = json!({"models": [], "source": "cached", "warning": "401"});
        assert!(listed_models(&none).unwrap_err().contains("401"));
        assert!(listed_models(&json!({"models": []}))
            .unwrap_err()
            .contains("Complete login"));
    }
    #[test]
    fn ordinary_suppliers_do_not_start_the_engine_or_change_their_secret() {
        let (base, secret) = resolve(
            "https://api.example.com/v1",
            SupplierSecret {
                api_key: "test-key".into(),
                auth_field: "OPENAI_API_KEY".into(),
            },
        )
        .unwrap();
        assert_eq!(base, "https://api.example.com/v1");
        assert_eq!(secret.api_key, "test-key");
    }
}
