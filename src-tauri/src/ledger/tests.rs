use super::*;

pub(super) fn price() -> PriceSnapshot {
    PriceSnapshot {
        input: "1".into(),
        output: "2".into(),
        cache_read: "0.1".into(),
        cache_creation: "1.25".into(),
        multiplier: "1".into(),
    }
}
pub(super) fn usage() -> Usage {
    Usage {
        input: 1_000_000,
        output: 500_000,
        cache_read: 0,
        cache_creation: 0,
        cache_creation_1h: 0,
    }
}
pub(super) fn budget(action: &str) -> Budget {
    Budget {
        id: String::new(),
        name: "Daily".into(),
        scope: "global".into(),
        scope_value: None,
        window: "daily".into(),
        limit_cost: Some("2".into()),
        limit_tokens: None,
        action: action.into(),
        enabled: true,
    }
}
pub(super) fn req(db: &Database) -> RequestRecord {
    let r = RequestRecord::new("claude", "local:claude", None);
    db.ledger_start(&r).unwrap();
    r
}
fn admit(db: &Database, r: &RequestRecord) -> Attempt {
    db.ledger_admit(&r.id, "claude:p", None, "sonnet", Some(price()))
        .unwrap()
        .attempt
        .unwrap()
}

#[test]
fn repeated_settlement_and_late_usage_are_idempotent() {
    let db = Database::memory().unwrap();
    db.save_budget(budget("block")).unwrap();
    let r = req(&db);
    let a = admit(&db, &r);
    db.ledger_settle(&r.id, a.attempt_no, "interrupted", None, None, true)
        .unwrap();
    assert_eq!(db.budget_status().unwrap()[0].totals.unknown_cost, 1);
    for _ in 0..2 {
        db.ledger_settle(
            &r.id,
            a.attempt_no,
            "interrupted",
            None,
            Some(usage()),
            true,
        )
        .unwrap();
    }
    let t = &db.budget_status().unwrap()[0].totals;
    assert_eq!(t.cost, "2");
    assert_eq!(t.tokens, 1_500_000);
    assert_eq!(t.unknown_cost, 0);
    assert_eq!(t.attempts, 1);
    db.ledger_settle(&r.id, a.attempt_no, "interrupted", None, None, false)
        .unwrap();
    assert_eq!(db.budget_status().unwrap()[0].totals.cost, "2");
    assert_eq!(
        db.ledger_admit(&req(&db).id, "claude:p", None, "sonnet", Some(price()))
            .unwrap()
            .blocked
            .as_deref(),
        Some("BUDGET_BLOCK")
    );
}
#[test]
fn every_retry_is_accounted_and_unknown_failures_stop_block_budgets() {
    let db = Database::memory().unwrap();
    let r = req(&db);
    let a = admit(&db, &r);
    db.ledger_settle(&r.id, a.attempt_no, "failed", Some("timeout"), None, false)
        .unwrap();
    let a = admit(&db, &r);
    db.ledger_settle(&r.id, a.attempt_no, "completed", None, Some(usage()), true)
        .unwrap();
    db.ledger_finish(&r.id, "completed").unwrap();
    let b = db.save_budget(budget("block")).unwrap();
    let t = &db.budget_status().unwrap()[0].totals;
    assert_eq!(t.cost, "2");
    assert_eq!(t.attempts, 2);
    assert_eq!(t.requests, 1);
    assert_eq!(t.unknown_usage, 1);
    assert_eq!(
        db.ledger_admit(&req(&db).id, "claude:p", None, "sonnet", Some(price()))
            .unwrap()
            .blocked
            .as_deref(),
        Some("USAGE_UNKNOWN")
    );
    db.save_budget(Budget {
        action: "warn".into(),
        ..b
    })
    .unwrap();
    let admission = db
        .ledger_admit(&req(&db).id, "claude:p", None, "sonnet", Some(price()))
        .unwrap();
    assert!(admission.attempt.is_some());
    assert!(!admission.warnings.is_empty());
}
#[test]
fn unpriced_attempt_is_refused_before_a_row_can_start() {
    let db = Database::memory().unwrap();
    db.save_budget(budget("block")).unwrap();
    let r = req(&db);
    let admission = db
        .ledger_admit(&r.id, "claude:p", None, "new-model", None)
        .unwrap();
    assert_eq!(admission.blocked.as_deref(), Some("UNPRICED"));
    assert!(db.ledger_attempts(&r.id).unwrap().is_empty());
}
#[test]
fn budget_backfill_and_threshold_edit_preserve_existing_cost() {
    let db = Database::memory().unwrap();
    let r = req(&db);
    let a = admit(&db, &r);
    db.ledger_settle(&r.id, a.attempt_no, "completed", None, Some(usage()), true)
        .unwrap();
    let b = db.save_budget(budget("warn")).unwrap();
    assert_eq!(db.budget_status().unwrap()[0].totals.cost, "2");
    db.save_budget(Budget {
        limit_cost: Some("3".into()),
        ..b.clone()
    })
    .unwrap();
    assert_eq!(db.budget_status().unwrap()[0].totals.cost, "2");
    assert!(db
        .save_budget(Budget {
            window: "monthly".into(),
            ..b
        })
        .is_err());
}
#[test]
fn project_scope_cannot_be_bypassed_with_an_unknown_binding() {
    let db = Database::memory().unwrap();
    let project = db.save_access_project("/work/alpha".into()).unwrap();
    db.save_budget(Budget {
        scope: "project".into(),
        scope_value: Some(project.id),
        ..budget("block")
    })
    .unwrap();
    let r = req(&db);
    assert_eq!(
        db.ledger_admit(&r.id, "p", None, "m", Some(price()))
            .unwrap()
            .blocked
            .as_deref(),
        Some("PROJECT_BINDING_REQUIRED")
    );
    let r = RequestRecord::new("claude", "binding-beta", Some("beta".into()));
    db.ledger_start(&r).unwrap();
    assert!(db
        .ledger_admit(&r.id, "p", None, "m", None)
        .unwrap()
        .attempt
        .is_some());
}
#[test]
fn utc_windows_include_leap_month_and_keep_long_requests_in_admission_window() {
    let at = Utc
        .with_ymd_and_hms(2024, 2, 29, 23, 59, 59)
        .unwrap()
        .timestamp_millis();
    let (start, end) = window_bounds("monthly", at).unwrap();
    assert_eq!(end - start, 29 * 86_400_000);
    assert_eq!(window_bounds("daily", at).unwrap().1, end);
    let db = Database::memory().unwrap();
    db.save_budget(budget("warn")).unwrap();
    let mut r = RequestRecord::new("claude", "c", None);
    r.created_at = at;
    db.ledger_start(&r).unwrap();
    let a = admit(&db, &r);
    db.ledger_settle(&r.id, a.attempt_no, "completed", None, Some(usage()), true)
        .unwrap();
    assert_eq!(db.budget_status().unwrap()[0].totals.attempts, 0);
    let conn = db.conn.lock().unwrap();
    let b = &budgets(&conn).unwrap()[0];
    assert_eq!(
        budget_totals(&conn, &b.id, window_bounds("daily", at).unwrap().0)
            .unwrap()
            .cost,
        "2"
    );
}
#[test]
fn startup_marks_unfinished_attempts_unknown_without_charging_zero() {
    let db = Database::memory().unwrap();
    db.save_budget(budget("warn")).unwrap();
    let r = req(&db);
    admit(&db, &r);
    db.ledger_recover().unwrap();
    db.ledger_recover().unwrap();
    let attempts = db.ledger_attempts(&r.id).unwrap();
    assert_eq!(attempts[0].state, "interrupted");
    assert!(attempts[0].estimated_cost_usd.is_none());
    assert_eq!(db.budget_status().unwrap()[0].totals.unknown_cost, 1);
}
#[test]
fn failed_transaction_cannot_leave_usage_partially_committed() {
    let db = Database::memory().unwrap();
    let r = req(&db);
    let a = admit(&db, &r);
    let b = db.save_budget(budget("warn")).unwrap();
    db.conn.lock().unwrap().execute_batch("CREATE TRIGGER reject_usage BEFORE UPDATE ON budget_usage BEGIN SELECT RAISE(ABORT,'injected write failure'); END;").unwrap();
    assert!(db
        .ledger_settle(&r.id, a.attempt_no, "completed", None, Some(usage()), true)
        .is_err());
    assert_eq!(db.ledger_attempts(&r.id).unwrap()[0].state, "started");
    let conn = db.conn.lock().unwrap();
    assert_eq!(
        budget_totals(
            &conn,
            &b.id,
            window_bounds("daily", r.created_at).unwrap().0
        )
        .unwrap()
        .cost,
        "0"
    );
}
#[test]
fn invalid_budget_values_are_rejected() {
    let db = Database::memory().unwrap();
    for v in ["-1", "NaN", "infinity"] {
        assert!(db
            .save_budget(Budget {
                limit_cost: Some(v.into()),
                ..budget("block")
            })
            .is_err());
    }
    assert!(db
        .save_budget(Budget {
            limit_cost: None,
            ..budget("block")
        })
        .is_err());
    assert!(db
        .save_budget(Budget {
            scope: "agent".into(),
            ..budget("block")
        })
        .is_err());
}

#[test]
fn partial_usage_is_kept_but_cannot_clear_the_unknown_budget_gate() {
    let db = Database::memory().unwrap();
    let r = req(&db);
    let a = admit(&db, &r);
    db.ledger_settle_observed(
        &r.id,
        a.attempt_no,
        "interrupted",
        None,
        Some(usage()),
        true,
        false,
    )
    .unwrap();
    let mut b = budget("block");
    b.limit_cost = Some("10".into());
    db.save_budget(b).unwrap();
    let totals = &db.budget_status().unwrap()[0].totals;
    assert_eq!(totals.cost, "2");
    assert_eq!(totals.tokens, 1_500_000);
    assert_eq!(totals.unknown_cost, 1);
    assert_eq!(totals.unknown_usage, 1);
    assert_eq!(
        db.ledger_admit(&req(&db).id, "p", None, "m", Some(price()))
            .unwrap()
            .blocked
            .as_deref(),
        Some("USAGE_UNKNOWN")
    );
    db.ledger_settle(&r.id, a.attempt_no, "completed", None, Some(usage()), true)
        .unwrap();
    db.ledger_settle_observed(
        &r.id,
        a.attempt_no,
        "interrupted",
        None,
        Some(Usage {
            output: 0,
            ..usage()
        }),
        true,
        false,
    )
    .unwrap();
    let totals = &db.budget_status().unwrap()[0].totals;
    assert_eq!(totals.cost, "2");
    assert_eq!(totals.tokens, 1_500_000);
    assert_eq!(totals.unknown_cost, 0);
    assert_eq!(totals.unknown_usage, 0);
}

#[test]
fn route_explanation_survives_disabled_and_deleted_diagnostic_traces() {
    let db = Database::memory().unwrap();
    let r = req(&db);
    let trace = crate::gateway::RequestTrace {
        id: r.id.clone(),
        created_at: r.created_at,
        app_id: "claude".into(),
        binding_id: None,
        binding_name: None,
        request_model: "alias".into(),
        catalog_revision: 7,
        policy: crate::gateway::RoutePolicy {
            id: "policy".into(),
            name: "Snapshot".into(),
            app_id: "claude".into(),
            enabled: true,
            match_model: "alias".into(),
            request_model: String::new(),
            priority: 0,
            failover: true,
            candidates: vec![],
            group_id: None,
        },
        decision: Some(crate::gateway::routing::RouteDecision {
            reason: "ordered".into(),
            ..Default::default()
        }),
        events: vec![],
        outcome: "pending".into(),
        latency_ms: 0,
        input_tokens: None,
        output_tokens: None,
        estimated_cost: None,
        persist: false,
    };
    db.write_gateway_trace(&trace).unwrap();
    assert!(db.gateway_traces().unwrap().is_empty());
    db.conn
        .lock()
        .unwrap()
        .execute("DELETE FROM gateway_traces", [])
        .unwrap();
    let snapshot = db.ledger_request(&r.id).unwrap().route.unwrap();
    assert_eq!(snapshot.catalog_revision, 7);
    assert_eq!(snapshot.policy.name, "Snapshot");
    assert_eq!(snapshot.decision.unwrap().reason, "ordered");
}

#[test]
fn price_overflow_rolls_back_without_panic_or_partial_usage() {
    let db = Database::memory().unwrap();
    let r = req(&db);
    let a = db
        .ledger_admit(
            &r.id,
            "p",
            None,
            "m",
            Some(PriceSnapshot {
                input: Decimal::MAX.to_string(),
                ..price()
            }),
        )
        .unwrap()
        .attempt
        .unwrap();
    assert!(db
        .ledger_settle(&r.id, a.attempt_no, "completed", None, Some(usage()), true)
        .is_err());
    let a = &db.ledger_attempts(&r.id).unwrap()[0];
    assert_eq!(a.state, "started");
    assert!(a.usage.is_none());
}

#[test]
fn enabling_budget_refuses_legacy_rollups_from_the_same_utc_day() {
    let db = Database::memory().unwrap();
    {
        let conn = db.conn.lock().unwrap();
        conn.execute("DELETE FROM ledger_metadata", []).unwrap();
        conn.execute("INSERT INTO usage_daily_rollups(date,app_type,provider_id,model,request_count) VALUES(?1,'claude','legacy','m',2)",[Utc::now().format("%Y-%m-%d").to_string()]).unwrap();
        create_tables(&conn).unwrap();
        conn.execute("DELETE FROM usage_daily_rollups", []).unwrap();
    }
    assert!(db
        .save_budget(budget("block"))
        .unwrap_err()
        .to_string()
        .contains("BUDGET_HISTORY_INCOMPLETE"));
    assert!(db.budget_status().unwrap().is_empty());
}

#[test]
fn budget_warnings_are_persisted_once_per_utc_window_and_reason() {
    let db = Database::memory().unwrap();
    let mut b = budget("warn");
    b.limit_cost = None;
    b.limit_tokens = Some(0);
    let b = db.save_budget(b).unwrap();
    for i in 0..3 {
        let r = req(&db);
        let a = db.ledger_admit(&r.id, "p", None, "m", None).unwrap();
        assert_eq!(a.warnings.len(), 1);
        assert_eq!(a.notifications.len(), if i == 0 { 1 } else { 0 });
    }
    db.save_budget(Budget {
        name: "Renamed".into(),
        ..b
    })
    .unwrap();
    assert_eq!(db.budget_status().unwrap()[0].alerts.len(), 1);
    let mut r = RequestRecord::new("claude", "local", None);
    r.created_at = window_bounds("daily", r.created_at).unwrap().1;
    db.ledger_start(&r).unwrap();
    assert_eq!(
        db.ledger_admit(&r.id, "p", None, "m", None)
            .unwrap()
            .notifications
            .len(),
        1
    );
}
