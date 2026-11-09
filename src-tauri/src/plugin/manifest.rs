//! 插件清单（`plugin.json`）的类型定义与校验。
//!
//! 一个插件就是一个目录：`<plugins>/<dir>/plugin.json`，可选带一个 `main.js`。
//! 清单只描述「定义」，不描述「执行」：脚本插件把入口交给沙箱执行，规则插件把
//! 声明式规则编译成请求阶段。两者都不允许插件自己指定宿主能力。
//!
//! 校验刻意保守：清单是外部输入，字段长度、条目数量、入口路径、正则复杂度都在
//! 这里卡住，避免一个坏清单把代理热路径拖垮或读到插件目录之外。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// 清单文件名（位于插件目录内）。
pub const MANIFEST_FILE: &str = "plugin.json";
/// 清单文件大小上限，超过直接拒绝：清单是配置，不是数据。
pub const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
/// 单次扫描最多接受的插件数量。
pub const MAX_PLUGINS: usize = 128;
/// 脚本插件入口文件大小上限。
pub const MAX_SCRIPT_BYTES: u64 = 256 * 1024;
/// 当前支持的清单结构版本。
pub const CURRENT_MANIFEST_VERSION: u32 = 1;

const MAX_ID_CHARS: usize = 64;
const MAX_NAME_CHARS: usize = 128;
const MAX_VERSION_CHARS: usize = 32;
const MAX_DESCRIPTION_CHARS: usize = 512;
const MAX_AUTHOR_CHARS: usize = 128;
const MAX_RULES: usize = 32;
const MAX_RULE_PATH_SEGMENTS: usize = 32;
const MAX_RULE_PATH_CHARS: usize = 256;
const MAX_PATTERN_CHARS: usize = 512;
const MAX_REPLACEMENT_CHARS: usize = 64;

fn default_manifest_version() -> u32 {
    CURRENT_MANIFEST_VERSION
}

fn default_version() -> String {
    "0.1.0".to_string()
}

fn default_priority() -> i32 {
    100
}

fn default_true() -> bool {
    true
}

/// 插件挂载的钩子点。
///
/// 目前只有出站请求体一个钩子：它是客户端意图的唯一定义处，响应侧改写会破坏
/// 流式语义与用量记账，先把一个点做稳。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum PluginHook {
    /// 出站请求体（JSON）变换。
    #[default]
    Request,
}

/// 插件实现方式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum PluginKind {
    /// 声明式规则：清单里写规则，宿主编译执行，不跑代码。
    #[default]
    Rules,
    /// 脚本：插件目录里的 `main.js` 导出 `onRequest(payload)`。
    Script,
}

/// 声明式规则的操作。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DeclarativeOp {
    /// 删除命中的字段。
    Remove,
    /// 改写命中的字符串（按 `pattern` 替换，未给 `pattern` 时整值替换）。
    Mask,
}

/// 一条声明式规则。
///
/// `path` 是点分路径，`*` 匹配任意键或数组元素，例如 `messages.*.content`。
/// 数字段表示数组下标：`messages.0.content`。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeclarativeRule {
    pub op: DeclarativeOp,
    pub path: String,
    /// `mask` 使用的正则；缺省表示把整个字符串替换成 `replacement`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pattern: Option<String>,
    /// `mask` 的替换文本，缺省为 `[REDACTED]`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replacement: Option<String>,
}

/// 插件清单。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PluginManifest {
    /// 清单结构版本，便于以后升级而不误读旧清单。
    #[serde(default = "default_manifest_version")]
    pub manifest_version: u32,
    /// 稳定标识：小写字母、数字、`-`、`_`、`.`，全局唯一。
    pub id: String,
    /// 展示名。
    pub name: String,
    #[serde(default = "default_version")]
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    /// 挂载的钩子点，空数组等于不生效。
    #[serde(default)]
    pub hooks: Vec<PluginHook>,
    /// 执行顺序：数值小的先跑，同值按 `id` 字典序，保证跨机器可复现。
    #[serde(default = "default_priority")]
    pub priority: i32,
    /// 没有用户覆盖时是否启用。
    #[serde(default = "default_true")]
    pub enabled_by_default: bool,
    #[serde(default)]
    pub kind: PluginKind,
    /// 脚本插件入口，相对插件目录，必须以 `.js` 结尾。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry: Option<String>,
    /// 规则插件的规则列表。
    #[serde(default)]
    pub rules: Vec<DeclarativeRule>,
}

impl Default for PluginManifest {
    fn default() -> Self {
        Self {
            manifest_version: CURRENT_MANIFEST_VERSION,
            id: String::new(),
            name: String::new(),
            version: default_version(),
            description: None,
            author: None,
            hooks: Vec::new(),
            priority: default_priority(),
            enabled_by_default: true,
            kind: PluginKind::Rules,
            entry: None,
            rules: Vec::new(),
        }
    }
}

/// 清单校验失败：带上出错的字段，UI 与日志都能直接指出位置。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginValidationError {
    pub field: &'static str,
    pub message: String,
}

impl PluginValidationError {
    fn new(field: &'static str, message: impl Into<String>) -> Self {
        Self {
            field,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for PluginValidationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.field, self.message)
    }
}

impl std::error::Error for PluginValidationError {}

impl PluginManifest {
    /// 从清单文本解析并校验。
    pub fn parse(raw: &str) -> Result<Self, PluginValidationError> {
        if raw.len() as u64 > MAX_MANIFEST_BYTES {
            return Err(PluginValidationError::new(
                "manifest",
                format!("清单超过 {MAX_MANIFEST_BYTES} 字节上限"),
            ));
        }
        let manifest: Self = serde_json::from_str(raw).map_err(|err| {
            PluginValidationError::new("manifest", format!("JSON 解析失败: {err}"))
        })?;
        manifest.validate()?;
        Ok(manifest)
    }

    /// 校验清单自身（不涉及磁盘上的入口文件）。
    pub fn validate(&self) -> Result<(), PluginValidationError> {
        if self.manifest_version != CURRENT_MANIFEST_VERSION {
            return Err(PluginValidationError::new(
                "manifest_version",
                format!(
                    "不支持的清单版本 {}（当前 {CURRENT_MANIFEST_VERSION}）",
                    self.manifest_version
                ),
            ));
        }
        validate_id(&self.id)?;
        let name_chars = self.name.chars().count();
        if name_chars == 0 || name_chars > MAX_NAME_CHARS {
            return Err(PluginValidationError::new(
                "name",
                format!("展示名长度必须在 1..={MAX_NAME_CHARS} 字符之间"),
            ));
        }
        let version_chars = self.version.chars().count();
        if version_chars == 0 || version_chars > MAX_VERSION_CHARS {
            return Err(PluginValidationError::new(
                "version",
                format!("版本号长度必须在 1..={MAX_VERSION_CHARS} 字符之间"),
            ));
        }
        if let Some(description) = &self.description {
            if description.chars().count() > MAX_DESCRIPTION_CHARS {
                return Err(PluginValidationError::new(
                    "description",
                    format!("描述超过 {MAX_DESCRIPTION_CHARS} 字符上限"),
                ));
            }
        }
        if let Some(author) = &self.author {
            if author.chars().count() > MAX_AUTHOR_CHARS {
                return Err(PluginValidationError::new(
                    "author",
                    format!("作者超过 {MAX_AUTHOR_CHARS} 字符上限"),
                ));
            }
        }
        if self.rules.len() > MAX_RULES {
            return Err(PluginValidationError::new(
                "rules",
                format!("规则数超过 {MAX_RULES} 条上限"),
            ));
        }
        for (index, rule) in self.rules.iter().enumerate() {
            rule.validate(index)?;
        }
        match self.kind {
            PluginKind::Script => {
                self.entry_path()?;
                if !self.rules.is_empty() {
                    return Err(PluginValidationError::new(
                        "rules",
                        "脚本插件不能再带声明式规则",
                    ));
                }
            }
            PluginKind::Rules => {
                if self.entry.is_some() {
                    return Err(PluginValidationError::new(
                        "entry",
                        "规则插件不能声明入口脚本",
                    ));
                }
            }
        }
        Ok(())
    }

    /// 脚本入口的规范化相对路径；规则插件返回 `None`。
    pub fn entry_path(&self) -> Result<Option<PathBuf>, PluginValidationError> {
        if self.kind == PluginKind::Rules {
            return Ok(None);
        }
        let Some(entry) = &self.entry else {
            return Err(PluginValidationError::new(
                "entry",
                "脚本插件必须声明入口文件",
            ));
        };
        let normalized = normalize_relative_js_path(entry)?;
        Ok(Some(normalized))
    }

    /// 这个插件是否需要在出站请求体上跑。
    pub fn hooks_request(&self) -> bool {
        self.hooks.contains(&PluginHook::Request)
    }

    /// 规则插件没有规则时是空操作，直接跳过，避免热路径白跑。
    pub fn is_effective(&self) -> bool {
        match self.kind {
            PluginKind::Script => true,
            PluginKind::Rules => !self.rules.is_empty(),
        }
    }
}

impl DeclarativeRule {
    fn validate(&self, index: usize) -> Result<(), PluginValidationError> {
        let path_chars = self.path.chars().count();
        if path_chars == 0 || path_chars > MAX_RULE_PATH_CHARS {
            return Err(PluginValidationError::new(
                "rules.path",
                format!("第 {index} 条规则的路径长度必须在 1..={MAX_RULE_PATH_CHARS} 字符之间"),
            ));
        }
        let segments: Vec<&str> = self.path.split('.').collect();
        if segments.len() > MAX_RULE_PATH_SEGMENTS {
            return Err(PluginValidationError::new(
                "rules.path",
                format!("第 {index} 条规则的路径段数超过 {MAX_RULE_PATH_SEGMENTS} 上限"),
            ));
        }
        for segment in segments {
            if segment.is_empty() {
                return Err(PluginValidationError::new(
                    "rules.path",
                    format!("第 {index} 条规则的路径含空段: {}", self.path),
                ));
            }
            if segment != "*"
                && !segment
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
            {
                return Err(PluginValidationError::new(
                    "rules.path",
                    format!("第 {index} 条规则的路径段含非法字符: {segment}"),
                ));
            }
        }
        if let Some(pattern) = &self.pattern {
            if pattern.is_empty() || pattern.chars().count() > MAX_PATTERN_CHARS {
                return Err(PluginValidationError::new(
                    "rules.pattern",
                    format!("第 {index} 条规则的正则长度必须在 1..={MAX_PATTERN_CHARS} 字符之间"),
                ));
            }
        }
        if let Some(replacement) = &self.replacement {
            if replacement.chars().count() > MAX_REPLACEMENT_CHARS {
                return Err(PluginValidationError::new(
                    "rules.replacement",
                    format!("第 {index} 条规则的替换文本超过 {MAX_REPLACEMENT_CHARS} 字符上限"),
                ));
            }
        }
        if self.op == DeclarativeOp::Remove && self.pattern.is_some() {
            return Err(PluginValidationError::new(
                "rules.pattern",
                format!("第 {index} 条规则是 remove，不接受 pattern"),
            ));
        }
        Ok(())
    }
}

fn validate_id(id: &str) -> Result<(), PluginValidationError> {
    let chars: Vec<char> = id.chars().collect();
    if chars.is_empty() || chars.len() > MAX_ID_CHARS {
        return Err(PluginValidationError::new(
            "id",
            format!("插件 id 长度必须在 1..={MAX_ID_CHARS} 字符之间"),
        ));
    }
    let first = chars[0];
    if !first.is_ascii_lowercase() && !first.is_ascii_digit() {
        return Err(PluginValidationError::new(
            "id",
            "插件 id 必须以小写字母或数字开头",
        ));
    }
    if !chars
        .iter()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '_' | '.'))
    {
        return Err(PluginValidationError::new(
            "id",
            "插件 id 只允许小写字母、数字、'-'、'_'、'.'",
        ));
    }
    Ok(())
}

/// 把入口路径规范化成相对路径，并拒绝任何逃出插件目录的写法。
fn normalize_relative_js_path(entry: &str) -> Result<PathBuf, PluginValidationError> {
    let path = Path::new(entry);
    // Windows 上 `/tmp/main.js` 不算 absolute（没有盘符前缀），所以额外拒绝以分隔符开头的写法。
    if path.is_absolute() || entry.starts_with('/') || entry.starts_with('\\') {
        return Err(PluginValidationError::new("entry", "入口必须是相对路径"));
    }
    if entry.contains('\\') {
        return Err(PluginValidationError::new(
            "entry",
            "入口路径使用 '/' 分隔，不接受反斜杠",
        ));
    }
    let mut normalized = PathBuf::new();
    for component in entry.split('/') {
        if component.is_empty() || component == "." {
            continue;
        }
        if component == ".." {
            return Err(PluginValidationError::new("entry", "入口路径不能包含 '..'"));
        }
        normalized.push(component);
    }
    if normalized.as_os_str().is_empty() {
        return Err(PluginValidationError::new("entry", "入口路径不能为空"));
    }
    if normalized.extension().and_then(|ext| ext.to_str()) != Some("js") {
        return Err(PluginValidationError::new(
            "entry",
            "入口文件必须以 .js 结尾",
        ));
    }
    Ok(normalized)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn script_manifest() -> PluginManifest {
        PluginManifest {
            id: "example.request".to_string(),
            name: "Example".to_string(),
            hooks: vec![PluginHook::Request],
            kind: PluginKind::Script,
            entry: Some("main.js".to_string()),
            ..PluginManifest::default()
        }
    }

    #[test]
    fn parses_minimal_manifest_with_defaults() {
        let manifest = PluginManifest::parse(
            r#"{"id":"a1","name":"A1","hooks":["request"],"kind":"script","entry":"main.js"}"#,
        )
        .expect("valid manifest");
        assert_eq!(manifest.manifest_version, CURRENT_MANIFEST_VERSION);
        assert_eq!(manifest.priority, default_priority());
        assert!(manifest.enabled_by_default);
        assert_eq!(manifest.version, "0.1.0");
        assert_eq!(
            manifest.entry_path().unwrap(),
            Some(PathBuf::from("main.js"))
        );
    }

    #[test]
    fn rejects_unknown_fields_instead_of_ignoring_typos() {
        let err = PluginManifest::parse(
            r#"{"id":"a1","name":"A1","hooks":["requets"],"kind":"rules","rules":[]}"#,
        )
        .unwrap_err();
        assert_eq!(err.field, "manifest");
    }

    #[test]
    fn rejects_path_traversal_and_absolute_entry() {
        for entry in [
            "../main.js",
            "/tmp/main.js",
            "\\\\server\\share\\main.js",
            "sub/../../main.js",
        ] {
            let mut manifest = script_manifest();
            manifest.entry = Some(entry.to_string());
            let err = manifest.validate().unwrap_err();
            assert_eq!(err.field, "entry", "entry={entry}");
        }
        let mut manifest = script_manifest();
        manifest.entry = Some("main.mjs".to_string());
        assert_eq!(manifest.validate().unwrap_err().field, "entry");
    }

    #[test]
    fn normalizes_dot_segments_inside_entry() {
        let mut manifest = script_manifest();
        manifest.entry = Some("./sub/./main.js".to_string());
        assert_eq!(
            manifest.entry_path().unwrap(),
            Some(PathBuf::from("sub/main.js"))
        );
    }

    #[test]
    fn rejects_invalid_ids() {
        for id in ["", "A1", "a b", "a/b", "-a"] {
            let mut manifest = script_manifest();
            manifest.id = id.to_string();
            assert_eq!(manifest.validate().unwrap_err().field, "id", "id={id}");
        }
        for id in ["a1", "a-1", "a_1", "a.b", "0"] {
            let mut manifest = script_manifest();
            manifest.id = id.to_string();
            assert!(manifest.validate().is_ok(), "id={id}");
        }
    }

    #[test]
    fn rule_kind_rejects_entry_and_script_kind_rejects_rules() {
        let mut manifest = PluginManifest {
            id: "rules.only".to_string(),
            name: "Rules".to_string(),
            hooks: vec![PluginHook::Request],
            ..PluginManifest::default()
        };
        manifest.entry = Some("main.js".to_string());
        assert_eq!(manifest.validate().unwrap_err().field, "entry");

        let mut script = script_manifest();
        script.rules.push(DeclarativeRule {
            op: DeclarativeOp::Remove,
            path: "a".to_string(),
            pattern: None,
            replacement: None,
        });
        assert_eq!(script.validate().unwrap_err().field, "rules");
    }

    #[test]
    fn rejects_malformed_rule_paths() {
        let mut manifest = PluginManifest {
            id: "rules.only".to_string(),
            name: "Rules".to_string(),
            hooks: vec![PluginHook::Request],
            ..PluginManifest::default()
        };
        for path in ["", "a..b", "a.b!", "$.a"] {
            manifest.rules = vec![DeclarativeRule {
                op: DeclarativeOp::Remove,
                path: path.to_string(),
                pattern: None,
                replacement: None,
            }];
            let err = manifest.validate().unwrap_err();
            assert!(
                matches!(err.field, "rules.path"),
                "path={path} field={}",
                err.field
            );
        }
    }

    #[test]
    fn rejects_remove_with_pattern() {
        let mut manifest = PluginManifest {
            id: "rules.only".to_string(),
            name: "Rules".to_string(),
            hooks: vec![PluginHook::Request],
            ..PluginManifest::default()
        };
        manifest.rules = vec![DeclarativeRule {
            op: DeclarativeOp::Remove,
            path: "a".to_string(),
            pattern: Some("x".to_string()),
            replacement: None,
        }];
        assert_eq!(manifest.validate().unwrap_err().field, "rules.pattern");
    }

    #[test]
    fn manifest_size_is_capped() {
        let raw = "x".repeat((MAX_MANIFEST_BYTES + 1) as usize);
        let err = PluginManifest::parse(&raw).unwrap_err();
        assert_eq!(err.field, "manifest");
    }

    #[test]
    fn unsupported_manifest_version_is_rejected() {
        let mut manifest = script_manifest();
        manifest.manifest_version = CURRENT_MANIFEST_VERSION + 1;
        assert_eq!(manifest.validate().unwrap_err().field, "manifest_version");
    }
}
