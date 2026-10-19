//! 请求上下文模块
//!
//! 提供请求生命周期的上下文管理，封装通用初始化逻辑

use crate::app_config::AppType;
use crate::mode::stack::StackTarget;
use crate::provider::Provider;
use crate::proxy::{
    extract_session_id,
    forwarder::RequestForwarder,
    server::ProxyState,
    types::{AppProxyConfig, CopilotOptimizerConfig, OptimizerConfig, RectifierConfig},
    ProxyError,
};
use axum::http::HeaderMap;
use std::time::Instant;

/// 流式超时配置
#[derive(Debug, Clone, Copy)]
pub struct StreamingTimeoutConfig {
    /// 首字节超时（秒），0 表示禁用
    pub first_byte_timeout: u64,
    /// 静默期超时（秒），0 表示禁用
    pub idle_timeout: u64,
}

/// 请求上下文
///
/// 贯穿整个请求生命周期，包含：
/// - 计时信息
/// - 应用级代理配置（per-app）
/// - 选中的 Provider 列表（用于故障转移）
/// - 请求模型名称
/// - 日志标签
/// - Session ID（用于日志关联）
pub struct RequestContext {
    /// 请求开始时间
    pub start_time: Instant,
    /// 应用级代理配置（per-app，包含重试次数和超时配置）
    pub app_config: AppProxyConfig,
    /// 选中的 Provider（故障转移链的第一个）
    pub provider: Provider,
    /// 完整的 Provider 列表（用于故障转移）
    providers: Vec<Provider>,
    /// 请求开始时的"当前供应商"（用于判断是否需要同步 UI/托盘）
    ///
    /// 这里使用本地 settings 的设备级 current provider。
    /// 代理模式下如果实际使用的 provider 与此不一致，会触发切换以确保 UI 始终准确。
    pub current_provider_id: String,
    /// 请求中的模型名称
    pub request_model: String,
    /// 实际发往上游的模型名（路由接管/模型映射后的真值，forward 成功后回填）。
    ///
    /// usage 归因的兜底顺序：上游响应回显 → outbound_model → request_model。
    /// 不能直接用 request_model 兜底：接管场景下它是映射前的客户端别名。
    pub outbound_model: Option<String>,
    /// 日志标签（如 "Claude"、"Codex"、"Gemini"）
    pub tag: &'static str,
    /// 应用类型字符串（如 "claude"、"codex"、"gemini"）
    pub app_type_str: &'static str,
    /// 应用类型（预留，目前通过 app_type_str 使用）
    #[allow(dead_code)]
    pub app_type: AppType,
    /// Session ID（从客户端请求提取或新生成）
    pub session_id: String,
    /// Session ID 是否由客户端提供。生成的 UUID 不能作为上游缓存 key，否则每个请求都会换 key。
    pub session_client_provided: bool,
    /// 整流器配置
    pub rectifier_config: RectifierConfig,
    /// 优化器配置
    pub optimizer_config: OptimizerConfig,
    /// Copilot 优化器配置
    pub copilot_optimizer_config: CopilotOptimizerConfig,
    /// Stack 模型的请求（`mode::stack`）：直达 Stack 里的那一家，不读也不写任何路由状态。
    pub is_stack: bool,
    pub gateway_route: Option<crate::gateway::ResolvedRoute>,
    pub gateway_trace: Option<std::sync::Arc<std::sync::Mutex<crate::gateway::RequestTrace>>>,
}

impl RequestContext {
    /// 创建请求上下文
    ///
    /// # Arguments
    /// * `state` - 代理服务器状态
    /// * `body` - 请求体 JSON
    /// * `headers` - 请求头（用于提取 Session ID）
    /// * `app_type` - 应用类型
    /// * `tag` - 日志标签
    /// * `app_type_str` - 应用类型字符串
    /// * `stack` - Stack 模型的目标（请求体里的 `model` 已换成上游名）
    ///
    /// # Errors
    /// 返回 `ProxyError` 如果 Provider 选择失败
    pub async fn new(
        state: &ProxyState,
        body: &serde_json::Value,
        headers: &HeaderMap,
        app_type: AppType,
        tag: &'static str,
        app_type_str: &'static str,
        stack: Option<StackTarget>,
    ) -> Result<Self, ProxyError> {
        let start_time = Instant::now();

        // 从数据库读取应用级代理配置（per-app）
        let mut app_config = state
            .db
            .get_proxy_config_for_app(app_type_str)
            .await
            .map_err(|e| ProxyError::DatabaseError(e.to_string()))?;

        // 从数据库读取整流器配置
        let rectifier_config = state.db.get_rectifier_config().unwrap_or_default();
        let optimizer_config = state.db.get_optimizer_config().unwrap_or_default();
        let copilot_optimizer_config = state.db.get_copilot_optimizer_config().unwrap_or_default();

        // 提取 Session ID
        let session_result = extract_session_id(headers, body, app_type_str);
        let session_id = session_result.session_id.clone();
        super::ledger_observer::context(
            body.get("model")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("unknown"),
            &session_id,
        )?;

        log::debug!(
            "[{}] Session ID: {} (from {:?}, client_provided: {})",
            tag,
            session_id,
            session_result.source,
            session_result.client_provided
        );

        let is_stack = stack.is_some();
        if is_stack {
            super::ledger_observer::authorize_group(None)
                .map_err(|e| ProxyError::AuthError(e.to_string()))?;
        }
        let planned_gateway = if is_stack {
            None
        } else {
            state
                .db
                .plan_gateway_request(
                    app_type_str,
                    body.get("model")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown"),
                    session_result
                        .client_provided
                        .then_some(session_id.as_str()),
                    body,
                    super::response_processor::usage_logging_enabled(state),
                )
                .await
                .map_err(|error| {
                    if error.to_string().contains("ACCESS_SCOPE_DENIED") {
                        ProxyError::UpstreamError { status: 403, body: Some(serde_json::json!({"error":{"type":"permission_error","code":"ACCESS_SCOPE_DENIED","message":"This PHI access token is not authorized for the selected route group."}}).to_string()) }
                    } else { ProxyError::ConfigError("gateway.invalidPolicy".into()) }
                })?
        };
        let (gateway_route, gateway_trace) = planned_gateway
            .map(|(route, trace)| (Some(route), Some(trace)))
            .unwrap_or((None, None));
        let mode = crate::mode::current::mode_state(&app_type);
        if !is_stack
            && mode.is_proxy()
            && mode
                .proxy_route
                .as_deref()
                .is_some_and(|id| id.starts_with("gateway-entry:"))
            && gateway_route.is_none()
        {
            return Err(ProxyError::NoAvailableProvider);
        }
        let (provider, providers, current_provider_id, request_model) = match stack {
            Some(target) => {
                // Stack 模型：只发往 Stack 里的那一家，不读代理路由、不经熔断器选家。按「单家、
                // 不转移」处理：换成有效副本，转发和读响应两个阶段都从这里取，超时和重试
                // 跟着关掉（见 `create_forwarder`）。
                app_config.auto_failover_enabled = false;
                log::debug!(
                    "[{}] Stacked model {} → provider {}, upstream model {}, session: {}",
                    tag,
                    target.original_model,
                    target.provider.name,
                    target.upstream_model,
                    session_id
                );
                (
                    target.provider.clone(),
                    vec![target.provider.clone()],
                    target.provider.id,
                    target.original_model,
                )
            }
            None => {
                let current_provider = if crate::gateway::local_apps::spec(app_type_str).is_some() {
                    // 路由专用应用没有模式控制器：当前供应商就是它自己的供应商行。
                    crate::mode::current::local_app_in_use(&state.db, app_type_str)
                        .ok()
                        .flatten()
                } else {
                    crate::mode::current::provider_in_use(&state.db, &app_type)
                        .ok()
                        .flatten()
                };
                let current_provider_id = current_provider
                    .as_ref()
                    .map(|provider| provider.id.clone())
                    .unwrap_or_default();

                // 从请求体提取模型名称
                if current_provider_id.starts_with("gateway-entry:") && gateway_route.is_none() {
                    return Err(ProxyError::NoAvailableProvider);
                }
                let request_model = body
                    .get("model")
                    .and_then(|m| m.as_str())
                    .unwrap_or("unknown")
                    .to_string();

                // 普通模型使用默认路由 / 故障转移队列，与是否发布聚合模型无关。
                // 只选择一次，避免重复消耗熔断器 HalfOpen 名额。
                let providers = if let Some(route) = &gateway_route {
                    app_config.auto_failover_enabled = route.policy.failover;
                    app_config.max_retries = route.providers.len().saturating_sub(1) as u32;
                    // 组驱动的路由用自己的故障转移超时策略；策略直连（无组）沿用应用配置
                    if let Some(timeouts) = &route.timeouts {
                        app_config.streaming_first_byte_timeout = timeouts.streaming_first_byte;
                        app_config.streaming_idle_timeout = timeouts.streaming_idle;
                        app_config.non_streaming_timeout = timeouts.non_streaming;
                    }
                    route.providers.clone()
                } else {
                    state
                        .provider_router
                        .select_providers_with_current(app_type_str, current_provider)
                        .await
                        .map_err(|e| match e {
                            crate::error::AppError::AllProvidersCircuitOpen => {
                                ProxyError::AllProvidersCircuitOpen
                            }
                            crate::error::AppError::NoProvidersConfigured => {
                                ProxyError::NoProvidersConfigured
                            }
                            _ => ProxyError::DatabaseError(e.to_string()),
                        })?
                };

                let provider = providers.first().cloned().ok_or_else(|| {
                    // 组内候选全部不可用（如全员冷却中）：把各自原因和剩余时间
                    // 带给调用方，终端不再只看到一句「无可用 Provider」。
                    if let Some(route) = &gateway_route {
                        let now = crate::gateway::routing::now();
                        let detail = route
                            .decision
                            .candidates
                            .iter()
                            .map(|c| {
                                let reason = if c.reason == "cooldown" {
                                    "冷却中".to_string()
                                } else {
                                    c.reason.clone()
                                };
                                let remain = c
                                    .cooldown_until
                                    .filter(|t| *t > now)
                                    .map(|t| {
                                        format!("，冷却剩余 {}s", t.saturating_sub(now) / 1000)
                                    })
                                    .unwrap_or_default();
                                format!("{} · {}：{reason}{remain}", c.supplier_name, c.model)
                            })
                            .collect::<Vec<_>>()
                            .join("；");
                        if detail.is_empty() {
                            ProxyError::NoAvailableProvider
                        } else {
                            ProxyError::NoAvailableProviderWithReason(detail)
                        }
                    } else {
                        ProxyError::NoAvailableProvider
                    }
                })?;

                log::debug!(
                    "[{}] Provider: {}, model: {}, failover chain: {} providers, session: {}",
                    tag,
                    provider.name,
                    request_model,
                    providers.len(),
                    session_id
                );
                (provider, providers, current_provider_id, request_model)
            }
        };

        Ok(Self {
            start_time,
            app_config,
            provider,
            providers,
            current_provider_id,
            request_model,
            outbound_model: None,
            tag,
            app_type_str,
            app_type,
            session_id,
            session_client_provided: session_result.client_provided,
            rectifier_config,
            optimizer_config,
            copilot_optimizer_config,
            is_stack,
            gateway_route,
            gateway_trace,
        })
    }

    /// 从 URI 提取模型名称（Gemini 专用）
    ///
    /// Gemini API 的模型名称在 URI 中，格式如：
    /// `/v1beta/models/gemini-pro:generateContent`
    pub fn with_model_from_uri(mut self, uri: &axum::http::Uri) -> Self {
        // 用 path() 而不是 path_and_query()：模型名必须从路径段中解析，
        // 否则 GET /v1beta/models/<id>?key=... 会把 query 拼到 request_model 上。
        let endpoint = uri.path();

        self.request_model =
            extract_gemini_model_from_path(endpoint).unwrap_or_else(|| "unknown".to_string());

        self
    }

    /// 创建 RequestForwarder
    ///
    /// 使用共享的 ProviderRouter，确保熔断器状态跨请求保持
    ///
    /// 配置生效规则：
    /// - 故障转移开启：超时配置正常生效（0 表示禁用超时）
    /// - 故障转移关闭：超时配置不生效（全部传入 0）
    pub fn create_forwarder(&self, state: &ProxyState) -> RequestForwarder {
        let (non_streaming_timeout, first_byte_timeout, idle_timeout) =
            if self.app_config.auto_failover_enabled {
                // 故障转移开启：使用配置的值（0 = 禁用超时）
                (
                    self.app_config.non_streaming_timeout as u64,
                    self.app_config.streaming_first_byte_timeout as u64,
                    self.app_config.streaming_idle_timeout as u64,
                )
            } else {
                // 故障转移关闭：不启用超时配置
                log::debug!(
                    "[{}] Failover disabled, timeout configs are bypassed",
                    self.tag
                );
                (0, 0, 0)
            };

        // 故障转移关闭时强制 max_retries=0（仅尝试 1 个 provider），与「不超时 + 不切换」语义一致。
        let max_retries = if self.app_config.auto_failover_enabled {
            self.app_config.max_retries
        } else {
            0
        };

        RequestForwarder::new(
            state.provider_router.clone(),
            non_streaming_timeout,
            state.status.clone(),
            state.current_providers.clone(),
            state.gemini_shadow.clone(),
            state.codex_chat_history.clone(),
            state.failover_manager.clone(),
            state.app_handle.clone(),
            self.current_provider_id.clone(),
            self.session_id.clone(),
            self.session_client_provided,
            first_byte_timeout,
            idle_timeout,
            self.rectifier_config.clone(),
            self.optimizer_config.clone(),
            self.copilot_optimizer_config.clone(),
            max_retries,
        )
        .stack_request(self.is_stack)
        .gateway_route(
            self.gateway_route.clone(),
            self.gateway_trace.clone(),
            state.db.clone(),
        )
    }

    /// 获取 Provider 列表（用于故障转移）
    ///
    /// 返回在创建上下文时已选择的 providers，避免重复调用 select_providers()
    pub fn get_providers(&self) -> Vec<Provider> {
        self.providers.clone()
    }

    /// 计算请求延迟（毫秒）
    #[inline]
    pub fn latency_ms(&self) -> u64 {
        self.start_time.elapsed().as_millis() as u64
    }

    /// 获取流式超时配置
    ///
    /// 配置生效规则：
    /// - 故障转移开启：返回配置的值（0 表示禁用超时检查）
    /// - 故障转移关闭：返回 0（禁用超时检查）
    #[inline]
    pub fn streaming_timeout_config(&self) -> StreamingTimeoutConfig {
        if self.app_config.auto_failover_enabled {
            // 故障转移开启：使用配置的值（0 = 禁用超时）
            StreamingTimeoutConfig {
                first_byte_timeout: self.app_config.streaming_first_byte_timeout as u64,
                idle_timeout: self.app_config.streaming_idle_timeout as u64,
            }
        } else {
            // 故障转移关闭：禁用流式超时检查
            StreamingTimeoutConfig {
                first_byte_timeout: 0,
                idle_timeout: 0,
            }
        }
    }
}

/// Pull the Gemini model name out of an API path.
///
/// Accepts forms like `/v1beta/models/gemini-pro:generateContent`,
/// `/v1/models/gemini-1.5-flash`, `gemini/v1beta/models/<model>:streamGenerateContent`.
/// Returns `None` when no `models/<name>` segment is present.
pub(crate) fn extract_gemini_model_from_path(endpoint: &str) -> Option<String> {
    let (_, tail) = endpoint.split_once("models/")?;
    let model = tail.split('?').next()?.split(':').next()?;
    let model = model.replace("%2F", "/").replace("%2f", "/");
    (!model.is_empty()).then_some(model)
}

#[cfg(test)]
mod tests {
    use super::extract_gemini_model_from_path;

    #[test]
    fn extract_group_alias_with_raw_and_encoded_slash() {
        for path in [
            "/v1beta/models/group/production:generateContent",
            "/v1beta/models/group%2Fproduction:generateContent?key=secret",
        ] {
            assert_eq!(
                extract_gemini_model_from_path(path).as_deref(),
                Some("group/production")
            );
        }
    }

    #[test]
    fn extract_model_with_action() {
        assert_eq!(
            extract_gemini_model_from_path("/v1beta/models/gemini-pro:generateContent").as_deref(),
            Some("gemini-pro"),
        );
    }

    #[test]
    fn extract_model_with_dotted_version() {
        assert_eq!(
            extract_gemini_model_from_path("/v1beta/models/gemini-1.5-flash:streamGenerateContent")
                .as_deref(),
            Some("gemini-1.5-flash"),
        );
    }

    #[test]
    fn extract_model_without_action() {
        assert_eq!(
            extract_gemini_model_from_path("/v1/models/gemini-1.5-pro").as_deref(),
            Some("gemini-1.5-pro"),
        );
    }

    #[test]
    fn extract_model_with_proxy_prefix() {
        assert_eq!(
            extract_gemini_model_from_path("/gemini/v1beta/models/gemini-2.0-flash:countTokens")
                .as_deref(),
            Some("gemini-2.0-flash"),
        );
    }

    #[test]
    fn extract_model_with_query_string() {
        assert_eq!(
            extract_gemini_model_from_path("/v1beta/models/gemini-pro:generateContent?key=abc")
                .as_deref(),
            Some("gemini-pro"),
        );
    }

    #[test]
    fn extract_model_missing_segment() {
        assert_eq!(extract_gemini_model_from_path("/v1beta/operations"), None);
    }

    #[test]
    fn extract_model_trailing_models_segment() {
        // `/v1beta/models` (list endpoint) has no following segment → None.
        assert_eq!(extract_gemini_model_from_path("/v1beta/models"), None);
    }

    #[test]
    fn extract_model_get_with_query_only() {
        // GET /v1beta/models/<id>?key=... 无 action verb，仅靠 ':' 拆分会把 query 带进 model 名。
        // 修复后应该把 query 剥掉。
        assert_eq!(
            extract_gemini_model_from_path("/v1beta/models/gemini-pro?key=abc").as_deref(),
            Some("gemini-pro"),
        );
    }

    #[test]
    fn extract_model_get_with_proxy_prefix_and_query() {
        assert_eq!(
            extract_gemini_model_from_path("/gemini/v1beta/models/gemini-2.0-flash?key=abc")
                .as_deref(),
            Some("gemini-2.0-flash"),
        );
    }
}
