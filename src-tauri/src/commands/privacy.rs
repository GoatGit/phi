#![allow(non_snake_case)]

use serde::Serialize;

use crate::privacy::{
    compile_for_preview, config_path, load_config, save_config, DetectorKind, PrivacyConfig,
};

/// 检测器描述，供前端列举可用规则。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivacyDetectorInfo {
    pub id: String,
    /// `custom` 之外都有内置形状。
    pub builtin: bool,
}

/// 隐私配置 + 可用检测器。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivacyConfigResponse {
    pub path: String,
    pub config: PrivacyConfig,
    pub detectors: Vec<PrivacyDetectorInfo>,
}

/// 干跑结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivacyPreviewResponse {
    pub text: String,
    pub hits: usize,
}

fn detectors() -> Vec<PrivacyDetectorInfo> {
    let mut all: Vec<PrivacyDetectorInfo> = DetectorKind::ALL
        .iter()
        .map(|detector| PrivacyDetectorInfo {
            id: detector.as_str().to_string(),
            builtin: true,
        })
        .collect();
    all.push(PrivacyDetectorInfo {
        id: DetectorKind::Custom.as_str().to_string(),
        builtin: false,
    });
    all
}

fn response(config: PrivacyConfig) -> PrivacyConfigResponse {
    PrivacyConfigResponse {
        path: config_path().to_string_lossy().to_string(),
        config,
        detectors: detectors(),
    }
}

/// 读取隐私脱敏配置（缺失时返回默认值）。
#[tauri::command]
pub async fn get_privacy_config() -> Result<PrivacyConfigResponse, String> {
    Ok(response(load_config()))
}

/// 保存隐私脱敏配置；非法配置在写盘前被拒。
#[tauri::command]
pub async fn save_privacy_config(config: PrivacyConfig) -> Result<PrivacyConfigResponse, String> {
    save_config(&config).map_err(|err| err.to_string())?;
    Ok(response(load_config()))
}

/// 用当前配置干跑一段文本，帮助用户确认规则效果与误伤范围。
#[tauri::command]
pub async fn preview_privacy_redaction(text: String) -> Result<PrivacyPreviewResponse, String> {
    let config = load_config();
    let redactor =
        compile_for_preview(&config).map_err(|err| format!("隐私脱敏配置无法编译: {err}"))?;
    let (text, hits) = redactor.redact_text(&text);
    Ok(PrivacyPreviewResponse { text, hits })
}
