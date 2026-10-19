//! Group routing semantics inspired by magpie's group/routing/affinity/trace
//! modules. Implemented for PHI's credential pool and authenticated app scope.
use super::*;
use std::sync::Mutex;

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Strategy {
    #[default]
    Ordered,
    RoundRobin,
    LeastUsed,
    Weighted,
    Manual,
}
fn yes() -> bool {
    true
}
fn one() -> u32 {
    1
}
fn attempts() -> u32 {
    3
}
fn first_byte_timeout() -> u32 {
    60
}
fn idle_timeout() -> u32 {
    180
}
fn non_streaming_timeout() -> u32 {
    600
}
fn affinity_ttl() -> u32 {
    1800
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GroupMember {
    pub id: String,
    #[serde(default)]
    pub supplier_id: Option<String>,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub group_id: Option<String>,
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(default = "one")]
    pub weight: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntentRule {
    pub id: String,
    pub name: String,
    pub description: String,
    pub member_id: String,
    #[serde(default = "yes")]
    pub enabled: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Classifier {
    pub supplier_id: String,
    pub model: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RouteGroup {
    pub id: String,
    pub name: String,
    #[serde(default = "yes")]
    pub enabled: bool,
    pub app_ids: Vec<String>,
    #[serde(default)]
    pub strategy: Strategy,
    #[serde(default)]
    pub members: Vec<GroupMember>,
    #[serde(default)]
    pub manual_member_id: Option<String>,
    #[serde(default)]
    pub session_affinity: bool,
    #[serde(default = "affinity_ttl")]
    pub affinity_ttl_seconds: u32,
    #[serde(default = "yes")]
    pub failover: bool,
    #[serde(default = "attempts")]
    pub max_attempts: u32,
    /// 流式首字节超时（秒）：等待上游首个数据块的上限。
    #[serde(default = "first_byte_timeout")]
    pub streaming_first_byte_timeout: u32,
    /// 流式静默超时（秒）：数据块之间的最大间隔，0 表示不限。
    #[serde(default = "idle_timeout")]
    pub streaming_idle_timeout: u32,
    /// 非流式总超时（秒）。
    #[serde(default = "non_streaming_timeout")]
    pub non_streaming_timeout: u32,
    #[serde(default)]
    pub classifier: Option<Classifier>,
    #[serde(default)]
    pub rules: Vec<IntentRule>,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateDecision {
    pub supplier_id: String,
    pub supplier_name: String,
    pub model: String,
    pub group_path: Vec<String>,
    pub member_path: Vec<String>,
    pub reason: String,
    pub available: bool,
    pub recent_tokens: f64,
    pub active: u32,
    pub cooldown_until: Option<i64>,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntentDecision {
    pub group_id: String,
    pub outcome: String,
    pub rule_id: Option<String>,
    pub rule_name: Option<String>,
    pub supplier_id: String,
    pub model: String,
    pub latency_ms: u64,
    pub input_tokens: Option<u32>,
    pub output_tokens: Option<u32>,
    pub estimated_cost: Option<String>,
    pub cached: bool,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteDecision {
    pub reason: String,
    pub group_id: Option<String>,
    pub groups: Vec<RouteGroup>,
    pub candidates: Vec<CandidateDecision>,
    pub intents: Vec<IntentDecision>,
    pub session_hash: Option<String>,
    pub affinity: String,
}
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberStatus {
    pub supplier_id: String,
    pub model: String,
    pub active: u32,
    pub requests: u64,
    pub successes: u64,
    pub failures: u64,
    pub recent_tokens: f64,
    pub unknown_usage: u64,
    pub cooldown_until: Option<i64>,
    pub last_error: Option<String>,
    pub last_latency_ms: Option<u64>,
    pub last_used_at: Option<i64>,
    #[serde(skip)]
    pub updated_at: i64,
}
#[derive(Clone)]
struct Affinity {
    key: String,
    expires: i64,
}
#[derive(Default)]
struct RuntimeState {
    members: HashMap<String, MemberStatus>,
    turns: HashMap<String, u64>,
    weights: HashMap<String, HashMap<String, i64>>,
    affinity: HashMap<String, Affinity>,
    intents: HashMap<String, (i64, IntentDecision)>,
    active: HashMap<String, RequestTrace>,
}
pub struct Runtime {
    inner: Mutex<RuntimeState>,
    pub started_at: i64,
}
impl Default for Runtime {
    fn default() -> Self {
        Self {
            inner: Mutex::new(RuntimeState::default()),
            started_at: now(),
        }
    }
}
pub fn candidate_key(supplier: &str, model: &str) -> String {
    format!("{supplier}\0{model}")
}
pub fn session_hash(app_id: &str, session: &str) -> String {
    format!("{:x}", Sha256::digest(format!("{app_id}\0{session}")))
}
pub(crate) fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
fn decay(status: &MemberStatus, at: i64) -> f64 {
    status.recent_tokens * 2_f64.powf(-((at - status.updated_at).max(0) as f64) / 3_600_000.)
}
impl Runtime {
    pub fn statuses(&self) -> Vec<MemberStatus> {
        let at = now();
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .members
            .values()
            .cloned()
            .map(|mut s| {
                s.recent_tokens = decay(&s, at);
                s
            })
            .collect()
    }
    pub fn active(&self) -> Vec<RequestTrace> {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .active
            .values()
            .cloned()
            .collect()
    }
    pub fn observe(&self, trace: &RequestTrace) {
        let mut state = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if matches!(trace.outcome.as_str(), "pending" | "upstream_accepted") {
            if state.active.len() < 1000 || state.active.contains_key(&trace.id) {
                state.active.insert(trace.id.clone(), trace.clone());
            }
        } else {
            state.active.remove(&trace.id);
        }
    }
    pub fn cached_intent(&self, key: &str) -> Option<IntentDecision> {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .intents
            .get(key)
            .filter(|(at, _)| now() - at < 1_800_000)
            .map(|(_, d)| {
                let mut d = d.clone();
                d.cached = true;
                d.latency_ms = 0;
                d.input_tokens = None;
                d.output_tokens = None;
                d.estimated_cost = Some("0".into());
                d
            })
    }
    pub fn cache_intent(&self, key: String, decision: IntentDecision) {
        let mut state = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        state.intents.retain(|_, (at, _)| now() - *at < 1_800_000);
        if state.intents.len() >= 2000 {
            state.intents.clear();
        }
        state.intents.insert(key, (now(), decision));
    }
    pub fn begin(&self, supplier: &str, model: &str) {
        let mut state = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if state.members.len() >= 10_000 {
            state.members.retain(|_, s| {
                s.active > 0 || s.last_used_at.is_some_and(|at| now() - at < 86_400_000)
            });
        }
        let status = state
            .members
            .entry(candidate_key(supplier, model))
            .or_insert_with(|| MemberStatus {
                supplier_id: supplier.into(),
                model: model.into(),
                ..Default::default()
            });
        status.active += 1;
        status.requests += 1;
        status.last_used_at = Some(now());
    }
    pub fn attempt_finished(&self, supplier: &str, model: &str, error: Option<&str>, latency: u64) {
        let mut state = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if error.is_some() {
            state
                .affinity
                .retain(|_, a| a.key != candidate_key(supplier, model));
        }
        let s = state
            .members
            .entry(candidate_key(supplier, model))
            .or_default();
        s.last_latency_ms = Some(latency);
        if let Some(error) = error {
            s.active = s.active.saturating_sub(1);
            s.failures += 1;
            s.last_error = Some(error.into());
            if matches!(
                error,
                "rate_limit" | "upstream_unavailable" | "transport" | "timeout" | "authentication"
            ) {
                s.cooldown_until = Some(
                    now()
                        + if error == "authentication" {
                            300_000
                        } else if error == "rate_limit" {
                            60_000
                        } else {
                            15_000
                        },
                );
            }
        }
    }
    pub fn complete(&self, trace: &RequestTrace) {
        self.observe(trace);
        let Some(event) = trace
            .events
            .iter()
            .rev()
            .find(|e| matches!(e.outcome.as_str(), "pending" | "upstream_accepted"))
        else {
            return;
        };
        let mut state = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let key = candidate_key(&event.supplier_id, &event.model);
        let s = state.members.entry(key.clone()).or_default();
        s.active = s.active.saturating_sub(1);
        let at = now();
        s.recent_tokens = decay(s, at)
            + u64::from(trace.input_tokens.unwrap_or(0))
                .saturating_add(u64::from(trace.output_tokens.unwrap_or(0))) as f64;
        if trace.input_tokens.is_none() || trace.output_tokens.is_none() {
            s.unknown_usage += 1;
        }
        s.updated_at = at;
        if trace.outcome == "completed" {
            s.successes += 1;
            s.last_error = None;
            s.cooldown_until = None;
        } else {
            s.failures += 1;
            s.last_error = Some(trace.outcome.clone());
        }
        if let Some(decision) = &trace.decision {
            if let Some(session) = &decision.session_hash {
                for group in &decision.groups {
                    let affinity_key =
                        format!("{}:{}:{}", trace.catalog_revision, group.id, session);
                    if trace.outcome == "completed"
                        && group.session_affinity
                        && event.group_path.contains(&group.id)
                    {
                        state.affinity.insert(
                            affinity_key,
                            Affinity {
                                key: key.clone(),
                                expires: at + i64::from(group.affinity_ttl_seconds) * 1000,
                            },
                        );
                    } else if trace.outcome != "completed" {
                        state.affinity.remove(&affinity_key);
                    }
                }
            }
        }
        state.affinity.retain(|_, a| a.expires > at);
        if state.affinity.len() > 10_000 {
            state.affinity.clear();
        }
    }
}

pub fn validate(catalog: &Catalog) -> Result<(), AppError> {
    if catalog.groups.len() > 100 {
        return Err(invalid("gateway.limitExceeded"));
    }
    let mut ids = HashSet::new();
    for g in &catalog.groups {
        if !identifier(&g.id)
            || !g
                .id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
            || !label(&g.name)
            || !ids.insert(&g.id)
            || g.app_ids.is_empty()
            || g.app_ids.len()
                > super::apps::ROUTING_APPS.len() + super::local_apps::LOCAL_APPS.len() + 1
            || g.members.len() > 32
            || g.rules.len() > 50
            || !(1..=11).contains(&g.max_attempts)
            || !(1..=120).contains(&g.streaming_first_byte_timeout)
            || !(0..=600).contains(&g.streaming_idle_timeout)
            || !(60..=1200).contains(&g.non_streaming_timeout)
            || !(60..=86400).contains(&g.affinity_ttl_seconds)
        {
            return Err(invalid("gateway.invalidGroup"));
        }
        let mut apps = HashSet::new();
        for a in &g.app_ids {
            if super::apps::spec_by_id(a).is_none()
                && super::local_apps::spec(a).is_none()
                && !super::typesafe::is_app(a)
            {
                return Err(invalid("gateway.invalidGroup"));
            }
            if !apps.insert(a) {
                return Err(invalid("gateway.invalidGroup"));
            }
        }
        let mut members = HashSet::new();
        for m in &g.members {
            if !identifier(&m.id) || !members.insert(&m.id) || !(1..=1000).contains(&m.weight) {
                return Err(invalid("gateway.invalidGroup"));
            }
            match (&m.supplier_id, &m.group_id) {
                (Some(id), None) => {
                    let s = catalog
                        .suppliers
                        .iter()
                        .find(|s| &s.id == id)
                        .ok_or_else(|| invalid("gateway.missingSupplier"))?;
                    if !s.models.contains(&m.model)
                        || g.app_ids
                            .iter()
                            .any(|a| !compatible(a, &s.endpoint.protocol))
                    {
                        return Err(invalid("gateway.invalidCandidate"));
                    }
                }
                (None, Some(id)) => {
                    let child = catalog
                        .groups
                        .iter()
                        .find(|g| &g.id == id)
                        .ok_or_else(|| invalid("gateway.missingGroup"))?;
                    if !m.model.is_empty() || g.app_ids.iter().any(|a| !child.app_ids.contains(a)) {
                        return Err(invalid("gateway.invalidGroup"));
                    }
                }
                _ => return Err(invalid("gateway.invalidGroup")),
            }
        }
        if g.enabled
            && (g.members.iter().all(|m| !m.enabled)
                || (g.strategy == Strategy::Manual
                    && !g
                        .members
                        .iter()
                        .any(|m| m.enabled && Some(&m.id) == g.manual_member_id.as_ref())))
        {
            return Err(invalid("gateway.emptyGroup"));
        }
        let mut rules = HashSet::new();
        for rule in &g.rules {
            if !identifier(&rule.id)
                || !rules.insert(&rule.id)
                || !label(&rule.name)
                || rule.description.trim().is_empty()
                || rule.description.chars().count() > 2000
                || !g.members.iter().any(|m| m.id == rule.member_id)
            {
                return Err(invalid("gateway.invalidRule"));
            }
        }
        if g.rules.iter().any(|r| r.enabled) && g.classifier.is_none() {
            return Err(invalid("gateway.missingClassifier"));
        }
        if let Some(c) = &g.classifier {
            let s = catalog
                .suppliers
                .iter()
                .find(|s| s.id == c.supplier_id)
                .ok_or_else(|| invalid("gateway.missingSupplier"))?;
            if !s.models.contains(&c.model) {
                return Err(invalid("gateway.invalidCandidate"));
            }
        }
        check_graph(catalog, &g.id, &mut Vec::new(), &mut 0)?;
        if enabled_leaves(catalog, &g.id) > 128 {
            return Err(invalid("gateway.limitExceeded"));
        }
        if g.enabled
            && !g.members.iter().any(|m| {
                m.enabled
                    && (g.strategy != Strategy::Manual
                        || Some(&m.id) == g.manual_member_id.as_ref())
                    && member_load(catalog, &RuntimeState::default(), m, 0) < f64::MAX
            })
        {
            return Err(invalid("gateway.emptyGroup"));
        }
    }
    for p in &catalog.policies {
        if let Some(id) = &p.group_id {
            let g = catalog
                .groups
                .iter()
                .find(|g| &g.id == id)
                .ok_or_else(|| invalid("gateway.missingGroup"))?;
            if !p.candidates.is_empty() || !g.app_ids.contains(&p.app_id) {
                return Err(invalid("gateway.invalidPolicy"));
            }
        }
    }
    Ok(())
}
fn check_graph(
    catalog: &Catalog,
    id: &str,
    path: &mut Vec<String>,
    visits: &mut usize,
) -> Result<(), AppError> {
    *visits += 1;
    if *visits > 4096 {
        return Err(invalid("gateway.limitExceeded"));
    }
    if path.iter().any(|p| p == id) || path.len() >= 8 {
        return Err(invalid("gateway.groupCycle"));
    }
    path.push(id.into());
    if let Some(g) = catalog.groups.iter().find(|g| g.id == id) {
        for member in &g.members {
            if let Some(child) = &member.group_id {
                check_graph(catalog, child, path, visits)?;
            }
        }
    }
    path.pop();
    Ok(())
}

fn enabled_leaves(catalog: &Catalog, id: &str) -> usize {
    let Some(g) = catalog.groups.iter().find(|g| g.id == id && g.enabled) else {
        return 0;
    };
    let mut count = 0;
    for m in g.members.iter().filter(|m| m.enabled) {
        count += m
            .group_id
            .as_ref()
            .map(|id| enabled_leaves(catalog, id))
            .unwrap_or(1);
        if count > 128 {
            return count;
        }
    }
    count
}

pub fn connection_id(app_id: &str) -> String {
    format!("connection/{app_id}")
}

pub fn app_connection<'a>(catalog: &'a Catalog, app_id: &str) -> Option<&'a RoutePolicy> {
    let id = connection_id(app_id);
    catalog
        .policies
        .iter()
        .find(|p| p.id == id && p.app_id == app_id)
}

pub fn group_policy(
    catalog: &Catalog,
    app_id: &str,
    group_id: &str,
    model: &str,
) -> Result<RoutePolicy, AppError> {
    let group = catalog
        .groups
        .iter()
        .find(|g| g.id == group_id && g.enabled && g.app_ids.iter().any(|a| a == app_id))
        .ok_or_else(|| invalid("gateway.unavailableGroup"))?;
    Ok(RoutePolicy {
        id: format!("group/{}", group.id),
        name: group.name.clone(),
        app_id: app_id.into(),
        enabled: true,
        match_model: model.into(),
        request_model: String::new(),
        priority: 0,
        failover: group.failover,
        candidates: vec![],
        group_id: Some(group.id.clone()),
    })
}

/// 一个应用当前连接的路由组里所有可发布的模型名（按组内出现顺序去重）。
/// 用于把路由组的模型清单写进客户端配置，以及本地 `/models` 发现。
pub fn published_models(catalog: &Catalog, app_id: &str) -> Vec<String> {
    let mut models = Vec::new();
    if let Some(connection) = app_connection(catalog, app_id) {
        if let Some(group_id) = connection
            .group_id
            .as_deref()
            .filter(|_| connection.enabled)
        {
            collect_group_models(catalog, group_id, &mut models, 0);
        }
    }
    models
}

fn collect_group_models(catalog: &Catalog, group_id: &str, models: &mut Vec<String>, depth: usize) {
    if depth > 8 {
        return;
    }
    let Some(group) = catalog
        .groups
        .iter()
        .find(|group| group.id == group_id && group.enabled)
    else {
        return;
    };
    for member in group.members.iter().filter(|member| member.enabled) {
        if let Some(supplier_id) = &member.supplier_id {
            if let Some(supplier) = catalog
                .suppliers
                .iter()
                .find(|supplier| &supplier.id == supplier_id)
            {
                for model in &supplier.models {
                    push_model(models, model);
                }
            }
        }
        if let Some(nested) = &member.group_id {
            collect_group_models(catalog, nested, models, depth + 1);
        }
        push_model(models, &member.model);
    }
}

fn push_model(models: &mut Vec<String>, model: &str) {
    let model = model.trim();
    if !model.is_empty() && !models.iter().any(|existing| existing == model) {
        models.push(model.to_string());
    }
}

pub fn matched_policy(
    catalog: &Catalog,
    app_id: &str,
    model: &str,
) -> Result<Option<RoutePolicy>, AppError> {
    // The application's selected group handles every model, including aliases
    // cached by an already-running client. Unavailable connections fail closed.
    if let Some(connection) = app_connection(catalog, app_id) {
        let group_id = connection
            .group_id
            .as_deref()
            .filter(|_| connection.enabled)
            .ok_or_else(|| invalid("gateway.unavailableGroup"))?;
        let mut policy = group_policy(catalog, app_id, group_id, "")?;
        policy.id = connection.id.clone();
        // 组连接仍然由「应用连接」决定组，但请求模型名可以点名组内成员：
        // plan 会把模型匹配的候选排到最前。`group/<id>` 是组别名，不参与。
        policy.request_model = if model.starts_with("group/") {
            String::new()
        } else {
            model.to_string()
        };
        return Ok(Some(policy));
    }
    matched_unbound_policy(catalog, app_id, model)
}

/// Explicit external access bindings retain their own allowed group selection.
pub fn matched_unbound_policy(
    catalog: &Catalog,
    app_id: &str,
    model: &str,
) -> Result<Option<RoutePolicy>, AppError> {
    if let Some(id) = model.strip_prefix("group/") {
        return group_policy(catalog, app_id, id, model).map(Some);
    }
    let mut policies: Vec<_> = catalog
        .policies
        .iter()
        .filter(|p| {
            p.enabled
                && p.app_id == app_id
                && p.id != connection_id(app_id)
                && (p.match_model.is_empty() || p.match_model == model)
        })
        .collect();
    policies.sort_by(|a, b| a.priority.cmp(&b.priority).then(a.id.cmp(&b.id)));
    Ok(policies.first().map(|p| (*p).clone()))
}

impl Runtime {
    pub fn plan(
        &self,
        catalog: &Catalog,
        policy: &RoutePolicy,
        session: Option<String>,
        intents: Vec<IntentDecision>,
        advance: bool,
    ) -> Result<RouteDecision, AppError> {
        let mut state = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if advance {
            let prefix = format!("{}:", catalog.revision);
            state.turns.retain(|key, _| key.starts_with(&prefix));
            state.weights.retain(|key, _| key.starts_with(&prefix));
            state
                .affinity
                .retain(|key, a| key.starts_with(&prefix) && a.expires > now());
        }
        let old_turns = state.turns.clone();
        let old_weights = state.weights.clone();
        let mut decision = RouteDecision {
            reason: if policy.group_id.is_some() {
                "group"
            } else if policy.match_model.is_empty() {
                "catch_all"
            } else {
                "model_match"
            }
            .into(),
            group_id: policy.group_id.clone(),
            session_hash: session,
            affinity: "off".into(),
            intents,
            ..Default::default()
        };
        if let Some(id) = &policy.group_id {
            expand(
                catalog,
                policy,
                id,
                &mut state,
                &mut decision,
                &[],
                &[],
                advance,
            )?;
        } else {
            for c in &policy.candidates {
                append_candidate(
                    catalog,
                    &mut state,
                    &mut decision,
                    &c.supplier_id,
                    &c.model,
                    vec![],
                    vec![],
                    "ordered",
                )?;
            }
        }
        // Keep snapshots for every branch, but only execute a leaf once.
        let mut seen = HashSet::new();
        for c in &mut decision.candidates {
            if c.available && !seen.insert(candidate_key(&c.supplier_id, &c.model)) {
                c.available = false;
                c.reason = "duplicate".into();
            }
        }
        if decision.candidates.len() > 128 {
            return Err(invalid("gateway.limitExceeded"));
        }
        // 请求模型名只做「点名」：匹配的成员排到最前，其余候选保持策略顺序，
        // 仍可作为故障转移。没有匹配时不改变任何行为。
        let wanted = policy.request_model.trim();
        if !wanted.is_empty() {
            decision
                .candidates
                .sort_by_key(|candidate| !candidate.model.eq_ignore_ascii_case(wanted));
        }
        if advance {
            // Reserve a turn only for groups on the primary path. Exploring a
            // fallback branch must not consume its rotation or weighted turn.
            let selected = decision
                .candidates
                .iter()
                .find(|c| c.available)
                .map(|c| c.group_path.clone())
                .unwrap_or_default();
            for group in &decision.groups {
                if !selected.contains(&group.id) {
                    let key = format!("{}:{}:{}", catalog.revision, policy.app_id, group.id);
                    if let Some(turn) = old_turns.get(&key) {
                        state.turns.insert(key.clone(), *turn);
                    } else {
                        state.turns.remove(&key);
                    }
                    if let Some(weights) = old_weights.get(&key) {
                        state.weights.insert(key, weights.clone());
                    } else {
                        state.weights.remove(&key);
                    }
                }
            }
        }
        Ok(decision)
    }
}
#[allow(clippy::too_many_arguments)]
fn append_candidate(
    catalog: &Catalog,
    state: &mut RuntimeState,
    decision: &mut RouteDecision,
    supplier: &str,
    model: &str,
    groups: Vec<String>,
    members: Vec<String>,
    reason: &str,
) -> Result<(), AppError> {
    let s = catalog
        .suppliers
        .iter()
        .find(|s| s.id == supplier)
        .ok_or_else(|| invalid("gateway.missingSupplier"))?;
    let status = state.members.get(&candidate_key(supplier, model));
    decision.candidates.push(CandidateDecision {
        supplier_id: supplier.into(),
        supplier_name: s.name.clone(),
        model: model.into(),
        group_path: groups,
        member_path: members,
        reason: reason.into(),
        available: status.is_none_or(|s| s.cooldown_until.is_none_or(|t| t <= now())),
        recent_tokens: status.map(|s| decay(s, now())).unwrap_or(0.),
        active: status.map(|s| s.active).unwrap_or(0),
        cooldown_until: status.and_then(|s| s.cooldown_until),
    });
    Ok(())
}
#[allow(clippy::too_many_arguments)]
fn expand(
    catalog: &Catalog,
    policy: &RoutePolicy,
    id: &str,
    state: &mut RuntimeState,
    decision: &mut RouteDecision,
    groups: &[String],
    members: &[String],
    advance: bool,
) -> Result<(), AppError> {
    if groups.len() >= 8 || groups.iter().any(|g| g == id) {
        return Err(invalid("gateway.groupCycle"));
    }
    let g = catalog
        .groups
        .iter()
        .find(|g| g.id == id)
        .ok_or_else(|| invalid("gateway.missingGroup"))?;
    if !decision.groups.iter().any(|g| g.id == id) {
        decision.groups.push(g.clone());
    }
    if !g.enabled || !g.app_ids.contains(&policy.app_id) {
        return Ok(());
    }
    let mut path = groups.to_vec();
    path.push(id.into());
    let start = decision.candidates.len();
    let mut entries: Vec<_> = g.members.iter().filter(|m| m.enabled).collect();
    let skipped: Vec<_> = entries
        .iter()
        .copied()
        .filter(|m| member_load(catalog, state, m, 0) == f64::MAX)
        .collect();
    entries.retain(|m| member_load(catalog, state, m, 0) < f64::MAX);
    let key = format!("{}:{}:{}", catalog.revision, policy.app_id, id);
    let reason = match g.strategy {
        Strategy::Ordered => "ordered",
        Strategy::Manual => {
            entries.retain(|m| Some(&m.id) == g.manual_member_id.as_ref());
            "manual"
        }
        Strategy::RoundRobin => {
            if !entries.is_empty() {
                let n = *state.turns.get(&key).unwrap_or(&0) as usize % entries.len();
                entries.rotate_left(n);
                if advance {
                    *state.turns.entry(key.clone()).or_default() += 1;
                }
            }
            "round_robin"
        }
        Strategy::Weighted => {
            let mut next = state.weights.get(&key).cloned().unwrap_or_default();
            let total = entries.iter().map(|m| i64::from(m.weight)).sum::<i64>();
            let mut selected = None;
            for (i, m) in entries.iter().enumerate() {
                let score = next.entry(m.id.clone()).or_default();
                *score += i64::from(m.weight);
                if selected.is_none_or(|(_, best)| *score > best) {
                    selected = Some((i, *score));
                }
            }
            if let Some((i, _)) = selected {
                *next.entry(entries[i].id.clone()).or_default() -= total;
                let m = entries.remove(i);
                entries.insert(0, m);
            }
            if advance {
                state.weights.insert(key.clone(), next);
            }
            "weighted"
        }
        Strategy::LeastUsed => {
            entries.sort_by(|a, b| {
                member_load(catalog, state, a, 0).total_cmp(&member_load(catalog, state, b, 0))
            });
            "least_used"
        }
    };
    if g.strategy != Strategy::Manual {
        if let Some(hit) = decision
            .intents
            .iter()
            .find(|d| d.group_id == id)
            .and_then(|d| d.rule_id.as_ref())
        {
            if let Some(rule) = g.rules.iter().find(|r| &r.id == hit && r.enabled) {
                if let Some(i) = entries.iter().position(|m| m.id == rule.member_id) {
                    let m = entries.remove(i);
                    entries.insert(0, m);
                }
            }
        }
    }
    entries.extend(
        skipped.into_iter().filter(|m| {
            g.strategy != Strategy::Manual || Some(&m.id) == g.manual_member_id.as_ref()
        }),
    );
    let intent_member = decision
        .intents
        .iter()
        .find(|i| i.group_id == id)
        .and_then(|i| i.rule_id.as_ref())
        .and_then(|id| g.rules.iter().find(|r| &r.id == id))
        .map(|r| r.member_id.as_str());
    for entry in entries {
        let entry_start = decision.candidates.len();
        let mut member_path = members.to_vec();
        member_path.push(entry.id.clone());
        if let Some(child) = &entry.group_id {
            expand(
                catalog,
                policy,
                child,
                state,
                decision,
                &path,
                &member_path,
                advance,
            )?;
        } else if let Some(supplier) = &entry.supplier_id {
            append_candidate(
                catalog,
                state,
                decision,
                supplier,
                &entry.model,
                path.clone(),
                member_path,
                reason,
            )?;
        }
        if intent_member == Some(entry.id.as_str()) {
            for c in &mut decision.candidates[entry_start..] {
                if c.available {
                    c.reason = "intent".into();
                }
            }
        }
        if decision.candidates.len() > 128 {
            return Err(invalid("gateway.limitExceeded"));
        }
    }
    // Affinity belongs to this group's subtree; nested groups retain their own policy.
    if g.session_affinity {
        if decision.affinity == "off" {
            decision.affinity = if decision.session_hash.is_some() {
                "new"
            } else {
                "no_session"
            }
            .into();
        }
        if let Some(session) = &decision.session_hash {
            let pinned = state
                .affinity
                .get(&format!("{}:{}:{}", catalog.revision, g.id, session))
                .filter(|a| a.expires > now());
            let intent_hit = decision.intents.iter().any(|i| {
                i.rule_id.is_some()
                    && (i.group_id == id
                        || decision.candidates[start..]
                            .iter()
                            .any(|c| c.group_path.contains(&i.group_id)))
            });
            if let Some(a) = pinned.filter(|_| !intent_hit) {
                if let Some(index) = decision.candidates[start..]
                    .iter()
                    .position(|c| c.available && candidate_key(&c.supplier_id, &c.model) == a.key)
                {
                    let mut c = decision.candidates.remove(start + index);
                    c.reason = "affinity".into();
                    decision.candidates.insert(start, c);
                    decision.affinity = "hit".into();
                }
            }
        }
    }
    let limit = if g.failover {
        g.max_attempts as usize
    } else {
        1
    };
    let mut count = 0;
    let mut seen = HashSet::new();
    for c in &mut decision.candidates[start..] {
        if c.available && !seen.insert(candidate_key(&c.supplier_id, &c.model)) {
            c.available = false;
            c.reason = "duplicate".into();
        }
        if c.available {
            count += 1;
            if count > limit {
                c.available = false;
                c.reason = "attempt_limit".into();
            }
        }
        if c.cooldown_until.is_some_and(|at| at > now()) {
            c.reason = "cooldown".into();
        }
    }
    Ok(())
}
fn member_load(catalog: &Catalog, state: &RuntimeState, m: &GroupMember, depth: usize) -> f64 {
    if depth > 8 {
        return f64::MAX;
    }
    if let Some(s) = &m.supplier_id {
        return state
            .members
            .get(&candidate_key(s, &m.model))
            .map(|s| {
                if s.cooldown_until.is_some_and(|at| at > now()) {
                    f64::MAX
                } else {
                    decay(s, now()) + f64::from(s.active) * 1024. + s.unknown_usage as f64
                }
            })
            .unwrap_or(0.);
    }
    catalog
        .groups
        .iter()
        .find(|g| g.enabled && Some(&g.id) == m.group_id.as_ref())
        .map(|g| {
            g.members
                .iter()
                .filter(|m| {
                    m.enabled
                        && (g.strategy != Strategy::Manual
                            || Some(&m.id) == g.manual_member_id.as_ref())
                })
                .map(|m| member_load(catalog, state, m, depth + 1))
                .fold(f64::MAX, f64::min)
        })
        .unwrap_or(f64::MAX)
}

/// Only app-scoped public aliases; supplier credentials never enter discovery.
pub fn published_aliases(catalog: &Catalog, app_id: &str) -> Vec<(String, String)> {
    if let Some(connection) = app_connection(catalog, app_id) {
        return catalog
            .groups
            .iter()
            .filter(|g| {
                Some(&g.id) == connection.group_id.as_ref()
                    && connection.enabled
                    && g.enabled
                    && g.app_ids.iter().any(|a| a == app_id)
            })
            .map(|g| (format!("group/{}", g.id), g.name.clone()))
            .collect();
    }
    published_unbound_aliases(catalog, app_id)
}

pub fn published_unbound_aliases(catalog: &Catalog, app_id: &str) -> Vec<(String, String)> {
    let mut aliases: Vec<_> = catalog
        .groups
        .iter()
        .filter(|g| g.enabled && g.app_ids.iter().any(|a| a == app_id))
        .map(|g| (format!("group/{}", g.id), g.name.clone()))
        .collect();
    aliases.extend(
        catalog
            .policies
            .iter()
            .filter(|p| {
                p.enabled
                    && p.app_id == app_id
                    && !p.match_model.is_empty()
                    && p.group_id
                        .as_ref()
                        .is_none_or(|id| catalog.groups.iter().any(|g| &g.id == id && g.enabled))
            })
            .map(|p| (p.match_model.clone(), p.name.clone())),
    );
    aliases.sort_by(|a, b| a.0.cmp(&b.0));
    aliases.dedup_by(|a, b| a.0 == b.0);
    aliases
}

/// Keep Codex's required catalog fields (notably base_instructions and the
/// truncation policy). Group aliases have no declared model capabilities yet.
pub fn codex_discovery(aliases: &[(String, String)]) -> serde_json::Value {
    let template: serde_json::Value = serde_json::from_str(include_str!(
        "../resources/codex_native_responses_template.json"
    ))
    .expect("bundled Codex template is valid JSON");
    let models: Vec<_> = aliases
        .iter()
        .enumerate()
        .map(|(index, (id, name))| {
            let mut entry = template.clone();
            entry["slug"] = serde_json::json!(id);
            entry["display_name"] = serde_json::json!(name);
            entry["description"] = serde_json::json!(name);
            entry["priority"] = serde_json::json!(index);
            entry["input_modalities"] = serde_json::json!(["text"]);
            entry["default_reasoning_level"] = serde_json::json!("none");
            entry["supported_reasoning_levels"] =
                serde_json::json!([{"effort":"none","description":"Disable Thinking"}]);
            entry["supports_reasoning_summaries"] = serde_json::json!(false);
            entry["context_window"] = serde_json::json!(128_000);
            entry["max_context_window"] = serde_json::json!(128_000);
            entry
        })
        .collect();
    serde_json::json!({"models": models})
}

#[cfg(test)]
#[path = "routing_tests.rs"]
mod tests;
