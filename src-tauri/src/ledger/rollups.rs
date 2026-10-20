//! UTC reporting projections. Updated with attempt settlement, never read by budgets.
use super::*;

const DAY: i64 = 86_400_000;
type Dimensions = BTreeMap<String, BTreeMap<String, Totals>>;

fn zero() -> Totals {
    Totals {
        cost: "0".into(),
        ..Default::default()
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Contribution {
    day: i64,
    agent: String,
    project: String,
    dimension: String,
    value: String,
    totals: Totals,
}

fn apply(total: &mut Totals, value: &Totals, subtract: bool) -> Result<(), AppError> {
    let lhs = decimal(&total.cost)?;
    let rhs = decimal(&value.cost)?;
    let cost = if subtract {
        lhs.checked_sub(rhs)
    } else {
        lhs.checked_add(rhs)
    }
    .filter(|v| !v.is_sign_negative())
    .ok_or_else(|| err("rollup cost out of range"))?;
    total.cost = cost.normalize().to_string();
    for (t, v) in [
        (&mut total.requests, value.requests),
        (&mut total.attempts, value.attempts),
        (&mut total.tokens, value.tokens),
        (&mut total.unknown_cost, value.unknown_cost),
        (&mut total.unknown_usage, value.unknown_usage),
    ] {
        *t = if subtract {
            t.checked_sub(v)
        } else {
            t.checked_add(v)
        }
        .ok_or_else(|| err("rollup counter out of range"))?;
    }
    Ok(())
}

fn contributions(conn: &Connection, r: &RequestRecord) -> Result<Vec<Contribution>, AppError> {
    let project = r.reporting_project_id.as_ref().or(r.project_id.as_ref());
    let mut buckets: BTreeMap<(String, String), Totals> = BTreeMap::new();
    // Every admitted request is counted, including a refusal with no upstream attempt.
    for (dimension, value) in [
        ("all", ""),
        ("agent", r.agent.as_str()),
        ("project", project.map(String::as_str).unwrap_or("unknown")),
        ("binding", r.binding_id.as_str()),
    ] {
        let mut total = zero();
        total.requests = 1;
        buckets.insert((dimension.into(), value.into()), total);
    }
    for a in attempt_list(conn, &r.id)?
        .iter()
        .filter(|a| a.state != "started")
    {
        for (dimension, value) in [
            ("all", ""),
            ("agent", r.agent.as_str()),
            ("project", project.map(String::as_str).unwrap_or("unknown")),
            ("binding", r.binding_id.as_str()),
            ("model", a.model.as_str()),
            ("account", a.account_id.as_deref().unwrap_or("unknown")),
        ] {
            let total = buckets
                .entry((dimension.into(), value.into()))
                .or_insert_with(|| {
                    let mut total = zero();
                    total.requests = 1;
                    total
                });
            add_attempt(total, a)?;
        }
    }
    let day = window_bounds("daily", r.created_at)?.0;
    Ok(buckets
        .into_iter()
        .map(|((dimension, value), totals)| Contribution {
            day,
            agent: r.agent.clone(),
            project: project.cloned().unwrap_or_default(),
            dimension,
            value,
            totals,
        })
        .collect())
}

fn update_bucket(conn: &Connection, c: &Contribution, subtract: bool) -> Result<(), AppError> {
    let stored: Option<String> = conn.query_row(
        "SELECT payload FROM ledger_daily_dimensions WHERE day=?1 AND agent=?2 AND project_id=?3 AND dimension=?4 AND value=?5",
        params![c.day,c.agent,c.project,c.dimension,c.value], |r| r.get(0)).optional().map_err(err)?;
    let mut total = stored.map(decode).transpose()?.unwrap_or_else(zero);
    apply(&mut total, &c.totals, subtract)?;
    if total == zero() {
        conn.execute("DELETE FROM ledger_daily_dimensions WHERE day=?1 AND agent=?2 AND project_id=?3 AND dimension=?4 AND value=?5",
            params![c.day,c.agent,c.project,c.dimension,c.value]).map_err(err)?;
    } else {
        conn.execute("INSERT INTO ledger_daily_dimensions(day,agent,project_id,dimension,value,payload) VALUES(?1,?2,?3,?4,?5,?6)
            ON CONFLICT(day,agent,project_id,dimension,value) DO UPDATE SET payload=excluded.payload",
            params![c.day,c.agent,c.project,c.dimension,c.value,json(&total)?]).map_err(err)?;
    }
    Ok(())
}

/// Caller must hold a transaction/savepoint, so a failed projection rolls back admission/settlement too.
pub(super) fn sync_request(conn: &Connection, r: &RequestRecord) -> Result<(), AppError> {
    let before: Option<String> = conn
        .query_row(
            "SELECT payload FROM ledger_request_rollups WHERE request_id=?1",
            [&r.id],
            |r| r.get(0),
        )
        .optional()
        .map_err(err)?;
    let before: Vec<Contribution> = before.map(decode).transpose()?.unwrap_or_default();
    let after = contributions(conn, r)?;
    if before == after {
        return Ok(());
    }
    for c in &before {
        update_bucket(conn, c, true)?;
    }
    for c in &after {
        update_bucket(conn, c, false)?;
    }
    conn.execute("INSERT INTO ledger_request_rollups(request_id,payload) VALUES(?1,?2) ON CONFLICT(request_id) DO UPDATE SET payload=excluded.payload",
        params![r.id,json(&after)?]).map_err(err)?;
    Ok(())
}

pub(super) fn migrate(conn: &Connection) -> Result<(), AppError> {
    migrate_projection_v101(conn)?;
    migrate_binding_dimension_v102(conn)
}

fn migrate_projection_v101(conn: &Connection) -> Result<(), AppError> {
    let done: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM phi_schema_migrations WHERE version=101)",
            [],
            |r| r.get(0),
        )
        .map_err(err)?;
    if done {
        return Ok(());
    }
    conn.execute_batch("SAVEPOINT phi_reporting_projection")
        .map_err(err)?;
    let result = (|| {
        let mut columns = conn
            .prepare("PRAGMA table_info(route_decisions)")
            .map_err(err)?;
        let columns = columns
            .query_map([], |r| r.get::<_, String>(1))
            .map_err(err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(err)?;
        if !columns.iter().any(|c| c == "reporting_project_id") {
            conn.execute(
                "ALTER TABLE route_decisions ADD COLUMN reporting_project_id TEXT",
                [],
            )
            .map_err(err)?;
        }
        conn.execute_batch("CREATE INDEX IF NOT EXISTS idx_reporting_project_time ON route_decisions(COALESCE(reporting_project_id,project_id,''),ts);
            DELETE FROM ledger_daily_dimensions; DELETE FROM ledger_request_rollups;").map_err(err)?;
        let mut stmt = conn
            .prepare("SELECT payload FROM route_decisions ORDER BY ts,request_id")
            .map_err(err)?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(err)?;
        for row in rows {
            let r: RequestRecord = decode(row.map_err(err)?)?;
            sync_request(conn, &r)?;
        }
        conn.execute(
            "INSERT INTO phi_schema_migrations(version,created_at) VALUES(101,?1)",
            [Utc::now().timestamp_millis()],
        )
        .map_err(err)?;
        Ok(())
    })();
    match result {
        Ok(()) => conn
            .execute_batch("RELEASE phi_reporting_projection")
            .map_err(err),
        Err(error) => {
            let _ = conn.execute_batch(
                "ROLLBACK TO phi_reporting_projection; RELEASE phi_reporting_projection",
            );
            Err(error)
        }
    }
}

fn migrate_binding_dimension_v102(conn: &Connection) -> Result<(), AppError> {
    let done: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM phi_schema_migrations WHERE version=102)",
            [],
            |r| r.get(0),
        )
        .map_err(err)?;
    if done {
        return Ok(());
    }
    conn.execute_batch("SAVEPOINT phi_binding_dimension")
        .map_err(err)?;
    let result = (|| {
        // The projection is derived, so rebuilding it is cheaper than teaching
        // every historical row a new dimension.
        conn.execute_batch(
            "DELETE FROM ledger_daily_dimensions; DELETE FROM ledger_request_rollups;",
        )
        .map_err(err)?;
        let mut stmt = conn
            .prepare("SELECT payload FROM route_decisions ORDER BY ts,request_id")
            .map_err(err)?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(err)?;
        for row in rows {
            let r: RequestRecord = decode(row.map_err(err)?)?;
            sync_request(conn, &r)?;
        }
        conn.execute(
            "INSERT INTO phi_schema_migrations(version,created_at) VALUES(102,?1)",
            [Utc::now().timestamp_millis()],
        )
        .map_err(err)?;
        Ok(())
    })();
    match result {
        Ok(()) => conn
            .execute_batch("RELEASE phi_binding_dimension")
            .map_err(err),
        Err(error) => {
            let _ = conn
                .execute_batch("ROLLBACK TO phi_binding_dimension; RELEASE phi_binding_dimension");
            Err(error)
        }
    }
}

fn accumulate(
    total: &mut Totals,
    dimensions: &mut Dimensions,
    dimension: &str,
    value: &str,
    amount: &Totals,
) -> Result<(), AppError> {
    if dimension == "all" {
        apply(total, amount, false)
    } else {
        apply(
            dimensions
                .entry(dimension.into())
                .or_default()
                .entry(value.into())
                .or_insert_with(zero),
            amount,
            false,
        )
    }
}

pub(super) fn report(
    conn: &Connection,
    q: &LedgerQuery,
    since: i64,
    until: i64,
) -> Result<(Totals, Dimensions), AppError> {
    let start_day = window_bounds("daily", since)?.0;
    let full_start = if since == start_day {
        start_day
    } else {
        start_day
            .checked_add(DAY)
            .ok_or_else(|| err("date overflow"))?
    };
    let full_end = window_bounds("daily", until)?.0.max(full_start);
    let mut total = zero();
    let mut dimensions = Dimensions::new();
    let mut stmt = conn.prepare("SELECT dimension,value,payload FROM ledger_daily_dimensions WHERE day>=?1 AND day<?2 AND (?3 IS NULL OR agent=?3) AND (?4 IS NULL OR project_id=?4)").map_err(err)?;
    let rows = stmt
        .query_map(params![full_start, full_end, q.agent, q.project_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(err)?;
    for row in rows {
        let (dimension, value, payload) = row.map_err(err)?;
        accumulate(
            &mut total,
            &mut dimensions,
            &dimension,
            &value,
            &decode(payload)?,
        )?;
    }
    // Only the partial boundary days use per-request contributions. Never add them to full-day rows.
    let mut stmt = conn.prepare("SELECT c.payload FROM ledger_request_rollups c JOIN route_decisions r USING(request_id)
        WHERE r.ts>=?1 AND r.ts<?2 AND (r.ts<?3 OR r.ts>=?4) AND (?5 IS NULL OR r.agent=?5)
        AND (?6 IS NULL OR COALESCE(r.reporting_project_id,r.project_id,'')=?6)").map_err(err)?;
    let rows = stmt
        .query_map(
            params![since, until, full_start, full_end, q.agent, q.project_id],
            |r| r.get::<_, String>(0),
        )
        .map_err(err)?;
    for row in rows {
        for c in decode::<Vec<Contribution>>(row.map_err(err)?)? {
            accumulate(
                &mut total,
                &mut dimensions,
                &c.dimension,
                &c.value,
                &c.totals,
            )?;
        }
    }
    Ok((total, dimensions))
}

impl Database {
    /// Explicit local reporting attribution. Cannot alter the trusted admission identity or budgets.
    pub fn set_reporting_project(
        &self,
        id: &str,
        project_id: Option<String>,
    ) -> Result<(), AppError> {
        let mut conn = lock_conn!(self.conn);
        let tx = conn.transaction().map_err(err)?;
        let mut r = request(&tx, id)?;
        if r.project_id.is_some() {
            return Err(err("authenticated project attribution is immutable"));
        }
        if r.state == "pending" {
            return Err(err("wait until the request has finished"));
        }
        if let Some(project) = &project_id {
            let exists: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM projects WHERE id=?1)",
                    [project],
                    |r| r.get(0),
                )
                .map_err(err)?;
            if !exists {
                return Err(err("reporting project must be registered"));
            }
        }
        if r.reporting_project_id == project_id {
            return Ok(());
        }
        r.reporting_project_id = project_id;
        r.attribution_source = r.reporting_project_id.as_ref().map(|_| "manual".into());
        r.reporting_assigned_at = r
            .reporting_project_id
            .as_ref()
            .map(|_| Utc::now().timestamp_millis());
        write_request(&tx, &r)?;
        sync_request(&tx, &r)?;
        tx.commit().map_err(err)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ledger::tests::{price, usage};

    fn at(db: &Database, timestamp: i64) -> RequestRecord {
        let mut r = RequestRecord::new("cline", "binding", None);
        r.created_at = timestamp;
        db.ledger_start(&r).unwrap();
        db.ledger_admit(
            &r.id,
            "supplier",
            Some("acct".into()),
            "model",
            Some(price()),
        )
        .unwrap();
        db.ledger_settle(&r.id, 1, "completed", None, Some(usage()), true)
            .unwrap();
        db.ledger_finish(&r.id, "completed").unwrap();
        r
    }

    #[test]
    fn utc_boundaries_partial_windows_filters_and_repeated_settlement_do_not_double_count() {
        let db = Database::memory().unwrap();
        let start = window_bounds("daily", Utc::now().timestamp_millis())
            .unwrap()
            .0
            - 3 * DAY;
        let a = at(&db, start + 10);
        at(&db, start + DAY + 10);
        at(&db, start + 2 * DAY + 10);
        db.ledger_settle(&a.id, 1, "completed", None, Some(usage()), true)
            .unwrap();
        for (since, until, expected) in [
            (start, start + 3 * DAY, 3),
            (start + 11, start + 2 * DAY + 11, 2),
            (start + 5, start + 11, 1),
            (start + 11, start + DAY, 0),
        ] {
            let page = db
                .ledger_page(LedgerQuery {
                    since: Some(since),
                    until: Some(until),
                    ..Default::default()
                })
                .unwrap();
            assert_eq!(page.total, expected);
            assert_eq!(page.totals.attempts, expected);
            assert_eq!(page.totals.cost, (2 * expected).to_string());
        }
        let empty = db
            .ledger_page(LedgerQuery {
                since: Some(start),
                until: Some(start + 3 * DAY),
                agent: Some("other".into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(empty.total, 0);
    }

    #[test]
    fn binding_dimension_and_binding_totals_follow_the_identity() {
        let db = Database::memory().unwrap();
        let start = window_bounds("daily", Utc::now().timestamp_millis())
            .unwrap()
            .0;
        at(&db, start + 10);
        let totals = db.ledger_binding_totals(start, start + DAY).unwrap();
        assert_eq!(totals["binding"].requests, 1);
        assert_eq!(totals["binding"].cost, "2");
        let expected = usage();
        assert_eq!(
            totals["binding"].tokens,
            expected.input + expected.output + expected.cache_read + expected.cache_creation
        );
        // Local app requests use a `local:<app>` identity and must stay separable.
        assert!(!totals.contains_key("local:codex"));
    }

    #[test]
    fn late_attribution_moves_reporting_buckets_but_never_budget_identity_or_totals() {
        let db = Database::memory().unwrap();
        let project = db.save_access_project("/synthetic/project".into()).unwrap();
        let mut b = crate::ledger::tests::budget("warn");
        b.limit_cost = Some("100".into());
        db.save_budget(b).unwrap();
        let r = at(&db, Utc::now().timestamp_millis());
        let before = json(&db.budget_status().unwrap()[0].totals).unwrap();
        for _ in 0..2 {
            db.set_reporting_project(&r.id, Some(project.id.clone()))
                .unwrap();
        }
        let record = db.ledger_request(&r.id).unwrap();
        assert!(record.project_id.is_none());
        assert_eq!(record.attribution_source.as_deref(), Some("manual"));
        assert_eq!(
            json(&db.budget_status().unwrap()[0].totals).unwrap(),
            before
        );
        let page = db
            .ledger_page(LedgerQuery {
                project_id: Some(project.id.clone()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(page.total, 1);
        assert_eq!(page.dimensions["project"][&project.id].cost, "2");
        assert!(!page.dimensions["project"].contains_key("unknown"));
        assert!(db
            .set_reporting_project(&r.id, Some("missing".into()))
            .is_err());
        db.set_reporting_project(&r.id, None).unwrap();
        assert_eq!(
            db.ledger_page(LedgerQuery::default()).unwrap().dimensions["project"]["unknown"]
                .requests,
            1
        );
    }

    #[test]
    fn unknown_to_partial_to_final_usage_updates_projection_by_delta_and_rolls_back_on_failure() {
        let db = Database::memory().unwrap();
        let r = crate::ledger::tests::req(&db);
        db.ledger_admit(&r.id, "supplier", None, "model", Some(price()))
            .unwrap();
        db.ledger_settle(&r.id, 1, "interrupted", None, None, false)
            .unwrap();
        assert_eq!(
            db.ledger_page(LedgerQuery::default())
                .unwrap()
                .totals
                .unknown_usage,
            1
        );
        db.ledger_settle_observed(&r.id, 1, "interrupted", None, Some(usage()), true, false)
            .unwrap();
        let partial = db.ledger_page(LedgerQuery::default()).unwrap().totals;
        assert_eq!(partial.cost, "2");
        assert_eq!(partial.unknown_usage, 1);
        db.ledger_settle(&r.id, 1, "interrupted", None, Some(usage()), true)
            .unwrap();
        let final_usage = db.ledger_page(LedgerQuery::default()).unwrap().totals;
        assert_eq!(final_usage.cost, "2");
        assert_eq!(final_usage.unknown_usage, 0);
        db.conn.lock().unwrap().execute_batch("CREATE TRIGGER fail_rollup BEFORE DELETE ON ledger_daily_dimensions BEGIN SELECT RAISE(ABORT,'injected'); END;").unwrap();
        let mut changed = usage();
        changed.output += 1;
        assert!(db
            .ledger_settle(&r.id, 1, "interrupted", None, Some(changed), true)
            .is_err());
        assert_eq!(
            db.ledger_attempts(&r.id).unwrap()[0]
                .usage
                .as_ref()
                .unwrap()
                .output,
            usage().output
        );
        assert_eq!(
            db.ledger_page(LedgerQuery::default()).unwrap().totals,
            final_usage
        );
    }

    #[test]
    fn migration_rebuilds_existing_requests_once_including_no_attempt_refusals() {
        let db = Database::memory().unwrap();
        at(&db, Utc::now().timestamp_millis());
        let refused = crate::ledger::tests::req(&db);
        db.ledger_finish(&refused.id, "blocked").unwrap();
        let before = db.ledger_page(LedgerQuery::default()).unwrap().totals;
        let conn = db.conn.lock().unwrap();
        conn.execute_batch("DELETE FROM phi_schema_migrations WHERE version IN (101,102); DELETE FROM ledger_daily_dimensions; DELETE FROM ledger_request_rollups;").unwrap();
        migrate(&conn).unwrap();
        migrate(&conn).unwrap();
        drop(conn);
        assert_eq!(
            db.ledger_page(LedgerQuery::default()).unwrap().totals,
            before
        );
        assert!(
            db.ledger_page(LedgerQuery::default()).unwrap().dimensions["binding"]
                .contains_key("binding")
        );
        assert_eq!(before.requests, 2);
        assert_eq!(before.attempts, 1);
    }
}
