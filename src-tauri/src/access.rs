//! User-issued gateway identities. Only a verifier of a random token is stored;
//! the token is returned once and cannot be recovered from database exports.
use crate::{database::lock_conn, error::AppError, Database};
use hmac::{Hmac, Mac};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Binding {
    pub id: String,
    pub name: String,
    pub agent: String,
    pub tool: String,
    pub project_id: Option<String>,
    pub allowed_groups: Vec<String>,
    pub enabled: bool,
}
impl Binding {
    pub fn session_namespace(&self) -> String {
        // Scope edits invalidate cached intent and affinity even when the binding ID stays stable.
        let scope = serde_json::to_vec(self).expect("binding serialization");
        format!("{}:{:x}", self.id, Sha256::digest(scope))
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssuedBinding {
    pub binding: Binding,
    pub token: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub display_path: String,
}
fn error(e: impl std::fmt::Display) -> AppError {
    AppError::Config(format!("Access: {e}"))
}
pub(crate) fn create_tables(conn: &rusqlite::Connection) -> Result<(), AppError> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,display_path TEXT NOT NULL,created_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS ingress_bindings(id TEXT PRIMARY KEY,token_verifier TEXT NOT NULL,payload TEXT NOT NULL);").map_err(error)
}
fn verifier(token: &str) -> String {
    format!("{:x}", Sha256::digest(token.as_bytes()))
}
fn equal(a: &str, b: &str) -> bool {
    let mut mac = Hmac::<Sha256>::new_from_slice(a.as_bytes()).expect("HMAC key");
    mac.update(b"phi-binding-v1");
    let tag = mac.finalize().into_bytes();
    let mut mac = Hmac::<Sha256>::new_from_slice(b.as_bytes()).expect("HMAC key");
    mac.update(b"phi-binding-v1");
    mac.verify_slice(&tag).is_ok()
}
/// 外部接入：一个令牌按入口协议使用全部协议，不绑定某个应用。
///
/// 应用自己的接入（Claude Code、Codex 等）由 PHI 写进客户端配置，令牌随进程重建，
/// 不需要用户填写。这个工具类型只服务 PHI 不写配置的客户端（Cursor、Cline、脚本）。
pub const EXTERNAL_TOOL: &str = "external";
/// 外部接入可用的协议身份。入口路径决定这次请求用哪个身份参与路由：
/// Chat → opencode、Responses → codex、Messages → claude、Gemini → gemini、
/// System One → typesafe。
pub const EXTERNAL_APPS: [&str; 5] = [
    "claude",
    "codex",
    "gemini",
    "opencode",
    crate::gateway::typesafe::APP_ID,
];
pub fn is_external(tool: &str) -> bool {
    tool == EXTERNAL_TOOL
}
pub fn tool_app(tool: &str) -> Option<&'static str> {
    if is_external(tool) {
        return Some(EXTERNAL_TOOL);
    }
    if crate::gateway::typesafe::is_app(tool) {
        return Some(crate::gateway::typesafe::APP_ID);
    }
    crate::gateway::apps::spec_by_id(tool).map(|spec| spec.id)
}
impl Database {
    pub fn access_projects(&self) -> Result<Vec<Project>, AppError> {
        let conn = lock_conn!(self.conn);
        let mut stmt = conn
            .prepare("SELECT id,display_path FROM projects ORDER BY display_path,id")
            .map_err(error)?;
        let rows = stmt
            .query_map([], |r| {
                Ok(Project {
                    id: r.get(0)?,
                    display_path: r.get(1)?,
                })
            })
            .map_err(error)?;
        rows.collect::<Result<_, _>>().map_err(error)
    }
    pub fn save_access_project(&self, path: String) -> Result<Project, AppError> {
        let path = path.trim().to_string();
        if let Some(existing) = self
            .access_projects()?
            .into_iter()
            .find(|p| p.display_path == path)
        {
            return Ok(existing);
        }
        if path.trim().is_empty() || path.len() > 4096 {
            return Err(error("invalid project path"));
        }
        let p = Project {
            id: uuid::Uuid::new_v4().to_string(),
            display_path: path,
        };
        lock_conn!(self.conn)
            .execute(
                "INSERT INTO projects(id,display_path,created_at) VALUES(?1,?2,?3)",
                params![p.id, p.display_path, chrono::Utc::now().timestamp_millis()],
            )
            .map_err(error)?;
        Ok(p)
    }
    pub fn access_bindings(&self) -> Result<Vec<Binding>, AppError> {
        let conn = lock_conn!(self.conn);
        let mut stmt = conn
            .prepare("SELECT payload FROM ingress_bindings ORDER BY id")
            .map_err(error)?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(error)?;
        rows.map(|r| serde_json::from_str(&r.map_err(error)?).map_err(error))
            .collect()
    }
    fn validate_binding(&self, b: &Binding) -> Result<(), AppError> {
        if b.name.trim().is_empty()
            || b.name.len() > 200
            || b.agent.trim().is_empty()
            || b.agent.len() > if is_external(&b.tool) { 200 } else { 100 }
            || tool_app(&b.tool).is_none()
            || b.allowed_groups.len() > 100
        {
            return Err(error("invalid binding"));
        }
        if let Some(project) = &b.project_id {
            if !self.access_projects()?.iter().any(|p| p.id == *project) {
                return Err(error("unknown project"));
            }
        }
        let catalog = self.gateway_catalog()?;
        for id in &b.allowed_groups {
            // 外部接入按入口协议切换身份，所以只要组对任一外部协议身份可用即可。
            let usable = catalog.groups.iter().any(|g| {
                g.id == *id
                    && if is_external(&b.tool) {
                        g.app_ids
                            .iter()
                            .any(|app| EXTERNAL_APPS.contains(&app.as_str()))
                    } else {
                        g.app_ids.contains(&b.tool)
                    }
            });
            if !usable {
                return Err(error("group is unavailable to this tool"));
            }
        }
        Ok(())
    }
    pub fn issue_access_binding(&self, mut b: Binding) -> Result<IssuedBinding, AppError> {
        self.validate_binding(&b)?;
        let conn = lock_conn!(self.conn);
        if b.id.is_empty() {
            b.id = uuid::Uuid::new_v4().to_string();
        } else if !conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM ingress_bindings WHERE id=?1)",
                [&b.id],
                |r| r.get::<_, bool>(0),
            )
            .map_err(error)?
        {
            return Err(error("unknown binding"));
        }
        let random = format!(
            "{}{}{}",
            uuid::Uuid::new_v4(),
            uuid::Uuid::new_v4(),
            uuid::Uuid::new_v4()
        );
        let token = format!(
            "phi-binding-v1:{}:{:x}",
            b.id,
            Sha256::digest(random.as_bytes())
        );
        conn.execute("INSERT INTO ingress_bindings(id,token_verifier,payload) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET token_verifier=excluded.token_verifier,payload=excluded.payload",params![b.id,verifier(&token),serde_json::to_string(&b).map_err(error)?]).map_err(error)?;
        Ok(IssuedBinding { binding: b, token })
    }
    pub fn delete_access_binding(&self, id: &str) -> Result<(), AppError> {
        // Keep historical ledger records; removing the verifier revokes future requests.
        lock_conn!(self.conn)
            .execute("DELETE FROM ingress_bindings WHERE id=?1", [id])
            .map_err(error)?;
        Ok(())
    }
    pub fn set_access_binding_enabled(&self, id: &str, enabled: bool) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        let payload: String = conn
            .query_row(
                "SELECT payload FROM ingress_bindings WHERE id=?1",
                [id],
                |r| r.get(0),
            )
            .map_err(error)?;
        let mut b: Binding = serde_json::from_str(&payload).map_err(error)?;
        b.enabled = enabled;
        conn.execute(
            "UPDATE ingress_bindings SET payload=?2 WHERE id=?1",
            params![id, serde_json::to_string(&b).map_err(error)?],
        )
        .map_err(error)?;
        Ok(())
    }
    pub fn authenticate_binding(&self, token: &str) -> Result<Option<Binding>, AppError> {
        let Some(rest) = token.strip_prefix("phi-binding-v1:") else {
            return Ok(None);
        };
        let Some((id, secret)) = rest.split_once(':') else {
            return Ok(None);
        };
        if secret.len() != 64 || id.len() != 36 {
            return Ok(None);
        }
        let conn = lock_conn!(self.conn);
        let row: Option<(String, String)> = conn
            .query_row(
                "SELECT token_verifier,payload FROM ingress_bindings WHERE id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(error)?;
        let Some((expected, payload)) = row else {
            return Ok(None);
        };
        if !equal(&expected, &verifier(token)) {
            return Ok(None);
        }
        let binding: Binding = serde_json::from_str(&payload).map_err(error)?;
        Ok(binding.enabled.then_some(binding))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn binding() -> Binding {
        Binding {
            id: "".into(),
            name: "Cline project".into(),
            agent: "cline".into(),
            tool: "codex".into(),
            project_id: None,
            allowed_groups: vec![],
            enabled: true,
        }
    }
    #[test]
    fn tokens_are_not_persisted_and_rotation_and_revocation_take_effect() {
        let db = Database::memory().unwrap();
        let first = db.issue_access_binding(binding()).unwrap();
        assert_eq!(
            db.authenticate_binding(&first.token)
                .unwrap()
                .unwrap()
                .agent,
            "cline"
        );
        assert!(!db.export_sql_string().unwrap().contains(&first.token));
        let second = db.issue_access_binding(first.binding).unwrap();
        assert!(db.authenticate_binding(&first.token).unwrap().is_none());
        assert!(db.authenticate_binding(&second.token).unwrap().is_some());
        db.set_access_binding_enabled(&second.binding.id, false)
            .unwrap();
        assert!(db.authenticate_binding(&second.token).unwrap().is_none());
    }
    #[test]
    fn deleting_a_binding_revokes_only_its_token_and_prevents_reissue() {
        let db = Database::memory().unwrap();
        let removed = db.issue_access_binding(binding()).unwrap();
        let kept = db.issue_access_binding(binding()).unwrap();
        db.delete_access_binding(&removed.binding.id).unwrap();
        assert!(db.authenticate_binding(&removed.token).unwrap().is_none());
        assert!(db.authenticate_binding(&kept.token).unwrap().is_some());
        let remaining = db.access_bindings().unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, kept.binding.id);
        assert!(db.issue_access_binding(removed.binding.clone()).is_err());
        // Repeated deletion is harmless, including after another window deleted it.
        db.delete_access_binding(&removed.binding.id).unwrap();
    }

    #[test]
    fn an_external_binding_may_scope_any_protocol_group() {
        let db = Database::memory().unwrap();
        let mut catalog = db
            .create_gateway_supplier(crate::gateway::SupplierUpsert {
                name: Some("Fixture Chat".into()),
                endpoint: Some(crate::gateway::Endpoint {
                    protocol: "openai_chat".into(),
                    base_url: "http://127.0.0.1:9".into(),
                }),
                models: Some(vec!["fixture-model".into()]),
                api_key: Some("fixture-key".into()),
                auth_field: Some("OPENAI_API_KEY".into()),
                ..Default::default()
            })
            .unwrap();
        let supplier = catalog.suppliers.last().unwrap().id.clone();
        catalog.groups.push(
            serde_json::from_value(serde_json::json!({
                "id": "external-chat",
                "name": "External Chat",
                "appIds": ["opencode"],
                "members": [{"id": "member", "supplierId": supplier, "model": "fixture-model"}]
            }))
            .unwrap(),
        );
        db.save_gateway_catalog(catalog).unwrap();
        let mut catalog = db.gateway_catalog().unwrap();
        catalog = db
            .create_gateway_supplier(crate::gateway::SupplierUpsert {
                name: Some("Fixture Decision".into()),
                endpoint: Some(crate::gateway::Endpoint {
                    protocol: "systemone".into(),
                    base_url: "http://127.0.0.1:9".into(),
                }),
                models: Some(vec!["jev-latest".into()]),
                api_key: Some("fixture-key".into()),
                auth_field: Some("TYPESAFE_API_KEY".into()),
                ..Default::default()
            })
            .unwrap();
        let decision = catalog.suppliers.last().unwrap().id.clone();
        catalog.groups.push(
            serde_json::from_value(serde_json::json!({
                "id": "external-decision",
                "name": "External Decision",
                "appIds": ["typesafe"],
                "members": [{"id": "member", "supplierId": decision, "model": "jev-latest"}]
            }))
            .unwrap(),
        );
        db.save_gateway_catalog(catalog).unwrap();
        // 外部接入能用聊天组，也能用决策组：它跟的是入口协议。
        for group in ["external-chat", "external-decision"] {
            assert!(
                db.issue_access_binding(Binding {
                    tool: crate::access::EXTERNAL_TOOL.into(),
                    allowed_groups: vec![group.into()],
                    ..binding()
                })
                .is_ok(),
                "{group}"
            );
        }
        // 单一应用的令牌仍是一个命名空间：System One 的牌碰不到聊天组。
        assert!(db
            .issue_access_binding(Binding {
                tool: "typesafe".into(),
                allowed_groups: vec!["external-chat".into()],
                ..binding()
            })
            .is_err());
    }

    #[test]
    fn unregistered_project_and_group_scopes_are_rejected() {
        let db = Database::memory().unwrap();
        assert!(db
            .issue_access_binding(Binding {
                project_id: Some("forged".into()),
                ..binding()
            })
            .is_err());
        assert!(db
            .issue_access_binding(Binding {
                allowed_groups: vec!["no-group".into()],
                ..binding()
            })
            .is_err());
        let p = db.save_access_project("/work/example".into()).unwrap();
        let issued = db
            .issue_access_binding(Binding {
                project_id: Some(p.id.clone()),
                ..binding()
            })
            .unwrap();
        assert_eq!(
            db.authenticate_binding(&issued.token)
                .unwrap()
                .unwrap()
                .project_id,
            Some(p.id)
        );
    }
}
