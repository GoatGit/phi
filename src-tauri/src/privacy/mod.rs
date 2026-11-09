//! 隐私脱敏：出站请求体与落库错误摘要的凭据 / PII 清理。
//!
//! ## 两个面
//!
//! - **请求体**（默认关）：作为插件管线里的内置阶段，在出站前把字符串值里的
//!   凭据/PII 换成占位文本。改写用户 prompt 是行为变化，必须显式开启。
//! - **错误摘要**（默认开）：上游报错原文、URL、请求回显里的凭据只进本地数据库，
//!   脱敏不影响任何功能，所以默认开启。
//!
//! ## 配置
//!
//! 一条规则 = 检测器 + 处置（`mask` / `remove`）。检测器表见 [`detectors`]，
//! 默认集合只覆盖几乎不可能是正常内容的形状。配置读盘带短 TTL 缓存，改完配置
//! 最多等一个 TTL 生效，热路径不做系统调用。

pub mod config;
pub mod detectors;
pub mod redactor;
pub mod stage;

use std::path::PathBuf;
use std::sync::{Arc, LazyLock, RwLock};
use std::time::{Duration, Instant};

use crate::plugin::stage::RequestStage;

pub use config::{PrivacyConfig, RedactionAction, RedactionRuleConfig, CONFIG_FILE};
pub use detectors::DetectorKind;
pub use redactor::{PrivacyRedactor, MAX_SCANNED_STRING_CHARS};
pub use stage::{PrivacyStage, PRIVACY_STAGE_ID};

/// 配置缓存复用时间。
pub const CONFIG_CACHE_TTL: Duration = Duration::from_secs(2);

struct CachedConfig {
    loaded_at: Option<Instant>,
    redactor: Option<Arc<PrivacyRedactor>>,
    redacts_error_logs: bool,
}

static CACHE: LazyLock<RwLock<CachedConfig>> = LazyLock::new(|| {
    RwLock::new(CachedConfig {
        loaded_at: None,
        redactor: None,
        redacts_error_logs: false,
    })
});

/// 配置文件路径：`<config>/privacy.json`。
pub fn config_path() -> PathBuf {
    crate::config::get_app_config_dir().join(CONFIG_FILE)
}

/// 读取配置（不做缓存；命令与插件重建用）。
pub fn load_config() -> PrivacyConfig {
    PrivacyConfig::load(&config_path())
}

/// 保存配置并立即让缓存失效。
pub fn save_config(config: &PrivacyConfig) -> Result<(), crate::error::AppError> {
    config.save(&config_path())?;
    invalidate_cache();
    Ok(())
}

/// 强制下一次读取重新加载配置。
pub fn invalidate_cache() {
    let mut cache = CACHE
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    cache.loaded_at = None;
}

/// 供配置界面 / 命令使用的脱敏器（不受 `applyToRequestBody` 影响）。
pub fn compile_for_preview(config: &PrivacyConfig) -> Result<PrivacyRedactor, String> {
    PrivacyRedactor::compile(config)
}

/// 当前生效的脱敏器；关闭或规则为空时返回 `None`。
pub fn active_redactor() -> Option<Arc<PrivacyRedactor>> {
    refresh_cache();
    let cache = CACHE
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    cache.redactor.clone()
}

/// 内置请求阶段工厂：`applyToRequestBody` 打开时返回脱敏阶段。
pub fn builtin_request_stages() -> Vec<Arc<dyn RequestStage>> {
    let config = load_config();
    if !config.rewrites_request_body() {
        return Vec::new();
    }
    match PrivacyRedactor::compile(&config) {
        Ok(redactor) => vec![Arc::new(PrivacyStage::new(Arc::new(redactor)))],
        Err(err) => {
            // 配置坏了不该让请求失败：记一条告警，本次不挂脱敏阶段。
            log::warn!("隐私脱敏阶段未启用: {err}");
            Vec::new()
        }
    }
}

/// 落库前脱敏错误摘要；关闭或规则为空时原样返回。
pub fn redact_error_message(text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    refresh_cache();
    let cache = CACHE
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if !cache.redacts_error_logs {
        return text.to_string();
    }
    match &cache.redactor {
        Some(redactor) => redactor.redact_text(text).0,
        None => text.to_string(),
    }
}

fn refresh_cache() {
    let fresh = {
        let cache = CACHE
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        cache
            .loaded_at
            .is_some_and(|loaded_at| loaded_at.elapsed() < CONFIG_CACHE_TTL)
    };
    if fresh {
        return;
    }

    let config = load_config();
    let redactor = PrivacyRedactor::compile(&config)
        .map_err(|err| log::warn!("隐私脱敏配置无法编译: {err}"))
        .ok()
        .filter(|_| config.enabled && !config.rules.is_empty())
        .map(Arc::new);
    let redacts_error_logs = config.redacts_error_logs() && redactor.is_some();

    let mut cache = CACHE
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    cache.loaded_at = Some(Instant::now());
    cache.redactor = redactor;
    cache.redacts_error_logs = redacts_error_logs;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_text_is_returned_unchanged() {
        assert_eq!(redact_error_message(""), "");
    }

    #[test]
    fn preview_compiles_default_config() {
        let redactor = compile_for_preview(&PrivacyConfig::default()).expect("default compiles");
        assert_eq!(redactor.rule_count(), PrivacyConfig::default().rules.len());
        let (text, hits) = redactor.redact_text("card 4111111111111111");
        assert_eq!(hits, 1, "{text}");
    }
}
