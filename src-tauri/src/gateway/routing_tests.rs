use super::*;
use serde_json::json;

fn catalog() -> Catalog {
    serde_json::from_value(json!({
        "revision": 7,
        "suppliers": [
            {"id":"a","name":"A","endpoint":{"protocol":"anthropic","baseUrl":"https://a.invalid"},"models":["m","n"]},
            {"id":"b","name":"B","endpoint":{"protocol":"anthropic","baseUrl":"https://b.invalid"},"models":["m"]}
        ],
        "policies": [],
        "groups": [{"id":"root","name":"Root","appIds":["claude","codex"],"members":[
            {"id":"one","supplierId":"a","model":"m","weight":3},
            {"id":"two","supplierId":"b","model":"m","weight":1}
        ]}]
    })).unwrap()
}
fn policy(c: &Catalog) -> RoutePolicy {
    matched_policy(c, "claude", "group/root").unwrap().unwrap()
}
fn primary(r: &Runtime, c: &Catalog, advance: bool) -> String {
    r.plan(c, &policy(c), None, vec![], advance)
        .unwrap()
        .candidates
        .into_iter()
        .find(|c| c.available)
        .unwrap()
        .supplier_id
}
fn trace(c: &Catalog, decision: RouteDecision, outcome: &str) -> RequestTrace {
    let selected = decision.candidates.iter().find(|c| c.available).unwrap();
    RequestTrace {
        id: uuid::Uuid::new_v4().to_string(),
        created_at: now(),
        app_id: "claude".into(),
        request_model: "group/root".into(),
        catalog_revision: c.revision,
        policy: policy(c),
        events: vec![TraceEvent {
            supplier_id: selected.supplier_id.clone(),
            supplier_name: selected.supplier_name.clone(),
            model: selected.model.clone(),
            outcome: "upstream_accepted".into(),
            group_path: selected.group_path.clone(),
            started_at: now(),
            latency_ms: 10,
        }],
        outcome: outcome.into(),
        latency_ms: 20,
        input_tokens: Some(10),
        output_tokens: Some(4),
        estimated_cost: None,
        decision: Some(decision),
        persist: true,
    }
}
#[test]
fn validation_rejects_cycles_scope_models_and_invalid_manual_target() {
    let c = catalog();
    assert!(validate(&c).is_ok());
    for mutation in 0..6 {
        let mut c = c.clone();
        match mutation {
            0 => {
                c.groups[0].members[0].supplier_id = None;
                c.groups[0].members[0].group_id = Some("root".into());
                c.groups[0].members[0].model.clear();
            }
            1 => c.groups[0].app_ids.push("gemini".into()),
            2 => c.groups[0].members[0].model = "missing".into(),
            3 => {
                c.groups[0].strategy = Strategy::Manual;
                c.groups[0].manual_member_id = Some("absent".into());
            }
            4 => c.groups[0].members[0].weight = 0,
            _ => c.groups[0].id = "unsafe:alias".into(),
        }
        assert!(validate(&c).is_err(), "mutation {mutation}");
    }
    assert!(matched_policy(&c, "gemini", "group/root").is_err());
    assert!(matched_policy(&c, "claude", "group/missing").is_err());
    let mut c = c;
    c.groups[0].enabled = false;
    assert!(matched_policy(&c, "claude", "group/root").is_err());
}
#[test]
fn round_robin_and_weighted_are_deterministic_and_preview_is_read_only() {
    let mut c = catalog();
    let r = Runtime::default();
    c.groups[0].strategy = Strategy::RoundRobin;
    for _ in 0..5 {
        assert_eq!(primary(&r, &c, false), "a");
    }
    assert_eq!(
        (
            primary(&r, &c, true),
            primary(&r, &c, true),
            primary(&r, &c, true)
        ),
        ("a".into(), "b".into(), "a".into())
    );
    c.groups[0].strategy = Strategy::Weighted;
    let r = Runtime::default();
    for _ in 0..5 {
        assert_eq!(primary(&r, &c, false), "a");
    }
    let sequence: Vec<_> = (0..40).map(|_| primary(&r, &c, true)).collect();
    assert_eq!(sequence.iter().filter(|s| s.as_str() == "a").count(), 30);
    assert_eq!(sequence.iter().filter(|s| s.as_str() == "b").count(), 10);
}
#[test]
fn health_manual_and_least_used_use_actual_outlet_state() {
    let mut c = catalog();
    let r = Runtime::default();
    c.groups[0].strategy = Strategy::LeastUsed;
    r.begin("a", "m");
    assert_eq!(primary(&r, &c, true), "b");
    r.attempt_finished("a", "m", Some("rate_limit"), 5);
    let d = r.plan(&c, &policy(&c), None, vec![], false).unwrap();
    let a = d.candidates.iter().find(|x| x.supplier_id == "a").unwrap();
    assert!(!a.available);
    assert_eq!(a.reason, "cooldown");
    c.groups[0].strategy = Strategy::Manual;
    c.groups[0].manual_member_id = Some("one".into());
    assert!(r
        .plan(&c, &policy(&c), None, vec![], true)
        .unwrap()
        .candidates
        .iter()
        .all(|x| !x.available));
    let s = r.statuses();
    assert_eq!(s[0].active, 0);
    assert_eq!(s[0].failures, 1);
}
#[test]
fn nesting_preserves_limits_paths_and_same_supplier_models() {
    let mut c = catalog();
    let mut child = c.groups[0].clone();
    child.id = "child".into();
    child.name = "Child".into();
    child.max_attempts = 1;
    c.groups[0].members = vec![
        GroupMember {
            id: "nested".into(),
            supplier_id: None,
            group_id: Some("child".into()),
            model: String::new(),
            enabled: true,
            weight: 1,
        },
        GroupMember {
            id: "other-model".into(),
            supplier_id: Some("a".into()),
            group_id: None,
            model: "n".into(),
            enabled: true,
            weight: 1,
        },
    ];
    c.groups.push(child);
    validate(&c).unwrap();
    let r = Runtime::default();
    let d = r.plan(&c, &policy(&c), None, vec![], true).unwrap();
    let available: Vec<_> = d.candidates.iter().filter(|x| x.available).collect();
    assert_eq!(available.len(), 2);
    assert_eq!(available[0].group_path, vec!["root", "child"]);
    assert_eq!(available[0].member_path, vec!["nested", "one"]);
    assert_eq!(available[1].model, "n");
    assert!(d
        .candidates
        .iter()
        .any(|x| x.supplier_id == "b" && x.reason == "attempt_limit"));
    c.groups[0].failover = false;
    assert_eq!(
        r.plan(&c, &policy(&c), None, vec![], false)
            .unwrap()
            .candidates
            .iter()
            .filter(|x| x.available)
            .count(),
        1
    );
}
#[test]
fn duplicate_candidates_do_not_consume_attempt_budget() {
    let mut c = catalog();
    let mut duplicate = c.groups[0].members[0].clone();
    duplicate.id = "duplicate".into();
    c.groups[0].members.insert(1, duplicate);
    c.groups[0].max_attempts = 2;
    let d = Runtime::default()
        .plan(&c, &policy(&c), None, vec![], false)
        .unwrap();
    assert_eq!(d.candidates.iter().filter(|x| x.available).count(), 2);
    assert_eq!(d.candidates[1].reason, "duplicate");
}
#[test]
fn affinity_is_app_revision_and_failure_scoped_and_intent_wins() {
    let mut c = catalog();
    c.groups[0].strategy = Strategy::RoundRobin;
    c.groups[0].session_affinity = true;
    let r = Runtime::default();
    let session = session_hash("claude", "s");
    let first = r
        .plan(&c, &policy(&c), Some(session.clone()), vec![], true)
        .unwrap();
    r.begin("a", "m");
    r.complete(&trace(&c, first, "completed"));
    let pinned = r
        .plan(&c, &policy(&c), Some(session.clone()), vec![], false)
        .unwrap();
    assert_eq!(pinned.candidates[0].supplier_id, "a");
    assert_eq!(pinned.affinity, "hit");
    let separate = r
        .plan(
            &c,
            &policy(&c),
            Some(session_hash("codex", "s")),
            vec![],
            false,
        )
        .unwrap();
    assert_eq!(separate.candidates[0].supplier_id, "b");
    c.groups[0].rules.push(IntentRule {
        id: "coding".into(),
        name: "Coding".into(),
        description: "coding".into(),
        member_id: "two".into(),
        enabled: true,
    });
    let intent = IntentDecision {
        group_id: "root".into(),
        rule_id: Some("coding".into()),
        outcome: "matched".into(),
        ..Default::default()
    };
    let chosen = r
        .plan(&c, &policy(&c), Some(session.clone()), vec![intent], false)
        .unwrap();
    assert_eq!(chosen.candidates[0].supplier_id, "b");
    assert_eq!(chosen.candidates[0].reason, "intent");
    c.revision += 1;
    let fresh = r
        .plan(&c, &policy(&c), Some(session), vec![], false)
        .unwrap();
    assert_ne!(fresh.affinity, "hit");
    r.begin("a", "m");
    r.attempt_finished("a", "m", Some("authentication"), 1);
    assert!(r.inner.lock().unwrap().affinity.is_empty());
}
#[test]
fn completion_distinguishes_cancellation_and_unknown_usage() {
    let c = catalog();
    let r = Runtime::default();
    let d = r.plan(&c, &policy(&c), None, vec![], true).unwrap();
    let mut t = trace(&c, d, "interrupted");
    t.events[0].outcome = "pending".into();
    t.input_tokens = None;
    t.output_tokens = None;
    r.begin("a", "m");
    r.observe(&RequestTrace {
        outcome: "pending".into(),
        ..t.clone()
    });
    r.complete(&t);
    assert!(r.active().is_empty());
    let s = r.statuses().remove(0);
    assert_eq!(s.active, 0);
    assert_eq!(s.failures, 1);
    assert_eq!(s.unknown_usage, 1);
    assert_eq!(s.recent_tokens, 0.);
}
#[test]
fn aliases_are_scoped_and_catalog_remains_backward_compatible() {
    let c = catalog();
    assert_eq!(published_aliases(&c, "claude")[0].0, "group/root");
    assert!(published_aliases(&c, "gemini").is_empty());
    let legacy: Catalog =
        serde_json::from_value(json!({"revision":0,"suppliers":[],"policies":[]})).unwrap();
    assert!(legacy.groups.is_empty());
}

#[test]
fn application_connection_replaces_model_matching_and_cached_group_aliases() {
    let mut c = catalog();
    let mut other = c.groups[0].clone();
    other.id = "other".into();
    other.name = "Other".into();
    c.groups.push(other);
    let mut legacy = group_policy(&c, "claude", "other", "old-model").unwrap();
    legacy.id = "old-rule".into();
    let mut connection = group_policy(&c, "claude", "root", "").unwrap();
    connection.id = connection_id("claude");
    c.policies.extend([legacy, connection]);
    for model in ["old-model", "new-model", "group/other", "group/missing"] {
        let p = matched_policy(&c, "claude", model).unwrap().unwrap();
        assert_eq!(p.id, "connection/claude");
        assert_eq!(p.group_id.as_deref(), Some("root"));
        assert!(p.match_model.is_empty());
    }
    assert_eq!(
        published_aliases(&c, "claude"),
        vec![("group/root".into(), "Root".into())]
    );
    assert_eq!(
        matched_unbound_policy(&c, "claude", "group/other")
            .unwrap()
            .unwrap()
            .group_id
            .as_deref(),
        Some("other")
    );
    assert_eq!(published_unbound_aliases(&c, "claude").len(), 3);
    // Other applications keep their own connection scope.
    assert_eq!(
        matched_policy(&c, "codex", "group/other")
            .unwrap()
            .unwrap()
            .group_id
            .as_deref(),
        Some("other")
    );
    c.groups[0].enabled = false;
    assert!(matched_policy(&c, "claude", "old-model").is_err());
    assert!(matched_policy(&c, "claude", "group/other").is_err());
    assert!(published_aliases(&c, "claude").is_empty());
    c.policies[1].enabled = false;
    c.policies[1].group_id = None;
    assert!(matched_policy(&c, "claude", "group/other").is_err());
}

#[test]
fn group_selection_persists_checks_revision_and_restores_failed_connections() {
    let db = Database::memory().unwrap();
    let mut c = db
        .create_gateway_supplier(SupplierUpsert {
            name: Some("A".into()),
            endpoint: Some(Endpoint {
                protocol: "anthropic".into(),
                base_url: "https://a.invalid".into(),
            }),
            models: Some(vec!["m".into(), "n".into()]),
            api_key: Some("secret".into()),
            auth_field: Some("ANTHROPIC_API_KEY".into()),
            ..Default::default()
        })
        .unwrap();
    let mut root = catalog().groups.remove(0);
    root.members.truncate(1);
    root.members[0].supplier_id = Some(c.suppliers[0].id.clone());
    let mut other = root.clone();
    other.id = "other".into();
    other.members[0].model = "n".into();
    c.groups.extend([root, other]);
    let mut legacy = group_policy(&c, "claude", "other", "").unwrap();
    legacy.id = "legacy".into(); // Same catch-all and priority as the new connection.
    c.policies.push(legacy);
    let saved = db.save_gateway_catalog(c).unwrap();
    assert!(db
        .select_gateway_group("claude", "root", Some(saved.revision - 1))
        .is_err());
    assert!(db
        .select_gateway_group("gemini", "root", Some(saved.revision))
        .is_err());
    assert!(db
        .select_gateway_group("claude", "missing", Some(saved.revision))
        .is_err());
    assert_eq!(db.gateway_catalog().unwrap().revision, saved.revision);
    let previous = db
        .select_gateway_group("claude", "root", Some(saved.revision))
        .unwrap();
    assert!(previous.is_none());
    let selected = db.gateway_catalog().unwrap();
    assert_eq!(
        app_connection(&selected, "claude")
            .unwrap()
            .group_id
            .as_deref(),
        Some("root")
    );
    assert!(selected.policies.iter().any(|p| p.id == "legacy"));
    assert_eq!(
        db.resolve_gateway_route("claude", "unmatched")
            .unwrap()
            .unwrap()
            .policy
            .group_id
            .as_deref(),
        Some("root")
    );
    let entry = db.gateway_entry_provider("claude").unwrap().unwrap();
    // 投影进客户端配置的模型是首成员的真实模型（不再是 group/<id> 路由标记）
    assert_eq!(entry.settings_config["env"]["ANTHROPIC_MODEL"], "m");
    assert!(!entry.settings_config.to_string().contains("secret"));
    let previous = db
        .select_gateway_group("claude", "other", Some(selected.revision))
        .unwrap();
    db.restore_gateway_group_connection("claude", "other", previous)
        .unwrap();
    assert_eq!(
        app_connection(&db.gateway_catalog().unwrap(), "claude")
            .unwrap()
            .group_id
            .as_deref(),
        Some("root")
    );
    db.restore_gateway_group_connection("claude", "root", None)
        .unwrap();
    assert!(app_connection(&db.gateway_catalog().unwrap(), "claude").is_none());
    assert_eq!(
        db.resolve_gateway_route("claude", "unmatched")
            .unwrap()
            .unwrap()
            .policy
            .id,
        "legacy"
    );
}

#[tokio::test]
async fn materialization_preserves_multiple_models_and_pending_trace_without_logging() {
    let db = Database::memory().unwrap();
    let mut c = db
        .create_gateway_supplier(SupplierUpsert {
            revision: Some(0),
            name: Some("A".into()),
            endpoint: Some(Endpoint {
                protocol: "anthropic".into(),
                base_url: "https://a.invalid".into(),
            }),
            models: Some(vec!["m".into(), "n".into()]),
            api_key: Some("secret".into()),
            auth_field: Some("ANTHROPIC_API_KEY".into()),
        })
        .unwrap();
    let mut group = catalog().groups.remove(0);
    group.members[0].supplier_id = Some(c.suppliers[0].id.clone());
    group.members[1].supplier_id = Some(c.suppliers[0].id.clone());
    group.members[1].model = "n".into();
    c.groups.push(group);
    db.save_gateway_catalog(c).unwrap();
    let (route, t) = db
        .plan_gateway_request("claude", "group/root", None, &json!({}), false)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(route.providers.len(), 2);
    assert_ne!(route.providers[0].id, route.providers[1].id);
    assert_eq!(route.models.len(), 2);
    assert!(db.gateway_traces().unwrap().is_empty());
    assert_eq!(db.gateway_runtime.active().len(), 1);
    let mut t = t.lock().unwrap();
    t.outcome = "interrupted".into();
    db.gateway_runtime.complete(&t);
    assert!(db.gateway_runtime.active().is_empty());
}

#[test]
fn codex_gateway_entry_publishes_every_group_model() {
    let db = Database::memory().unwrap();
    let mut c = db
        .create_gateway_supplier(SupplierUpsert {
            revision: Some(0),
            name: Some("A".into()),
            endpoint: Some(Endpoint {
                protocol: "openai_responses".into(),
                base_url: "https://a.invalid/v1".into(),
            }),
            models: Some(vec!["m".into(), "n".into()]),
            api_key: Some("secret".into()),
            auth_field: Some("OPENAI_API_KEY".into()),
        })
        .unwrap();
    let supplier_a = c.suppliers[0].id.clone();
    let c = db
        .create_gateway_supplier(SupplierUpsert {
            revision: Some(c.revision),
            name: Some("B".into()),
            endpoint: Some(Endpoint {
                protocol: "anthropic".into(),
                base_url: "https://b.invalid".into(),
            }),
            models: Some(vec!["claude-x".into(), "claude-y".into()]),
            api_key: Some("secret-b".into()),
            auth_field: Some("ANTHROPIC_API_KEY".into()),
        })
        .unwrap();
    let supplier_b = c.suppliers[1].id.clone();
    let mut group = catalog().groups.remove(0);
    group.app_ids = vec!["codex".into()];
    group.members = serde_json::from_value(json!([
        {"id":"one","supplierId":supplier_a,"model":"m"},
        {"id":"two","supplierId":supplier_b,"model":"claude-x"}
    ]))
    .unwrap();
    let mut c = c;
    c.groups.push(group);
    let saved = db.save_gateway_catalog(c).unwrap();
    db.select_gateway_group("codex", "root", Some(saved.revision))
        .unwrap();

    let entry = db.gateway_entry_provider("codex").unwrap().unwrap();
    let models: Vec<&str> = entry.settings_config["modelCatalog"]["models"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|row| row["model"].as_str())
        .collect();
    // 组里混了 Anthropic 成员：Codex 的选择器也要能看到它，才能按模型名点名。
    assert_eq!(models, vec!["m", "n", "claude-x", "claude-y"]);
    assert!(entry.settings_config["config"]
        .as_str()
        .unwrap()
        .contains("model = \"m\""));
    assert!(!entry.settings_config.to_string().contains("secret"));
}

#[test]
fn request_model_pins_the_matching_group_member() {
    let mut c: Catalog = serde_json::from_value(json!({
        "revision": 7,
        "suppliers": [
            {"id":"gpt","name":"GPT","endpoint":{"protocol":"openai_responses","baseUrl":"https://g.invalid"},"models":["gpt-5"]},
            {"id":"claude","name":"Claude","endpoint":{"protocol":"anthropic","baseUrl":"https://c.invalid"},"models":["claude-x"]}
        ],
        "policies": [],
        "groups": [{"id":"root","name":"Root","appIds":["codex"],"members":[
            {"id":"g","supplierId":"gpt","model":"gpt-5"},
            {"id":"c","supplierId":"claude","model":"claude-x"}
        ]}]
    }))
    .unwrap();
    let mut connection = group_policy(&c, "codex", "root", "").unwrap();
    connection.id = connection_id("codex");
    c.policies.push(connection);

    let runtime = Runtime::default();
    for (requested, expected) in [
        ("claude-x", "claude-x"),
        ("CLAUDE-X", "claude-x"),
        ("gpt-5", "gpt-5"),
        ("unknown", "gpt-5"),
    ] {
        let policy = matched_policy(&c, "codex", requested).unwrap().unwrap();
        let decision = runtime
            .plan(&c, &policy, None, vec![], false)
            .expect("plan");
        assert_eq!(decision.candidates[0].model, expected, "{requested}");
    }

    // `group/<id>` 是组别名，不是成员模型，不能触发点名。
    let policy = matched_policy(&c, "codex", "group/root").unwrap().unwrap();
    assert!(policy.request_model.is_empty());
    assert_eq!(policy.match_model, "");
}

#[test]
fn duplicate_models_keep_the_group_order_when_pinned() {
    let mut c: Catalog = serde_json::from_value(json!({
        "revision": 7,
        "suppliers": [
            {"id":"a","name":"A","endpoint":{"protocol":"openai_responses","baseUrl":"https://a.invalid"},"models":["same"]},
            {"id":"b","name":"B","endpoint":{"protocol":"anthropic","baseUrl":"https://b.invalid"},"models":["same"]},
            {"id":"c","name":"C","endpoint":{"protocol":"openai_responses","baseUrl":"https://c.invalid"},"models":["other"]}
        ],
        "policies": [],
        "groups": [{"id":"root","name":"Root","appIds":["codex"],"members":[
            {"id":"a","supplierId":"a","model":"same"},
            {"id":"c","supplierId":"c","model":"other"},
            {"id":"b","supplierId":"b","model":"same"}
        ]}]
    }))
    .unwrap();
    let mut connection = group_policy(&c, "codex", "root", "").unwrap();
    connection.id = connection_id("codex");
    c.policies.push(connection);
    let policy = matched_policy(&c, "codex", "same").unwrap().unwrap();
    let decision = Runtime::default()
        .plan(&c, &policy, None, vec![], false)
        .unwrap();
    let order: Vec<_> = decision
        .candidates
        .iter()
        .map(|candidate| candidate.supplier_id.as_str())
        .collect();
    assert_eq!(order, vec!["a", "b", "c"]);
}

#[tokio::test]
async fn group_timeout_policy_defaults_validated_and_carried_into_routes() {
    // 旧目录 JSON 没有超时字段：反序列化落到默认值
    let c = catalog();
    assert_eq!(c.groups[0].streaming_first_byte_timeout, 60);
    assert_eq!(c.groups[0].streaming_idle_timeout, 180);
    assert_eq!(c.groups[0].non_streaming_timeout, 600);
    assert!(validate(&c).is_ok());

    for mutation in 0..4 {
        let mut c = c.clone();
        match mutation {
            0 => c.groups[0].streaming_first_byte_timeout = 0,
            1 => c.groups[0].streaming_first_byte_timeout = 121,
            2 => c.groups[0].streaming_idle_timeout = 601,
            _ => c.groups[0].non_streaming_timeout = 1201,
        }
        assert!(validate(&c).is_err(), "mutation {mutation}");
    }

    // 组驱动的路由把组自己的超时策略带进 ResolvedRoute
    let mut custom = c.clone();
    custom.groups[0].streaming_first_byte_timeout = 120;
    custom.groups[0].streaming_idle_timeout = 0;
    custom.groups[0].non_streaming_timeout = 1200;
    assert!(validate(&custom).is_ok());

    let db = Database::memory().unwrap();
    let c = db
        .create_gateway_supplier(SupplierUpsert {
            revision: Some(0),
            name: Some("A".into()),
            endpoint: Some(Endpoint {
                protocol: "anthropic".into(),
                base_url: "https://a.invalid".into(),
            }),
            models: Some(vec!["m".into(), "n".into()]),
            api_key: Some("secret".into()),
            auth_field: Some("ANTHROPIC_API_KEY".into()),
        })
        .unwrap();
    let mut group = custom.groups.remove(0);
    group.members[0].supplier_id = Some(c.suppliers[0].id.clone());
    group.members[1].supplier_id = Some(c.suppliers[0].id.clone());
    group.members[1].model = "n".into();
    let mut saved = c;
    saved.groups.push(group);
    db.save_gateway_catalog(saved).unwrap();
    let (route, _) = db
        .plan_gateway_request("claude", "group/root", None, &json!({}), false)
        .await
        .unwrap()
        .unwrap();
    let timeouts = route.timeouts.expect("group timeouts");
    assert_eq!(timeouts.streaming_first_byte, 120);
    assert_eq!(timeouts.streaming_idle, 0);
    assert_eq!(timeouts.non_streaming, 1200);
}

#[test]
fn codex_group_discovery_keeps_required_client_fields_without_custom_tools() {
    let result = codex_discovery(&[("group/root".into(), "Root".into())]);
    let row = &result["models"][0];
    assert_eq!(row["slug"], "group/root");
    assert_eq!(row["display_name"], "Root");
    assert!(row["base_instructions"]
        .as_str()
        .is_some_and(|s| !s.is_empty()));
    assert!(row["truncation_policy"].is_object());
    assert_eq!(row["shell_type"], "shell_command");
    assert_eq!(row["default_reasoning_level"], "none");
    assert!(row.get("apply_patch_tool_type").is_none());
    assert_eq!(row["input_modalities"], json!(["text"]));
}

#[test]
fn published_models_flattens_the_connected_group_for_any_app() {
    let mut c = catalog();
    c.groups[0].app_ids.push("opencode".into());
    let mut connection = group_policy(&c, "opencode", "root", "").unwrap();
    connection.id = connection_id("opencode");
    c.policies.push(connection);
    assert_eq!(published_models(&c, "opencode"), vec!["m", "n"]);
    // 未接入的应用没有可发布模型，不能凭空给出别家的名单。
    assert!(published_models(&c, "hermes").is_empty());
}
