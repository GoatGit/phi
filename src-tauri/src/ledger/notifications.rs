//! Persistent budget alerts and optional desktop delivery, independent of the main window.
use super::*;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tauri_plugin_notification::NotificationExt;

pub(super) fn record(
    conn: &Connection,
    budget: &Budget,
    window_start: i64,
    reason: &str,
) -> Result<Option<BudgetAlert>, AppError> {
    let at = Utc::now().timestamp_millis();
    let inserted = conn.execute("INSERT OR IGNORE INTO budget_alerts(budget_id,window_start,reason,created_at) VALUES(?1,?2,?3,?4)",
        params![budget.id,window_start,reason,at]).map_err(err)?;
    Ok((inserted > 0).then(|| BudgetAlert {
        budget_id: budget.id.clone(),
        name: budget.name.clone(),
        window_start,
        reason: reason.into(),
        created_at: at,
    }))
}

impl Database {
    pub fn budget_system_notifications(&self) -> Result<bool, AppError> {
        let conn = lock_conn!(self.conn);
        let value: Option<i64> = conn
            .query_row(
                "SELECT value FROM ledger_metadata WHERE key='system_notifications'",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(err)?;
        Ok(value == Some(1))
    }
    pub fn set_budget_system_notifications(&self, enabled: bool) -> Result<(), AppError> {
        lock_conn!(self.conn).execute("INSERT INTO ledger_metadata(key,value) VALUES('system_notifications',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [i64::from(enabled)]).map_err(err)?;
        Ok(())
    }
    fn claim_budget_alerts(&self) -> Result<Vec<BudgetAlert>, AppError> {
        let mut conn = lock_conn!(self.conn);
        let tx = conn.transaction().map_err(err)?;
        let alerts = {
            let mut stmt = tx.prepare("SELECT a.budget_id,b.payload,a.window_start,a.reason,a.created_at FROM budget_alerts a JOIN budgets b ON b.id=a.budget_id WHERE a.notified_at IS NULL ORDER BY a.created_at").map_err(err)?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, i64>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, i64>(4)?,
                    ))
                })
                .map_err(err)?;
            let mut alerts = vec![];
            for row in rows {
                let (budget_id, payload, window_start, reason, created_at) = row.map_err(err)?;
                let b: Budget = decode(payload)?;
                // Retain every warning in the UI, but avoid a notification storm after a long shutdown.
                if b.enabled && created_at >= Utc::now().timestamp_millis() - 86_400_000 {
                    alerts.push(BudgetAlert {
                        budget_id,
                        name: b.name,
                        window_start,
                        reason,
                        created_at,
                    });
                }
            }
            alerts
        };
        // At most one desktop attempt. Persisted alerts remain visible even if the OS suppresses them.
        tx.execute(
            "UPDATE budget_alerts SET notified_at=?1 WHERE notified_at IS NULL",
            [Utc::now().timestamp_millis()],
        )
        .map_err(err)?;
        tx.commit().map_err(err)?;
        Ok(alerts)
    }
}

fn text(language: &str, reason: &str) -> (&'static str, &'static str) {
    match language {
        "zh" => (
            "PHI 预算提醒",
            match reason {
                "UNPRICED" => "缺少模型价格",
                "USAGE_UNKNOWN" => "存在未知用量",
                "PROJECT_BINDING_REQUIRED" => "请求缺少可信项目绑定",
                _ => "已达到预算阈值",
            },
        ),
        "zh-TW" => (
            "PHI 預算提醒",
            match reason {
                "UNPRICED" => "缺少模型價格",
                "USAGE_UNKNOWN" => "存在未知用量",
                "PROJECT_BINDING_REQUIRED" => "請求缺少可信專案綁定",
                _ => "已達到預算閾值",
            },
        ),
        "ja" => (
            "PHI 予算通知",
            match reason {
                "UNPRICED" => "モデル価格が未設定です",
                "USAGE_UNKNOWN" => "不明な使用量があります",
                "PROJECT_BINDING_REQUIRED" => "信頼できるプロジェクトの紐付けが必要です",
                _ => "予算のしきい値に達しました",
            },
        ),
        _ => (
            "PHI budget alert",
            match reason {
                "UNPRICED" => "Model price is missing",
                "USAGE_UNKNOWN" => "Usage is unknown",
                "PROJECT_BINDING_REQUIRED" => "A trusted project binding is required",
                _ => "Budget threshold reached",
            },
        ),
    }
}

pub(crate) fn publish(db: Arc<Database>, app: AppHandle) {
    tauri::async_runtime::spawn_blocking(move || {
        let alerts = match db.claim_budget_alerts() {
            Ok(alerts) => alerts,
            Err(_) => {
                log::warn!("Budget alert delivery could not read pending alerts");
                return;
            }
        };
        let system = db.budget_system_notifications().unwrap_or(false);
        let language = crate::settings::get_settings()
            .language
            .unwrap_or_else(|| "en".into());
        for alert in alerts {
            let _ = app.emit("phi-budget-warning", &alert);
            if system {
                let (title, reason) = text(&language, &alert.reason);
                if app
                    .notification()
                    .builder()
                    .title(title)
                    .body(format!("{}: {reason}", alert.name))
                    .show()
                    .is_err()
                {
                    log::warn!("Desktop notification unavailable; the budget alert remains in PHI");
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn settlement_warns_without_another_request_and_delivery_is_claimed_once() {
        let db = Database::memory().unwrap();
        assert!(!db.budget_system_notifications().unwrap());
        db.set_budget_system_notifications(true).unwrap();
        assert!(db.budget_system_notifications().unwrap());
        db.save_budget(crate::ledger::tests::budget("block"))
            .unwrap();
        let r = crate::ledger::tests::req(&db);
        db.ledger_admit(&r.id, "p", None, "m", Some(crate::ledger::tests::price()))
            .unwrap();
        assert!(db.claim_budget_alerts().unwrap().is_empty());
        for _ in 0..2 {
            db.ledger_settle(
                &r.id,
                1,
                "completed",
                None,
                Some(crate::ledger::tests::usage()),
                true,
            )
            .unwrap();
        }
        let alerts = db.claim_budget_alerts().unwrap();
        assert_eq!(alerts.len(), 1);
        assert_eq!(alerts[0].reason, "BUDGET_BLOCK");
        assert!(db.claim_budget_alerts().unwrap().is_empty());
        assert_eq!(db.budget_status().unwrap()[0].alerts.len(), 1);
    }
}
