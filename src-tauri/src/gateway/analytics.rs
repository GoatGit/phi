//! Read-only routing status and bounded request-window aggregates.
use super::*;
use rust_decimal::Decimal;
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TraceQuery {
    pub since: Option<i64>,
    pub app_id: Option<String>,
    pub group_id: Option<String>,
    pub policy_id: Option<String>,
    pub outcome: Option<String>,
    pub offset: Option<usize>,
}
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub requests: u64,
    pub completed: u64,
    pub failed: u64,
    pub interrupted: u64,
    pub failovers: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub unknown_usage: u64,
    pub estimated_cost: String,
    pub unknown_cost: u64,
    pub classifier_calls: u64,
    pub classifier_cost: String,
    pub classifier_unknown_cost: u64,
    pub p50_latency_ms: u64,
    pub p95_latency_ms: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TracePage {
    pub traces: Vec<RequestTrace>,
    pub total: usize,
    pub summary: Summary,
    pub retained_since: Option<i64>,
    pub members: Vec<routing::MemberStatus>,
    pub active: Vec<RequestTrace>,
}
impl Database {
    pub fn gateway_trace_page(&self, query: TraceQuery) -> Result<TracePage, AppError> {
        let since = query
            .since
            .unwrap_or_else(|| chrono::Utc::now().timestamp_millis() - 86_400_000);
        let mut traces = {
            let conn = lock_conn!(self.conn);
            let mut stmt=conn.prepare("SELECT payload FROM gateway_traces WHERE created_at >= ?1 ORDER BY created_at DESC LIMIT 50000").map_err(db_error)?;
            let rows = stmt
                .query_map([since], |r| r.get::<_, String>(0))
                .map_err(db_error)?;
            rows.map(|r| {
                serde_json::from_str::<RequestTrace>(&r.map_err(db_error)?).map_err(db_error)
            })
            .collect::<Result<Vec<_>, _>>()?
        };
        let active = self.gateway_runtime.active();
        for trace in &mut traces {
            if matches!(trace.outcome.as_str(), "pending" | "upstream_accepted")
                && trace.created_at < self.gateway_runtime.started_at
                && !active.iter().any(|a| a.id == trace.id)
            {
                trace.outcome = "interrupted".into();
            }
        }
        let retained_since = {
            let conn = lock_conn!(self.conn);
            conn.query_row("SELECT MIN(created_at) FROM gateway_traces", [], |r| {
                r.get::<_, Option<i64>>(0)
            })
            .map_err(db_error)?
        };
        let mut traces: Vec<_> = traces
            .into_iter()
            .filter(|t| matches_query(t, &query))
            .collect();
        let summary = summarize(&traces);
        let total = traces.len();
        let offset = query.offset.unwrap_or(0).min(total);
        traces = traces.into_iter().skip(offset).take(50).collect();
        Ok(TracePage {
            traces,
            total,
            summary,
            retained_since,
            members: self.gateway_runtime.statuses(),
            active: self
                .gateway_runtime
                .active()
                .into_iter()
                .filter(|t| matches_query(t, &query))
                .collect(),
        })
    }
}
fn matches_query(t: &RequestTrace, q: &TraceQuery) -> bool {
    q.app_id.as_ref().is_none_or(|a| a == &t.app_id)
        && q.group_id.as_ref().is_none_or(|g| {
            t.decision.as_ref().is_some_and(|d| {
                d.group_id.as_ref() == Some(g) || d.groups.iter().any(|group| &group.id == g)
            })
        })
        && q.policy_id.as_ref().is_none_or(|p| p == &t.policy.id)
        && q.outcome.as_ref().is_none_or(|o| o == &t.outcome)
}
fn summarize(traces: &[RequestTrace]) -> Summary {
    let mut s = Summary::default();
    let mut costs = Decimal::ZERO;
    let mut classifier_costs = Decimal::ZERO;
    let mut latencies = vec![];
    for t in traces {
        if matches!(t.outcome.as_str(), "pending" | "upstream_accepted") {
            continue;
        }
        s.requests += 1;
        match t.outcome.as_str() {
            "completed" => s.completed += 1,
            "interrupted" => s.interrupted += 1,
            _ => s.failed += 1,
        }
        if t.events
            .iter()
            .map(|e| (&e.supplier_id, &e.model))
            .collect::<HashSet<_>>()
            .len()
            > 1
        {
            s.failovers += 1;
        }
        match (t.input_tokens, t.output_tokens) {
            (Some(i), Some(o)) => {
                s.input_tokens += u64::from(i);
                s.output_tokens += u64::from(o);
            }
            _ => s.unknown_usage += 1,
        }
        if let Some(cost) = t
            .estimated_cost
            .as_deref()
            .and_then(|c| c.parse::<Decimal>().ok())
        {
            costs += cost;
        } else {
            s.unknown_cost += 1;
        }
        if let Some(d) = &t.decision {
            for i in &d.intents {
                if !i.cached
                    && !matches!(
                        i.outcome.as_str(),
                        "unconfigured" | "no_user_text" | "budget_exhausted"
                    )
                {
                    s.classifier_calls += 1;
                    if let Some(cost) = i
                        .estimated_cost
                        .as_deref()
                        .and_then(|c| c.parse::<Decimal>().ok())
                    {
                        classifier_costs += cost;
                    } else {
                        s.classifier_unknown_cost += 1;
                    }
                }
            }
        }
        latencies.push(t.latency_ms);
    }
    latencies.sort_unstable();
    if !latencies.is_empty() {
        s.p50_latency_ms = latencies[(latencies.len() - 1) / 2];
        s.p95_latency_ms =
            latencies[((latencies.len() * 95).div_ceil(100) - 1).min(latencies.len() - 1)];
    }
    s.estimated_cost = costs.to_string();
    s.classifier_cost = classifier_costs.to_string();
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn trace(index: usize) -> RequestTrace {
        serde_json::from_value(json!({
            "id":format!("t-{index}"),"createdAt":chrono::Utc::now().timestamp_millis()+index as i64,
            "appId":"claude","requestModel":"alias","catalogRevision":1,
            "policy":{"id":"p","name":"P","appId":"claude","enabled":true,"matchModel":"alias","priority":1,"failover":true,"candidates":[]},
            "events":[{"supplierId":"s","supplierName":"Snapshot","model":"m","outcome":"upstream_accepted"}],
            "outcome":"completed","latencyMs":100+index,"inputTokens":3,"outputTokens":7,"estimatedCost":"0.01",
            "decision":{"reason":"group","groupId":"g","groups":[{"id":"g","name":"Group","appIds":["claude"],"members":[]}],"candidates":[],"intents":[],"sessionHash":null,"affinity":"off"}
        })).unwrap()
    }
    #[test]
    fn pagination_aggregates_the_entire_filtered_window_with_unknowns_separate() {
        let db = Database::memory().unwrap();
        for index in 0..65 {
            let mut t = trace(index);
            if index == 0 {
                t.input_tokens = None;
                t.output_tokens = None;
                t.estimated_cost = None;
            }
            if index == 1 {
                let mut event = t.events[0].clone();
                event.supplier_id = "other".into();
                t.events.insert(0, event);
            }
            if index == 2 {
                t.events.push(t.events[0].clone());
            }
            db.write_gateway_trace(&t).unwrap();
        }
        let mut pending = trace(65);
        pending.outcome = "pending".into();
        db.write_gateway_trace(&pending).unwrap();
        let page = db
            .gateway_trace_page(TraceQuery {
                since: Some(0),
                group_id: Some("g".into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(page.total, 66);
        assert_eq!(page.traces.len(), 50);
        assert_eq!(page.active.len(), 1);
        assert_eq!(page.summary.requests, 65);
        assert_eq!(page.summary.completed, 65);
        assert_eq!(page.summary.failovers, 1);
        assert_eq!(page.summary.unknown_usage, 1);
        assert_eq!(page.summary.unknown_cost, 1);
        assert_eq!(page.summary.input_tokens, 64 * 3);
        assert_eq!(
            page.summary.estimated_cost.parse::<Decimal>().unwrap(),
            Decimal::new(64, 2)
        );
        assert_eq!(page.summary.p50_latency_ms, 132);
        assert_eq!(page.summary.p95_latency_ms, 161);
        let next = db
            .gateway_trace_page(TraceQuery {
                since: Some(0),
                offset: Some(50),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(next.traces.len(), 16);
        assert_eq!(next.summary.requests, 65);
        assert_eq!(
            db.gateway_trace_page(TraceQuery {
                app_id: Some("codex".into()),
                ..Default::default()
            })
            .unwrap()
            .total,
            0
        );
    }
    #[test]
    fn classifier_overhead_counts_calls_without_double_counting_cache() {
        let mut t = trace(0);
        t.decision.as_mut().unwrap().intents = vec![
            routing::IntentDecision {
                outcome: "matched".into(),
                estimated_cost: Some("0.004".into()),
                ..Default::default()
            },
            routing::IntentDecision {
                outcome: "timeout".into(),
                ..Default::default()
            },
            routing::IntentDecision {
                outcome: "matched".into(),
                cached: true,
                estimated_cost: Some("0.004".into()),
                ..Default::default()
            },
            routing::IntentDecision {
                outcome: "budget_exhausted".into(),
                ..Default::default()
            },
        ];
        let s = summarize(&[t]);
        assert_eq!(s.classifier_calls, 2);
        assert_eq!(s.classifier_unknown_cost, 1);
        assert_eq!(s.classifier_cost, "0.004");
    }
    #[test]
    fn old_pending_record_is_interrupted_but_current_live_record_is_pending() {
        let db = Database::memory().unwrap();
        let mut old = trace(0);
        old.created_at = db.gateway_runtime.started_at - 100;
        old.outcome = "pending".into();
        old.input_tokens = None;
        old.output_tokens = None;
        old.estimated_cost = None;
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO gateway_traces(id,created_at,payload) VALUES(?1,?2,?3)",
                params![old.id, old.created_at, serde_json::to_string(&old).unwrap()],
            )
            .unwrap();
        }
        let live = RequestTrace {
            id: "live".into(),
            ..old.clone()
        };
        db.write_gateway_trace(&live).unwrap();
        let page = db
            .gateway_trace_page(TraceQuery {
                since: Some(0),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(page.summary.interrupted, 1);
        assert_eq!(page.summary.unknown_usage, 1);
        assert_eq!(page.active.len(), 1);
        assert!(page
            .traces
            .iter()
            .any(|t| t.id == "live" && t.outcome == "pending"));
    }
}
