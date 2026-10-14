//! Durable gateway ledger. Session imports and disposable routing traces never
//! participate in this accounting. All amounts are Decimal strings, never REAL.
use crate::{database::lock_conn, error::AppError, Database};
use chrono::{Datelike, TimeZone, Utc};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, str::FromStr};
pub(crate) mod notifications;
mod rollups;

fn err(e: impl std::fmt::Display) -> AppError {
    AppError::Database(format!("Ledger: {e}"))
}
fn json<T: Serialize>(v: &T) -> Result<String, AppError> {
    serde_json::to_string(v).map_err(err)
}
fn decode<T: serde::de::DeserializeOwned>(v: String) -> Result<T, AppError> {
    serde_json::from_str(&v).map_err(err)
}
fn decimal(v: &str) -> Result<Decimal, AppError> {
    Decimal::from_str(v).map_err(err)
}

pub(crate) fn create_tables(conn: &Connection) -> Result<(), AppError> {
    conn.execute_batch(include_str!("ledger/schema.sql"))
        .map_err(err)?;
    let mut stmt = conn
        .prepare("PRAGMA table_info(budget_attempts)")
        .map_err(err)?;
    let columns = stmt
        .query_map([], |r| r.get::<_, String>(1))
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    for column in ["partial_cost", "partial_usage"] {
        if !columns.iter().any(|name| name == column) {
            conn.execute(
                &format!(
                    "ALTER TABLE budget_attempts ADD COLUMN {column} INTEGER NOT NULL DEFAULT 0"
                ),
                [],
            )
            .map_err(err)?;
        }
    }
    let has_notified: bool = conn
        .prepare("PRAGMA table_info(budget_alerts)")
        .map_err(err)?
        .query_map([], |r| r.get::<_, String>(1))
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?
        .iter()
        .any(|c| c == "notified_at");
    if !has_notified {
        conn.execute(
            "ALTER TABLE budget_alerts ADD COLUMN notified_at INTEGER",
            [],
        )
        .map_err(err)?;
    }
    // Freeze evidence of legacy usage before new gateway/session rollups appear.
    // A compacted same-day rollup cannot be treated as zero when budgets are enabled.
    let captured: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM ledger_metadata WHERE key='legacy_until')",
            [],
            |r| r.get(0),
        )
        .map_err(err)?;
    if !captured {
        let mut legacy_until = 0i64;
        for (table, column, scale) in [
            ("proxy_request_logs", "created_at", 1000i64),
            ("gateway_traces", "created_at", 1),
        ] {
            let exists: bool = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                    [table],
                    |r| r.get(0),
                )
                .map_err(err)?;
            if exists {
                let value: i64 = conn
                    .query_row(
                        &format!("SELECT COALESCE(MAX({column}),0) FROM {table}"),
                        [],
                        |r| r.get(0),
                    )
                    .map_err(err)?;
                legacy_until = legacy_until.max(value.saturating_mul(scale));
            }
        }
        let last_date: Option<String> = conn
            .query_row("SELECT MAX(date) FROM usage_daily_rollups", [], |r| {
                r.get(0)
            })
            .map_err(err)?;
        if let Some(date) =
            last_date.and_then(|v| chrono::NaiveDate::parse_from_str(&v, "%Y-%m-%d").ok())
        {
            if let Some(end) = date.succ_opt().and_then(|v| v.and_hms_opt(0, 0, 0)) {
                legacy_until = legacy_until.max(end.and_utc().timestamp_millis() - 1);
            }
        }
        conn.execute(
            "INSERT INTO ledger_metadata(key,value) VALUES('legacy_until',?1)",
            [legacy_until],
        )
        .map_err(err)?;
    }
    rollups::migrate(conn)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestRecord {
    pub id: String,
    pub created_at: i64,
    pub binding_id: String,
    pub agent: String,
    pub tool: String,
    pub project_id: Option<String>,
    #[serde(default)]
    pub reporting_project_id: Option<String>,
    #[serde(default)]
    pub attribution_source: Option<String>,
    #[serde(default)]
    pub reporting_assigned_at: Option<i64>,
    pub session_id: Option<String>,
    pub request_model: String,
    pub state: String,
    pub reason_codes: Vec<String>,
    pub estimated_cost_usd: String,
    pub tokens: u64,
    pub unknown_cost_attempts: u64,
    pub unknown_usage_attempts: u64,
    pub attempts: u64,
    #[serde(default)]
    pub route: Option<RouteSnapshot>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteSnapshot {
    pub catalog_revision: u64,
    pub policy: crate::gateway::RoutePolicy,
    pub decision: Option<crate::gateway::routing::RouteDecision>,
}
impl RequestRecord {
    pub fn new(agent: &str, binding_id: &str, project_id: Option<String>) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            created_at: Utc::now().timestamp_millis(),
            binding_id: binding_id.into(),
            agent: agent.into(),
            tool: agent.into(),
            project_id,
            reporting_project_id: None,
            attribution_source: None,
            reporting_assigned_at: None,
            session_id: None,
            request_model: "unknown".into(),
            state: "pending".into(),
            reason_codes: vec![],
            estimated_cost_usd: "0".into(),
            tokens: 0,
            unknown_cost_attempts: 0,
            unknown_usage_attempts: 0,
            attempts: 0,
            route: None,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceSnapshot {
    pub input: String,
    pub output: String,
    pub cache_read: String,
    pub cache_creation: String,
    pub multiplier: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    /// Normalized fresh input; cached tokens are separate for every protocol.
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_creation: u64,
    pub cache_creation_1h: u64,
}
impl Usage {
    fn tokens(&self) -> Result<u64, AppError> {
        self.input
            .checked_add(self.output)
            .and_then(|n| n.checked_add(self.cache_read))
            .and_then(|n| n.checked_add(self.cache_creation))
            .filter(|n| *n <= i64::MAX as u64)
            .ok_or_else(|| err("token count overflow"))
    }
}
impl PriceSnapshot {
    fn validate(&self) -> Result<(), AppError> {
        for value in [
            &self.input,
            &self.output,
            &self.cache_read,
            &self.cache_creation,
            &self.multiplier,
        ] {
            if decimal(value)?.is_sign_negative() {
                return Err(err("negative price"));
            }
        }
        Ok(())
    }
    fn cost(&self, usage: &Usage) -> Result<String, AppError> {
        self.validate()?;
        let hour = usage.cache_creation_1h.min(usage.cache_creation);
        let mut amount = Decimal::ZERO;
        for (tokens, rate) in [
            (Decimal::from(usage.input), &self.input),
            (Decimal::from(usage.output), &self.output),
            (Decimal::from(usage.cache_read), &self.cache_read),
            (
                Decimal::from(usage.cache_creation - hour)
                    + Decimal::from(hour) * Decimal::new(16, 1),
                &self.cache_creation,
            ),
        ] {
            amount = amount
                .checked_add(
                    tokens
                        .checked_mul(decimal(rate)?)
                        .ok_or_else(|| err("price overflow"))?,
                )
                .ok_or_else(|| err("cost overflow"))?;
        }
        let amount = amount
            .checked_div(Decimal::from(1_000_000))
            .and_then(|amount| amount.checked_mul(decimal(&self.multiplier).ok()?))
            .ok_or_else(|| err("cost overflow"))?;
        Ok(amount.normalize().to_string())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attempt {
    pub request_id: String,
    pub attempt_no: u64,
    pub provider_id: String,
    pub account_id: Option<String>,
    pub model: String,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub state: String,
    pub reason_code: Option<String>,
    pub response_committed: bool,
    pub price: Option<PriceSnapshot>,
    pub usage: Option<Usage>,
    #[serde(default = "complete_usage")]
    pub usage_complete: bool,
    pub usage_source: String,
    pub cost_source: String,
    pub estimated_cost_usd: Option<String>,
}
fn complete_usage() -> bool {
    true
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Budget {
    pub id: String,
    pub name: String,
    pub scope: String,
    pub scope_value: Option<String>,
    pub window: String,
    pub limit_cost: Option<String>,
    pub limit_tokens: Option<u64>,
    pub action: String,
    pub enabled: bool,
}
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Totals {
    pub cost: String,
    pub tokens: u64,
    pub unknown_cost: u64,
    pub unknown_usage: u64,
    pub attempts: u64,
    pub requests: u64,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetStatus {
    pub budget: Budget,
    pub window_start: i64,
    pub window_end: i64,
    pub totals: Totals,
    pub in_flight: u64,
    pub alerts: Vec<BudgetAlert>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetAlert {
    pub budget_id: String,
    pub name: String,
    pub window_start: i64,
    pub reason: String,
    pub created_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Admission {
    pub attempt: Option<Attempt>,
    pub warnings: Vec<String>,
    pub notifications: Vec<BudgetAlert>,
    pub blocked: Option<String>,
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LedgerQuery {
    pub since: Option<i64>,
    pub until: Option<i64>,
    pub agent: Option<String>,
    pub project_id: Option<String>,
    pub offset: Option<u64>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerPage {
    pub records: Vec<RequestRecord>,
    pub total: u64,
    pub totals: Totals,
    pub dimensions: BTreeMap<String, BTreeMap<String, Totals>>,
    pub coverage_since: i64,
}

pub fn window_bounds(window: &str, at: i64) -> Result<(i64, i64), AppError> {
    let date = Utc
        .timestamp_millis_opt(at)
        .single()
        .ok_or_else(|| err("invalid timestamp"))?;
    let day = if window == "monthly" { 1 } else { date.day() };
    let start = Utc
        .with_ymd_and_hms(date.year(), date.month(), day, 0, 0, 0)
        .single()
        .ok_or_else(|| err("invalid date"))?;
    let end = if window == "daily" {
        start.checked_add_signed(chrono::Duration::days(1))
    } else if window == "monthly" {
        start.checked_add_months(chrono::Months::new(1))
    } else {
        return Err(err("invalid budget window"));
    }
    .ok_or_else(|| err("invalid window end"))?;
    Ok((start.timestamp_millis(), end.timestamp_millis()))
}
fn matches(b: &Budget, r: &RequestRecord) -> bool {
    match b.scope.as_str() {
        "global" => true,
        "agent" => b.scope_value.as_deref() == Some(r.agent.as_str()),
        "project" => b
            .scope_value
            .as_ref()
            .is_some_and(|p| Some(p) == r.project_id.as_ref()),
        _ => false,
    }
}
fn budgets(conn: &Connection) -> Result<Vec<Budget>, AppError> {
    let mut stmt = conn
        .prepare("SELECT payload FROM budgets ORDER BY id")
        .map_err(err)?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(err)?;
    rows.map(|r| decode(r.map_err(err)?)).collect()
}
fn request(conn: &Connection, id: &str) -> Result<RequestRecord, AppError> {
    decode(
        conn.query_row(
            "SELECT payload FROM route_decisions WHERE request_id=?1",
            [id],
            |r| r.get(0),
        )
        .map_err(err)?,
    )
}
fn write_request(conn: &Connection, r: &RequestRecord) -> Result<(), AppError> {
    conn.execute(
        "UPDATE route_decisions SET payload=?2,state=?3,reporting_project_id=?4 WHERE request_id=?1",
        params![r.id, json(r)?, r.state, r.reporting_project_id],
    )
    .map_err(err)?;
    Ok(())
}
fn attempt_list(conn: &Connection, id: &str) -> Result<Vec<Attempt>, AppError> {
    let mut stmt = conn
        .prepare("SELECT payload FROM route_attempts WHERE request_id=?1 ORDER BY attempt_no")
        .map_err(err)?;
    let rows = stmt
        .query_map([id], |r| r.get::<_, String>(0))
        .map_err(err)?;
    rows.map(|r| decode(r.map_err(err)?)).collect()
}
fn budget_totals(conn: &Connection, id: &str, start: i64) -> Result<Totals, AppError> {
    conn.query_row(
        "SELECT payload FROM budget_usage WHERE budget_id=?1 AND window_start=?2",
        params![id, start],
        |r| r.get::<_, String>(0),
    )
    .optional()
    .map_err(err)?
    .map(decode)
    .transpose()
    .map(|v| {
        v.unwrap_or_else(|| Totals {
            cost: "0".into(),
            ..Default::default()
        })
    })
}
fn add_attempt(t: &mut Totals, a: &Attempt) -> Result<(), AppError> {
    t.attempts += 1;
    if let Some(usage) = &a.usage {
        t.tokens = t
            .tokens
            .checked_add(usage.tokens()?)
            .ok_or_else(|| err("token overflow"))?;
    }
    if a.usage.is_none() || !a.usage_complete {
        t.unknown_usage += 1;
    }
    if let Some(cost) = &a.estimated_cost_usd {
        t.cost = decimal(&t.cost)?
            .checked_add(decimal(cost)?)
            .ok_or_else(|| err("total cost overflow"))?
            .normalize()
            .to_string();
    }
    if a.estimated_cost_usd.is_none() || !a.usage_complete {
        t.unknown_cost += 1;
    }
    Ok(())
}
fn account_budget(
    tx: &Transaction<'_>,
    b: &Budget,
    start: i64,
    end: i64,
    a: &Attempt,
) -> Result<(), AppError> {
    let previous: Option<(Option<String>,Option<u64>, bool, bool)> = tx.query_row(
        "SELECT accounted_cost,accounted_tokens,partial_cost,partial_usage FROM budget_attempts WHERE budget_id=?1 AND request_id=?2 AND attempt_no=?3",
        params![b.id,a.request_id,a.attempt_no], |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().map_err(err)?;
    let mut totals = budget_totals(tx, &b.id, start)?;
    if let Some((cost, tokens, partial_cost, partial_usage)) = &previous {
        if let Some(cost) = cost {
            totals.cost = (decimal(&totals.cost)? - decimal(cost)?).to_string();
        }
        if cost.is_none() || *partial_cost {
            totals.unknown_cost -= 1;
        }
        if let Some(tokens) = tokens {
            totals.tokens -= tokens;
        }
        if tokens.is_none() || *partial_usage {
            totals.unknown_usage -= 1;
        }
        totals.attempts -= 1;
    } else {
        let counted: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM budget_attempts WHERE budget_id=?1 AND request_id=?2)",
                params![b.id, a.request_id],
                |r| r.get(0),
            )
            .map_err(err)?;
        if !counted {
            totals.requests += 1;
        }
    }
    add_attempt(&mut totals, a)?;
    let tokens = a.usage.as_ref().map(Usage::tokens).transpose()?;
    tx.execute("INSERT INTO budget_attempts(budget_id,request_id,attempt_no,window_start,accounted_cost,accounted_tokens,partial_cost,partial_usage) VALUES(?1,?2,?3,?4,?5,?6,?7,?7) ON CONFLICT(budget_id,request_id,attempt_no) DO UPDATE SET accounted_cost=excluded.accounted_cost,accounted_tokens=excluded.accounted_tokens,partial_cost=excluded.partial_cost,partial_usage=excluded.partial_usage",params![b.id,a.request_id,a.attempt_no,start,a.estimated_cost_usd,tokens,!a.usage_complete]).map_err(err)?;
    tx.execute("INSERT INTO budget_usage(budget_id,window_start,window_end,payload) VALUES(?1,?2,?3,?4) ON CONFLICT(budget_id,window_start) DO UPDATE SET payload=excluded.payload",params![b.id,start,end,json(&totals)?]).map_err(err)?;
    Ok(())
}
/// Backfill shares the same idempotent delta path as ordinary settlement.
fn rebuild_budget(tx: &Transaction<'_>, b: &Budget, start: i64, end: i64) -> Result<(), AppError> {
    tx.execute(
        "DELETE FROM budget_attempts WHERE budget_id=?1 AND window_start=?2",
        params![b.id, start],
    )
    .map_err(err)?;
    tx.execute(
        "DELETE FROM budget_usage WHERE budget_id=?1 AND window_start=?2",
        params![b.id, start],
    )
    .map_err(err)?;
    tx.execute(
        "INSERT INTO budget_usage(budget_id,window_start,window_end,payload) VALUES(?1,?2,?3,?4)",
        params![
            b.id,
            start,
            end,
            json(&Totals {
                cost: "0".into(),
                ..Default::default()
            })?
        ],
    )
    .map_err(err)?;
    let mut stmt = tx.prepare("SELECT d.payload,a.payload FROM route_decisions d JOIN route_attempts a ON a.request_id=d.request_id WHERE d.ts>=?1 AND d.ts<?2 AND a.state<>'started'").map_err(err)?;
    let rows = stmt
        .query_map(params![start, end], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(err)?;
    for row in rows {
        let (r, a) = row.map_err(err)?;
        let r: RequestRecord = decode(r)?;
        if matches(b, &r) {
            let a: Attempt = decode(a)?;
            account_budget(tx, b, start, end, &a)?;
        }
    }
    Ok(())
}
fn finalize(tx: &Transaction<'_>, a: &Attempt) -> Result<(), AppError> {
    tx.execute(
        "UPDATE route_attempts SET state=?3,payload=?4 WHERE request_id=?1 AND attempt_no=?2",
        params![a.request_id, a.attempt_no, a.state, json(a)?],
    )
    .map_err(err)?;
    let mut r = request(tx, &a.request_id)?;
    let mut totals = Totals {
        cost: "0".into(),
        ..Default::default()
    };
    for other in attempt_list(tx, &r.id)? {
        if other.state != "started" {
            add_attempt(&mut totals, &other)?;
        }
    }
    r.attempts = totals.attempts;
    r.tokens = totals.tokens;
    r.estimated_cost_usd = totals.cost;
    r.unknown_cost_attempts = totals.unknown_cost;
    r.unknown_usage_attempts = totals.unknown_usage;
    write_request(tx, &r)?;
    rollups::sync_request(tx, &r)?;
    for b in budgets(tx)?.iter().filter(|b| b.enabled && matches(b, &r)) {
        let (start, end) = window_bounds(&b.window, r.created_at)?;
        account_budget(tx, b, start, end, a)?;
        let totals = budget_totals(tx, &b.id, start)?;
        let spent = decimal(&totals.cost)?;
        let reason = if b.limit_cost.is_some() && a.price.is_none() {
            Some("UNPRICED")
        } else if (b.limit_cost.is_some() && totals.unknown_cost > 0)
            || (b.limit_tokens.is_some() && totals.unknown_usage > 0)
        {
            Some("USAGE_UNKNOWN")
        } else if b
            .limit_cost
            .as_deref()
            .map(decimal)
            .transpose()?
            .is_some_and(|cap| spent >= cap)
            || b.limit_tokens.is_some_and(|cap| totals.tokens >= cap)
        {
            Some("BUDGET_BLOCK")
        } else {
            None
        };
        if let Some(reason) = reason {
            notifications::record(tx, b, start, reason)?;
        }
    }
    Ok(())
}

impl Database {
    pub fn ledger_start(&self, r: &RequestRecord) -> Result<(), AppError> {
        let mut conn = lock_conn!(self.conn);
        let tx = conn.transaction().map_err(err)?;
        tx.execute("INSERT INTO route_decisions(request_id,ts,agent,project_id,state,payload) VALUES(?1,?2,?3,?4,?5,?6)",params![r.id,r.created_at,r.agent,r.project_id,r.state,json(r)?]).map_err(err)?;
        rollups::sync_request(&tx, r)?;
        tx.commit().map_err(err)
    }
    pub fn ledger_context(
        &self,
        id: &str,
        model: &str,
        session: Option<String>,
    ) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        let mut r = request(&conn, id)?;
        r.request_model = model.chars().take(256).collect();
        r.session_id = session;
        write_request(&conn, &r)
    }
    pub fn ledger_admit(
        &self,
        id: &str,
        provider: &str,
        account: Option<String>,
        model: &str,
        price: Option<PriceSnapshot>,
    ) -> Result<Admission, AppError> {
        if let Some(price) = &price {
            price.validate()?;
        }
        let mut conn = lock_conn!(self.conn);
        let tx = conn.transaction().map_err(err)?;
        let mut r = request(&tx, id)?;
        let mut warnings = vec![];
        let mut notifications = vec![];
        let mut blocked = None;
        if r.state == "blocked" {
            return Ok(Admission {
                attempt: None,
                warnings,
                notifications,
                blocked: Some(
                    r.reason_codes
                        .last()
                        .cloned()
                        .unwrap_or_else(|| "BUDGET_BLOCK".into()),
                ),
            });
        }
        for b in budgets(&tx)?.iter().filter(|b| b.enabled) {
            let reason = if b.scope == "project" && r.project_id.is_none() && b.action == "block" {
                Some("PROJECT_BINDING_REQUIRED")
            } else if !matches(b, &r) {
                None
            } else {
                let (start, _) = window_bounds(&b.window, r.created_at)?;
                let t = budget_totals(&tx, &b.id, start)?;
                let spent = decimal(&t.cost)?;
                if b.limit_cost.is_some() && price.is_none() {
                    Some("UNPRICED")
                } else if (b.limit_cost.is_some() && t.unknown_cost > 0)
                    || (b.limit_tokens.is_some() && t.unknown_usage > 0)
                {
                    Some("USAGE_UNKNOWN")
                } else if b
                    .limit_cost
                    .as_deref()
                    .map(decimal)
                    .transpose()?
                    .is_some_and(|cap| spent >= cap)
                    || b.limit_tokens.is_some_and(|cap| t.tokens >= cap)
                {
                    Some("BUDGET_BLOCK")
                } else {
                    None
                }
            };
            if let Some(reason) = reason {
                if b.action == "block" {
                    blocked = Some(reason.to_string());
                } else {
                    warnings.push(format!("{}:{reason}", b.id));
                }
                let (start, _) = window_bounds(&b.window, r.created_at)?;
                if let Some(alert) = notifications::record(&tx, b, start, reason)? {
                    notifications.push(alert);
                }
            }
        }
        for reason in &warnings {
            if !r.reason_codes.contains(reason) {
                r.reason_codes.push(reason.clone());
            }
        }
        let attempt = if let Some(reason) = &blocked {
            r.state = "blocked".into();
            r.reason_codes.push(reason.clone());
            None
        } else {
            let no: u64 = tx
                .query_row(
                    "SELECT COALESCE(MAX(attempt_no),0)+1 FROM route_attempts WHERE request_id=?1",
                    [id],
                    |row| row.get(0),
                )
                .map_err(err)?;
            let a = Attempt {
                request_id: id.into(),
                attempt_no: no,
                provider_id: provider.into(),
                account_id: account,
                model: model.into(),
                started_at: Utc::now().timestamp_millis(),
                ended_at: None,
                state: "started".into(),
                reason_code: None,
                response_committed: false,
                price,
                usage: None,
                usage_complete: true,
                usage_source: "unknown".into(),
                cost_source: "unknown".into(),
                estimated_cost_usd: None,
            };
            tx.execute("INSERT INTO route_attempts(request_id,attempt_no,state,payload) VALUES(?1,?2,?3,?4)",params![id,no,a.state,json(&a)?]).map_err(err)?;
            Some(a)
        };
        write_request(&tx, &r)?;
        tx.commit().map_err(err)?;
        Ok(Admission {
            attempt,
            warnings,
            notifications,
            blocked,
        })
    }
    pub fn ledger_settle(
        &self,
        id: &str,
        no: u64,
        state: &str,
        reason: Option<&str>,
        usage: Option<Usage>,
        committed: bool,
    ) -> Result<(), AppError> {
        self.ledger_settle_observed(id, no, state, reason, usage, committed, true)
    }
    pub fn ledger_settle_observed(
        &self,
        id: &str,
        no: u64,
        state: &str,
        reason: Option<&str>,
        usage: Option<Usage>,
        committed: bool,
        usage_complete: bool,
    ) -> Result<(), AppError> {
        if !matches!(state, "completed" | "failed" | "interrupted") {
            return Err(err("invalid terminal state"));
        }
        let mut conn = lock_conn!(self.conn);
        let tx = conn.transaction().map_err(err)?;
        let mut a: Attempt = decode(
            tx.query_row(
                "SELECT payload FROM route_attempts WHERE request_id=?1 AND attempt_no=?2",
                params![id, no],
                |r| r.get(0),
            )
            .map_err(err)?,
        )?;
        // A disconnect/duplicate callback cannot erase already observed usage.
        if a.state == "started" {
            a.state = state.into();
            a.reason_code = reason.map(str::to_string);
            a.ended_at = Some(Utc::now().timestamp_millis());
        }
        a.response_committed |= committed;
        if let Some(usage) = usage {
            usage.tokens()?;
            // A partial callback cannot replace a fully observed final usage.
            if a.usage.is_none() || !a.usage_complete || usage_complete {
                a.usage = Some(usage);
                a.usage_complete = usage_complete;
                a.usage_source = "reported".into();
            }
        }
        if let (Some(price), Some(usage)) = (&a.price, &a.usage) {
            a.estimated_cost_usd = Some(price.cost(usage)?);
            a.cost_source = "price_table".into();
        }
        finalize(&tx, &a)?;
        tx.commit().map_err(err)
    }
    pub fn ledger_finish(&self, id: &str, state: &str) -> Result<(), AppError> {
        let mut conn = lock_conn!(self.conn);
        let tx = conn.transaction().map_err(err)?;
        for mut a in attempt_list(&tx, id)?
            .into_iter()
            .filter(|a| a.state == "started")
        {
            a.state = "interrupted".into();
            a.reason_code = Some("USAGE_UNKNOWN".into());
            a.ended_at = Some(Utc::now().timestamp_millis());
            finalize(&tx, &a)?;
        }
        let mut r = request(&tx, id)?;
        if r.state == "pending" {
            r.state = state.into();
        }
        write_request(&tx, &r)?;
        tx.commit().map_err(err)
    }
    pub fn ledger_recover(&self) -> Result<(), AppError> {
        let ids = {
            let conn = lock_conn!(self.conn);
            let mut stmt=conn.prepare("SELECT request_id FROM route_decisions WHERE state='pending' OR request_id IN (SELECT request_id FROM route_attempts WHERE state='started')").map_err(err)?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(err)?;
            rows.collect::<Result<Vec<_>, _>>().map_err(err)?
        };
        for id in ids {
            self.ledger_finish(&id, "interrupted")?;
        }
        Ok(())
    }
    pub fn ledger_route(&self, trace: &crate::gateway::RequestTrace) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM route_decisions WHERE request_id=?1)",
                [&trace.id],
                |r| r.get(0),
            )
            .map_err(err)?;
        if exists {
            let mut record = request(&conn, &trace.id)?;
            record.route = Some(RouteSnapshot {
                catalog_revision: trace.catalog_revision,
                policy: trace.policy.clone(),
                decision: trace.decision.clone(),
            });
            write_request(&conn, &record)?;
        }
        Ok(())
    }
    pub fn ledger_request(&self, id: &str) -> Result<RequestRecord, AppError> {
        let conn = lock_conn!(self.conn);
        request(&conn, id)
    }
    pub fn ledger_attempts(&self, id: &str) -> Result<Vec<Attempt>, AppError> {
        let conn = lock_conn!(self.conn);
        attempt_list(&conn, id)
    }
    pub fn save_budget(&self, mut b: Budget) -> Result<Budget, AppError> {
        if b.id.is_empty() {
            b.id = uuid::Uuid::new_v4().to_string();
        }
        if b.name.trim().is_empty()
            || b.name.len() > 200
            || !matches!(b.scope.as_str(), "global" | "agent" | "project")
            || !matches!(b.window.as_str(), "daily" | "monthly")
            || !matches!(b.action.as_str(), "warn" | "block")
            || (b.limit_cost.is_none() && b.limit_tokens.is_none())
            || (b.scope == "global") != b.scope_value.is_none()
            || b.scope_value.as_ref().is_some_and(|s| s.trim().is_empty())
            || b.limit_tokens.is_some_and(|n| n > i64::MAX as u64)
        {
            return Err(err("invalid budget"));
        }
        if let Some(cost) = &b.limit_cost {
            let value = decimal(cost)?;
            if value.is_sign_negative() {
                return Err(err("negative budget"));
            }
            b.limit_cost = Some(value.normalize().to_string());
        }
        let mut conn = lock_conn!(self.conn);
        let tx = conn.transaction().map_err(err)?;
        if b.scope == "project"
            && !tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM projects WHERE id=?1)",
                    [b.scope_value.as_deref().unwrap_or_default()],
                    |r| r.get::<_, bool>(0),
                )
                .map_err(err)?
        {
            return Err(err("unknown budget project"));
        }
        if let Some(old) = budgets(&tx)?.iter().find(|old| old.id == b.id) {
            if (old.scope.as_str(), &old.scope_value, old.window.as_str())
                != (b.scope.as_str(), &b.scope_value, b.window.as_str())
            {
                return Err(err("create a new budget to change its scope or window"));
            }
        }
        let (start, end) = window_bounds(&b.window, Utc::now().timestamp_millis())?;
        if b.enabled {
            let coverage: i64 = tx
                .query_row(
                    "SELECT created_at FROM phi_schema_migrations WHERE version=100",
                    [],
                    |r| r.get(0),
                )
                .map_err(err)?;
            let legacy_until: i64 = tx
                .query_row(
                    "SELECT value FROM ledger_metadata WHERE key='legacy_until'",
                    [],
                    |r| r.get(0),
                )
                .map_err(err)?;
            if coverage > start && legacy_until >= start {
                return Err(err("BUDGET_HISTORY_INCOMPLETE: pre-ledger usage cannot be reconstructed; enable this budget in the next complete UTC window"));
            }
        }
        // The ledger is retained independently; no truncated routing data is imported.
        tx.execute("INSERT INTO budgets(id,payload) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",params![b.id,json(&b)?]).map_err(err)?;
        rebuild_budget(&tx, &b, start, end)?;
        tx.commit().map_err(err)?;
        Ok(b)
    }
    pub fn budget_status(&self) -> Result<Vec<BudgetStatus>, AppError> {
        let conn = lock_conn!(self.conn);
        let now = Utc::now().timestamp_millis();
        budgets(&conn)?.into_iter().map(|b|{
            let (start,end)=window_bounds(&b.window,now)?;
            let totals=budget_totals(&conn,&b.id,start)?;
            let mut stmt=conn.prepare("SELECT DISTINCT d.payload FROM route_decisions d JOIN route_attempts a ON a.request_id=d.request_id WHERE a.state='started' AND d.ts>=?1 AND d.ts<?2").map_err(err)?;
            let rows=stmt.query_map(params![start,end],|r|r.get::<_,String>(0)).map_err(err)?;
            let mut in_flight=0;for row in rows {if matches(&b,&decode(row.map_err(err)?)?){in_flight+=1;}}
            let mut alerts_stmt=conn.prepare("SELECT reason,created_at FROM budget_alerts WHERE budget_id=?1 AND window_start=?2 ORDER BY created_at DESC").map_err(err)?;
            let alerts=alerts_stmt.query_map(params![b.id,start],|r|Ok(BudgetAlert{budget_id:b.id.clone(),name:b.name.clone(),window_start:start,reason:r.get(0)?,created_at:r.get(1)?})).map_err(err)?.collect::<Result<Vec<_>,_>>().map_err(err)?;
            Ok(BudgetStatus{budget:b,window_start:start,window_end:end,totals,in_flight,alerts})
        }).collect()
    }
    pub fn ledger_page(&self, q: LedgerQuery) -> Result<LedgerPage, AppError> {
        let conn = lock_conn!(self.conn);
        let now = Utc::now().timestamp_millis();
        let since = q.since.unwrap_or(window_bounds("monthly", now)?.0);
        let until = q.until.unwrap_or(now + 1);
        if until <= since
            || until
                .checked_sub(since)
                .is_none_or(|range| range > 366 * 86_400_000)
        {
            return Err(err("ledger range must be at most 366 days"));
        }
        let offset =
            i64::try_from(q.offset.unwrap_or(0)).map_err(|_| err("invalid page offset"))?;
        let (totals, dimensions) = rollups::report(&conn, &q, since, until)?;
        let total = totals.requests;
        let mut stmt = conn.prepare("SELECT payload FROM route_decisions WHERE ts>=?1 AND ts<?2 AND (?3 IS NULL OR agent=?3)
            AND (?4 IS NULL OR COALESCE(reporting_project_id,project_id,'')=?4)
            ORDER BY ts DESC,request_id DESC LIMIT 50 OFFSET ?5").map_err(err)?;
        let rows = stmt
            .query_map(params![since, until, q.agent, q.project_id, offset], |r| {
                r.get::<_, String>(0)
            })
            .map_err(err)?;
        let records = rows
            .map(|row| decode(row.map_err(err)?))
            .collect::<Result<Vec<RequestRecord>, AppError>>()?;
        let coverage_since = conn
            .query_row(
                "SELECT created_at FROM phi_schema_migrations WHERE version=100",
                [],
                |r| r.get(0),
            )
            .map_err(err)?;
        Ok(LedgerPage {
            records,
            total,
            totals,
            dimensions,
            coverage_since,
        })
    }
}

#[cfg(test)]
mod tests;

pub mod billing;
