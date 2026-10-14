//! Manual statement comparison. These records never change attempt costs or budgets.
use super::*;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BillingAdjustment {
    pub id: String,
    pub account_id: String,
    pub since: i64,
    pub until: i64,
    pub currency: String,
    pub amount: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BillingComparison {
    pub statement: BillingAdjustment,
    pub estimate: Totals,
    pub difference_usd: Option<String>,
    pub complete_coverage: bool,
}

impl Database {
    pub fn save_billing_adjustment(&self, mut value: BillingAdjustment) -> Result<(), AppError> {
        if value.account_id.trim().is_empty()
            || value.account_id.len() > 256
            || value.until <= value.since
            || value
                .until
                .checked_sub(value.since)
                .is_none_or(|n| n > 366 * 86_400_000)
            || value.since % 86_400_000 != 0
            || value.until % 86_400_000 != 0
            || value.currency.len() != 3
            || !value.currency.bytes().all(|b| b.is_ascii_uppercase())
            || decimal(&value.amount)?.is_sign_negative()
        {
            return Err(err(
                "invalid billing statement: use UTC dates and an ISO currency",
            ));
        }
        if value.id.is_empty() {
            value.id = uuid::Uuid::new_v4().to_string();
        }
        value.amount = decimal(&value.amount)?.normalize().to_string();
        let conn = lock_conn!(self.conn);
        conn.execute("INSERT INTO billing_adjustments(id,payload) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload", params![value.id,json(&value)?]).map_err(err)?;
        Ok(())
    }
    pub fn delete_billing_adjustment(&self, id: &str) -> Result<(), AppError> {
        lock_conn!(self.conn)
            .execute("DELETE FROM billing_adjustments WHERE id=?1", [id])
            .map_err(err)?;
        Ok(())
    }
    pub fn billing_comparisons(&self) -> Result<Vec<BillingComparison>, AppError> {
        let conn = lock_conn!(self.conn);
        let coverage: i64 = conn
            .query_row(
                "SELECT created_at FROM phi_schema_migrations WHERE version=100",
                [],
                |r| r.get(0),
            )
            .map_err(err)?;
        let mut stmt = conn
            .prepare("SELECT payload FROM billing_adjustments ORDER BY id")
            .map_err(err)?;
        let statements = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(err)?;
        let mut results = vec![];
        for value in statements {
            let statement: BillingAdjustment = decode(value.map_err(err)?)?;
            let mut estimate = Totals {
                cost: "0".into(),
                ..Default::default()
            };
            let mut rows = conn.prepare("SELECT a.payload FROM route_attempts a JOIN route_decisions d ON d.request_id=a.request_id WHERE d.ts>=?1 AND d.ts<?2").map_err(err)?;
            let mut requests = std::collections::HashSet::new();
            let mut complete =
                coverage <= statement.since && statement.until <= Utc::now().timestamp_millis();
            for value in rows
                .query_map(params![statement.since, statement.until], |r| {
                    r.get::<_, String>(0)
                })
                .map_err(err)?
            {
                let a: Attempt = decode(value.map_err(err)?)?;
                // Unknown accounts may belong to this statement. Never claim full coverage.
                if a.account_id.is_none() {
                    complete = false;
                }
                if a.account_id.as_deref() == Some(&statement.account_id) {
                    if a.state == "started" {
                        complete = false;
                        continue;
                    }
                    add_attempt(&mut estimate, &a)?;
                    requests.insert(a.request_id);
                }
            }
            estimate.requests = requests.len() as u64;
            complete &= estimate.unknown_cost == 0 && estimate.unknown_usage == 0;
            let difference_usd = (statement.currency == "USD")
                .then(|| {
                    decimal(&statement.amount)?
                        .checked_sub(decimal(&estimate.cost)?)
                        .map(|n| n.normalize().to_string())
                        .ok_or_else(|| err("billing difference overflow"))
                })
                .transpose()?;
            results.push(BillingComparison {
                statement,
                estimate,
                difference_usd,
                complete_coverage: complete,
            });
        }
        Ok(results)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn billing_comparison_never_changes_usage_or_budget_and_keeps_currencies_separate() {
        let db = Database::memory().unwrap();
        let r = super::super::tests::req(&db);
        let a = db
            .ledger_admit(
                &r.id,
                "p",
                Some("account".into()),
                "m",
                Some(super::super::tests::price()),
            )
            .unwrap()
            .attempt
            .unwrap();
        db.ledger_settle(
            &r.id,
            a.attempt_no,
            "completed",
            None,
            Some(super::super::tests::usage()),
            true,
        )
        .unwrap();
        db.save_budget(super::super::tests::budget("warn")).unwrap();
        let (since, until) = window_bounds("monthly", r.created_at).unwrap();
        let statement = BillingAdjustment {
            id: "bill".into(),
            account_id: "account".into(),
            since,
            until,
            currency: "USD".into(),
            amount: "3".into(),
        };
        db.save_billing_adjustment(statement.clone()).unwrap();
        let result = db.billing_comparisons().unwrap();
        assert_eq!(result[0].estimate.cost, "2");
        assert_eq!(result[0].difference_usd.as_deref(), Some("1"));
        assert!(!result[0].complete_coverage);
        db.save_billing_adjustment(BillingAdjustment {
            currency: "CNY".into(),
            ..statement
        })
        .unwrap();
        assert!(db.billing_comparisons().unwrap()[0]
            .difference_usd
            .is_none());
        assert_eq!(db.budget_status().unwrap()[0].totals.cost, "2");
        assert_eq!(
            db.ledger_attempts(&r.id).unwrap()[0]
                .estimated_cost_usd
                .as_deref(),
            Some("2")
        );
    }
}
