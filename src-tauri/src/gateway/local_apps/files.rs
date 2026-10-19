//! 路由专用应用的配置文件读写。
//!
//! 这些应用的原生配置只有两种：JSON/JSONC（保留注释与键序）和 TOML（保留注释、
//! 表顺序与其他键）。写入以「操作」为单位，接入与还原都能重放同一份计划。

use serde_json::{Map, Value};
use std::path::Path;
use toml_edit::{DocumentMut, Item, Table};

use crate::config::atomic_write;
use crate::error::AppError;
use crate::jsonc_document::JsoncDocument;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Json,
    Toml,
}

/// 一次配置写入。`path` 是键路径，最后一段是键本身。
#[derive(Debug, Clone, PartialEq)]
pub enum Op {
    /// 写一个值（对象、数组或标量）。
    Set {
        path: Vec<String>,
        value: Value,
    },
    Delete {
        path: Vec<String>,
    },
    /// 写一张 TOML 表（`[providers.phi]`、`[models."phi/gpt"]`）。
    SetTable {
        table: Vec<String>,
        entries: Vec<(String, Value)>,
    },
    DeleteTable {
        table: Vec<String>,
    },
    /// 删除 `root` 下所有以 `prefix` 开头的表（`[models."phi/…"]`）。
    DeleteTablesUnder {
        root: String,
        prefix: String,
    },
    /// 在数组里按某个字段 upsert 一项。
    UpsertArrayItem {
        path: Vec<String>,
        field: String,
        value: Value,
    },
    /// 删除数组里某个字段以 `prefix` 开头的项。
    RemoveArrayItems {
        path: Vec<String>,
        field_prefix: String,
    },
}

pub fn read_value(path: &Path, format: Format, key: &[String]) -> Result<Option<Value>, AppError> {
    if !path.exists() {
        return Ok(None);
    }
    match format {
        Format::Json => {
            let source = std::fs::read_to_string(path).map_err(|e| AppError::io(path, e))?;
            if source.trim().is_empty() {
                return Ok(None);
            }
            let value: Value = json5::from_str(&source)
                .map_err(|e| AppError::Config(format!("{}: {e}", path.display())))?;
            Ok(lookup(&value, key).cloned())
        }
        Format::Toml => {
            let source = std::fs::read_to_string(path).map_err(|e| AppError::io(path, e))?;
            if source.trim().is_empty() {
                return Ok(None);
            }
            let doc: toml::Value = toml::from_str(&source)
                .map_err(|e| AppError::Config(format!("{}: {e}", path.display())))?;
            Ok(lookup_toml(&doc, key).and_then(toml_to_json))
        }
    }
}

pub fn apply(path: &Path, format: Format, ops: &[Op]) -> Result<(), AppError> {
    // 用户把配置删了：删除类操作不必再把文件建回来。
    let only_removals = ops.iter().all(|op| {
        matches!(
            op,
            Op::Delete { .. }
                | Op::DeleteTable { .. }
                | Op::DeleteTablesUnder { .. }
                | Op::RemoveArrayItems { .. }
        )
    });
    if only_removals && !path.exists() {
        return Ok(());
    }
    match format {
        Format::Json => apply_json(path, ops),
        Format::Toml => apply_toml(path, ops),
    }
}

fn apply_json(path: &Path, ops: &[Op]) -> Result<(), AppError> {
    ensure_private_parent(path)?;
    let source = if path.exists() {
        std::fs::read_to_string(path).map_err(|e| AppError::io(path, e))?
    } else {
        String::new()
    };
    let mut document = if source.trim().is_empty() {
        JsoncDocument::parse("{}")?
    } else {
        JsoncDocument::parse(&source)?
    };
    let mut desired = document.value().clone();
    for op in ops {
        apply_json_op(&mut desired, op)?;
    }
    if &desired == document.value() {
        return Ok(());
    }
    document.apply(&desired)?;
    let text = document.validated_source()?;
    atomic_write(path, text.as_bytes())
}

fn apply_json_op(root: &mut Value, op: &Op) -> Result<(), AppError> {
    match op {
        Op::Set { path, value } => {
            set_path(root, path, value.clone());
            Ok(())
        }
        Op::Delete { path } => {
            delete_path(root, path);
            Ok(())
        }
        Op::UpsertArrayItem { path, field, value } => {
            let items = array_at(root, path);
            let key = value.get(field.as_str()).cloned();
            if let Some(key) = key {
                if let Some(slot) = items
                    .iter_mut()
                    .find(|item| item.get(field.as_str()) == Some(&key))
                {
                    *slot = value.clone();
                    return Ok(());
                }
            }
            items.push(value.clone());
            Ok(())
        }
        Op::RemoveArrayItems { path, field_prefix } => {
            let items = array_at(root, path);
            items.retain(|item| {
                !item
                    .get("id")
                    .or_else(|| item.get("model"))
                    .and_then(Value::as_str)
                    .is_some_and(|value| value.starts_with(field_prefix))
            });
            if items.is_empty() {
                delete_path(root, path);
            }
            Ok(())
        }
        Op::SetTable { .. } | Op::DeleteTable { .. } | Op::DeleteTablesUnder { .. } => Err(
            AppError::Config("TOML 表操作不能写进 JSON 配置".to_string()),
        ),
    }
}

/// 新建的配置文件一律按凭据文件创建（0600）；已有文件保留用户原来的权限位。
fn ensure_private_parent(path: &Path) -> Result<(), AppError> {
    if path.exists() {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| AppError::io(parent, error))?;
    }
    crate::config::atomic_write_private(path, b"")
}

fn lookup<'a>(value: &'a Value, path: &[String]) -> Option<&'a Value> {
    let mut current = value;
    for key in path {
        current = current.get(key)?;
    }
    Some(current)
}

fn set_path(root: &mut Value, path: &[String], value: Value) {
    let Some((last, parents)) = path.split_last() else {
        *root = value;
        return;
    };
    let mut current = root;
    for key in parents {
        if !current.is_object() {
            *current = Value::Object(Map::new());
        }
        let object = current.as_object_mut().expect("object just ensured");
        current = object
            .entry(key.clone())
            .or_insert_with(|| Value::Object(Map::new()));
        if !current.is_object() {
            *current = Value::Object(Map::new());
        }
    }
    if !current.is_object() {
        *current = Value::Object(Map::new());
    }
    current
        .as_object_mut()
        .expect("object just ensured")
        .insert(last.clone(), value);
}

fn delete_path(root: &mut Value, path: &[String]) {
    let Some((last, parents)) = path.split_last() else {
        return;
    };
    let mut current = root;
    for key in parents {
        let Some(next) = current.get_mut(key) else {
            return;
        };
        current = next;
    }
    if let Some(object) = current.as_object_mut() {
        object.remove(last);
    }
}

fn array_at<'a>(root: &'a mut Value, path: &[String]) -> &'a mut Vec<Value> {
    let Some((last, parents)) = path.split_last() else {
        if !root.is_array() {
            *root = Value::Array(Vec::new());
        }
        return root.as_array_mut().expect("array just ensured");
    };
    let mut current = root;
    for key in parents {
        if !current.is_object() {
            *current = Value::Object(Map::new());
        }
        let object = current.as_object_mut().expect("object just ensured");
        current = object
            .entry(key.clone())
            .or_insert_with(|| Value::Array(Vec::new()));
        if !current.is_array() {
            *current = Value::Array(Vec::new());
        }
    }
    if !current.is_object() {
        *current = Value::Object(Map::new());
    }
    let object = current.as_object_mut().expect("object just ensured");
    let entry = object
        .entry(last.clone())
        .or_insert_with(|| Value::Array(Vec::new()));
    if !entry.is_array() {
        *entry = Value::Array(Vec::new());
    }
    entry.as_array_mut().expect("array just ensured")
}

fn apply_toml(path: &Path, ops: &[Op]) -> Result<(), AppError> {
    ensure_private_parent(path)?;
    let source = if path.exists() {
        std::fs::read_to_string(path).map_err(|e| AppError::io(path, e))?
    } else {
        String::new()
    };
    let mut document: DocumentMut = if source.trim().is_empty() {
        DocumentMut::new()
    } else {
        source
            .parse::<DocumentMut>()
            .map_err(|e| AppError::Config(format!("{}: {e}", path.display())))?
    };
    for op in ops {
        apply_toml_op(&mut document, op)?;
    }
    atomic_write(path, document.to_string().as_bytes())
}

fn apply_toml_op(document: &mut DocumentMut, op: &Op) -> Result<(), AppError> {
    match op {
        Op::Set { path, value } => {
            set_toml_value(document, path, value)?;
            Ok(())
        }
        Op::Delete { path } => {
            delete_toml(document, path);
            Ok(())
        }
        Op::SetTable { table, entries } => {
            let item = table_mut(document, table);
            let target = item
                .as_table_mut()
                .ok_or_else(|| AppError::Config(format!("{} 不是一张表", table.join("."))))?;
            for (key, value) in entries {
                let item = json_to_toml(value)?;
                insert_item(target, key, item);
            }
            Ok(())
        }
        Op::DeleteTable { table } => {
            delete_toml(document, table);
            Ok(())
        }
        Op::DeleteTablesUnder { root, prefix } => {
            let Some(table) = document.get_mut(root).and_then(Item::as_table_mut) else {
                return Ok(());
            };
            let names: Vec<String> = table
                .iter()
                .filter(|(name, _)| name.starts_with(prefix))
                .map(|(name, _)| name.to_string())
                .collect();
            for name in names {
                table.remove(&name);
            }
            Ok(())
        }
        Op::UpsertArrayItem { .. } | Op::RemoveArrayItems { .. } => {
            Err(AppError::Config("数组操作不能写进 TOML 配置".to_string()))
        }
    }
}

fn table_mut<'a>(document: &'a mut DocumentMut, table: &[String]) -> &'a mut Item {
    let mut item: &mut Item = document.as_item_mut();
    for key in table {
        if !item.is_table() {
            *item = Item::Table(Table::new());
        }
        let target = item.as_table_mut().expect("table just ensured");
        if !target.contains_key(key) {
            target.insert(key, Item::Table(Table::new()));
        }
        item = target.get_mut(key).expect("entry just inserted");
        if !item.is_table() {
            *item = Item::Table(Table::new());
        }
    }
    item
}

fn set_toml_value(
    document: &mut DocumentMut,
    path: &[String],
    value: &Value,
) -> Result<(), AppError> {
    let Some((last, parents)) = path.split_last() else {
        return Err(AppError::Config("TOML 键路径为空".to_string()));
    };
    let item = table_mut(document, parents);
    let target = item
        .as_table_mut()
        .ok_or_else(|| AppError::Config(format!("{} 不是一张表", parents.join("."))))?;
    insert_item(target, last, json_to_toml(value)?);
    Ok(())
}

/// 替换一张表里的键，保留这个键原有的前导注释与排版。
fn insert_item(table: &mut Table, key: &str, item: Item) {
    match table.key(key).cloned() {
        Some(mut existing) => {
            table.insert_formatted(&mut existing, item);
        }
        None => {
            table.insert(key, item);
        }
    }
}

fn delete_toml(document: &mut DocumentMut, path: &[String]) {
    let Some((last, parents)) = path.split_last() else {
        return;
    };
    let mut item: &mut Item = document.as_item_mut();
    for key in parents {
        let Some(next) = item.as_table_mut().and_then(|table| table.get_mut(key)) else {
            return;
        };
        item = next;
    }
    if let Some(table) = item.as_table_mut() {
        table.remove(last);
    }
}

fn json_to_toml(value: &Value) -> Result<Item, AppError> {
    Ok(match value {
        Value::Null => Item::None,
        Value::Bool(value) => Item::Value((*value).into()),
        Value::Number(number) => {
            if let Some(value) = number.as_i64() {
                Item::Value(value.into())
            } else if let Some(value) = number.as_f64() {
                Item::Value(value.into())
            } else {
                return Err(AppError::Config(format!("TOML 不接受数字 {number}")));
            }
        }
        Value::String(value) => Item::Value(value.as_str().into()),
        Value::Array(items) => {
            let mut array = toml_edit::Array::new();
            for item in items {
                let item = json_to_toml(item)?;
                let Some(value) = item.as_value() else {
                    return Err(AppError::Config("TOML 数组里不能放表".to_string()));
                };
                array.push(value.clone());
            }
            Item::Value(toml_edit::Value::Array(array))
        }
        Value::Object(map) => {
            let mut table = Table::new();
            for (key, value) in map {
                table.insert(key, json_to_toml(value)?);
            }
            Item::Table(table)
        }
    })
}

fn lookup_toml<'a>(value: &'a toml::Value, path: &[String]) -> Option<&'a toml::Value> {
    let mut current = value;
    for key in path {
        current = current.get(key)?;
    }
    Some(current)
}

fn toml_to_json(value: &toml::Value) -> Option<Value> {
    Some(match value {
        toml::Value::String(value) => Value::String(value.clone()),
        toml::Value::Integer(value) => Value::Number((*value).into()),
        toml::Value::Float(value) => serde_json::Number::from_f64(*value).map(Value::Number)?,
        toml::Value::Boolean(value) => Value::Bool(*value),
        toml::Value::Datetime(value) => Value::String(value.to_string()),
        toml::Value::Array(items) => Value::Array(
            items
                .iter()
                .map(toml_to_json)
                .collect::<Option<Vec<Value>>>()?,
        ),
        toml::Value::Table(table) => Value::Object(
            table
                .iter()
                .map(|(key, value)| Some((key.clone(), toml_to_json(value)?)))
                .collect::<Option<Map<String, Value>>>()?,
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "phi-local-apps-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn json_edits_keep_other_keys_and_comments() {
        let dir = temp("json");
        let path = dir.join("settings.json");
        std::fs::write(
            &path,
            "{\n  // 用户自己的键\n  \"keep\": 1,\n  \"nested\": { \"a\": true }\n}\n",
        )
        .unwrap();
        apply(
            &path,
            Format::Json,
            &[
                Op::Set {
                    path: vec!["nested".into(), "b".into()],
                    value: Value::String("x".into()),
                },
                Op::Set {
                    path: vec!["added".into()],
                    value: Value::Number(2.into()),
                },
            ],
        )
        .unwrap();
        let source = std::fs::read_to_string(&path).unwrap();
        assert!(source.contains("// 用户自己的键"), "{source}");
        let value: Value = json5::from_str(&source).unwrap();
        assert_eq!(value["keep"], 1);
        assert_eq!(value["nested"]["a"], true);
        assert_eq!(value["nested"]["b"], "x");
        assert_eq!(value["added"], 2);
    }

    #[test]
    fn json_array_upsert_and_prefix_removal() {
        let dir = temp("array");
        let path = dir.join("settings.json");
        std::fs::write(
            &path,
            r#"{"customModels":[{"id":"custom:mine/1","model":"a"}]}"#,
        )
        .unwrap();
        apply(
            &path,
            Format::Json,
            &[Op::UpsertArrayItem {
                path: vec!["customModels".into()],
                field: "id".into(),
                value: serde_json::json!({"id":"phi-route-x/1","model":"a"}),
            }],
        )
        .unwrap();
        apply(
            &path,
            Format::Json,
            &[Op::UpsertArrayItem {
                path: vec!["customModels".into()],
                field: "id".into(),
                value: serde_json::json!({"id":"phi-route-x/1","model":"b"}),
            }],
        )
        .unwrap();
        let value = read_value(&path, Format::Json, &["customModels".into()])
            .unwrap()
            .unwrap();
        assert_eq!(value.as_array().unwrap().len(), 2);
        assert_eq!(value[1]["model"], "b");

        apply(
            &path,
            Format::Json,
            &[Op::RemoveArrayItems {
                path: vec!["customModels".into()],
                field_prefix: "phi-route-x/".into(),
            }],
        )
        .unwrap();
        let value = read_value(&path, Format::Json, &["customModels".into()])
            .unwrap()
            .unwrap();
        assert_eq!(value.as_array().unwrap().len(), 1);
        assert_eq!(value[0]["id"], "custom:mine/1");
    }

    #[test]
    fn toml_tables_are_added_in_place_and_removed_by_prefix() {
        let dir = temp("toml");
        let path = dir.join("config.toml");
        std::fs::write(
            &path,
            "# 用户注释\ndefault_model = \"mine\"\n\n[providers.mine]\ntype = \"kimi\"\n",
        )
        .unwrap();
        apply(
            &path,
            Format::Toml,
            &[
                Op::SetTable {
                    table: vec!["providers".into(), "phi-route-kimi".into()],
                    entries: vec![
                        ("type".into(), Value::String("kimi".into())),
                        (
                            "base_url".into(),
                            Value::String("http://127.0.0.1:1/kimi/v1".into()),
                        ),
                    ],
                },
                Op::SetTable {
                    table: vec!["models".into(), "phi-route-kimi/glm-5".into()],
                    entries: vec![
                        ("provider".into(), Value::String("phi-route-kimi".into())),
                        ("model".into(), Value::String("glm-5".into())),
                    ],
                },
                Op::Set {
                    path: vec!["default_model".into()],
                    value: Value::String("phi-route-kimi/glm-5".into()),
                },
            ],
        )
        .unwrap();
        let source = std::fs::read_to_string(&path).unwrap();
        assert!(source.contains("# 用户注释"), "{source}");
        assert!(source.contains("[providers.mine]"), "{source}");
        let value: toml::Value = toml::from_str(&source).unwrap();
        assert_eq!(
            value["default_model"].as_str(),
            Some("phi-route-kimi/glm-5")
        );
        assert_eq!(
            value["providers"]["phi-route-kimi"]["base_url"].as_str(),
            Some("http://127.0.0.1:1/kimi/v1")
        );

        apply(
            &path,
            Format::Toml,
            &[
                Op::DeleteTablesUnder {
                    root: "models".into(),
                    prefix: "phi-route-kimi/".into(),
                },
                Op::DeleteTable {
                    table: vec!["providers".into(), "phi-route-kimi".into()],
                },
            ],
        )
        .unwrap();
        let source = std::fs::read_to_string(&path).unwrap();
        let value: toml::Value = toml::from_str(&source).unwrap();
        assert!(
            value["providers"].get("phi-route-kimi").is_none(),
            "{source}"
        );
        assert!(
            value
                .get("models")
                .is_none_or(|models| models.get("phi-route-kimi/glm-5").is_none()),
            "{source}"
        );
        assert_eq!(value["providers"]["mine"]["type"].as_str(), Some("kimi"));
    }

    #[test]
    fn read_value_returns_none_for_missing_files_and_keys() {
        let dir = temp("read");
        assert_eq!(
            read_value(&dir.join("none.json"), Format::Json, &["a".into()]).unwrap(),
            None
        );
        let path = dir.join("some.json");
        std::fs::write(&path, "{}").unwrap();
        assert_eq!(
            read_value(&path, Format::Json, &["a".into()]).unwrap(),
            None
        );
    }
}
