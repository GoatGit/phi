//! Episode：一个 tick 里那一段「有判断」的循环。
//!
//! 这是 pi sidecar 将来要接进来的位置，所以先把它定成一个接口，而不是写死一段代码：
//! 调用方只知道「给候选和预算，换回一组决策」。现在有两个实现：
//!
//! - [`RuleEpisode`]：纯确定性策略，不调模型。影子模式和测试用它，
//!   sidecar 不可用时也用它兜底——宁可保守地派发，也不要整轮空转。
//! - [`crate::super_agent::sidecar::SidecarEpisode`]：同样入参、同样出参，
//!   区别是它把循环放进另一个进程，由模型自己决定先问哪个工具、什么时候问判官。
//!   它崩溃或起不来时由 [`FallbackEpisode`] 退回规则版。
//!
//! 约束写在接口上：episode 只能产出 [`Decision`]，不能执行。派发、写状态、抢租约
//! 全在 [`crate::super_agent::tick`] 里，模型碰不到。

use std::future::Future;
use std::pin::Pin;

use crate::super_agent::judge::Judge;
use crate::super_agent::model::{Candidate, Decision, DecisionSet, RouterSettings};

pub(crate) type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Clone)]
pub(crate) struct EpisodeInput<'a> {
    pub candidates: &'a [Candidate],
    pub settings: &'a RouterSettings,
    /// 一次 episode 最多走几步（含读卡与提名）。
    pub steps: usize,
    /// 一次 episode 最多问判官几次。规则版 episode 不调判官，sidecar 版按它执行。
    pub judge_calls: usize,
    /// 判官。`None` 表示这一轮没有可用判官（额度用完或没配路由），
    /// sidecar 拿到的 `judge` 工具会直接报错而不是等超时。
    pub judge: Option<&'a dyn Judge>,
    /// 判官模型名。侧车按这个名字问 Jev。
    pub judge_model: &'a str,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum EpisodeError {
    /// 预算太小，一步都走不了。
    NoBudget,
    /// 实现的内部故障（sidecar 崩溃、协议不合等）。规则版不会产生它。
    Failed(String),
}

/// 一次 episode 的日志行，写进 trace 的 `degraded` 或排障输出。
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct EpisodeOutcome {
    pub decisions: DecisionSet,
    pub steps: Vec<String>,
    pub judge_calls: usize,
}

pub(crate) trait Episode: Send + Sync {
    fn run<'a>(
        &'a self,
        input: EpisodeInput<'a>,
    ) -> BoxFuture<'a, Result<EpisodeOutcome, EpisodeError>>;
}

/// 让 `Box<dyn Episode>` 也是 Episode，tick 只认 trait 对象。
impl<T: Episode + ?Sized> Episode for Box<T> {
    fn run<'a>(
        &'a self,
        input: EpisodeInput<'a>,
    ) -> BoxFuture<'a, Result<EpisodeOutcome, EpisodeError>> {
        (**self).run(input)
    }
}

/// 主实现失败时退回规则版。
///
/// 只接 [`EpisodeError::Failed`]：sidecar 崩了、协议乱了、机器上压根没有它——
/// 这些都不该让一轮 tick 失败，更不该让整张看板停摆。
/// [`EpisodeError::NoBudget`] 照旧往上抛：预算不足是这一轮本来就不该动，
/// 换谁来都算不出东西。
pub(crate) struct FallbackEpisode {
    pub primary: Box<dyn Episode>,
    pub fallback: Box<dyn Episode>,
}

impl Episode for FallbackEpisode {
    fn run<'a>(
        &'a self,
        input: EpisodeInput<'a>,
    ) -> BoxFuture<'a, Result<EpisodeOutcome, EpisodeError>> {
        Box::pin(async move {
            match self.primary.run(input.clone()).await {
                Ok(outcome) => Ok(outcome),
                Err(EpisodeError::NoBudget) => Err(EpisodeError::NoBudget),
                Err(EpisodeError::Failed(reason)) => {
                    // 退回是常态（比如没凭据、运行时被系统拦），但每次都要留痕：
                    // 静默退化会让人以为侧车在工作，其实一直在跑规则版。
                    log::warn!("router sidecar failed, falling back to rules: {reason}");
                    let mut outcome = self.fallback.run(input).await?;
                    // 退回去了也要留痕：下一轮排障时能看出这一轮不是规则版自己愿意跑的。
                    outcome.steps.insert(0, format!("sidecar-failed:{reason}"));
                    Ok(outcome)
                }
            }
        })
    }
}

/// 确定性策略版 episode。
///
/// 它的每一步都对应 pi 版会做的同一件事：读卡、检查能不能动、提名。
/// 区别只在于「检查能不能动」这一步用的是规则而不是判官的判断。
pub(crate) struct RuleEpisode;

impl RuleEpisode {
    /// 单张卡的判定，抽出来是为了能单独断言。
    pub(crate) fn decide(
        candidate: &Candidate,
        settings: &RouterSettings,
    ) -> (Decision, Vec<String>) {
        let mut steps = vec![format!("read_task {}", candidate.task_id)];

        let title = candidate.title.trim();
        if title.is_empty() {
            steps.push("title-missing".into());
            return (
                Decision::ask(
                    candidate.task_id.clone(),
                    "这张卡没有标题，看不出要做什么，先补一句。",
                ),
                steps,
            );
        }

        let Some(worker) = settings.default_worker() else {
            steps.push("no-worker-configured".into());
            return (
                Decision::ask(
                    candidate.task_id.clone(),
                    "没有配置可派发的 worker，先在自动调度设置里选一个。",
                ),
                steps,
            );
        };

        // 上一次失败过：把失败原因带上，让接手的人不用翻日志。
        if let Some(run) = &candidate.run {
            if run.state == crate::super_agent::model::RunState::Failed {
                steps.push("retry-after-failure".into());
                let reason = run
                    .detail
                    .clone()
                    .unwrap_or_else(|| "上一次失败，原因未记录".into());
                return (
                    Decision::dispatch(
                        candidate.task_id.clone(),
                        worker,
                        format!("重试（第 {} 次）：{reason}", run.attempts + 1),
                    ),
                    steps,
                );
            }
        }

        steps.push(format!("nominate {worker}"));
        (
            Decision::dispatch(
                candidate.task_id.clone(),
                worker,
                "规则版：卡片位于触发列、依赖已满足、还有重试额度。",
            ),
            steps,
        )
    }
}

impl Episode for RuleEpisode {
    fn run<'a>(
        &'a self,
        input: EpisodeInput<'a>,
    ) -> BoxFuture<'a, Result<EpisodeOutcome, EpisodeError>> {
        Box::pin(async move {
            if input.steps == 0 || input.candidates.is_empty() {
                return Err(EpisodeError::NoBudget);
            }
            let mut outcome = EpisodeOutcome::default();
            let mut used = 0usize;
            for candidate in input.candidates {
                // 读卡算一步，提名算一步：与 pi 版的步数口径一致，
                // 这样换成 sidecar 之后预算不用重新标定。
                if used + 2 > input.steps {
                    outcome.decisions.unfinished = true;
                    outcome.steps.push("step-budget-exhausted".into());
                    break;
                }
                let (decision, mut steps) = Self::decide(candidate, input.settings);
                used += 2;
                outcome.steps.append(&mut steps);
                outcome.decisions.decisions.push(decision);
            }
            Ok(outcome)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::super_agent::model::{RunState, TaskRun};

    fn candidate(id: &str, title: &str) -> Candidate {
        Candidate {
            discussion_hold: false,
            task_id: id.into(),
            root: "/repo".into(),
            title: title.into(),
            status: "In Progress".into(),
            file: format!("backlog/tasks/{id}.md"),
            fingerprint: "fp".into(),
            dependencies: Vec::new(),
            schedule: None,
            assignees: Vec::new(),
            labels: Vec::new(),
            session: None,
            run: None,
        }
    }

    /// 一定失败的实现，用来验证退回规则版这条路径。
    struct Broken;

    impl Episode for Broken {
        fn run<'a>(
            &'a self,
            _input: EpisodeInput<'a>,
        ) -> BoxFuture<'a, Result<EpisodeOutcome, EpisodeError>> {
            Box::pin(async move { Err(EpisodeError::Failed("no such binary".into())) })
        }
    }

    /// 永远报「没预算」的实现。这种情况不该退回规则版：这一轮本来就不该动。
    struct Empty;

    impl Episode for Empty {
        fn run<'a>(
            &'a self,
            _input: EpisodeInput<'a>,
        ) -> BoxFuture<'a, Result<EpisodeOutcome, EpisodeError>> {
            Box::pin(async move { Err(EpisodeError::NoBudget) })
        }
    }

    #[tokio::test]
    async fn a_broken_primary_falls_back_to_the_rules_and_says_so() {
        let settings = RouterSettings::default();
        let candidates = vec![candidate("TASK-1", "fix it")];
        let episode = FallbackEpisode {
            primary: Box::new(Broken),
            fallback: Box::new(RuleEpisode),
        };
        let outcome = episode
            .run(EpisodeInput {
                candidates: &candidates,
                settings: &settings,
                steps: 8,
                judge_calls: 5,
                judge: None,
                judge_model: "jev-latest",
            })
            .await
            .expect("fallback keeps the tick alive");

        assert_eq!(outcome.decisions.decisions.len(), 1);
        assert!(outcome.steps[0].starts_with("sidecar-failed:"));
    }

    #[tokio::test]
    async fn no_budget_is_not_a_reason_to_fall_back() {
        let settings = RouterSettings::default();
        let candidates = vec![candidate("TASK-1", "fix it")];
        let episode = FallbackEpisode {
            primary: Box::new(Empty),
            fallback: Box::new(RuleEpisode),
        };
        let error = episode
            .run(EpisodeInput {
                candidates: &candidates,
                settings: &settings,
                steps: 8,
                judge_calls: 5,
                judge: None,
                judge_model: "jev-latest",
            })
            .await
            .expect_err("no budget stays no budget");
        assert_eq!(error, EpisodeError::NoBudget);
    }

    #[tokio::test]
    async fn empty_title_asks_instead_of_dispatching() {
        let settings = RouterSettings::default();
        let input = EpisodeInput {
            candidates: &[candidate("TASK-1", "  ")],
            settings: &settings,
            steps: 8,
            judge_calls: 5,
            judge: None,
            judge_model: "jev-latest",
        };
        let outcome = RuleEpisode.run(input).await.expect("episode");
        assert_eq!(
            outcome.decisions.decisions[0].action,
            crate::super_agent::model::Action::Ask
        );
    }

    #[tokio::test]
    async fn step_budget_stops_the_loop_without_dropping_finished_decisions() {
        let settings = RouterSettings::default();
        let candidates = vec![
            candidate("TASK-1", "one"),
            candidate("TASK-2", "two"),
            candidate("TASK-3", "three"),
        ];
        let input = EpisodeInput {
            candidates: &candidates,
            settings: &settings,
            steps: 4,
            judge_calls: 0,
            judge: None,
            judge_model: "jev-latest",
        };
        let outcome = RuleEpisode.run(input).await.expect("episode");
        assert_eq!(outcome.decisions.decisions.len(), 2);
        assert!(outcome.decisions.unfinished);
    }

    #[tokio::test]
    async fn retry_carries_the_previous_failure_reason() {
        let settings = RouterSettings::default();
        let mut task = candidate("TASK-9", "fix it");
        task.run = Some(TaskRun {
            task_id: "TASK-9".into(),
            root: "/repo".into(),
            state: RunState::Failed,
            worker_app: Some("claude".into()),
            agent_id: None,
            agent_name: None,
            agent_model: None,
            session_id: None,
            attempts: 1,
            detail: Some("terminal-limit".into()),
            card_fingerprint: None,
            shadow: false,
            updated_at: 0,
        });
        let input = EpisodeInput {
            candidates: &[task],
            settings: &settings,
            steps: 8,
            judge_calls: 0,
            judge: None,
            judge_model: "jev-latest",
        };
        let outcome = RuleEpisode.run(input).await.expect("episode");
        let decision = &outcome.decisions.decisions[0];
        assert_eq!(decision.action, crate::super_agent::model::Action::Dispatch);
        assert!(decision
            .reason
            .as_deref()
            .unwrap()
            .contains("terminal-limit"));
    }
}
