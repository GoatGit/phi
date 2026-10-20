//! System One 的路由专用身份。
//!
//! System One 是 TypeSafe 的 typed decision 协议，不是聊天补全协议。它没有客户端
//! 原生配置可写，也不能和 Chat/Anthropic/Gemini 成员混在同一个路由组里，因此这里
//! 只登记一个虚拟应用身份：组里全部是 System One 供应商时，目录会推导出
//! `app_ids = ["typesafe"]`，请求经 `/typesafe/v1/systemone` 原样转发。
//!
//! 它不进入侧栏应用管理，也不参与聊天协议的 IR 互转；这与 `local_apps` 的
//! 「只接路由、不写原生配置」不同，连原生配置都没有。

use crate::gateway::routing::RouteGroup;
use crate::gateway::Catalog;

pub const APP_ID: &str = "typesafe";
pub const INGRESS: &str = "/typesafe";
pub const PROTOCOL: &str = "systemone";

pub fn accepts_protocol(protocol: &str) -> bool {
    protocol == PROTOCOL
}

pub fn is_app(id: &str) -> bool {
    id == APP_ID
}

/// 选出能服务这个模型名的 System One 组。
///
/// `group/<组名>` 是显式的组别名；其余模型名按组内供应商声明的模型精确匹配。
/// 只考虑目录里已经推导出 `typesafe` 应用身份的组，因此混有聊天供应商的组
/// 永远不会被选中。
pub(crate) fn group_for_model<'a>(catalog: &'a Catalog, model: &str) -> Option<&'a RouteGroup> {
    if let Some((group, _)) = super::routing::resolve_group_alias(catalog, APP_ID, model) {
        return Some(group);
    }
    catalog.groups.iter().find(|group| {
        group.enabled
            && group.app_ids.iter().any(|app| app == APP_ID)
            && group_has_model(catalog, group, model, 0)
    })
}

fn group_has_model(catalog: &Catalog, group: &RouteGroup, model: &str, depth: usize) -> bool {
    if depth > 8 {
        return false;
    }
    group
        .members
        .iter()
        .filter(|member| member.enabled)
        .any(|member| {
            if let Some(supplier_id) = &member.supplier_id {
                return catalog
                    .suppliers
                    .iter()
                    .find(|supplier| &supplier.id == supplier_id)
                    .is_some_and(|supplier| supplier.models.iter().any(|name| name == model));
            }
            if let Some(child_id) = &member.group_id {
                return catalog
                    .groups
                    .iter()
                    .find(|child| &child.id == child_id && child.enabled)
                    .is_some_and(|child| group_has_model(catalog, child, model, depth + 1));
            }
            false
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn catalog(groups: serde_json::Value, suppliers: serde_json::Value) -> Catalog {
        serde_json::from_value(json!({
            "revision": 1,
            "suppliers": suppliers,
            "policies": [],
            "groups": groups
        }))
        .expect("catalog")
    }

    #[test]
    fn finds_a_system_one_group_by_model_and_group_alias() {
        let catalog = catalog(
            json!([{
                "id":"system-one",
                "name":"System One",
                "enabled":true,
                "appIds":["typesafe"],
                "members":[{"id":"m1","supplierId":"s1","groupId":null,"model":"jev-latest","weight":1,"enabled":true}]
            }]),
            json!([{
                "id":"s1",
                "name":"TypeSafe",
                "endpoint":{"protocol":"systemone","baseUrl":"https://api.typesafe.ai"},
                "models":["jev-latest"]
            }]),
        );
        assert_eq!(
            group_for_model(&catalog, "jev-latest").map(|group| group.id.as_str()),
            Some("system-one")
        );
        assert_eq!(
            group_for_model(&catalog, "group/system-one").map(|group| group.id.as_str()),
            Some("system-one")
        );
        assert!(group_for_model(&catalog, "missing").is_none());
    }

    #[test]
    fn ignores_groups_without_the_typesafe_app_identity() {
        let catalog = catalog(
            json!([{
                "id":"mixed",
                "name":"Mixed",
                "enabled":true,
                "appIds":[],
                "members":[{"id":"m1","supplierId":"s1","groupId":null,"model":"jev-latest","weight":1,"enabled":true}]
            }]),
            json!([{
                "id":"s1",
                "name":"TypeSafe",
                "endpoint":{"protocol":"systemone","baseUrl":"https://api.typesafe.ai"},
                "models":["jev-latest"]
            }]),
        );
        assert!(group_for_model(&catalog, "jev-latest").is_none());
    }
}
