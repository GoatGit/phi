//! 把证据折成判决。这一层不碰 IO，只认传进来的事实，方便把规则写死成测试。

use serde::Serialize;

/// 一次失败的类别。决定「怎么接」：换会话、还是原地重来。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum FailureKind {
    /// 额度耗尽 / 被限流：会话本身是好的，换条链路续上。
    Quota,
    /// 上下文超限：同一会话再挂一次也一样，得开新会话并交接。
    Context,
    /// 上游供应商故障（5xx、连接中断）：原地重来一次通常就好。
    Provider,
    /// 进程自己死了，没有可归因的外部原因。
    Crash,
}

impl FailureKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Quota => "quota",
            Self::Context => "context",
            Self::Provider => "provider",
            Self::Crash => "crash",
        }
    }

    pub fn from_str(value: &str) -> Option<Self> {
        Some(match value {
            "quota" => Self::Quota,
            "context" => Self::Context,
            "provider" => Self::Provider,
            "crash" => Self::Crash,
            _ => return None,
        })
    }

    /// 同一原因连续出现时是否还值得再试一次。
    ///
    /// 供应商抖动重来一次有意义；额度与上下文原地重试就是白烧额度。
    pub fn worth_retrying(self) -> bool {
        matches!(self, Self::Provider)
    }
}

/// 代理侧的一条失败请求（`proxy_request_logs` 里状态码非成功）。
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ProxyFailure {
    pub status_code: u16,
    pub message: String,
}

/// 判决的输入。字段都是「已经确认过的事实」，不在这里做推断。
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Evidence {
    pub exit_code: i32,
    pub proxy: Vec<ProxyFailure>,
    /// 会话文件尾部命中的标记（已小写化）。
    pub session_markers: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Verdict {
    /// 跑完了。退出码 0 且没有任何失败痕迹。
    Completed,
    /// 用户自己中断的（Ctrl-C / 关窗口），不接棒。
    Interrupted,
    Failed {
        kind: FailureKind,
        reason: String,
    },
}

/// 额度类标记：命中任意一条就按额度处理。全部小写，比较时也小写。
const QUOTA_MARKERS: &[&str] = &[
    "usage limit",
    "rate limit",
    "ratelimit",
    "insufficient_quota",
    "insufficient quota",
    "quota exceeded",
    "quota exhausted",
    "credit balance",
    "exceeded your current quota",
    "billing hard limit",
    "payment required",
];

/// 上下文类标记。比额度更具体，所以先判。
const CONTEXT_MARKERS: &[&str] = &[
    "context length",
    "context window",
    "context_length_exceeded",
    "maximum context",
    "prompt is too long",
    "prompt too long",
    "too many tokens",
    "input is too long",
    "input length exceeds",
];

/// 供应商类标记。只在代理错误消息里用，不从会话文本里定罪（见 `actionable_markers`）。
const PROVIDER_MARKERS: &[&str] = &[
    "overloaded",
    "service unavailable",
    "bad gateway",
    "gateway timeout",
    "connection reset",
    "connection refused",
    "upstream",
    "temporarily unavailable",
    "stream error",
    "internal server error",
];

/// 只认额度与上下文两类标记：它们决定「换链路」还是「换会话」。
const SESSION_MARKER_LIMIT: usize = 8;

/// shell 把信号折成 128+N。这三个是「用户主动结束」，不是故障。
const INTERRUPT_EXIT_CODES: &[i32] = &[130, 131, 143];

fn hit(text: &str, markers: &[&str]) -> Option<String> {
    let lowered = text.to_lowercase();
    markers
        .iter()
        .find(|marker| lowered.contains(**marker))
        .map(|marker| (*marker).to_string())
}

/// 会话文件里只认额度与上下文标记。供应商类词（`upstream` 之类）在正常会话
/// 文本里也常见，拿它当证据会把一次正常退出判成故障。
pub(crate) fn actionable_markers(text: &str) -> Vec<String> {
    let lowered = text.to_lowercase();
    let mut hits: Vec<String> = Vec::new();
    for markers in [CONTEXT_MARKERS, QUOTA_MARKERS] {
        for marker in markers {
            if lowered.contains(marker) && !hits.iter().any(|hit| hit == marker) {
                hits.push((*marker).to_string());
                if hits.len() >= SESSION_MARKER_LIMIT {
                    return hits;
                }
            }
        }
    }
    hits
}

fn first_marker<'a>(evidence: &'a Evidence, markers: &[&str]) -> Option<&'a str> {
    evidence
        .session_markers
        .iter()
        .find(|marker| markers.contains(&marker.as_str()))
        .map(String::as_str)
}

pub(crate) fn classify(evidence: &Evidence) -> Verdict {
    let failure_kind = |kind: FailureKind, marker: &str| Verdict::Failed {
        kind,
        reason: format!("命中 {} 标记：{marker}", kind.as_str()),
    };

    // 用户中断优先：哪怕同时有额度痕迹，也不该替他重启。
    if INTERRUPT_EXIT_CODES.contains(&evidence.exit_code) {
        return Verdict::Interrupted;
    }

    // 上下文比额度更具体（超限也常被上游回 400/413），先判。
    if let Some(marker) = first_marker(evidence, CONTEXT_MARKERS) {
        return failure_kind(FailureKind::Context, marker);
    }
    for failure in &evidence.proxy {
        if let Some(marker) = hit(&failure.message, CONTEXT_MARKERS) {
            return failure_kind(FailureKind::Context, &marker);
        }
    }

    if let Some(marker) = first_marker(evidence, QUOTA_MARKERS) {
        return failure_kind(FailureKind::Quota, marker);
    }
    for failure in &evidence.proxy {
        if failure.status_code == 402 || failure.status_code == 429 {
            return failure_kind(FailureKind::Quota, &failure.status_code.to_string());
        }
        if let Some(marker) = hit(&failure.message, QUOTA_MARKERS) {
            return failure_kind(FailureKind::Quota, &marker);
        }
    }

    for failure in &evidence.proxy {
        if failure.status_code >= 500 {
            return failure_kind(FailureKind::Provider, &failure.status_code.to_string());
        }
        if let Some(marker) = hit(&failure.message, PROVIDER_MARKERS) {
            return failure_kind(FailureKind::Provider, &marker);
        }
    }

    if evidence.exit_code != 0 {
        return Verdict::Failed {
            kind: FailureKind::Crash,
            reason: format!(
                "进程以退出码 {} 结束，没有可归因的外部失败",
                evidence.exit_code
            ),
        };
    }
    Verdict::Completed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exit_with(exit_code: i32) -> Evidence {
        Evidence {
            exit_code,
            ..Default::default()
        }
    }

    fn proxy(status_code: u16, message: &str) -> ProxyFailure {
        ProxyFailure {
            status_code,
            message: message.to_string(),
        }
    }

    fn kind_of(verdict: Verdict) -> FailureKind {
        match verdict {
            Verdict::Failed { kind, .. } => kind,
            other => panic!("expected a failure, got {other:?}"),
        }
    }

    #[test]
    fn clean_exit_is_completed() {
        assert_eq!(classify(&exit_with(0)), Verdict::Completed);
    }

    #[test]
    fn user_interrupt_never_restarts_the_session() {
        for code in [130, 143] {
            assert_eq!(classify(&exit_with(code)), Verdict::Interrupted);
        }
        // 哪怕同时有额度失败痕迹，用户按下 Ctrl-C 就是不想跑下去了
        let mut interrupted = exit_with(130);
        interrupted.proxy = vec![proxy(429, "usage limit reached")];
        assert_eq!(classify(&interrupted), Verdict::Interrupted);
    }

    #[test]
    fn context_overflow_wins_over_quota_markers() {
        // 超限请求常被上游回 400 + "too many tokens"，语义上属于上下文而不是额度
        let mut evidence = exit_with(1);
        evidence.proxy = vec![proxy(400, "prompt is too long: too many tokens")];
        assert_eq!(kind_of(classify(&evidence)), FailureKind::Context);
    }

    #[test]
    fn rate_limited_upstream_is_quota() {
        let mut evidence = exit_with(1);
        evidence.proxy = vec![proxy(429, "rate_limit_exceeded")];
        assert_eq!(kind_of(classify(&evidence)), FailureKind::Quota);

        let mut payment = exit_with(1);
        payment.proxy = vec![proxy(402, "payment required")];
        assert_eq!(kind_of(classify(&payment)), FailureKind::Quota);
    }

    #[test]
    fn session_marker_is_enough_without_proxy_traffic() {
        // 直连模式下代理看不到请求，只能靠会话文件里的错误消息。
        // 标记由 `actionable_markers` 归一化成标记表里的原词，这里断言同一形状。
        let mut evidence = exit_with(1);
        evidence.session_markers = vec!["usage limit".to_string()];
        assert_eq!(kind_of(classify(&evidence)), FailureKind::Quota);

        let mut limit = exit_with(1);
        limit.session_markers = vec!["context window".to_string()];
        assert_eq!(kind_of(classify(&limit)), FailureKind::Context);
    }

    #[test]
    fn upstream_5xx_is_provider_failure() {
        let mut evidence = exit_with(1);
        evidence.proxy = vec![proxy(503, "service unavailable")];
        assert_eq!(kind_of(classify(&evidence)), FailureKind::Provider);
    }

    #[test]
    fn unknown_nonzero_exit_is_a_crash() {
        let mut evidence = exit_with(2);
        evidence.proxy = vec![proxy(400, "invalid request")];
        assert_eq!(kind_of(classify(&evidence)), FailureKind::Crash);
    }

    #[test]
    fn failure_kind_round_trips_through_storage() {
        for kind in [
            FailureKind::Quota,
            FailureKind::Context,
            FailureKind::Provider,
            FailureKind::Crash,
        ] {
            assert_eq!(FailureKind::from_str(kind.as_str()), Some(kind));
        }
        assert_eq!(FailureKind::from_str("unknown"), None);
    }

    #[test]
    fn only_provider_failures_are_worth_an_immediate_retry() {
        assert!(FailureKind::Provider.worth_retrying());
        assert!(!FailureKind::Quota.worth_retrying());
        assert!(!FailureKind::Context.worth_retrying());
        assert!(!FailureKind::Crash.worth_retrying());
    }

    #[test]
    fn session_text_scan_is_bounded_and_skips_provider_noise() {
        let hits = actionable_markers(
            "You've hit your usage limit. upstream connect error. context window: 200k",
        );
        assert!(hits.iter().any(|hit| hit.contains("usage limit")));
        assert!(hits.iter().any(|hit| hit.contains("context window")));
        assert!(
            !hits.iter().any(|hit| hit == "upstream"),
            "供应商类词不能从会话文本里定罪"
        );
        assert!(hits.len() <= SESSION_MARKER_LIMIT);
    }
}
