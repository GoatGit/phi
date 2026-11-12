//! 续跑决策。规则要能被单独读、单独测：给定判决、策略和历史，只有一种结论。

use super::classify::FailureKind;
use super::classify::Verdict;

/// 接棒时用哪种方式恢复：
/// - `SameSession`：还进原来那条会话，换条链路继续——上下文还在；
/// - `FreshSession`：开一条新会话再交接——上下文已经塞不下了，硬续必然再挂。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ResumeMode {
    SameSession,
    FreshSession,
}

impl ResumeMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SameSession => "same-session",
            Self::FreshSession => "fresh-session",
        }
    }

    pub fn from_str(value: &str) -> Option<Self> {
        Some(match value {
            "same-session" => Self::SameSession,
            "fresh-session" => Self::FreshSession,
            _ => return None,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum StopReason {
    /// 跑完了，不需要接棒。
    Completed,
    /// 用户自己中断的。
    Interrupted,
    /// 策略里关掉了自动接棒。
    Disabled,
    /// 这次终端会话已经用满尝试次数。
    AttemptsExhausted,
    /// 同一类故障反复出现，再试只是重复烧额度。
    NoProgress,
    /// 找不到可以恢复的会话（会话文件还没落盘 / 应用不支持 resume）。
    NoTarget,
    /// 插件明确表示「只记录，不重启」。
    PluginDeclined,
}

impl StopReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Interrupted => "interrupted",
            Self::Disabled => "disabled",
            Self::AttemptsExhausted => "attempts-exhausted",
            Self::NoProgress => "no-progress",
            Self::NoTarget => "no-target",
            Self::PluginDeclined => "plugin-declined",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Decision {
    Stop(StopReason),
    Resume { mode: ResumeMode, kind: FailureKind },
}

/// 这个终端会话此前已经接棒过几次、最后一次是什么原因。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct History {
    pub attempts: u32,
    pub last_kind: Option<FailureKind>,
}

/// 有没有会话可恢复、有没有超出次数，是判定的两个前置事实。
///
/// `has_target` 单独传：判定「该不该接」和「有没有东西可接」是两件事，
/// 分开之后规则好测，也方便 UI 分别展示。
pub(crate) fn decide(
    verdict: &Verdict,
    auto_resume: bool,
    max_attempts: u32,
    history: History,
    has_target: bool,
) -> Decision {
    let (kind, mode) = match verdict {
        Verdict::Completed => return Decision::Stop(StopReason::Completed),
        Verdict::Interrupted => return Decision::Stop(StopReason::Interrupted),
        Verdict::Failed { kind, .. } => {
            let mode = if *kind == FailureKind::Context {
                ResumeMode::FreshSession
            } else {
                ResumeMode::SameSession
            };
            (*kind, mode)
        }
    };

    if !auto_resume {
        return Decision::Stop(StopReason::Disabled);
    }
    if history.attempts >= max_attempts {
        return Decision::Stop(StopReason::AttemptsExhausted);
    }
    // 同一原因已经接过一次、而且这一类不值得原地重试：停手。
    if history.attempts > 0 && history.last_kind == Some(kind) && !kind.worth_retrying() {
        return Decision::Stop(StopReason::NoProgress);
    }
    // 上下文超限要开新会话，不需要旧会话；其余三类必须能 resume 才有意义。
    if mode == ResumeMode::SameSession && !has_target {
        return Decision::Stop(StopReason::NoTarget);
    }
    Decision::Resume { mode, kind }
}

/// 让插件的决策与内置决策合并。
///
/// 插件只能**收窄**，不能放宽：
/// - 内置判定要停：无论插件说什么都停（插件不能把「跑完了」改成「重跑」）；
/// - 插件说只记录：停，并记一条 `plugin-declined`；
/// - 插件指定恢复方式：采纳，但「同会话」在没有旧会话时回落到内置判定
///   （内置在这种情况下本来就不会给 SameSession，所以等于不生效）。
pub(crate) fn merge_plugin_decision(
    host: Decision,
    plugin: Option<(ResumeMode, String)>,
    has_target: bool,
) -> (Decision, Option<String>) {
    let Decision::Resume { mode: _, kind } = host else {
        return (host, None);
    };
    match plugin {
        None => (host, None),
        Some((plugin_mode, plugin_reason)) => {
            if plugin_mode == ResumeMode::SameSession && !has_target {
                return (Decision::Stop(StopReason::NoTarget), Some(plugin_reason));
            }
            (
                Decision::Resume {
                    mode: plugin_mode,
                    kind,
                },
                Some(plugin_reason),
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::classify::FailureKind::{Context, Crash, Provider, Quota};
    use super::*;

    fn failed(kind: FailureKind) -> Verdict {
        Verdict::Failed {
            kind,
            reason: "test".into(),
        }
    }

    fn resume_mode(decision: Decision) -> ResumeMode {
        match decision {
            Decision::Resume { mode, .. } => mode,
            other => panic!("expected resume, got {other:?}"),
        }
    }

    fn stop_reason(decision: Decision) -> StopReason {
        match decision {
            Decision::Stop(reason) => reason,
            other => panic!("expected stop, got {other:?}"),
        }
    }

    #[test]
    fn finished_work_is_never_restarted() {
        assert_eq!(
            stop_reason(decide(
                &Verdict::Completed,
                true,
                2,
                History::default(),
                true
            )),
            StopReason::Completed
        );
        assert_eq!(
            stop_reason(decide(
                &Verdict::Interrupted,
                true,
                2,
                History::default(),
                true
            )),
            StopReason::Interrupted
        );
    }

    #[test]
    fn disabled_policy_only_records() {
        assert_eq!(
            stop_reason(decide(&failed(Quota), false, 2, History::default(), true)),
            StopReason::Disabled
        );
    }

    #[test]
    fn attempts_are_capped() {
        let history = History {
            attempts: 2,
            last_kind: Some(Provider),
        };
        assert_eq!(
            stop_reason(decide(&failed(Provider), true, 2, history, true)),
            StopReason::AttemptsExhausted
        );
    }

    #[test]
    fn quota_resumes_the_same_session() {
        assert_eq!(
            resume_mode(decide(&failed(Quota), true, 2, History::default(), true)),
            ResumeMode::SameSession
        );
    }

    #[test]
    fn context_overflow_starts_a_fresh_session_with_a_handoff() {
        // 上下文塞满了，再 resume 同一条会话必然原地再挂一次
        assert_eq!(
            resume_mode(decide(&failed(Context), true, 2, History::default(), false)),
            ResumeMode::FreshSession
        );
    }

    #[test]
    fn repeating_the_same_reason_stops_instead_of_burning_quota() {
        let history = History {
            attempts: 1,
            last_kind: Some(Quota),
        };
        assert_eq!(
            stop_reason(decide(&failed(Quota), true, 3, history, true)),
            StopReason::NoProgress
        );

        // 供应商抖动不属于「没有进展」，允许再试一次
        let provider = History {
            attempts: 1,
            last_kind: Some(Provider),
        };
        assert!(matches!(
            decide(&failed(Provider), true, 3, provider, true),
            Decision::Resume { .. }
        ));
    }

    #[test]
    fn a_different_reason_after_a_retry_is_allowed() {
        let history = History {
            attempts: 1,
            last_kind: Some(Crash),
        };
        assert!(matches!(
            decide(&failed(Quota), true, 3, history, true),
            Decision::Resume { .. }
        ));
    }

    #[test]
    fn nothing_to_resume_is_reported_separately_from_a_policy_stop() {
        assert_eq!(
            stop_reason(decide(&failed(Crash), true, 3, History::default(), false)),
            StopReason::NoTarget
        );
    }

    #[test]
    fn plugin_cannot_restart_work_the_host_would_not() {
        let stopped = Decision::Stop(StopReason::Completed);
        let (merged, reason) = merge_plugin_decision(
            stopped,
            Some((ResumeMode::SameSession, "插件想重跑".into())),
            true,
        );
        assert_eq!(merged, stopped);
        assert!(reason.is_none());
    }

    #[test]
    fn plugin_can_switch_the_recovery_mode() {
        let host = Decision::Resume {
            mode: ResumeMode::SameSession,
            kind: Quota,
        };
        let (merged, reason) = merge_plugin_decision(
            host,
            Some((ResumeMode::FreshSession, "换个新会话".into())),
            true,
        );
        assert_eq!(
            merged,
            Decision::Resume {
                mode: ResumeMode::FreshSession,
                kind: Quota
            }
        );
        assert_eq!(reason.as_deref(), Some("换个新会话"));
    }

    #[test]
    fn plugin_cannot_pin_a_session_that_does_not_exist() {
        let host = Decision::Resume {
            mode: ResumeMode::FreshSession,
            kind: Context,
        };
        let (merged, _) = merge_plugin_decision(
            host,
            Some((ResumeMode::SameSession, "续原会话".into())),
            false,
        );
        assert_eq!(merged, Decision::Stop(StopReason::NoTarget));
    }

    #[test]
    fn no_plugin_keeps_the_builtin_decision() {
        let host = Decision::Resume {
            mode: ResumeMode::SameSession,
            kind: Crash,
        };
        let (merged, reason) = merge_plugin_decision(host, None, true);
        assert_eq!(merged, host);
        assert!(reason.is_none());
    }
}
