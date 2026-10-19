//! 路由专用应用：只接入统一路由，不进入侧栏的完整应用管理。
//!
//! 这里的事实表对照 magpie（`internal/agent/*.go`）实现：每个应用的原生配置路径、
//! 供应商块形状、激活键与还原方式。接入时写供应商块并切到它，退出时删掉供应商块、
//! 把激活键恢复成接入前的值。
//!
//! 这些应用都不支持「模式控制器」接法，也不做供应商直连：它们只经本地网关的
//! `/<app>/v1` 进入路由组。

pub mod files;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};

use crate::config::get_home_dir;
use crate::error::AppError;
use files::{Format, Op};

/// 一个路由专用应用的静态描述。
#[derive(Debug, Clone, Copy)]
pub struct LocalApp {
    pub id: &'static str,
    pub label: &'static str,
    /// 本地网关的路径前缀（不含结尾 `/v1`）。
    pub ingress: &'static str,
    /// 应用原生直接消费的协议。这些应用都讲 OpenAI Chat。
    pub direct_protocol: &'static str,
}

/// 全部路由专用应用。顺序与前端流程图一致。
pub const LOCAL_APPS: [LocalApp; 6] = [
    LocalApp {
        id: "commandcode",
        label: "Command Code",
        ingress: "/commandcode",
        direct_protocol: "openai_chat",
    },
    LocalApp {
        id: "crush",
        label: "Crush",
        ingress: "/crush",
        direct_protocol: "openai_chat",
    },
    LocalApp {
        id: "droid",
        label: "Droid",
        ingress: "/droid",
        direct_protocol: "openai_chat",
    },
    LocalApp {
        id: "kimi",
        label: "Kimi Code",
        ingress: "/kimi",
        direct_protocol: "openai_chat",
    },
    LocalApp {
        id: "atomcode",
        label: "AtomCode",
        ingress: "/atomcode",
        direct_protocol: "openai_chat",
    },
    LocalApp {
        id: "omo",
        label: "OmO",
        ingress: "/omo",
        direct_protocol: "openai_chat",
    },
];

/// 这些应用经本地 Chat 入口接入：Chat 直接送达，Responses / Anthropic 由网关中转。
pub const ACCEPTED_PROTOCOLS: [&str; 3] = ["openai_chat", "openai_responses", "anthropic"];

pub fn accepts_protocol(protocol: &str) -> bool {
    ACCEPTED_PROTOCOLS.contains(&protocol)
}

pub fn spec(id: &str) -> Option<&'static LocalApp> {
    LOCAL_APPS.iter().find(|spec| spec.id == id)
}

pub fn ids() -> impl Iterator<Item = &'static str> {
    LOCAL_APPS.iter().map(|spec| spec.id)
}

pub fn provider_id(id: &str) -> String {
    format!("phi-route-{id}")
}

/// 应用接入产生的供应商行 id（与托管应用的 `apps::provider_id` 同形）。
pub fn is_gateway_provider_id(id: &str) -> bool {
    id.starts_with("phi-route-")
}

/// 一份按文件分组的写入计划。
#[derive(Debug, Clone, PartialEq)]
pub struct FilePlan {
    pub path: PathBuf,
    pub format: Format,
    pub ops: Vec<Op>,
}

/// 接入、还原与刷新共用的一份计划。
#[derive(Debug, Clone, PartialEq)]
pub struct LocalPlan {
    /// 供应商行的原生配置（存进数据库，供界面展示与凭据展示）。
    pub settings: Value,
    /// 写入供应商块。
    pub provider: Vec<FilePlan>,
    /// 把应用切到该供应商（需要还原的键）。
    pub activate: Vec<FilePlan>,
    /// 退出路由时删除供应商块。
    pub remove: Vec<FilePlan>,
}

/// 接入前需要还原的值。`value` 为 None 表示这个键原来不存在。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedValue {
    pub file: String,
    pub path: Vec<String>,
    pub value: Option<Value>,
}

fn env_abs(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
}

fn config_root(home: &Path) -> PathBuf {
    if let Some(dir) = env_abs("XDG_CONFIG_HOME") {
        return dir;
    }
    #[cfg(target_os = "macos")]
    {
        return home.join("Library").join("Application Support");
    }
    #[cfg(not(target_os = "macos"))]
    {
        home.join(".config")
    }
}

fn data_root(home: &Path) -> PathBuf {
    if let Some(dir) = env_abs("XDG_DATA_HOME") {
        return dir;
    }
    home.join(".local").join("share")
}

/// 计划里出现的所有文件（用于界面展示与测试）。
pub fn plan_files(plan: &LocalPlan) -> Vec<&Path> {
    plan.provider
        .iter()
        .chain(plan.activate.iter())
        .chain(plan.remove.iter())
        .map(|file| file.path.as_path())
        .collect()
}

pub fn plan(
    id: &str,
    base_url: &str,
    api_key: &str,
    models: &[String],
) -> Result<LocalPlan, AppError> {
    plan_in(&get_home_dir(), id, base_url, api_key, models)
}

/// `plan` 的可测试版本：配置全部落在给定的 home 下。
pub fn plan_in(
    home: &Path,
    id: &str,
    base_url: &str,
    api_key: &str,
    models: &[String],
) -> Result<LocalPlan, AppError> {
    let spec = spec(id).ok_or_else(|| AppError::InvalidInput(format!("{id} 不是路由专用应用")))?;
    let provider = provider_id(spec.id);
    // 还原计划不需要模型名单；接入前的 `models` 校验在 attach 里做。
    Ok(match spec.id {
        "commandcode" => commandcode_plan(home, &provider, base_url, api_key, models),
        "crush" => crush_plan(home, &provider, base_url, api_key, models),
        "droid" => droid_plan(home, &provider, base_url, api_key, models),
        "kimi" => kimi_plan(home, &provider, base_url, api_key, models),
        "atomcode" => atomcode_plan(home, &provider, base_url, api_key, models),
        "omo" => omo_plan(home, &provider, base_url, api_key, models),
        _ => unreachable!("registry and planners match"),
    })
}

fn model_list(models: &[String]) -> Vec<Value> {
    models
        .iter()
        .map(|model| json!({ "id": model, "name": model }))
        .collect()
}

fn settings_summary(base_url: &str, api_key: &str, models: &[String]) -> Value {
    json!({
        "base_url": base_url,
        "api_key": api_key,
        "models": models,
    })
}

fn first_model(models: &[String]) -> String {
    models.first().cloned().unwrap_or_default()
}

/// Command Code：`providers.json` 里一行供应商，`settings.json` 记住 provider/model。
fn commandcode_plan(
    home: &Path,
    provider: &str,
    base_url: &str,
    api_key: &str,
    models: &[String],
) -> LocalPlan {
    let dir = home.join(".commandcode");
    let mut published = Map::new();
    for model in models {
        published.insert(model.clone(), json!({ "name": model }));
    }
    LocalPlan {
        settings: settings_summary(base_url, api_key, models),
        provider: vec![FilePlan {
            path: dir.join("providers.json"),
            format: Format::Json,
            ops: vec![Op::Set {
                path: vec!["provider".into(), provider.into()],
                value: json!({
                    "name": "PHI",
                    "api": "openai-completions",
                    "baseURL": base_url,
                    "apiKey": api_key,
                    "models": published,
                }),
            }],
        }],
        activate: vec![FilePlan {
            path: dir.join("settings.json"),
            format: Format::Json,
            ops: vec![
                Op::Set {
                    path: vec!["model".into()],
                    value: json!(format!("{provider}/{}", first_model(models))),
                },
                Op::Set {
                    path: vec!["modelProvider".into()],
                    value: json!(provider),
                },
            ],
        }],
        remove: vec![FilePlan {
            path: dir.join("providers.json"),
            format: Format::Json,
            ops: vec![Op::Delete {
                path: vec!["provider".into(), provider.into()],
            }],
        }],
    }
}

/// Crush：`crush.json` 里一行供应商，选中的模型写在自己的数据文件里。
fn crush_plan(
    home: &Path,
    provider: &str,
    base_url: &str,
    api_key: &str,
    models: &[String],
) -> LocalPlan {
    let config = if cfg!(windows) {
        // Crush 在 Windows 上把配置和数据都放在 %LOCALAPPDATA%\crush。
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData").join("Local"))
            .join("crush")
            .join("crush.json")
    } else {
        config_root(home).join("crush").join("crush.json")
    };
    let data = if cfg!(windows) {
        config.clone()
    } else {
        data_root(home).join("crush").join("crush.json")
    };
    let published: Vec<Value> = models
        .iter()
        .map(|model| {
            json!({
                "id": model,
                "name": model,
                "context_window": 200000,
                "default_max_tokens": 16384,
                "can_reason": false,
            })
        })
        .collect();
    LocalPlan {
        settings: settings_summary(base_url, api_key, models),
        provider: vec![FilePlan {
            path: config.clone(),
            format: Format::Json,
            ops: vec![Op::Set {
                path: vec!["providers".into(), provider.into()],
                value: json!({
                    "type": "openai",
                    "name": "PHI",
                    "base_url": base_url,
                    "api_key": api_key,
                    "models": published,
                }),
            }],
        }],
        activate: vec![FilePlan {
            path: data,
            format: Format::Json,
            ops: vec![Op::Set {
                path: vec!["models".into(), "large".into()],
                value: json!({
                    "provider": provider,
                    "model": first_model(models),
                }),
            }],
        }],
        remove: vec![FilePlan {
            path: config,
            format: Format::Json,
            ops: vec![Op::Delete {
                path: vec!["providers".into(), provider.into()],
            }],
        }],
    }
}

/// Droid：`customModels` 数组里每个模型一项，默认模型指向其中一项。
fn droid_plan(
    home: &Path,
    provider: &str,
    base_url: &str,
    api_key: &str,
    models: &[String],
) -> LocalPlan {
    let dir = env_abs("FACTORY_HOME_OVERRIDE")
        .unwrap_or_else(|| home.to_path_buf())
        .join(".factory");
    let prefix = format!("custom:{provider}/");
    let mut ops = Vec::new();
    for model in models {
        ops.push(Op::UpsertArrayItem {
            path: vec!["customModels".into()],
            field: "id".into(),
            value: json!({
                "model": model,
                "id": format!("{prefix}{model}"),
                "displayName": model,
                "baseUrl": base_url,
                "apiKey": api_key,
                "provider": "generic-chat-completion-api",
                "noImageSupport": true,
            }),
        });
    }
    LocalPlan {
        settings: settings_summary(base_url, api_key, models),
        provider: vec![FilePlan {
            path: dir.join("settings.json"),
            format: Format::Json,
            ops,
        }],
        activate: vec![FilePlan {
            path: dir.join("settings.json"),
            format: Format::Json,
            ops: vec![Op::Set {
                path: vec!["sessionDefaultSettings".into(), "model".into()],
                value: json!(format!("{prefix}{}", first_model(models))),
            }],
        }],
        remove: vec![FilePlan {
            path: dir.join("settings.json"),
            format: Format::Json,
            ops: vec![Op::RemoveArrayItems {
                path: vec!["customModels".into()],
                field_prefix: prefix,
            }],
        }],
    }
}

/// Kimi Code：一张 provider 表 + 每个模型一张 `[models."<provider>/<model>"]`。
fn kimi_plan(
    home: &Path,
    provider: &str,
    base_url: &str,
    api_key: &str,
    models: &[String],
) -> LocalPlan {
    let dir = if let Some(dir) = env_abs("KIMI_CODE_HOME") {
        dir
    } else if home.join(".kimi-code").exists() {
        home.join(".kimi-code")
    } else if let Some(dir) = env_abs("KIMI_SHARE_DIR") {
        dir
    } else if home.join(".kimi").exists() {
        home.join(".kimi")
    } else {
        home.join(".kimi-code")
    };
    let path = dir.join("config.toml");
    let mut ops = vec![Op::SetTable {
        table: vec!["providers".into(), provider.into()],
        entries: vec![
            ("type".into(), json!("kimi")),
            ("base_url".into(), json!(base_url)),
            ("api_key".into(), json!(api_key)),
        ],
    }];
    for model in models {
        ops.push(Op::SetTable {
            table: vec!["models".into(), format!("{provider}/{model}")],
            entries: vec![
                ("provider".into(), json!(provider)),
                ("model".into(), json!(model)),
                ("max_context_size".into(), json!(128000)),
            ],
        });
    }
    LocalPlan {
        settings: settings_summary(base_url, api_key, models),
        provider: vec![FilePlan {
            path: path.clone(),
            format: Format::Toml,
            ops,
        }],
        activate: vec![FilePlan {
            path: path.clone(),
            format: Format::Toml,
            ops: vec![Op::Set {
                path: vec!["default_model".into()],
                value: json!(format!("{provider}/{}", first_model(models))),
            }],
        }],
        remove: vec![FilePlan {
            path,
            format: Format::Toml,
            ops: vec![
                Op::DeleteTablesUnder {
                    root: "models".into(),
                    prefix: format!("{provider}/"),
                },
                Op::DeleteTable {
                    table: vec!["providers".into(), provider.into()],
                },
            ],
        }],
    }
}

/// AtomCode：一张 provider account 表 + 每个模型一张 model 表。
fn atomcode_plan(
    home: &Path,
    provider: &str,
    base_url: &str,
    api_key: &str,
    models: &[String],
) -> LocalPlan {
    let dir = env_abs("ATOMCODE_HOME").unwrap_or_else(|| home.join(".atomcode"));
    let path = dir.join("config.toml");
    let mut ops = vec![Op::SetTable {
        table: vec!["provider_accounts".into(), provider.into()],
        entries: vec![
            ("provider".into(), json!("openai-compatible")),
            ("base_url".into(), json!(base_url)),
            ("api_key".into(), json!(api_key)),
        ],
    }];
    for model in models {
        ops.push(Op::SetTable {
            table: vec!["models".into(), format!("{provider}/{model}")],
            entries: vec![
                ("account".into(), json!(provider)),
                ("model".into(), json!(model)),
                ("context_window".into(), json!(128000)),
                ("supports_vision".into(), json!(false)),
            ],
        });
    }
    LocalPlan {
        settings: settings_summary(base_url, api_key, models),
        provider: vec![FilePlan {
            path: path.clone(),
            format: Format::Toml,
            ops,
        }],
        activate: vec![FilePlan {
            path: path.clone(),
            format: Format::Toml,
            ops: vec![
                Op::Set {
                    path: vec!["default_provider".into()],
                    value: json!(provider),
                },
                Op::Set {
                    path: vec!["default_model".into()],
                    value: json!(format!("{provider}/{}", first_model(models))),
                },
            ],
        }],
        remove: vec![FilePlan {
            path,
            format: Format::Toml,
            ops: vec![
                Op::DeleteTablesUnder {
                    root: "models".into(),
                    prefix: format!("{provider}/"),
                },
                Op::DeleteTable {
                    table: vec!["provider_accounts".into(), provider.into()],
                },
            ],
        }],
    }
}

/// OmO：Pi 的分支，`models.json` 一行供应商，`settings.json` 记住默认模型。
fn omo_plan(
    home: &Path,
    provider: &str,
    base_url: &str,
    api_key: &str,
    models: &[String],
) -> LocalPlan {
    let dir = env_abs("OMO_CODING_AGENT_DIR")
        .or_else(|| env_abs("SENPI_CODING_AGENT_DIR"))
        .unwrap_or_else(|| home.join(".omo").join("agent"));
    LocalPlan {
        settings: settings_summary(base_url, api_key, models),
        provider: vec![FilePlan {
            path: dir.join("models.json"),
            format: Format::Json,
            ops: vec![Op::Set {
                path: vec!["providers".into(), provider.into()],
                value: json!({
                    "name": "PHI",
                    "baseUrl": base_url,
                    "api": "openai-completions",
                    "apiKey": api_key,
                    "models": model_list(models),
                }),
            }],
        }],
        activate: vec![FilePlan {
            path: dir.join("settings.json"),
            format: Format::Json,
            ops: vec![
                Op::Set {
                    path: vec!["defaultProvider".into()],
                    value: json!(provider),
                },
                Op::Set {
                    path: vec!["defaultModel".into()],
                    value: json!(first_model(models)),
                },
            ],
        }],
        remove: vec![FilePlan {
            path: dir.join("models.json"),
            format: Format::Json,
            ops: vec![Op::Delete {
                path: vec!["providers".into(), provider.into()],
            }],
        }],
    }
}

/// 接入前先记下激活键现在的值；退出路由时原样放回。
pub fn stash(plan: &LocalPlan) -> Result<Vec<SavedValue>, AppError> {
    let mut saved = Vec::new();
    for file in &plan.activate {
        for op in &file.ops {
            let path = match op {
                Op::Set { path, .. } => path,
                _ => continue,
            };
            let value = files::read_value(&file.path, file.format, path)?;
            saved.push(SavedValue {
                file: file.path.to_string_lossy().into_owned(),
                path: path.clone(),
                value,
            });
        }
    }
    Ok(saved)
}

pub fn apply(plan: &LocalPlan) -> Result<(), AppError> {
    for file in plan.provider.iter().chain(plan.activate.iter()) {
        files::apply(&file.path, file.format, &file.ops)?;
    }
    Ok(())
}

pub fn remove(plan: &LocalPlan) -> Result<(), AppError> {
    for file in &plan.remove {
        files::apply(&file.path, file.format, &file.ops)?;
    }
    Ok(())
}

pub fn restore(saved: &[SavedValue]) -> Result<(), AppError> {
    for value in saved {
        let path = PathBuf::from(&value.file);
        let format = if path.extension().is_some_and(|ext| ext == "toml") {
            Format::Toml
        } else {
            Format::Json
        };
        let op = match &value.value {
            Some(current) => Op::Set {
                path: value.path.clone(),
                value: current.clone(),
            },
            None => Op::Delete {
                path: value.path.clone(),
            },
        };
        files::apply(&path, format, &[op])?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn models() -> Vec<String> {
        vec!["glm-5".into(), "kimi-k3".into()]
    }

    fn read(path: &Path) -> String {
        std::fs::read_to_string(path).unwrap()
    }

    struct Home(TempDir);

    impl Home {
        fn new() -> Self {
            Self(TempDir::new().unwrap())
        }
        fn path(&self) -> &Path {
            self.0.path()
        }
    }

    fn connect(home: &Path, id: &str) -> LocalPlan {
        let plan = plan_in(
            home,
            id,
            "http://127.0.0.1:15721/ingress/v1",
            "phi-local-v1:test",
            &models(),
        )
        .unwrap();
        let saved = stash(&plan).unwrap();
        apply(&plan).unwrap();
        let _ = saved;
        plan
    }

    #[test]
    fn commandcode_writes_a_provider_row_and_points_the_model_at_it() {
        let home = Home::new();
        connect(home.path(), "commandcode");
        let providers = read(&home.path().join(".commandcode/providers.json"));
        let value: Value = json5::from_str(&providers).unwrap();
        let row = &value["provider"]["phi-route-commandcode"];
        assert_eq!(row["api"], "openai-completions");
        assert_eq!(row["baseURL"], "http://127.0.0.1:15721/ingress/v1");
        assert_eq!(row["models"]["glm-5"]["name"], "glm-5");
        let settings: Value =
            json5::from_str(&read(&home.path().join(".commandcode/settings.json"))).unwrap();
        assert_eq!(settings["modelProvider"], "phi-route-commandcode");
        assert_eq!(settings["model"], "phi-route-commandcode/glm-5");
    }

    #[test]
    fn crush_splits_the_provider_from_the_pick() {
        let home = Home::new();
        connect(home.path(), "crush");
        let config: Value =
            json5::from_str(&read(&config_root(home.path()).join("crush/crush.json"))).unwrap();
        assert_eq!(
            config["providers"]["phi-route-crush"]["base_url"],
            "http://127.0.0.1:15721/ingress/v1"
        );
        let data: Value =
            json5::from_str(&read(&data_root(home.path()).join("crush/crush.json"))).unwrap();
        assert_eq!(data["models"]["large"]["provider"], "phi-route-crush");
        assert_eq!(data["models"]["large"]["model"], "glm-5");
    }

    #[test]
    fn droid_upserts_custom_models_without_moving_the_users() {
        let home = Home::new();
        let path = home.path().join(".factory/settings.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            r#"{"customModels":[{"id":"custom:mine/1","model":"mine","displayName":"Mine"}],"sessionDefaultSettings":{"model":"custom:mine/1"}}"#,
        )
        .unwrap();
        let saved = {
            let plan = plan_in(
                home.path(),
                "droid",
                "http://127.0.0.1:15721/droid/v1",
                "key",
                &models(),
            )
            .unwrap();
            let saved = stash(&plan).unwrap();
            apply(&plan).unwrap();
            saved
        };
        let value: Value = json5::from_str(&read(&path)).unwrap();
        let entries = value["customModels"].as_array().unwrap();
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0]["id"], "custom:mine/1");
        assert_eq!(entries[1]["id"], "custom:phi-route-droid/glm-5");
        assert_eq!(
            value["sessionDefaultSettings"]["model"],
            "custom:phi-route-droid/glm-5"
        );

        let plan = plan_in(home.path(), "droid", "", "", &[]).unwrap();
        remove(&plan).unwrap();
        restore(&saved).unwrap();
        let value: Value = json5::from_str(&read(&path)).unwrap();
        assert_eq!(value["customModels"].as_array().unwrap().len(), 1);
        assert_eq!(value["sessionDefaultSettings"]["model"], "custom:mine/1");
    }

    #[test]
    fn kimi_adds_tables_and_restores_the_previous_default() {
        let home = Home::new();
        let path = home.path().join(".kimi-code/config.toml");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            "default_model = \"mine\"\n\n[providers.mine]\ntype = \"kimi\"\n",
        )
        .unwrap();
        let saved = {
            let plan = plan_in(
                home.path(),
                "kimi",
                "http://127.0.0.1:15721/kimi/v1",
                "key",
                &models(),
            )
            .unwrap();
            let saved = stash(&plan).unwrap();
            apply(&plan).unwrap();
            saved
        };
        let value: toml::Value = toml::from_str(&read(&path)).unwrap();
        assert_eq!(
            value["default_model"].as_str(),
            Some("phi-route-kimi/glm-5")
        );
        assert_eq!(
            value["providers"]["phi-route-kimi"]["api_key"].as_str(),
            Some("key")
        );
        assert_eq!(
            value["models"]["phi-route-kimi/glm-5"]["provider"].as_str(),
            Some("phi-route-kimi")
        );
        assert_eq!(value["providers"]["mine"]["type"].as_str(), Some("kimi"));

        let plan = plan_in(home.path(), "kimi", "", "", &[]).unwrap();
        remove(&plan).unwrap();
        restore(&saved).unwrap();
        let value: toml::Value = toml::from_str(&read(&path)).unwrap();
        assert_eq!(value["default_model"].as_str(), Some("mine"));
        assert!(value["providers"].get("phi-route-kimi").is_none());
        assert!(
            value.get("models").is_none() || value["models"].get("phi-route-kimi/glm-5").is_none()
        );
    }

    #[test]
    fn atomcode_adds_an_account_and_model_tables() {
        let home = Home::new();
        connect(home.path(), "atomcode");
        let value: toml::Value =
            toml::from_str(&read(&home.path().join(".atomcode/config.toml"))).unwrap();
        assert_eq!(
            value["default_provider"].as_str(),
            Some("phi-route-atomcode")
        );
        assert_eq!(
            value["default_model"].as_str(),
            Some("phi-route-atomcode/glm-5")
        );
        assert_eq!(
            value["provider_accounts"]["phi-route-atomcode"]["provider"].as_str(),
            Some("openai-compatible")
        );
        assert_eq!(
            value["models"]["phi-route-atomcode/kimi-k3"]["account"].as_str(),
            Some("phi-route-atomcode")
        );
    }

    #[test]
    fn omo_writes_pi_shaped_models_and_defaults() {
        let home = Home::new();
        connect(home.path(), "omo");
        let models_file: Value =
            json5::from_str(&read(&home.path().join(".omo/agent/models.json"))).unwrap();
        assert_eq!(
            models_file["providers"]["phi-route-omo"]["baseUrl"],
            "http://127.0.0.1:15721/ingress/v1"
        );
        assert_eq!(
            models_file["providers"]["phi-route-omo"]["models"][0]["id"],
            "glm-5"
        );
        let settings: Value =
            json5::from_str(&read(&home.path().join(".omo/agent/settings.json"))).unwrap();
        assert_eq!(settings["defaultProvider"], "phi-route-omo");
        assert_eq!(settings["defaultModel"], "glm-5");
    }

    #[test]
    fn disconnect_removes_the_provider_and_restores_activation() {
        let home = Home::new();
        let plan = plan_in(
            home.path(),
            "commandcode",
            "http://127.0.0.1:15721/commandcode/v1",
            "key",
            &models(),
        )
        .unwrap();
        let saved = stash(&plan).unwrap();
        apply(&plan).unwrap();
        // 模型被用户改过：退出时按接入前记录恢复。
        let plan = plan_in(home.path(), "commandcode", "", "", &[]).unwrap();
        remove(&plan).unwrap();
        restore(&saved).unwrap();
        let providers: Value =
            json5::from_str(&read(&home.path().join(".commandcode/providers.json"))).unwrap();
        assert!(providers["provider"].get("phi-route-commandcode").is_none());
        let settings: Value =
            json5::from_str(&read(&home.path().join(".commandcode/settings.json"))).unwrap();
        assert!(settings.get("model").is_none());
        assert!(settings.get("modelProvider").is_none());
    }
}
