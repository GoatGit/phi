//! Independent gateway control plane. Public DTOs never contain credentials.
//! Suppliers form one unified pool and own their API keys (stored separately
//! in gateway_supplier_secrets). Legacy per-app `credential` references are
//! kept only as import provenance; routing never reads application configs.
pub mod analytics;
pub mod intent;
pub mod routing;
use crate::proxy::providers::{get_adapter, AuthInfo, AuthStrategy};
use crate::{
    app_config::AppType,
    database::{lock_conn, Database},
    error::AppError,
    provider::{Provider, ProviderMeta, UniversalProvider},
};
use rusqlite::{params, params_from_iter, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    str::FromStr,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CredentialRef {
    pub app_id: String,
    pub provider_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Endpoint {
    pub protocol: String,
    pub base_url: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Supplier {
    pub id: String,
    pub name: String,
    /// 迁移来源，仅供展示与导入去重；运行时不再回读应用配置。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential: Option<CredentialRef>,
    pub endpoint: Endpoint,
    pub models: Vec<String>,
}
/// 新建/编辑资源池供应商的输入。api_key/auth_field 只写入密钥表，绝不进入目录 DTO。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SupplierUpsert {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub endpoint: Option<Endpoint>,
    #[serde(default)]
    pub models: Option<Vec<String>>,
    #[serde(default)]
    pub revision: Option<u64>,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub auth_field: Option<String>,
}
/// 资源池自持的密钥，随供应商删除。
#[derive(Debug, Clone)]
pub struct SupplierSecret {
    pub api_key: String,
    pub auth_field: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RouteCandidate {
    pub supplier_id: String,
    pub model: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoutePolicy {
    pub id: String,
    pub name: String,
    pub app_id: String,
    pub enabled: bool,
    /// Empty matches every model; otherwise an exact client model alias.
    pub match_model: String,
    pub priority: u32,
    pub failover: bool,
    pub candidates: Vec<RouteCandidate>,
    #[serde(default)]
    pub group_id: Option<String>,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Catalog {
    pub revision: u64,
    pub suppliers: Vec<Supplier>,
    pub policies: Vec<RoutePolicy>,
    #[serde(default)]
    pub groups: Vec<routing::RouteGroup>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportPreview {
    pub source: CredentialRef,
    pub fingerprint: String,
    pub supplier: Supplier,
    pub already_imported: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceEvent {
    #[serde(default)]
    pub supplier_name: String,
    pub supplier_id: String,
    pub model: String,
    pub outcome: String,
    #[serde(default)]
    pub group_path: Vec<String>,
    #[serde(default)]
    pub started_at: i64,
    #[serde(default)]
    pub latency_ms: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestTrace {
    pub id: String,
    pub created_at: i64,
    pub app_id: String,
    #[serde(default)]
    pub request_model: String,
    pub catalog_revision: u64,
    pub policy: RoutePolicy,
    pub events: Vec<TraceEvent>,
    pub outcome: String,
    pub latency_ms: u64,
    pub input_tokens: Option<u32>,
    pub output_tokens: Option<u32>,
    pub estimated_cost: Option<String>,
    #[serde(default)]
    pub decision: Option<routing::RouteDecision>,
    #[serde(default = "default_persist")]
    pub persist: bool,
}
fn default_persist() -> bool {
    true
}
#[derive(Clone)]
pub struct ResolvedRoute {
    pub revision: u64,
    pub policy: RoutePolicy,
    pub providers: Vec<Provider>,
    pub models: HashMap<String, String>,
    pub supplier_ids: HashMap<String, String>,
    pub decision: routing::RouteDecision,
    /// 由组驱动的路由携带该组的超时策略；策略直连（无组）时为 None，
    /// 沿用应用级代理配置。
    pub timeouts: Option<RouteTimeouts>,
}
/// 路由组自己的故障转移超时策略（秒）。
#[derive(Debug, Clone, Copy)]
pub struct RouteTimeouts {
    pub streaming_first_byte: u32,
    pub streaming_idle: u32,
    pub non_streaming: u32,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutePreview {
    pub revision: u64,
    pub policy: Option<RoutePolicy>,
    pub reason: String,
    pub decision: Option<routing::RouteDecision>,
}
fn invalid(message: &str) -> AppError {
    AppError::Config(message.into())
}
fn db_error(e: impl std::fmt::Display) -> AppError {
    AppError::Database(e.to_string())
}
fn app(id: &str) -> Result<AppType, AppError> {
    if !matches!(id, "claude" | "codex" | "gemini" | "grokbuild") {
        return Err(invalid("gateway.invalidApp"));
    }
    AppType::from_str(id).map_err(|_| invalid("gateway.invalidApp"))
}
fn identifier(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 200
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_.:/@".contains(c))
}
fn label(s: &str) -> bool {
    !s.trim().is_empty() && s.len() <= 200 && !s.chars().any(char::is_control)
}
fn valid_endpoint(endpoint: &Endpoint) -> bool {
    let Ok(url) = url::Url::parse(&endpoint.base_url) else {
        return false;
    };
    matches!(
        endpoint.protocol.as_str(),
        "anthropic" | "openai_chat" | "openai_responses" | "gemini_native"
    ) && matches!(url.scheme(), "http" | "https")
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
}
fn compatible(app_id: &str, protocol: &str) -> bool {
    match app_id {
        "claude" => true,
        "codex" | "grokbuild" => protocol != "gemini_native",
        "gemini" => protocol == "gemini_native",
        _ => false,
    }
}
fn secret_text(s: &str) -> bool {
    !s.is_empty() && s.len() <= 4096 && !s.chars().any(char::is_control)
}
/// 协议决定可用的鉴权字段：anthropic 上游通常接受 x-api-key 或 Bearer 二选一。
fn auth_field_allowed(protocol: &str, auth_field: &str) -> bool {
    match protocol {
        "anthropic" => matches!(auth_field, "ANTHROPIC_API_KEY" | "ANTHROPIC_AUTH_TOKEN"),
        "openai_chat" | "openai_responses" => auth_field == "OPENAI_API_KEY",
        "gemini_native" => auth_field == "GEMINI_API_KEY",
        _ => false,
    }
}
fn validate_secret(api_key: &str, auth_field: &str, protocol: &str) -> Result<(), AppError> {
    if !secret_text(api_key) || !auth_field_allowed(protocol, auth_field) {
        return Err(invalid("gateway.invalidSecret"));
    }
    Ok(())
}
/// 迁移/导入时按协议与来源策略推导初始鉴权字段。
fn auth_field_for(protocol: &str, strategy: &AuthStrategy) -> &'static str {
    match protocol {
        "anthropic" => {
            if *strategy == AuthStrategy::Anthropic {
                "ANTHROPIC_API_KEY"
            } else {
                "ANTHROPIC_AUTH_TOKEN"
            }
        }
        "gemini_native" => "GEMINI_API_KEY",
        _ => "OPENAI_API_KEY",
    }
}

/// Extract a template without writing an application provider or native config.
fn supplier_from_provider(app_id: &str, provider: &Provider) -> Result<Supplier, AppError> {
    let adapter = get_adapter(&app(app_id)?).ok_or_else(|| invalid("gateway.invalidApp"))?;
    let base_url = adapter
        .extract_base_url(provider)
        .map_err(|_| invalid("gateway.invalidSupplier"))?;
    let protocol = match app_id {
        "claude" => match crate::proxy::providers::get_claude_api_format(provider) {
            "openai_chat" => "openai_chat",
            "openai_responses" => "openai_responses",
            "gemini_native" => "gemini_native",
            _ => "anthropic",
        },
        "gemini" => "gemini_native",
        _ => {
            if crate::proxy::providers::should_convert_codex_responses_to_anthropic(
                provider,
                "/v1/responses",
            ) {
                "anthropic"
            } else if crate::proxy::providers::should_convert_codex_responses_to_chat(
                provider,
                "/v1/responses",
            ) {
                "openai_chat"
            } else {
                "openai_responses"
            }
        }
    }
    .to_string();
    let models = provider_models(provider);
    let supplier = Supplier {
        id: uuid::Uuid::new_v4().to_string(),
        name: provider.name.clone(),
        credential: None,
        endpoint: Endpoint { protocol, base_url },
        models,
    };
    if !valid_endpoint(&supplier.endpoint) {
        return Err(invalid("gateway.invalidSupplier"));
    }
    Ok(supplier)
}

/// 向上游拉取 `/models` 风格的模型清单。URL、鉴权头按协议推导；重定向一律
/// 不跟随，密钥只用于本次请求。供「拉取模型」和「引入供应商时自动补全模型
/// 清单」两个入口共用。
async fn fetch_upstream_model_ids(
    base_url: &str,
    protocol: &str,
    auth_field: &str,
    api_key: &str,
    timeout: std::time::Duration,
) -> Result<Vec<String>, AppError> {
    static FETCH_CLIENT: std::sync::LazyLock<reqwest::Client> = std::sync::LazyLock::new(|| {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("failed to build the model fetch client")
    });
    let base = base_url.trim_end_matches('/');
    let url = match protocol {
        "gemini_native" if !base.ends_with("/v1beta") && !base.ends_with("/v1") => {
            format!("{base}/v1beta/models")
        }
        _ if url::Url::parse(base).is_ok_and(|u| u.path() == "/" || u.path().is_empty()) => {
            format!("{base}/v1/models")
        }
        _ => format!("{base}/models"),
    };
    let mut request = FETCH_CLIENT.get(url).timeout(timeout);
    request = match auth_field {
        "ANTHROPIC_API_KEY" => request.header("x-api-key", api_key),
        "GEMINI_API_KEY" => request.header("x-goog-api-key", api_key),
        _ => request.bearer_auth(api_key),
    };
    if protocol == "anthropic" {
        request = request.header("anthropic-version", "2023-06-01");
    }
    let response = request
        .send()
        .await
        .map_err(|_| invalid("gateway.modelFetchFailed"))?;
    if !response.status().is_success() {
        return Err(invalid("gateway.modelFetchFailed"));
    }
    let mut response = response;
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| invalid("gateway.modelFetchFailed"))?
    {
        if bytes.len() + chunk.len() > 2 * 1024 * 1024 {
            return Err(invalid("gateway.limitExceeded"));
        }
        bytes.extend_from_slice(&chunk);
    }
    let body: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| invalid("gateway.modelFetchFailed"))?;
    let entries = body
        .get("data")
        .or_else(|| body.get("models"))
        .and_then(|v| v.as_array())
        .ok_or_else(|| invalid("gateway.modelFetchFailed"))?;
    let mut models: Vec<String> = entries
        .iter()
        .filter_map(|entry| {
            ["id", "slug", "name"]
                .iter()
                .find_map(|key| entry.get(key)?.as_str())
        })
        .map(|id| id.strip_prefix("models/").unwrap_or(id))
        .filter(|id| identifier(id))
        .map(str::to_string)
        .collect();
    models.sort();
    models.dedup();
    if models.len() > 200 {
        return Err(invalid("gateway.limitExceeded"));
    }
    Ok(models)
}

pub(crate) fn provider_models(provider: &Provider) -> Vec<String> {
    let mut models = Vec::new();
    for path in [
        "/env/ANTHROPIC_MODEL",
        "/env/ANTHROPIC_DEFAULT_SONNET_MODEL",
        "/env/ANTHROPIC_DEFAULT_OPUS_MODEL",
        "/env/ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "/env/ANTHROPIC_DEFAULT_FABLE_MODEL",
        "/env/ANTHROPIC_SMALL_FAST_MODEL",
        "/env/CLAUDE_CODE_SUBAGENT_MODEL",
        "/env/GEMINI_MODEL",
        "/model",
    ] {
        if let Some(m) = provider
            .settings_config
            .pointer(path)
            .and_then(|v| v.as_str())
        {
            if identifier(m) && !models.iter().any(|v| v == m) {
                models.push(m.to_string());
            }
        }
    }
    if let Some(m) = crate::proxy::providers::codex_provider_upstream_model(provider) {
        if identifier(&m) && !models.contains(&m) {
            models.push(m);
        }
    }
    if let Some(catalog) = provider
        .settings_config
        .pointer("/modelCatalog/models")
        .and_then(|v| v.as_array())
    {
        for model in catalog {
            if let Some(id) = model.get("model").and_then(|v| v.as_str()) {
                if identifier(id) && !models.iter().any(|m| m == id) {
                    models.push(id.to_string());
                }
            }
        }
    }
    // Codex 表单把模型目录写进 config TOML 的 [model_catalog]；引入时一并带上
    if let Some(catalog) = provider
        .settings_config
        .get("config")
        .and_then(|v| v.as_str())
        .and_then(|config| config.parse::<toml::Value>().ok())
    {
        if let Some(entries) = catalog
            .get("model_catalog")
            .and_then(|catalog| catalog.get("models"))
            .and_then(|models| models.as_array())
        {
            for model in entries {
                let id = model
                    .get("model")
                    .and_then(|v| v.as_str())
                    .or_else(|| model.as_str())
                    .map(str::trim)
                    .filter(|id| !id.is_empty());
                if let Some(id) = id {
                    if identifier(id) && !models.iter().any(|m| m == id) {
                        models.push(id.to_string());
                    }
                }
            }
        }
    }
    if let Some(stack_models) = provider
        .meta
        .as_ref()
        .and_then(|meta| meta.stack_models.as_ref())
    {
        for model in stack_models {
            if identifier(&model.model) && !models.contains(&model.model) {
                models.push(model.model.clone());
            }
        }
    }
    models
}

fn reusable_provider_auth(app_id: &str, provider: &Provider) -> Result<AuthInfo, AppError> {
    // Managed accounts carry protocol/account-specific identities. Never turn
    // an inbound account token into a reusable cross-agent credential.
    if provider.uses_managed_account_auth()
        || crate::proxy::providers::is_codex_official_provider(provider)
    {
        return Err(invalid("gateway.managedCredential"));
    }
    let adapter = get_adapter(&app(app_id)?).ok_or_else(|| invalid("gateway.invalidApp"))?;
    let auth = adapter
        .extract_auth(provider)
        .ok_or_else(|| invalid("gateway.missingCredential"))?;
    if auth.api_key.is_empty()
        || !matches!(
            auth.strategy,
            AuthStrategy::Anthropic
                | AuthStrategy::ClaudeAuth
                | AuthStrategy::Bearer
                | AuthStrategy::Google
        )
    {
        return Err(invalid("gateway.managedCredential"));
    }
    Ok(auth)
}

pub(crate) fn create_tables(conn: &rusqlite::Connection) -> Result<(), AppError> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS gateway_catalog (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS gateway_supplier_secrets (supplier_id TEXT PRIMARY KEY, api_key TEXT NOT NULL, auth_field TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS gateway_traces (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, payload TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS gateway_traces_created ON gateway_traces(created_at);") .map_err(db_error)
}
impl Database {
    /// Read the stored catalog without credential migration or self-healing.
    pub(crate) fn gateway_catalog_snapshot(&self) -> Result<Catalog, AppError> {
        let conn = lock_conn!(self.conn);
        read_catalog(&conn)
    }
    pub fn preview_gateway_route(
        &self,
        app_id: &str,
        model: &str,
    ) -> Result<RoutePreview, AppError> {
        app(app_id)?;
        let catalog = self.gateway_catalog()?;
        let policy = routing::matched_policy(&catalog, app_id, model)?;
        let decision = policy
            .as_ref()
            .map(|p| self.gateway_runtime.plan(&catalog, p, None, vec![], false))
            .transpose()?;
        let reason = decision
            .as_ref()
            .map(|d| d.reason.clone())
            .unwrap_or_else(|| "no_match".into());
        Ok(RoutePreview {
            revision: catalog.revision,
            policy,
            reason,
            decision,
        })
    }

    /// A virtual client configuration, never an application-owned credential copy.
    pub fn gateway_entry_provider(&self, app_id: &str) -> Result<Option<Provider>, AppError> {
        app(app_id)?;
        let catalog = self.gateway_catalog()?;
        let mut policies: Vec<_> = catalog
            .policies
            .iter()
            .filter(|p| p.enabled && p.app_id == app_id)
            .collect();
        policies.sort_by_key(|p| (p.priority, &p.id));
        let model = if let Some(connection) = routing::app_connection(&catalog, app_id) {
            let Some(group) = catalog.groups.iter().find(|g| {
                Some(&g.id) == connection.group_id.as_ref()
                    && connection.enabled
                    && g.enabled
                    && g.app_ids.iter().any(|a| a == app_id)
            }) else {
                return Ok(None);
            };
            format!("group/{}", group.id)
        } else if let Some(policy) = policies.first() {
            if !policy.match_model.is_empty() {
                policy.match_model.clone()
            } else if let Some(id) = &policy.group_id {
                format!("group/{id}")
            } else {
                policy
                    .candidates
                    .first()
                    .ok_or_else(|| invalid("gateway.invalidPolicy"))?
                    .model
                    .clone()
            }
        } else if let Some(group) = catalog
            .groups
            .iter()
            .filter(|g| g.enabled && g.app_ids.iter().any(|a| a == app_id))
            .min_by_key(|g| &g.id)
        {
            format!("group/{}", group.id)
        } else {
            return Ok(None);
        };
        let Some(route) = self.resolve_gateway_route(app_id, &model)? else {
            return Ok(None);
        };
        let Some(mut provider) = route.providers.into_iter().next() else {
            return Ok(None);
        };
        // 组连接场景：路由按「应用连接」决定组、不依赖模型名，投影可以写首成员的
        // 真实模型（如 GLM-5.3）——CLI 界面会把配置里的模型名原样显示给用户，
        // group/<id> 标记对他们毫无意义。策略直连（match_model 别名）场景必须保留
        // 别名：客户端发送的模型名要能命中策略。
        let in_group = model.strip_prefix("group/").is_some();
        let entry_model = if in_group {
            route
                .models
                .get(&provider.id)
                .cloned()
                .unwrap_or_else(|| model.clone())
        } else {
            model.clone()
        };
        provider.id = format!("gateway-entry:{app_id}");
        provider.name = "PHI".into();
        // This virtual row only projects the client configuration. Runtime
        // forwarding resolves real credentials separately; legacy editor APIs
        // must never expose a pool secret through this provider lookup.
        for pointer in [
            "/env/ANTHROPIC_API_KEY",
            "/env/ANTHROPIC_AUTH_TOKEN",
            "/env/GEMINI_API_KEY",
            "/auth/OPENAI_API_KEY",
        ] {
            if let Some(value) = provider.settings_config.pointer_mut(pointer) {
                *value = serde_json::json!("PHI_VIRTUAL");
            }
        }
        match app_id {
            "claude" => {
                provider.settings_config["env"]["ANTHROPIC_MODEL"] =
                    serde_json::json!(entry_model);
                provider.settings_config["env"]["CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY"] =
                    serde_json::json!("1");
            }
            "gemini" => {
                provider.settings_config["env"]["GEMINI_MODEL"] = serde_json::json!(entry_model);
            }
            "grokbuild" => {
                provider.settings_config["config"] = serde_json::json!(format!("[models]\ndefault = \"phi\"\n[model.phi]\nname = \"PHI\"\nmodel = {}\nbase_url = {}\napi_key = \"PHI_VIRTUAL\"\napi_backend = \"responses\"\ncontext_window = 500000\n", serde_json::to_string(&entry_model).map_err(db_error)?, serde_json::to_string(provider.settings_config["base_url"].as_str().unwrap_or_default()).map_err(db_error)?));
            }
            _ => {
                provider.settings_config["config"] = serde_json::json!(format!("model = {}\nmodel_provider = \"custom\"\n[model_providers.custom]\nname = \"PHI\"\nbase_url = {}\nwire_api = \"responses\"\n", serde_json::to_string(&entry_model).map_err(db_error)?, serde_json::to_string(provider.settings_config["base_url"].as_str().unwrap_or_default()).map_err(db_error)?));
            }
        }
        Ok(Some(provider))
    }

    /// Store the group's catch-all connection, keeping old rules for compatibility
    /// and historical snapshots. The reserved connection takes precedence over them.
    pub(crate) fn select_gateway_group(
        &self,
        app_id: &str,
        group_id: &str,
        revision: Option<u64>,
    ) -> Result<Option<RoutePolicy>, AppError> {
        app(app_id)?;
        let mut catalog = self.gateway_catalog()?;
        if revision.is_some_and(|r| r != catalog.revision) {
            return Err(invalid("gateway.staleRevision"));
        }
        let mut connection = routing::group_policy(&catalog, app_id, group_id, "")?;
        let previous = routing::app_connection(&catalog, app_id).cloned();
        connection.id = routing::connection_id(app_id);
        connection.match_model.clear();
        catalog.policies.retain(|p| p.id != connection.id);
        catalog.policies.push(connection);
        self.save_gateway_catalog(catalog)?;
        Ok(previous)
    }

    /// Compensate a failed client attachment without overwriting unrelated edits.
    pub(crate) fn restore_gateway_group_connection(
        &self,
        app_id: &str,
        selected_group: &str,
        previous: Option<RoutePolicy>,
    ) -> Result<(), AppError> {
        let mut catalog = self.gateway_catalog()?;
        if !routing::app_connection(&catalog, app_id)
            .is_some_and(|p| p.group_id.as_deref() == Some(selected_group) && p.enabled)
        {
            return Ok(());
        }
        catalog
            .policies
            .retain(|p| p.id != routing::connection_id(app_id));
        catalog.policies.extend(previous);
        self.save_gateway_catalog(catalog)?;
        Ok(())
    }

    pub async fn fetch_gateway_models(&self, supplier_id: &str) -> Result<Vec<String>, AppError> {
        let catalog = self.gateway_catalog()?;
        let supplier = catalog
            .suppliers
            .iter()
            .find(|s| s.id == supplier_id)
            .ok_or_else(|| invalid("gateway.missingSupplier"))?;
        let secret = self
            .secret(supplier_id)?
            .ok_or_else(|| invalid("gateway.missingSecret"))?;
        // Use the saved endpoint and credential together. Never return the key or
        // upstream error body to the renderer, nor forward credentials on redirects.
        fetch_upstream_model_ids(
            &supplier.endpoint.base_url,
            &supplier.endpoint.protocol,
            &secret.auth_field,
            &secret.api_key,
            std::time::Duration::from_secs(15),
        )
        .await
    }
    pub fn gateway_catalog(&self) -> Result<Catalog, AppError> {
        // Legacy catalogs reference per-app credentials; self-heal them before use.
        self.ensure_supplier_secrets()?;
        let conn = lock_conn!(self.conn);
        read_catalog(&conn)
    }
    /// 一次性把旧目录里按应用引用的密钥复制进资源池；来源已失效或属于
    /// OAuth 托管账号（永远不能安全复用）的旧条目被直接移除。
    fn ensure_supplier_secrets(&self) -> Result<(), AppError> {
        let pending: Vec<(String, String, Option<CredentialRef>)> = {
            let conn = lock_conn!(self.conn);
            let catalog = read_catalog(&conn)?;
            if catalog.suppliers.is_empty() {
                return Ok(());
            }
            let owned: HashSet<String> = {
                let mut stmt = conn
                    .prepare("SELECT supplier_id FROM gateway_supplier_secrets")
                    .map_err(db_error)?;
                let rows = stmt
                    .query_map([], |r| r.get::<_, String>(0))
                    .map_err(db_error)?;
                rows.collect::<Result<HashSet<_>, _>>().map_err(db_error)?
            };
            catalog
                .suppliers
                .iter()
                .filter(|s| !owned.contains(&s.id))
                .map(|s| {
                    (
                        s.id.clone(),
                        s.endpoint.protocol.clone(),
                        s.credential.clone(),
                    )
                })
                .collect()
        };
        if pending.is_empty() {
            return Ok(());
        }
        let mut rows = Vec::new();
        let mut dropped: HashSet<String> = HashSet::new();
        for (id, protocol, reference) in pending {
            match reference.map(|r| self.credential_secret(&r, &protocol)) {
                Some(Ok((api_key, auth_field))) => rows.push((id, api_key, auth_field)),
                _ => {
                    dropped.insert(id);
                }
            }
        }
        if rows.is_empty() && dropped.is_empty() {
            return Ok(());
        }
        let mut conn = lock_conn!(self.conn);
        let tx = conn.transaction().map_err(db_error)?;
        for (id, api_key, auth_field) in &rows {
            upsert_secret(&tx, id, api_key, auth_field)?;
        }
        if !dropped.is_empty() {
            let mut catalog = read_catalog(&tx)?;
            catalog.suppliers.retain(|s| !dropped.contains(&s.id));
            for p in &mut catalog.policies {
                p.candidates.retain(|c| !dropped.contains(&c.supplier_id));
            }
            catalog.policies.retain(|p| !p.candidates.is_empty());
            catalog.revision += 1;
            let payload = serde_json::to_string(&catalog).map_err(db_error)?;
            tx.execute("INSERT INTO gateway_catalog(id,payload) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload", [payload]).map_err(db_error)?;
        }
        tx.commit().map_err(db_error)?;
        Ok(())
    }
    fn secret(&self, supplier_id: &str) -> Result<Option<SupplierSecret>, AppError> {
        let conn = lock_conn!(self.conn);
        conn.query_row(
            "SELECT api_key, auth_field FROM gateway_supplier_secrets WHERE supplier_id=?1",
            [supplier_id],
            |r| {
                Ok(SupplierSecret {
                    api_key: r.get(0)?,
                    auth_field: r.get(1)?,
                })
            },
        )
        .optional()
        .map_err(db_error)
    }
    /// 校验后的目录落盘；同事务内维护密钥表：写入/替换指定密钥，并清理
    /// 已不在目录中的供应商密钥，保证“目录即真相”。
    fn persist_catalog(
        &self,
        catalog: Catalog,
        secret: Option<(&str, &str, &str)>,
    ) -> Result<Catalog, AppError> {
        self.persist_catalog_with_secrets(catalog, &secret.into_iter().collect::<Vec<_>>())
    }
    fn persist_catalog_with_secrets(
        &self,
        mut catalog: Catalog,
        secrets: &[(&str, &str, &str)],
    ) -> Result<Catalog, AppError> {
        let mut conn = lock_conn!(self.conn);
        let tx = conn.transaction().map_err(db_error)?;
        let old = read_catalog(&tx)?;
        if old.revision != catalog.revision {
            return Err(invalid("gateway.staleRevision"));
        }
        catalog.revision += 1;
        let payload = serde_json::to_string(&catalog).map_err(db_error)?;
        tx.execute("INSERT INTO gateway_catalog(id,payload) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload", [payload]).map_err(db_error)?;
        for (id, api_key, auth_field) in secrets {
            upsert_secret(&tx, id, api_key, auth_field)?;
        }
        let ids: Vec<String> = catalog.suppliers.iter().map(|s| s.id.clone()).collect();
        if ids.is_empty() {
            tx.execute("DELETE FROM gateway_supplier_secrets", [])
                .map_err(db_error)?;
        } else {
            let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
            let sql = format!(
                "DELETE FROM gateway_supplier_secrets WHERE supplier_id NOT IN ({placeholders})"
            );
            tx.execute(&sql, params_from_iter(ids.iter()))
                .map_err(db_error)?;
        }
        tx.commit().map_err(db_error)?;
        Ok(catalog)
    }
    pub fn save_gateway_catalog(&self, catalog: Catalog) -> Result<Catalog, AppError> {
        self.validate_gateway_catalog(&catalog)?;
        for supplier in &catalog.suppliers {
            let secret = self
                .secret(&supplier.id)?
                .ok_or_else(|| invalid("gateway.missingSecret"))?;
            validate_secret(
                &secret.api_key,
                &secret.auth_field,
                &supplier.endpoint.protocol,
            )?;
        }
        self.persist_catalog(catalog, None)
    }
    pub fn create_gateway_supplier(&self, input: SupplierUpsert) -> Result<Catalog, AppError> {
        let mut catalog = self.gateway_catalog()?;
        if input
            .revision
            .is_some_and(|revision| revision != catalog.revision)
        {
            return Err(invalid("gateway.staleRevision"));
        }
        let Some(name) = input.name else {
            return Err(invalid("gateway.invalidSupplier"));
        };
        let Some(endpoint) = input.endpoint else {
            return Err(invalid("gateway.invalidSupplier"));
        };
        let Some(models) = input.models else {
            return Err(invalid("gateway.invalidSupplier"));
        };
        let Some(api_key) = input.api_key.filter(|k| !k.is_empty()) else {
            return Err(invalid("gateway.invalidSecret"));
        };
        let Some(auth_field) = input.auth_field else {
            return Err(invalid("gateway.invalidSecret"));
        };
        validate_secret(&api_key, &auth_field, &endpoint.protocol)?;
        let supplier = Supplier {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            credential: None,
            endpoint,
            models,
        };
        catalog.suppliers.push(supplier.clone());
        self.validate_gateway_catalog(&catalog)?;
        self.persist_catalog(catalog, Some((&supplier.id, &api_key, &auth_field)))
    }
    pub async fn create_gateway_supplier_from_template(
        &self,
        app_id: &str,
        provider: &Provider,
        revision: u64,
    ) -> Result<Catalog, AppError> {
        self.create_gateway_template_suppliers(&[(app_id, provider.clone())], revision)
            .await
    }

    pub async fn create_gateway_suppliers_from_universal(
        &self,
        provider: &UniversalProvider,
        revision: u64,
    ) -> Result<Catalog, AppError> {
        let providers: Vec<_> = [
            ("claude", provider.to_claude_provider()),
            ("codex", provider.to_codex_provider()),
            ("gemini", provider.to_gemini_provider()),
        ]
        .into_iter()
        .filter_map(|(app, provider)| provider.map(|p| (app, p)))
        .collect();
        self.create_gateway_template_suppliers(&providers, revision)
            .await
    }

    /// A universal template may have several protocols. Validate all of them
    /// before a single transaction, so retries never leave a partial import.
    async fn create_gateway_template_suppliers(
        &self,
        providers: &[(&str, Provider)],
        revision: u64,
    ) -> Result<Catalog, AppError> {
        if providers.is_empty() {
            return Err(invalid("gateway.invalidSupplier"));
        }
        let mut catalog = self.gateway_catalog()?;
        if catalog.revision != revision {
            return Err(invalid("gateway.staleRevision"));
        }
        let mut secrets = Vec::new();
        for (app_id, provider) in providers {
            let auth = reusable_provider_auth(app_id, provider)?;
            let mut supplier = supplier_from_provider(app_id, provider)?;
            let field = auth_field_for(&supplier.endpoint.protocol, &auth.strategy);
            validate_secret(&auth.api_key, field, &supplier.endpoint.protocol)?;
            // 引入即补全模型清单：静态提取（env / 模型目录）之外，向上游 /models
            // 拉取一份并合并。拉取失败不阻断创建——清单之后仍可手工编辑或重试。
            if let Ok(mut fetched) = fetch_upstream_model_ids(
                &supplier.endpoint.base_url,
                &supplier.endpoint.protocol,
                field,
                &auth.api_key,
                std::time::Duration::from_secs(3),
            )
            .await
            {
                fetched.retain(|id| !supplier.models.contains(id));
                supplier.models.extend(fetched);
                supplier.models.truncate(200);
            }
            secrets.push((supplier.id.clone(), auth.api_key, field));
            catalog.suppliers.push(supplier);
        }
        self.validate_gateway_catalog(&catalog)?;
        let writes: Vec<_> = secrets
            .iter()
            .map(|(id, key, field)| (id.as_str(), key.as_str(), *field))
            .collect();
        self.persist_catalog_with_secrets(catalog, &writes)
    }
    pub fn update_gateway_supplier(
        &self,
        supplier_id: &str,
        input: SupplierUpsert,
    ) -> Result<Catalog, AppError> {
        let mut catalog = self.gateway_catalog()?;
        if input
            .revision
            .is_some_and(|revision| revision != catalog.revision)
        {
            return Err(invalid("gateway.staleRevision"));
        }
        let supplier = catalog
            .suppliers
            .iter_mut()
            .find(|s| s.id == supplier_id)
            .ok_or_else(|| invalid("gateway.missingSupplier"))?;
        if let Some(name) = input.name {
            supplier.name = name;
        }
        if let Some(endpoint) = input.endpoint {
            supplier.endpoint = endpoint;
        }
        if let Some(models) = input.models {
            supplier.models = models;
        }
        // 密钥是补丁语义：只改传入的字段，其余保持原值。
        let replacement = match (input.api_key.filter(|k| !k.is_empty()), input.auth_field) {
            (Some(api_key), Some(auth_field)) => Some((api_key, auth_field)),
            (Some(api_key), None) => {
                let existing = self
                    .secret(supplier_id)?
                    .ok_or_else(|| invalid("gateway.invalidSecret"))?;
                Some((api_key, existing.auth_field))
            }
            (None, Some(auth_field)) => {
                let existing = self
                    .secret(supplier_id)?
                    .ok_or_else(|| invalid("gateway.invalidSecret"))?;
                Some((existing.api_key, auth_field))
            }
            (None, None) => None,
        };
        if let Some((api_key, auth_field)) = &replacement {
            validate_secret(api_key, auth_field, &supplier.endpoint.protocol)?;
        } else {
            let existing = self
                .secret(supplier_id)?
                .ok_or_else(|| invalid("gateway.missingSecret"))?;
            validate_secret(
                &existing.api_key,
                &existing.auth_field,
                &supplier.endpoint.protocol,
            )?;
        }
        self.validate_gateway_catalog(&catalog)?;
        match replacement {
            Some((api_key, auth_field)) => {
                self.persist_catalog(catalog, Some((supplier_id, &api_key, &auth_field)))
            }
            None => self.persist_catalog(catalog, None),
        }
    }
    fn credential_provider(&self, reference: &CredentialRef) -> Result<Provider, AppError> {
        app(&reference.app_id)?;
        let provider = self
            .get_provider_by_id(&reference.provider_id, &reference.app_id)?
            .ok_or_else(|| invalid("gateway.missingCredential"))?;
        reusable_provider_auth(&reference.app_id, &provider)?;
        Ok(provider)
    }
    /// 从应用配置里提取一次密钥（仅用于导入/迁移），返回 (api_key, auth_field)。
    fn credential_secret(
        &self,
        reference: &CredentialRef,
        protocol: &str,
    ) -> Result<(String, String), AppError> {
        let provider = self.credential_provider(reference)?;
        let adapter =
            get_adapter(&app(&reference.app_id)?).ok_or_else(|| invalid("gateway.invalidApp"))?;
        let auth = adapter
            .extract_auth(&provider)
            .ok_or_else(|| invalid("gateway.missingCredential"))?;
        Ok((
            auth.api_key,
            auth_field_for(protocol, &auth.strategy).to_string(),
        ))
    }
    fn validate_gateway_catalog(&self, catalog: &Catalog) -> Result<(), AppError> {
        routing::validate(catalog)?;
        if catalog.suppliers.len() > 500 || catalog.policies.len() > 500 {
            return Err(invalid("gateway.limitExceeded"));
        }
        let mut ids = HashSet::new();
        for s in &catalog.suppliers {
            if !identifier(&s.id)
                || !label(&s.name)
                || !ids.insert(&s.id)
                || !valid_endpoint(&s.endpoint)
                || s.models.len() > 200
                || s.models.iter().any(|m| !identifier(m))
                || s.models.iter().collect::<HashSet<_>>().len() != s.models.len()
            {
                return Err(invalid("gateway.invalidSupplier"));
            }
        }
        let mut policies = HashSet::new();
        let mut matches = HashSet::new();
        for p in &catalog.policies {
            app(&p.app_id)?;
            if !identifier(&p.id)
                || !label(&p.name)
                || !policies.insert(&p.id)
                || (!p.match_model.is_empty() && !identifier(&p.match_model))
                || (p.enabled && p.candidates.is_empty() && p.group_id.is_none())
                || p.candidates.len() > 11
                || (!p.failover && p.candidates.len() > 1)
                || (p.id.starts_with("connection/")
                    && (p.id != routing::connection_id(&p.app_id)
                        || !p.match_model.is_empty()
                        || !p.candidates.is_empty()))
                || (p.enabled
                    && p.id != routing::connection_id(&p.app_id)
                    && !matches.insert((&p.app_id, &p.match_model, p.priority)))
            {
                return Err(invalid("gateway.invalidPolicy"));
            }
            let mut candidates = HashSet::new();
            for c in &p.candidates {
                let s = catalog
                    .suppliers
                    .iter()
                    .find(|s| s.id == c.supplier_id)
                    .ok_or_else(|| invalid("gateway.missingSupplier"))?;
                if !s.models.contains(&c.model)
                    || !compatible(&p.app_id, &s.endpoint.protocol)
                    || !candidates.insert(&c.supplier_id)
                {
                    return Err(invalid("gateway.invalidCandidate"));
                }
            }
        }
        Ok(())
    }
    pub fn preview_gateway_import(&self, source: CredentialRef) -> Result<ImportPreview, AppError> {
        let provider = self.credential_provider(&source)?;
        let mut supplier = supplier_from_provider(&source.app_id, &provider)?;
        supplier.credential = Some(source.clone());
        let fingerprint = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&provider).map_err(db_error)?)
        );
        let already_imported = self
            .gateway_catalog()?
            .suppliers
            .iter()
            .any(|s| s.credential.as_ref() == Some(&source));
        Ok(ImportPreview {
            source,
            fingerprint,
            supplier,
            already_imported,
        })
    }
    pub fn apply_gateway_import(
        &self,
        preview: ImportPreview,
        revision: u64,
    ) -> Result<Catalog, AppError> {
        let fresh = self.preview_gateway_import(preview.source.clone())?;
        if fresh.fingerprint != preview.fingerprint {
            return Err(invalid("gateway.staleImport"));
        }
        if fresh.already_imported {
            return Err(invalid("gateway.alreadyImported"));
        }
        // 复制一次密钥进资源池；之后目录与来源应用配置彻底解耦。
        let (api_key, auth_field) =
            self.credential_secret(&preview.source, &fresh.supplier.endpoint.protocol)?;
        let mut catalog = self.gateway_catalog()?;
        if catalog.revision != revision {
            return Err(invalid("gateway.staleRevision"));
        }
        // Use freshly derived metadata, never caller-supplied source settings.
        let supplier = fresh.supplier;
        catalog.suppliers.push(supplier.clone());
        self.validate_gateway_catalog(&catalog)?;
        self.persist_catalog(catalog, Some((&supplier.id, &api_key, &auth_field)))
    }
    pub fn resolve_gateway_route(
        &self,
        app_id: &str,
        model: &str,
    ) -> Result<Option<ResolvedRoute>, AppError> {
        let catalog = self.gateway_catalog()?;
        let Some(policy) = routing::matched_policy(&catalog, app_id, model)? else {
            return Ok(None);
        };
        let decision = self
            .gateway_runtime
            .plan(&catalog, &policy, None, vec![], false)?;
        self.materialize_gateway_route(&catalog, app_id, policy, decision)
            .map(Some)
    }
    pub async fn plan_gateway_request(
        &self,
        app_id: &str,
        model: &str,
        session: Option<&str>,
        body: &serde_json::Value,
        persist: bool,
    ) -> Result<Option<(ResolvedRoute, crate::proxy::gateway_observer::Trace)>, AppError> {
        let catalog = self.gateway_catalog()?;
        let policy = if crate::proxy::ledger_observer::has_access_binding() {
            routing::matched_unbound_policy(&catalog, app_id, model)?
        } else {
            routing::matched_policy(&catalog, app_id, model)?
        };
        crate::proxy::ledger_observer::authorize_group(policy.as_ref().and_then(|p|p.group_id.as_deref()))?;
        let Some(policy) = policy else {
            return Ok(None);
        };
        let session = session.map(|s| routing::session_hash(app_id, &format!("{}:{s}",crate::proxy::ledger_observer::session_namespace().unwrap_or_default())));
        let initial =
            self.gateway_runtime
                .plan(&catalog, &policy, session.clone(), vec![], false)?;
        let trace = std::sync::Arc::new(std::sync::Mutex::new(RequestTrace {
            id: crate::proxy::ledger_observer::request_id().unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            created_at: chrono::Utc::now().timestamp_millis(),
            app_id: app_id.into(),
            request_model: model.into(),
            catalog_revision: catalog.revision,
            policy: policy.clone(),
            events: vec![],
            outcome: "pending".into(),
            latency_ms: 0,
            input_tokens: None,
            output_tokens: None,
            estimated_cost: None,
            decision: Some(initial.clone()),
            persist,
        }));
        // Register before any network call: cancellation while classifying must
        // leave an interrupted request, not an untracked classifier charge.
        crate::proxy::gateway_observer::register(&trace);
        self.write_gateway_trace(&*trace.lock().map_err(|_| invalid("gateway.traceLock"))?)?;
        let mut intents = vec![];
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(6);
        for group in &initial.groups {
            if group.enabled
                && group.strategy != routing::Strategy::Manual
                && group.rules.iter().any(|r| {
                    r.enabled
                        && group
                            .members
                            .iter()
                            .any(|m| m.enabled && m.id == r.member_id)
                })
            {
                {
                    let mut snapshot = trace.lock().map_err(|_| invalid("gateway.traceLock"))?;
                    if let Some(decision) = &mut snapshot.decision {
                        decision.intents.push(routing::IntentDecision {
                            group_id: group.id.clone(),
                            outcome: "pending".into(),
                            supplier_id: group
                                .classifier
                                .as_ref()
                                .map(|c| c.supplier_id.clone())
                                .unwrap_or_default(),
                            model: group
                                .classifier
                                .as_ref()
                                .map(|c| c.model.clone())
                                .unwrap_or_default(),
                            ..Default::default()
                        });
                    }
                    self.write_gateway_trace(&snapshot)?;
                }
                intents.push(
                    intent::classify(
                        self,
                        &catalog,
                        group,
                        app_id,
                        session.as_deref(),
                        body,
                        deadline,
                    )
                    .await,
                );
                let mut snapshot = trace.lock().map_err(|_| invalid("gateway.traceLock"))?;
                if let Some(decision) = &mut snapshot.decision {
                    decision.intents = intents.clone();
                }
                self.write_gateway_trace(&snapshot)?;
            }
        }
        let decision = self
            .gateway_runtime
            .plan(&catalog, &policy, session, intents, true)?;
        let route = self.materialize_gateway_route(&catalog, app_id, policy, decision)?;
        {
            let mut snapshot = trace.lock().map_err(|_| invalid("gateway.traceLock"))?;
            snapshot.decision = Some(route.decision.clone());
            snapshot.policy = route.policy.clone();
            if route.providers.is_empty() {
                snapshot.outcome = if route.decision.candidates.is_empty() {
                    "configuration"
                } else {
                    "circuit_open"
                }
                .into();
            }
            self.write_gateway_trace(&snapshot)?;
        }
        Ok(Some((route, trace)))
    }
    fn materialize_gateway_route(
        &self,
        catalog: &Catalog,
        app_id: &str,
        mut policy: RoutePolicy,
        decision: routing::RouteDecision,
    ) -> Result<ResolvedRoute, AppError> {
        let mut providers = Vec::new();
        let mut models = HashMap::new();
        let mut supplier_ids = HashMap::new();
        if let Some(group) = decision.groups.first() {
            policy.failover = group.failover;
        }
        let max = decision
            .groups
            .first()
            .map(|g| {
                if g.failover {
                    g.max_attempts as usize
                } else {
                    1
                }
            })
            .unwrap_or(if policy.failover { 11 } else { 1 });
        for c in decision.candidates.iter().filter(|c| c.available).take(max) {
            let supplier = catalog
                .suppliers
                .iter()
                .find(|s| s.id == c.supplier_id)
                .ok_or_else(|| invalid("gateway.missingSupplier"))?;
            let secret = self
                .secret(&supplier.id)?
                .ok_or_else(|| invalid("gateway.missingSecret"))?;
            let mut provider = Provider::with_id(
                if policy.group_id.is_some() {
                    format!(
                        "gateway:{}:{:x}",
                        supplier.id,
                        Sha256::digest(c.model.as_bytes())
                    )
                } else {
                    format!("gateway:{}", supplier.id)
                },
                supplier.name.clone(),
                serde_json::json!({}),
                None,
            );
            let base = &supplier.endpoint.base_url;
            let protocol = &supplier.endpoint.protocol;
            let api_key_field: String = match (app_id, secret.auth_field.as_str()) {
                ("claude" | "codex" | "grokbuild", "ANTHROPIC_API_KEY") => {
                    "ANTHROPIC_API_KEY".to_string()
                }
                ("claude", _) => "ANTHROPIC_AUTH_TOKEN".to_string(),
                ("gemini", _) => "GEMINI_API_KEY".to_string(),
                _ => "OPENAI_API_KEY".to_string(),
            };
            provider.meta = Some(ProviderMeta {
                api_format: Some(protocol.clone()),
                api_key_field: Some(api_key_field.clone()),
                ..Default::default()
            });
            provider.settings_config = match app_id {
                "claude" => {
                    let mut env = serde_json::Map::new();
                    env.insert(
                        "ANTHROPIC_BASE_URL".to_string(),
                        serde_json::Value::String(base.clone()),
                    );
                    env.insert(api_key_field, serde_json::Value::String(secret.api_key));
                    serde_json::json!({"env": env})
                }
                "gemini" => {
                    serde_json::json!({"env": {"GOOGLE_GEMINI_BASE_URL": base, "GEMINI_API_KEY": secret.api_key}})
                }
                _ => {
                    serde_json::json!({"base_url": base, "auth": {"OPENAI_API_KEY": secret.api_key}, "config": ""})
                }
            };
            supplier_ids.insert(provider.id.clone(), supplier.id.clone());
            models.insert(provider.id.clone(), c.model.clone());
            providers.push(provider);
        }
        Ok(ResolvedRoute {
            revision: catalog.revision,
            timeouts: decision.groups.first().map(|g| RouteTimeouts {
                streaming_first_byte: g.streaming_first_byte_timeout,
                streaming_idle: g.streaming_idle_timeout,
                non_streaming: g.non_streaming_timeout,
            }),
            policy,
            providers,
            models,
            supplier_ids,
            decision,
        })
    }
    pub fn write_gateway_trace(&self, trace: &RequestTrace) -> Result<(), AppError> {
        self.ledger_route(trace).map_err(|error| {
            self.ledger_available.store(false, std::sync::atomic::Ordering::Release);
            error
        })?;
        self.gateway_runtime.observe(trace);
        if !trace.persist {
            return Ok(());
        }
        let conn = lock_conn!(self.conn);
        conn.execute("INSERT INTO gateway_traces(id,created_at,payload) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload", params![trace.id, trace.created_at, serde_json::to_string(trace).map_err(db_error)?]).map_err(db_error)?;
        conn.execute("DELETE FROM gateway_traces WHERE id IN (SELECT id FROM gateway_traces ORDER BY created_at DESC LIMIT -1 OFFSET 1000)", []).map_err(db_error)?;
        Ok(())
    }
    pub fn gateway_traces(&self) -> Result<Vec<RequestTrace>, AppError> {
        let conn = lock_conn!(self.conn);
        let mut stmt = conn
            .prepare("SELECT payload FROM gateway_traces ORDER BY created_at DESC LIMIT 100")
            .map_err(db_error)?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(db_error)?;
        rows.map(|row| serde_json::from_str(&row.map_err(db_error)?).map_err(db_error))
            .collect()
    }
}
fn upsert_secret(
    tx: &rusqlite::Transaction<'_>,
    supplier_id: &str,
    api_key: &str,
    auth_field: &str,
) -> Result<(), AppError> {
    tx.execute("INSERT INTO gateway_supplier_secrets(supplier_id,api_key,auth_field) VALUES(?1,?2,?3) ON CONFLICT(supplier_id) DO UPDATE SET api_key=excluded.api_key, auth_field=excluded.auth_field",
        params![supplier_id, api_key, auth_field]).map_err(db_error)?;
    Ok(())
}
fn read_catalog(conn: &rusqlite::Connection) -> Result<Catalog, AppError> {
    let payload: Option<String> = conn
        .query_row("SELECT payload FROM gateway_catalog WHERE id=1", [], |r| {
            r.get(0)
        })
        .optional()
        .map_err(db_error)?;
    payload
        .map(|p| serde_json::from_str(&p).map_err(db_error))
        .unwrap_or_else(|| Ok(Catalog::default()))
}

/// Only fixed error categories enter the trace, never upstream bodies/URLs/keys.
pub fn error_category(error: &crate::proxy::ProxyError) -> &'static str {
    use crate::proxy::ProxyError::*;
    match error {
        UpstreamError {
            status: 401 | 403, ..
        }
        | AuthError(_) => "authentication",
        UpstreamError { status: 429, .. } => "rate_limit",
        UpstreamError {
            status: 500..=599, ..
        } => "upstream_unavailable",
        UpstreamError { .. } | InvalidRequest(_) => "request_rejected",
        Timeout(_) | StreamIdleTimeout(_) => "timeout",
        AllProvidersCircuitOpen => "circuit_open",
        ConfigError(_) | NoAvailableProvider | NoProvidersConfigured => "configuration",
        _ => "transport",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::Database;

    fn memory_db() -> Database {
        Database::memory().expect("memory db")
    }

    fn test_provider(id: &str, key_var: &str) -> crate::provider::Provider {
        crate::provider::Provider::with_id(
            id.into(),
            format!("test-{id}"),
            serde_json::json!({"env": {
                "ANTHROPIC_BASE_URL": "http://127.0.0.1:9",
                (key_var): "sk-test-key",
                "ANTHROPIC_MODEL": "claude-sonnet-4-5",
            }}),
            None,
        )
    }

    fn test_supplier(id: &str) -> Supplier {
        Supplier {
            id: id.into(),
            name: format!("supplier-{id}"),
            credential: None,
            endpoint: Endpoint {
                protocol: "anthropic".into(),
                base_url: "https://relay.example.com".into(),
            },
            models: vec!["claude-sonnet-4-5".into(), "routed-model".into()],
        }
    }

    #[tokio::test]
    async fn templates_create_pool_credentials_without_application_rows() {
        let db = memory_db();
        let mut claude = test_provider("draft", "ANTHROPIC_API_KEY");
        claude.settings_config["env"]["ANTHROPIC_DEFAULT_SONNET_MODEL"] =
            serde_json::json!("second-model");
        let mut converted = claude.clone();
        converted.meta = Some(ProviderMeta {
            api_format: Some("openai_chat".into()),
            ..Default::default()
        });
        let codex = Provider::with_id(
            "draft".into(),
            "Codex template".into(),
            serde_json::json!({
                "auth": {"OPENAI_API_KEY": "template-key"},
                "modelCatalog": {"models": [{"model": "custom-model"}, {"model": "catalog-model"}]},
                "config": "model = \"custom-model\"\nmodel_provider = \"custom\"\n[model_providers.custom]\nbase_url = \"http://127.0.0.1:9/v1\"\nwire_api = \"responses\"\n"
            }),
            None,
        );
        let gemini = Provider::with_id(
            "draft".into(),
            "Gemini template".into(),
            serde_json::json!({"env": {
                "GEMINI_API_KEY": "template-key", "GOOGLE_GEMINI_BASE_URL": "https://example.com", "GEMINI_MODEL": "gemini-model"
            }}),
            None,
        );
        let grok = Provider::with_id(
            "draft".into(),
            "Grok template".into(),
            serde_json::json!({
                "config": "[models]\ndefault = \"custom\"\n[model.custom]\nname = \"Custom\"\nmodel = \"grok-model\"\nbase_url = \"http://127.0.0.1:9/v1\"\napi_key = \"template-key\"\napi_backend = \"responses\"\ncontext_window = 500000\n"
            }),
            None,
        );
        for (index, (app, provider, protocol, field, model)) in [
            (
                "claude",
                claude,
                "anthropic",
                "ANTHROPIC_API_KEY",
                "second-model",
            ),
            (
                "claude",
                converted,
                "openai_chat",
                "OPENAI_API_KEY",
                "second-model",
            ),
            (
                "codex",
                codex,
                "openai_responses",
                "OPENAI_API_KEY",
                "catalog-model",
            ),
            (
                "gemini",
                gemini,
                "gemini_native",
                "GEMINI_API_KEY",
                "gemini-model",
            ),
            (
                "grokbuild",
                grok,
                "openai_responses",
                "OPENAI_API_KEY",
                "grok-model",
            ),
        ]
        .into_iter()
        .enumerate()
        {
            let saved = db
                .create_gateway_supplier_from_template(app, &provider, index as u64)
                .await
                .unwrap();
            let supplier = saved.suppliers.last().unwrap();
            assert_eq!(supplier.endpoint.protocol, protocol);
            assert!(supplier.models.contains(&model.to_string()));
            assert!(supplier.credential.is_none());
            assert_eq!(db.secret(&supplier.id).unwrap().unwrap().auth_field, field);
            assert!(db.get_provider_by_id("draft", app).unwrap().is_none());
            assert!(!serde_json::to_string(&saved)
                .unwrap()
                .contains("template-key"));
            assert!(!serde_json::to_string(&saved)
                .unwrap()
                .contains("sk-test-key"));
        }
        let provider = test_provider("stale", "ANTHROPIC_API_KEY");
        assert!(db
            .create_gateway_supplier_from_template("claude", &provider, 0)
            .await
            .unwrap_err()
            .to_string()
            .contains("staleRevision"));
        let mut managed = provider.clone();
        managed.meta = Some(ProviderMeta {
            provider_type: Some("codex_oauth".into()),
            ..Default::default()
        });
        assert!(db
            .create_gateway_supplier_from_template("codex", &managed, 5)
            .await
            .is_err());
        assert_eq!(db.gateway_catalog().unwrap().suppliers.len(), 5);
        assert_eq!(secret_count(&db), 5);
    }

    #[tokio::test]
    async fn templates_import_upstream_models_and_merge_with_static_ones() {
        let upstream = axum::Router::new().route(
            "/v1/models",
            axum::routing::get(|| async {
                axum::Json(serde_json::json!({
                    "data": [
                        {"id": "fetched-b"},
                        {"id": "fetched-a"},
                        {"id": "claude-sonnet-4-5"}
                    ]
                }))
            }),
        );
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, upstream).await.unwrap();
        });

        let db = memory_db();
        let mut provider = test_provider("draft", "ANTHROPIC_API_KEY");
        provider.settings_config["env"]["ANTHROPIC_BASE_URL"] =
            serde_json::json!(format!("http://{address}"));
        let saved = db
            .create_gateway_supplier_from_template("claude", &provider, 0)
            .await
            .unwrap();
        let supplier = saved.suppliers.last().unwrap();
        for model in ["claude-sonnet-4-5", "fetched-a", "fetched-b"] {
            assert!(
                supplier.models.contains(&model.to_string()),
                "missing {model}: {:?}",
                supplier.models
            );
        }
    }

    #[test]
    fn provider_models_reads_the_codex_config_toml_catalog() {
        let provider = crate::provider::Provider::with_id(
            "draft".into(),
            "Codex template".into(),
            serde_json::json!({
                "auth": {},
                "config": "[model_catalog]\nmodels = [{model = \"gpt-5-codex\"}, {model = \"gpt-5-mini\"}]\n",
            }),
            None,
        );
        let models = provider_models(&provider);
        assert!(models.contains(&"gpt-5-codex".to_string()), "{models:?}");
        assert!(models.contains(&"gpt-5-mini".to_string()), "{models:?}");
    }

    #[tokio::test]
    async fn universal_templates_save_all_protocols_atomically() {
        let db = memory_db();
        let mut provider = UniversalProvider::new(
            "draft".into(),
            "NewAPI".into(),
            "newapi".into(),
            "http://127.0.0.1:9".into(),
            "template-key".into(),
        );
        provider.apps = crate::provider::UniversalProviderApps {
            claude: true,
            codex: true,
            gemini: true,
        };
        let saved = db
            .create_gateway_suppliers_from_universal(&provider, 0)
            .await
            .unwrap();
        assert_eq!(saved.revision, 1);
        assert_eq!(
            saved
                .suppliers
                .iter()
                .map(|s| s.endpoint.protocol.as_str())
                .collect::<Vec<_>>(),
            ["anthropic", "openai_responses", "gemini_native"]
        );
        assert_eq!(secret_count(&db), 3);
        for app in ["claude", "codex", "gemini"] {
            assert!(db
                .get_provider_by_id(&format!("universal-{app}-draft"), app)
                .unwrap()
                .is_none());
        }
        let mut invalid = provider.clone();
        // An invalid key fails without persisting any of the protocol entries.
        invalid.api_key = "bad\nkey".into();
        assert!(db
            .create_gateway_suppliers_from_universal(&invalid, 1)
            .await
            .is_err());
        assert_eq!(db.gateway_catalog().unwrap().suppliers.len(), 3);
        assert_eq!(secret_count(&db), 3);
        let valid = provider.to_claude_provider().unwrap();
        let mut missing_key = provider.to_gemini_provider().unwrap();
        missing_key.settings_config["env"]["GEMINI_API_KEY"] = serde_json::json!("");
        assert!(db
            .create_gateway_template_suppliers(&[("claude", valid), ("gemini", missing_key)], 1)
            .await
            .is_err());
        assert_eq!(db.gateway_catalog().unwrap().suppliers.len(), 3);
        assert_eq!(secret_count(&db), 3);
        let mut none = provider;
        none.apps.claude = false;
        none.apps.codex = false;
        none.apps.gemini = false;
        assert!(db
            .create_gateway_suppliers_from_universal(&none, 1)
            .await
            .is_err());
    }

    fn test_policy(
        id: &str,
        app_id: &str,
        match_model: &str,
        priority: u32,
        failover: bool,
        suppliers: &[&str],
    ) -> RoutePolicy {
        RoutePolicy {
            group_id: None,
            id: id.into(),
            name: format!("policy-{id}"),
            app_id: app_id.into(),
            enabled: true,
            match_model: match_model.into(),
            priority,
            failover,
            candidates: suppliers
                .iter()
                .map(|s| RouteCandidate {
                    supplier_id: (*s).into(),
                    model: "claude-sonnet-4-5".into(),
                })
                .collect(),
        }
    }

    fn catalog_with(suppliers: Vec<Supplier>, policies: Vec<RoutePolicy>) -> Catalog {
        Catalog {
            groups: vec![],
            revision: 0,
            suppliers,
            policies,
        }
    }

    fn seed_legacy_catalog(db: &Database, catalog: &Catalog) {
        let conn = db.conn.lock().expect("lock conn");
        conn.execute("INSERT INTO gateway_catalog(id,payload) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
            [serde_json::to_string(catalog).expect("payload")]).expect("seed catalog");
    }

    fn seed_secret(db: &Database, supplier_id: &str, api_key: &str, auth_field: &str) {
        let conn = db.conn.lock().expect("lock conn");
        conn.execute("INSERT INTO gateway_supplier_secrets(supplier_id,api_key,auth_field) VALUES(?1,?2,?3) ON CONFLICT(supplier_id) DO UPDATE SET api_key=excluded.api_key, auth_field=excluded.auth_field",
            params![supplier_id, api_key, auth_field]).expect("seed secret");
    }

    fn secret_count(db: &Database) -> usize {
        let conn = db.conn.lock().expect("lock conn");
        conn.query_row("SELECT COUNT(*) FROM gateway_supplier_secrets", [], |r| {
            r.get::<_, i64>(0)
        })
        .expect("count") as usize
    }

    fn delete_provider_row(db: &Database, id: &str) {
        let conn = db.conn.lock().expect("lock conn");
        conn.execute("DELETE FROM providers WHERE id=?1", [id])
            .expect("delete provider row");
    }

    #[test]
    fn catalog_defaults_empty_and_revision_bumps() {
        let db = memory_db();
        assert!(db.gateway_catalog().expect("catalog").suppliers.is_empty());

        let catalog = catalog_with(vec![test_supplier("sup-a")], vec![]);
        seed_secret(&db, "sup-a", "sk-a", "ANTHROPIC_AUTH_TOKEN");
        let saved = db.save_gateway_catalog(catalog).expect("save");
        assert_eq!(saved.revision, 1);

        // Stale revision (still based on revision 0) must be rejected.
        let stale = catalog_with(vec![test_supplier("sup-a")], vec![]);
        let err = db.save_gateway_catalog(stale).unwrap_err();
        assert!(
            err.to_string().contains("staleRevision"),
            "unexpected: {err}"
        );

        // Saving based on the fresh revision succeeds and bumps again.
        let next = db.save_gateway_catalog(saved).expect("save again");
        assert_eq!(next.revision, 2);
    }

    #[test]
    fn managed_or_missing_credentials_rejected() {
        let db = memory_db();
        let mut oauth = test_provider("codex-oauth", "ANTHROPIC_AUTH_TOKEN");
        oauth.meta = Some(crate::provider::ProviderMeta {
            provider_type: Some("codex_oauth".into()),
            ..Default::default()
        });
        db.save_provider("claude", &oauth)
            .expect("save oauth provider");
        let err = db
            .preview_gateway_import(CredentialRef {
                app_id: "claude".into(),
                provider_id: "codex-oauth".into(),
            })
            .unwrap_err();
        assert!(
            err.to_string().contains("managedCredential"),
            "unexpected: {err}"
        );

        let keyless = crate::provider::Provider::with_id(
            "keyless".into(),
            "keyless".into(),
            serde_json::json!({}),
            None,
        );
        db.save_provider("claude", &keyless)
            .expect("save keyless provider");
        let err = db
            .preview_gateway_import(CredentialRef {
                app_id: "claude".into(),
                provider_id: "keyless".into(),
            })
            .unwrap_err();
        assert!(
            err.to_string().contains("managedCredential")
                || err.to_string().contains("missingCredential"),
            "unexpected: {err}"
        );

        let err = db
            .preview_gateway_import(CredentialRef {
                app_id: "claude".into(),
                provider_id: "ghost".into(),
            })
            .unwrap_err();
        assert!(
            err.to_string().contains("missingCredential"),
            "unexpected: {err}"
        );
    }

    #[test]
    fn import_copies_key_into_pool_and_stays_independent() {
        let db = memory_db();
        db.save_provider("claude", &test_provider("prov-a", "ANTHROPIC_AUTH_TOKEN"))
            .expect("save provider");
        let source = CredentialRef {
            app_id: "claude".into(),
            provider_id: "prov-a".into(),
        };

        let preview = db.preview_gateway_import(source.clone()).expect("preview");
        assert_eq!(preview.supplier.endpoint.protocol, "anthropic");
        assert_eq!(
            preview.supplier.endpoint.base_url,
            "http://127.0.0.1:9"
        );
        assert!(preview
            .supplier
            .models
            .iter()
            .any(|m| m == "claude-sonnet-4-5"));
        assert!(!preview.already_imported);

        let catalog = db.apply_gateway_import(preview, 0).expect("apply");
        assert_eq!(catalog.suppliers.len(), 1);
        assert_eq!(catalog.suppliers[0].credential.as_ref(), Some(&source));

        // Re-importing the same credential must be rejected.
        let second = db.preview_gateway_import(source).expect("second preview");
        assert!(second.already_imported);
        let err = db
            .apply_gateway_import(second, catalog.revision)
            .unwrap_err();
        assert!(
            err.to_string().contains("alreadyImported"),
            "unexpected: {err}"
        );

        // The serialized catalog DTO never carries the key, but the pool owns a copy.
        let serialized =
            serde_json::to_string(&db.gateway_catalog().expect("catalog")).expect("serialize");
        assert!(
            !serialized.contains("sk-test-key"),
            "catalog leaked the key"
        );
        assert_eq!(secret_count(&db), 1);

        // Resolve reads the pool secret, not the app config.
        let mut catalog = db.gateway_catalog().expect("catalog");
        let supplier_id = catalog.suppliers[0].id.clone();
        catalog.policies.push(test_policy(
            "p1",
            "claude",
            "",
            1,
            false,
            std::slice::from_ref(&supplier_id.as_str()),
        ));
        db.save_gateway_catalog(catalog).expect("save policy");

        let resolved = db
            .resolve_gateway_route("claude", "claude-sonnet-4-5")
            .expect("resolve")
            .expect("matched");
        let env = resolved.providers[0].settings_config["env"]
            .as_object()
            .expect("env");
        assert_eq!(
            env.get("ANTHROPIC_AUTH_TOKEN").and_then(|v| v.as_str()),
            Some("sk-test-key")
        );
        assert_eq!(
            env.get("ANTHROPIC_BASE_URL").and_then(|v| v.as_str()),
            Some("http://127.0.0.1:9")
        );

        // Deleting the source app config must not break the routed pool entry.
        delete_provider_row(&db, "prov-a");
        assert!(db
            .resolve_gateway_route("claude", "claude-sonnet-4-5")
            .expect("resolve")
            .is_some());

        // A stale preview (provider changed after preview) must be rejected.
        db.save_provider("claude", &test_provider("prov-a", "ANTHROPIC_API_KEY"))
            .expect("mutate provider");
        let stale = ImportPreview {
            source: CredentialRef {
                app_id: "codex".into(),
                provider_id: "other".into(),
            },
            fingerprint: "deadbeef".into(),
            supplier: test_supplier("sup-x"),
            already_imported: false,
        };
        let err = db.apply_gateway_import(stale, 99).unwrap_err();
        assert!(
            err.to_string().contains("staleImport")
                || err.to_string().contains("missingCredential"),
            "unexpected: {err}"
        );
    }

    #[test]
    fn create_update_supplier_flow_with_secret_lifecycle() {
        let db = memory_db();
        let upsert =
            |name: &str, models: Vec<&str>, api_key: &str, auth_field: &str| SupplierUpsert {
                name: Some(name.into()),
                endpoint: Some(Endpoint {
                    protocol: "anthropic".into(),
                    base_url: "https://relay.example.com".into(),
                }),
                models: Some(models.iter().map(|m| (*m).into()).collect()),
                revision: None,
                api_key: Some(api_key.into()),
                auth_field: Some(auth_field.into()),
            };
        let catalog = db
            .create_gateway_supplier(upsert(
                "pool-relay",
                vec!["claude-sonnet-4-5"],
                "sk-pool",
                "ANTHROPIC_AUTH_TOKEN",
            ))
            .expect("create");
        assert_eq!(catalog.suppliers.len(), 1);
        assert!(
            catalog.suppliers[0].credential.is_none(),
            "fresh suppliers carry no provenance"
        );
        assert_eq!(secret_count(&db), 1);
        let id = catalog.suppliers[0].id.clone();

        // Missing key is rejected.
        let err = db
            .create_gateway_supplier(SupplierUpsert {
                name: Some("x".into()),
                endpoint: Some(Endpoint {
                    protocol: "anthropic".into(),
                    base_url: "https://x.example.com".into(),
                }),
                models: Some(vec!["m".into()]),
                revision: None,
                api_key: Some("".into()),
                auth_field: Some("ANTHROPIC_AUTH_TOKEN".into()),
            })
            .unwrap_err();
        assert!(
            err.to_string().contains("invalidSecret"),
            "unexpected: {err}"
        );

        // Auth field must match the protocol.
        let err = db
            .update_gateway_supplier(
                &id,
                SupplierUpsert {
                    auth_field: Some("OPENAI_API_KEY".into()),
                    ..Default::default()
                },
            )
            .unwrap_err();
        assert!(
            err.to_string().contains("invalidSecret"),
            "unexpected: {err}"
        );

        // Partial update keeps the stored key and only swaps given fields.
        let catalog = db
            .update_gateway_supplier(
                &id,
                SupplierUpsert {
                    name: Some("renamed".into()),
                    models: Some(vec!["claude-sonnet-4-5".into(), "alt-model".into()]),
                    ..Default::default()
                },
            )
            .expect("update");
        assert_eq!(catalog.suppliers[0].name, "renamed");
        assert_eq!(secret_count(&db), 1);

        // Rotating only the key keeps the auth field.
        db.update_gateway_supplier(
            &id,
            SupplierUpsert {
                api_key: Some("sk-rotated".into()),
                ..Default::default()
            },
        )
        .expect("rotate");
        assert_eq!(secret_count(&db), 1);

        let mut catalog = db.gateway_catalog().expect("catalog");
        catalog
            .policies
            .push(test_policy("p1", "claude", "", 1, false, &[id.as_str()]));
        db.save_gateway_catalog(catalog).expect("save policy");
        let resolved = db
            .resolve_gateway_route("claude", "claude-sonnet-4-5")
            .expect("resolve")
            .expect("matched");
        let env = resolved.providers[0].settings_config["env"]
            .as_object()
            .expect("env");
        assert_eq!(
            env.get("ANTHROPIC_AUTH_TOKEN").and_then(|v| v.as_str()),
            Some("sk-rotated")
        );

        // Unknown supplier id.
        let err = db
            .update_gateway_supplier(
                "ghost",
                SupplierUpsert {
                    name: Some("n".into()),
                    ..Default::default()
                },
            )
            .unwrap_err();
        assert!(
            err.to_string().contains("missingSupplier"),
            "unexpected: {err}"
        );

        // Raw catalog save dropping the supplier must clean the orphan key.
        let mut stripped = db.gateway_catalog().expect("catalog");
        stripped.suppliers.clear();
        stripped.policies.clear();
        db.save_gateway_catalog(stripped).expect("strip");
        assert_eq!(secret_count(&db), 0);
        assert!(db
            .resolve_gateway_route("claude", "claude-sonnet-4-5")
            .expect("resolve")
            .is_none());
    }

    #[test]
    fn legacy_entries_gain_secrets_or_are_dropped() {
        let db = memory_db();
        db.save_provider("claude", &test_provider("prov-a", "ANTHROPIC_AUTH_TOKEN"))
            .expect("save provider");
        let mut oauth = test_provider("oauth", "ANTHROPIC_AUTH_TOKEN");
        oauth.meta = Some(crate::provider::ProviderMeta {
            provider_type: Some("codex_oauth".into()),
            ..Default::default()
        });
        db.save_provider("claude", &oauth).expect("save oauth");

        let mut good_entry = test_supplier("sup-good");
        good_entry.credential = Some(CredentialRef {
            app_id: "claude".into(),
            provider_id: "prov-a".into(),
        });
        let mut ghost_entry = test_supplier("sup-ghost");
        ghost_entry.credential = Some(CredentialRef {
            app_id: "claude".into(),
            provider_id: "ghost".into(),
        });
        let mut managed_entry = test_supplier("sup-managed");
        managed_entry.credential = Some(CredentialRef {
            app_id: "claude".into(),
            provider_id: "oauth".into(),
        });
        let plain_entry = test_supplier("sup-plain"); // no provenance at all
        let policies = vec![
            test_policy("p1", "claude", "", 1, false, &["sup-good"]),
            test_policy("p2", "claude", "", 2, false, &["sup-managed"]),
        ];
        seed_legacy_catalog(
            &db,
            &catalog_with(
                vec![good_entry, ghost_entry, managed_entry, plain_entry],
                policies,
            ),
        );

        // First catalog read self-heals: resolvable key copied, rest dropped.
        let catalog = db.gateway_catalog().expect("catalog");
        let ids: Vec<&str> = catalog.suppliers.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, vec!["sup-good"]);
        assert!(
            catalog.policies.iter().all(|p| p.id == "p1"),
            "empty policies must be pruned"
        );
        assert_eq!(secret_count(&db), 1);

        // Routing uses the copied key even after the app config disappears.
        delete_provider_row(&db, "prov-a");
        let resolved = db
            .resolve_gateway_route("claude", "claude-sonnet-4-5")
            .expect("resolve")
            .expect("matched");
        let env = resolved.providers[0].settings_config["env"]
            .as_object()
            .expect("env");
        assert_eq!(
            env.get("ANTHROPIC_AUTH_TOKEN").and_then(|v| v.as_str()),
            Some("sk-test-key")
        );
    }

    #[test]
    fn catalog_validation_rejects_inconsistent_policies() {
        let db = memory_db();
        let supplier = test_supplier("sup-a");

        // Candidate references a supplier that is not in the catalog.
        let policy = test_policy("p1", "claude", "", 1, false, &["missing"]);
        let err = db
            .save_gateway_catalog(catalog_with(vec![supplier.clone()], vec![policy]))
            .unwrap_err();
        assert!(
            err.to_string().contains("missingSupplier"),
            "unexpected: {err}"
        );

        // failover=false requires exactly one candidate.
        let policy = test_policy("p1", "claude", "", 1, false, &["sup-a", "sup-a"]);
        let err = db
            .save_gateway_catalog(catalog_with(vec![supplier.clone()], vec![policy]))
            .unwrap_err();
        assert!(
            err.to_string().contains("invalidPolicy"),
            "unexpected: {err}"
        );

        // Same supplier twice in one queue is pointless, reject it.
        let policy = test_policy("p1", "claude", "", 1, true, &["sup-a", "sup-a"]);
        let err = db
            .save_gateway_catalog(catalog_with(vec![supplier.clone()], vec![policy]))
            .unwrap_err();
        assert!(
            err.to_string().contains("invalidCandidate"),
            "unexpected: {err}"
        );

        // Protocol incompatible with the app (gemini_native supplier used by codex).
        let mut gemini_supplier = supplier.clone();
        gemini_supplier.id = "sup-g".into();
        gemini_supplier.endpoint.protocol = "gemini_native".into();
        let policy = test_policy("p1", "codex", "", 1, false, &["sup-g"]);
        let err = db
            .save_gateway_catalog(catalog_with(vec![gemini_supplier], vec![policy]))
            .unwrap_err();
        assert!(
            err.to_string().contains("invalidCandidate"),
            "unexpected: {err}"
        );

        // Duplicate enabled (app, match, priority) collide.
        let p1 = test_policy("p1", "claude", "", 1, false, &["sup-a"]);
        let p2 = test_policy("p2", "claude", "", 1, false, &["sup-a"]);
        let err = db
            .save_gateway_catalog(catalog_with(vec![supplier], vec![p1, p2]))
            .unwrap_err();
        assert!(
            err.to_string().contains("invalidPolicy"),
            "unexpected: {err}"
        );
    }

    #[test]
    fn resolve_route_prefers_priority_and_maps_models() {
        let db = memory_db();
        let suppliers = vec![test_supplier("sup-a"), test_supplier("sup-b")];
        // Catch-all has higher priority number (lower precedence); specific model wins.
        let catch_all = test_policy("catch-all", "claude", "", 10, true, &["sup-a", "sup-b"]);
        let specific = {
            let mut p = test_policy(
                "specific",
                "claude",
                "claude-sonnet-4-5",
                1,
                false,
                &["sup-b"],
            );
            p.candidates[0].model = "routed-model".into();
            p
        };
        seed_secret(&db, "sup-a", "sk-a", "ANTHROPIC_AUTH_TOKEN");
        seed_secret(&db, "sup-b", "sk-b", "ANTHROPIC_API_KEY");
        db.save_gateway_catalog(catalog_with(suppliers, vec![catch_all, specific]))
            .expect("save catalog");

        let resolved = db
            .resolve_gateway_route("claude", "claude-sonnet-4-5")
            .expect("resolve")
            .expect("matched");
        assert_eq!(resolved.policy.id, "specific");
        assert_eq!(resolved.providers.len(), 1);
        assert_eq!(
            resolved.models.get("gateway:sup-b").map(String::as_str),
            Some("routed-model")
        );
        let provider = &resolved.providers[0];
        assert_eq!(provider.id, "gateway:sup-b");
        // Per-supplier auth fields flow into the resolved settings untouched.
        let env = provider.settings_config["env"].as_object().expect("env");
        assert_eq!(
            env.get("ANTHROPIC_API_KEY").and_then(|v| v.as_str()),
            Some("sk-b")
        );

        // No specific match: enabled catch-all with candidates in queue order.
        let resolved = db
            .resolve_gateway_route("claude", "claude-haiku-4-5")
            .expect("resolve")
            .expect("matched");
        assert_eq!(resolved.policy.id, "catch-all");
        assert_eq!(resolved.providers.len(), 2);
        assert_eq!(resolved.providers[0].id, "gateway:sup-a");

        // Disabled policy must not match: disable catch-all, then unknown model resolves nothing.
        let mut catalog = db.gateway_catalog().expect("catalog");
        for p in &mut catalog.policies {
            if p.match_model.is_empty() {
                p.enabled = false;
            }
        }
        db.save_gateway_catalog(catalog).expect("save");
        assert!(db
            .resolve_gateway_route("claude", "claude-haiku-4-5")
            .expect("resolve")
            .is_none());

        // A different app never inherits claude policies.
        assert!(db
            .resolve_gateway_route("codex", "claude-sonnet-4-5")
            .expect("resolve")
            .is_none());
    }

    #[test]
    fn traces_round_trip_and_cap_at_1000() {
        let db = memory_db();
        let trace = |i: i64| RequestTrace {
            decision: None,
            persist: true,
            id: format!("trace-{i}"),
            created_at: i,
            app_id: "claude".into(),
            request_model: "m".into(),
            catalog_revision: 1,
            policy: test_policy("p", "claude", "", 1, false, &["s"]),
            events: vec![TraceEvent {
                group_path: vec![],
                started_at: 0,
                latency_ms: 0,
                supplier_name: "Snapshot supplier".into(),
                supplier_id: "s".into(),
                model: "m".into(),
                outcome: "upstream_accepted".into(),
            }],
            outcome: "upstream_accepted".into(),
            latency_ms: 12,
            input_tokens: Some(10),
            output_tokens: Some(20),
            estimated_cost: None,
        };
        for i in 0..1005 {
            db.write_gateway_trace(&trace(i)).expect("write trace");
        }
        let traces = db.gateway_traces().expect("read traces");
        // The read path serves the latest 100; the table itself is capped at 1000.
        assert_eq!(traces.len(), 100);
        // Newest first.
        assert_eq!(traces[0].id, "trace-1004");
        assert!(traces[0].policy.id == "p");
    }

    #[test]
    fn supplier_removal_can_disable_an_empty_policy_but_cannot_enable_it() {
        let db = memory_db();
        let mut policy = test_policy("p", "claude", "", 1, false, &[]);
        policy.enabled = false;
        let saved = db
            .save_gateway_catalog(catalog_with(vec![], vec![policy]))
            .unwrap();
        let mut enabled = saved.clone();
        enabled.policies[0].enabled = true;
        assert!(db
            .save_gateway_catalog(enabled)
            .unwrap_err()
            .to_string()
            .contains("invalidPolicy"));
        assert!(db.resolve_gateway_route("claude", "m").unwrap().is_none());
    }

    #[test]
    fn cross_agent_auth_and_virtual_entries_preserve_protocol_and_alias() {
        for app_id in ["claude", "codex", "grokbuild", "gemini"] {
            let db = memory_db();
            let mut supplier = test_supplier("s");
            let auth = if app_id == "gemini" {
                supplier.endpoint.protocol = "gemini_native".into();
                "GEMINI_API_KEY"
            } else {
                "ANTHROPIC_API_KEY"
            };
            seed_secret(&db, "s", "upstream-only-key", auth);
            let policy = test_policy("p", app_id, "client-alias", 1, false, &["s"]);
            db.save_gateway_catalog(catalog_with(vec![supplier], vec![policy]))
                .unwrap();
            let route = db
                .resolve_gateway_route(app_id, "client-alias")
                .unwrap()
                .unwrap();
            assert_eq!(
                route.providers[0]
                    .meta
                    .as_ref()
                    .unwrap()
                    .api_key_field
                    .as_deref(),
                Some(auth)
            );
            let adapter = get_adapter(&app(app_id).unwrap()).unwrap();
            let auth_info = adapter.extract_auth(&route.providers[0]).unwrap();
            assert_eq!(auth_info.api_key, "upstream-only-key");
            if app_id != "gemini" {
                assert_eq!(auth_info.strategy, AuthStrategy::Anthropic);
            }
            let entry = db
                .get_provider_by_id(&format!("gateway-entry:{app_id}"), app_id)
                .unwrap()
                .unwrap();
            assert!(!entry
                .settings_config
                .to_string()
                .contains("upstream-only-key"));
            assert!(db.get_all_providers(app_id).unwrap().is_empty());
            if app_id == "grokbuild" {
                let projection =
                    crate::live::project::grok::GrokProjection::of(&entry.settings_config, false)
                        .unwrap();
                assert_eq!(
                    projection.table.unwrap().1["model"].as_str(),
                    Some("client-alias")
                );
            }
            let preview = db.preview_gateway_route(app_id, "client-alias").unwrap();
            assert_eq!(preview.reason, "model_match");
            assert_eq!(preview.policy.unwrap().id, route.policy.id);
            assert!(db
                .preview_gateway_route(app_id, "other")
                .unwrap()
                .policy
                .is_none());
        }
    }

    #[test]
    fn edits_reject_stale_revisions_and_incompatible_stored_auth() {
        let db = memory_db();
        let catalog = db
            .create_gateway_supplier(SupplierUpsert {
                name: Some("Supplier".into()),
                endpoint: Some(Endpoint {
                    protocol: "anthropic".into(),
                    base_url: "http://127.0.0.1:9".into(),
                }),
                models: Some(vec!["m".into()]),
                api_key: Some("key".into()),
                auth_field: Some("ANTHROPIC_API_KEY".into()),
                ..Default::default()
            })
            .unwrap();
        let id = &catalog.suppliers[0].id;
        assert!(db
            .update_gateway_supplier(
                id,
                SupplierUpsert {
                    revision: Some(0),
                    name: Some("Old edit".into()),
                    ..Default::default()
                }
            )
            .unwrap_err()
            .to_string()
            .contains("staleRevision"));
        assert!(db
            .update_gateway_supplier(
                id,
                SupplierUpsert {
                    endpoint: Some(Endpoint {
                        protocol: "gemini_native".into(),
                        base_url: "https://example.com".into()
                    }),
                    ..Default::default()
                }
            )
            .unwrap_err()
            .to_string()
            .contains("invalidSecret"));
        assert_eq!(db.gateway_catalog().unwrap().revision, catalog.revision);
    }

    #[tokio::test]
    async fn discovery_uses_saved_auth_and_keeps_the_catalog_unchanged() {
        let upstream = axum::Router::new().route("/v1/models", axum::routing::get(|headers: axum::http::HeaderMap| async move {
            assert_eq!(headers["x-api-key"], "upstream-only-key");
            assert!(!headers.contains_key("authorization"));
            axum::Json(serde_json::json!({"data": [{"id": "second"}, {"id": "first"}, {"id": "second"}]}))
        }));
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, upstream).await.unwrap();
        });
        let db = memory_db();
        let catalog = db
            .create_gateway_supplier(SupplierUpsert {
                name: Some("Supplier".into()),
                endpoint: Some(Endpoint {
                    protocol: "anthropic".into(),
                    base_url: format!("http://{address}"),
                }),
                models: Some(vec![]),
                api_key: Some("upstream-only-key".into()),
                auth_field: Some("ANTHROPIC_API_KEY".into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(
            db.fetch_gateway_models(&catalog.suppliers[0].id)
                .await
                .unwrap(),
            vec!["first", "second"]
        );
        let after = db.gateway_catalog().unwrap();
        assert_eq!(after.revision, catalog.revision);
        assert!(after.suppliers[0].models.is_empty());
        assert!(!serde_json::to_string(&after)
            .unwrap()
            .contains("upstream-only-key"));
        server.abort();
    }
}
