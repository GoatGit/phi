//! pi sidecar：把 episode 从「Rust 里的一段规则」换成「另一个进程里的一个循环」。
//!
//! 边界只有一条：**sidecar 里的一切都是模型可以不听劝的**，所以凡是不能被绕过的，
//! 都留在这里。具体是这几件事——工具表由 Rust 给、候选集由 Rust 给、步数与判官额度
//! 由 Rust 计、提名由 Rust 闸门判、决策由 Rust 结算。sidecar 能做的只有：选先问哪个
//! 工具、决定什么时候放弃。
//!
//! 协议是 stdio 上的行分隔 JSON，一次 episode 一个子进程：
//!
//! ```text
//! Rust → sidecar   {"type":"episode.request", ...}     一次，给出候选、预算、工具表
//! sidecar → Rust   {"type":"tool.call", id, name, args} 任意次
//! Rust → sidecar   {"type":"tool.result", id, ok, ...}  与上一条同 id
//! sidecar → Rust   {"type":"episode.done", note}        收尾（可以不来，见下）
//! ```
//!
//! 三条降级规则写在实现里，不是写在提示词里：
//!
//! 1. **没有 `episode.done` 不等于失败。** 已经通过闸门的提名照用，整轮标记 unfinished。
//!    一次超时不该把已经判对的东西一起扔掉。
//! 2. **判官额度用完只让工具报错。** sidecar 从这个错误里自己应变，整轮不中断。
//! 3. **子进程崩了、协议乱了、起不来，都只让这一轮退回规则版。** 见 [`crate::super_agent::episode::FallbackEpisode`]。

use std::collections::BTreeMap;
use std::path::Path;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

/// 测试里替掉真进程用的构造器。抽出来只为让 clippy 闭嘴，不影响语义。
type Factory = Box<dyn Fn() -> BoxFuture<'static, Result<Box<dyn Channel>, String>> + Send + Sync>;

use crate::super_agent::episode::{BoxFuture, Episode, EpisodeError, EpisodeInput, EpisodeOutcome};
use crate::super_agent::judge::{JudgeError, Question, Thresholds};
use crate::super_agent::model::{Candidate, Decision};

/// 工具表。这是模型全部的手：没有 shell、没有文件写、没有网络。
const TOOLS: [&str; 7] = [
    "read_task",
    "list_workers",
    "read_budget",
    "judge",
    "nominate_worker",
    "ask_user",
    "finish",
];

/// 一次 episode 的墙钟上限。tick 每 30 秒一拍，超时的这一拍也只是把下一拍推后。
const DEFAULT_DEADLINE: Duration = Duration::from_secs(40);

/// 单行帧的上限。超过就是协议出了问题，不当成一次合法的工具调用。
const MAX_LINE: usize = 256 * 1024;

/// 任务正文给模型看多少字。整张卡可能很长，够判断「要做什么」就行。
const BODY_EXCERPT: usize = 1500;

/// 环境变量：`PHI_ROUTER_SIDECAR="node /path/to/router-episode.mjs"`。
/// 没设就是规则版 episode——sidecar 是可选件，不是启动前提。
pub(crate) const SIDECAR_ENV: &str = "PHI_ROUTER_SIDECAR";

// ---------------------------------------------------------------- 管道

/// episode 与子进程之间的双向管道。抽成 trait 是为了让协议逻辑能在没有子进程时测。
pub(crate) trait Channel: Send {
    fn send<'a>(&'a mut self, line: String) -> BoxFuture<'a, Result<(), String>>;
    fn recv<'a>(&'a mut self) -> BoxFuture<'a, Result<Option<String>, String>>;
    /// 收尾时杀掉子进程。允许重复调用。
    fn kill(&mut self);
}

/// 真的子进程：stdin 写、stdout 读、stderr 丢给日志。
pub(crate) struct StdioChannel {
    child: tokio::process::Child,
    stdin: tokio::process::ChildStdin,
    stdout: tokio::io::Lines<tokio::io::BufReader<tokio::process::ChildStdout>>,
}

impl StdioChannel {
    pub(crate) async fn spawn(program: &str, args: &[String]) -> Result<Self, String> {
        use tokio::process::Command;

        let mut child = Command::new(program)
            .args(args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| format!("spawn {program}: {error}"))?;

        let stdin = child.stdin.take().ok_or_else(|| "no stdin".to_string())?;
        let stdout = child.stdout.take().ok_or_else(|| "no stdout".to_string())?;

        // stderr 不参与协议，但必须有人读：管道写满会把子进程卡死。
        if let Some(stderr) = child.stderr.take() {
            tauri::async_runtime::spawn(async move {
                let mut lines = tokio::io::BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    log::debug!("router-sidecar: {line}");
                }
            });
        }

        Ok(Self {
            child,
            stdin,
            stdout: tokio::io::BufReader::new(stdout).lines(),
        })
    }
}

impl Channel for StdioChannel {
    fn send<'a>(&'a mut self, line: String) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            self.stdin
                .write_all(line.as_bytes())
                .await
                .map_err(|error| format!("write: {error}"))?;
            self.stdin
                .write_all(b"\n")
                .await
                .map_err(|error| format!("write: {error}"))?;
            self.stdin
                .flush()
                .await
                .map_err(|error| format!("flush: {error}"))
        })
    }

    fn recv<'a>(&'a mut self) -> BoxFuture<'a, Result<Option<String>, String>> {
        Box::pin(async move {
            loop {
                match self.stdout.next_line().await {
                    Ok(Some(line)) => {
                        if line.trim().is_empty() {
                            continue; // 空行不是帧，跳过比判协议错更宽容。
                        }
                        if line.len() > MAX_LINE {
                            return Err("frame too large".into());
                        }
                        return Ok(Some(line));
                    }
                    Ok(None) => return Ok(None),
                    Err(error) => return Err(format!("read: {error}")),
                }
            }
        })
    }

    fn kill(&mut self) {
        let _ = self.child.start_kill();
    }
}

// ---------------------------------------------------------------- 帧

#[derive(Deserialize)]
#[serde(tag = "type")]
enum Inbound {
    #[serde(rename = "tool.call")]
    ToolCall {
        id: String,
        name: String,
        #[serde(default)]
        args: Value,
    },
    #[serde(rename = "episode.done")]
    Done {
        #[serde(default)]
        note: Option<String>,
    },
}

/// 工具失败的形状。模型看到的是「自己的一次调用失败了」，不是「有人拒绝了它」。
struct ToolError {
    code: &'static str,
    message: String,
}

impl ToolError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

// ---------------------------------------------------------------- episode

/// sidecar 版 episode。每次 run 起一个新进程：一个进程只服务一次 tick，
/// 这样上一轮残留的状态（模型上下文、半截工具调用）不会污染下一轮。
pub(crate) struct SidecarEpisode {
    program: String,
    args: Vec<String>,
    deadline: Duration,
    /// 交给模型的名字。没有它就用确定性策略——网关没起来时也走这条。
    model: Option<String>,
    /// 测试用：不真的起进程。
    factory: Option<Factory>,
}

impl SidecarEpisode {
    pub(crate) fn new(program: impl Into<String>, args: Vec<String>, deadline: Duration) -> Self {
        Self {
            program: program.into(),
            args,
            deadline,
            model: None,
            factory: None,
        }
    }

    /// 指定模型名。真正能不能问成，还要看 phi 的网关是否在监听。
    pub(crate) fn with_model(mut self, model: impl Into<String>) -> Self {
        let model = model.into();
        if !model.trim().is_empty() {
            self.model = Some(model);
        }
        self
    }

    /// 模型通道：pi 的请求经 phi 自己的网关出去，因此不需要在这里碰任何供应商凭据。
    ///
    /// 网关没在监听就返回 None——这时候交给模型等于让它干等，不如直接用确定性策略。
    fn model_channel(&self) -> Option<Value> {
        let model = self.model.as_deref()?;
        let port = crate::proxy::http_client::active_proxy_port()?;
        Some(json!({
            // pi 的 OpenAI 兼容客户端会把 `/chat/completions` 接在后面。
            "baseUrl": format!("http://127.0.0.1:{port}/pi/v1"),
            "apiKey": crate::proxy::ingress::token("pi"),
            "model": model,
        }))
    }

    /// 找随包分发的侧车：`phi-node` 与主程序放在一起，episode 脚本放在 resources 里。
    ///
    /// 找不到就返回 `None`——没带运行时（比如开发机上只跑了 npm 脚本）时不该让 tick 报错，
    /// 只是退回规则版。环境变量 `PHI_ROUTER_SIDECAR` 存在时以它为准，方便调试。
    pub(crate) fn bundled(app: &tauri::AppHandle) -> Option<Self> {
        if let Some(episode) = Self::from_env() {
            return Some(episode);
        }
        let executable = std::env::current_exe().ok()?;
        let dir = executable.parent()?;
        let node = dir.join(if cfg!(windows) {
            "phi-node.exe"
        } else {
            "phi-node"
        });
        if !node.is_file() {
            return None;
        }
        use tauri::Manager;
        let script = app.path().resource_dir().ok()?.join("sidecar");
        let script = script.join("router-episode.mjs");
        if !script.is_file() {
            return None;
        }
        Some(Self::new(
            node.to_string_lossy().to_string(),
            vec![script.to_string_lossy().to_string()],
            DEFAULT_DEADLINE,
        ))
    }

    /// 从环境变量读命令。没配就是 `None`。
    fn from_env() -> Option<Self> {
        let raw = std::env::var(SIDECAR_ENV).ok()?;
        let mut parts = raw.split_whitespace();
        let program = parts.next()?.to_string();
        let args: Vec<String> = parts.map(str::to_string).collect();
        Some(Self::new(program, args, DEFAULT_DEADLINE))
    }

    #[cfg(test)]
    pub(crate) fn with_factory(deadline: Duration, factory: Factory) -> Self {
        Self {
            program: String::new(),
            args: Vec::new(),
            deadline,
            model: None,
            factory: Some(factory),
        }
    }

    async fn open(&self) -> Result<Box<dyn Channel>, String> {
        match &self.factory {
            Some(factory) => factory().await,
            None => Ok(Box::new(
                StdioChannel::spawn(&self.program, &self.args).await?,
            )),
        }
    }
}

impl Episode for SidecarEpisode {
    fn run<'a>(
        &'a self,
        input: EpisodeInput<'a>,
    ) -> BoxFuture<'a, Result<EpisodeOutcome, EpisodeError>> {
        Box::pin(async move {
            if input.steps == 0 || input.candidates.is_empty() {
                return Err(EpisodeError::NoBudget);
            }
            let mut channel = self.open().await.map_err(EpisodeError::Failed)?;
            let mut session = Session::new(&input);
            let deadline = tokio::time::Instant::now() + self.deadline;

            let mut request = json!({
                "type": "episode.request",
                "id": uuid::Uuid::new_v4().to_string(),
                "budget": { "steps": input.steps, "judgeCalls": input.judge_calls },
                "settings": {
                    "triggerStatus": input.settings.trigger_status,
                    "workerApps": input.settings.worker_apps,
                    "maxAttempts": input.settings.max_attempts,
                },
                "candidates": input.candidates.iter().map(view).collect::<Vec<_>>(),
                "tools": TOOLS,
            });
            request["deadlineMs"] = json!(self.deadline.as_millis() as u64);
            if let Some(channel) = self.model_channel() {
                request["model"] = channel;
            }

            if let Err(reason) = send_within(&mut *channel, &request, deadline).await {
                channel.kill();
                return Err(EpisodeError::Failed(reason));
            }

            let mut frames = 0usize;
            // 一个只会刷帧不会收手的子进程不该能拖住 tick。
            let frame_cap = input.steps * 4 + 16;

            let outcome = loop {
                frames += 1;
                if frames > frame_cap {
                    break Err("protocol: too many frames".to_string());
                }

                let line = match recv_within(&mut *channel, deadline).await {
                    Ok(Some(line)) => line,
                    // 子进程自己退出了：没有 finish，但已经收下的决策照用。
                    // 一条都没收下就是「什么都没判断出来」，交给规则版，别让整轮空转。
                    Ok(None) if session.decisions.is_empty() => {
                        break Err("sidecar-exited-without-decision".to_string())
                    }
                    Ok(None) => break Ok(()),
                    Err(reason) if reason == TIMEOUT => {
                        session.note("deadline-exceeded");
                        // 到点但一条决策都没拿到：这一轮实际上什么都没判断出来。
                        // 返回 Ok 会让 tick 既不派发也不在卡上留任何状态，用户只看到
                        // 「卡片躺在执行列里，什么都没发生」。退回规则版才有活干。
                        // 已经拿到决策时照用（见模块注释第 1 条），不因为没收到 finish 就扔掉。
                        if session.decisions.is_empty() {
                            break Err(TIMEOUT.to_string());
                        }
                        break Ok(());
                    }
                    Err(reason) => break Err(reason),
                };

                let frame: Inbound = match serde_json::from_str(&line) {
                    Ok(frame) => frame,
                    Err(error) => break Err(format!("protocol: {error}")),
                };

                match frame {
                    Inbound::Done { note } => {
                        if let Some(note) = note {
                            session.note(&format!("done: {note}"));
                        }
                        session.finished = true;
                        break Ok(());
                    }
                    Inbound::ToolCall { id, name, args } => {
                        let result = session.call(&name, &args).await;
                        let reply = match result {
                            Ok(value) => json!({
                                "type": "tool.result",
                                "id": id,
                                "ok": true,
                                "result": value,
                            }),
                            Err(error) => json!({
                                "type": "tool.result",
                                "id": id,
                                "ok": false,
                                "error": { "code": error.code, "message": error.message },
                            }),
                        };
                        if let Err(reason) = send_within(&mut *channel, &reply, deadline).await {
                            break Err(reason);
                        }
                    }
                }
            };

            channel.kill();
            match outcome {
                Err(reason) => Err(EpisodeError::Failed(reason)),
                Ok(()) => Ok(session.finish()),
            }
        })
    }
}

const TIMEOUT: &str = "deadline-exceeded";

async fn send_within(
    channel: &mut dyn Channel,
    value: &Value,
    deadline: tokio::time::Instant,
) -> Result<(), String> {
    let remaining = remaining(deadline)?;
    match tokio::time::timeout(remaining, channel.send(value.to_string())).await {
        Ok(result) => result,
        Err(_) => Err(TIMEOUT.into()),
    }
}

async fn recv_within(
    channel: &mut dyn Channel,
    deadline: tokio::time::Instant,
) -> Result<Option<String>, String> {
    let remaining = remaining(deadline)?;
    match tokio::time::timeout(remaining, channel.recv()).await {
        Ok(result) => result,
        Err(_) => Err(TIMEOUT.into()),
    }
}

fn remaining(deadline: tokio::time::Instant) -> Result<Duration, String> {
    let now = tokio::time::Instant::now();
    if now >= deadline {
        return Err(TIMEOUT.into());
    }
    Ok(deadline - now)
}

/// 一张卡进 sidecar 时带什么。刻意不含运行态之外的东西：模型不需要知道数据库长什么样。
fn view(candidate: &Candidate) -> Value {
    let run = candidate.run.as_ref().map(|run| {
        json!({
            "state": run.state.as_str(),
            "attempts": run.attempts,
            "workerApp": run.worker_app,
            "detail": run.detail,
        })
    });
    json!({
        "taskId": candidate.task_id,
        "title": candidate.title,
        "status": candidate.status,
        "file": candidate.file,
        "dependencies": candidate.dependencies,
        "run": run,
    })
}

// ---------------------------------------------------------------- 会话状态

/// 一次 episode 里 Rust 侧攒下的东西：预算计数、闸门结果、日志行。
struct Session<'a> {
    input: &'a EpisodeInput<'a>,
    steps_left: usize,
    judge_left: usize,
    steps: Vec<String>,
    decisions: Vec<Decision>,
    judge_calls: usize,
    finished: bool,
}

impl<'a> Session<'a> {
    fn new(input: &'a EpisodeInput<'a>) -> Self {
        Self {
            input,
            steps_left: input.steps,
            judge_left: input.judge_calls,
            steps: Vec::new(),
            decisions: Vec::new(),
            judge_calls: 0,
            finished: false,
        }
    }

    fn note(&mut self, line: &str) {
        self.steps.push(format!("sidecar: {line}"));
    }

    fn finish(self) -> EpisodeOutcome {
        let mut steps = self.steps;
        if !self.finished {
            steps.push("sidecar: unfinished".into());
        }
        EpisodeOutcome {
            decisions: crate::super_agent::model::DecisionSet {
                decisions: self.decisions,
                unfinished: !self.finished,
            },
            steps,
            judge_calls: self.judge_calls,
        }
    }

    async fn call(&mut self, name: &str, args: &Value) -> Result<Value, ToolError> {
        if self.steps_left == 0 {
            return Err(ToolError::new(
                "step-budget-exhausted",
                "这一步的步数用完了，直接 finish",
            ));
        }
        self.steps_left -= 1;
        self.note(name);

        match name {
            "read_task" => self.read_task(args),
            "list_workers" => Ok(json!({
                "workers": self.input.settings.worker_apps,
                "default": self.input.settings.default_worker(),
            })),
            "read_budget" => Ok(json!({
                "stepsLeft": self.steps_left,
                "judgeCallsLeft": self.judge_left,
            })),
            "judge" => self.judge(args).await,
            "nominate_worker" => self.nominate(args),
            "ask_user" => self.ask(args),
            "finish" => {
                self.finished = true;
                Ok(json!({ "ok": true }))
            }
            other => Err(ToolError::new(
                "unknown-tool",
                format!("没有这个工具：{other}"),
            )),
        }
    }

    fn candidate(&self, args: &Value) -> Result<&'a Candidate, ToolError> {
        let task_id = args
            .get("taskId")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::new("bad-args", "缺少 taskId"))?;
        self.input
            .candidates
            .iter()
            .find(|candidate| candidate.task_id == task_id)
            .ok_or_else(|| ToolError::new("unknown-task", format!("{task_id} 不在这一轮的候选里")))
    }

    fn read_task(&mut self, args: &Value) -> Result<Value, ToolError> {
        let candidate = self.candidate(args)?;
        let body = read_excerpt(candidate);
        let mut view = view(candidate);
        view["bodyExcerpt"] = body.map(Value::from).unwrap_or(Value::Null);
        Ok(view)
    }

    async fn judge(&mut self, args: &Value) -> Result<Value, ToolError> {
        let Some(judge) = self.input.judge else {
            return Err(ToolError::new("judge-unavailable", "这一轮没有可用的判官"));
        };
        if self.judge_left == 0 {
            return Err(ToolError::new(
                "judge-budget-exhausted",
                "今天的判官额度用完了，按确定性规则决定",
            ));
        }

        let instructions = args
            .get("instructions")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if instructions.is_empty() {
            return Err(ToolError::new("bad-args", "缺少 instructions"));
        }
        let kind = args.get("kind").and_then(Value::as_str).unwrap_or("noul");

        let question = match kind {
            "noul" => Question::noul(instructions),
            "score" => {
                // score 走同一个入口，只是读的字段不同；这里的题干仍是自然语言。
                Question::noul(instructions)
            }
            "choice" => {
                let options = args
                    .get("options")
                    .and_then(Value::as_array)
                    .map(|values| {
                        values
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::to_string)
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                // 候选由代码给：options 只能是这一轮允许的 worker，模型不能自己造人。
                if options.is_empty()
                    || options
                        .iter()
                        .any(|option| !self.input.settings.worker_apps.contains(option))
                {
                    return Err(ToolError::new(
                        "options-not-closed",
                        "choice 的候选只能是 list_workers 里的 app",
                    ));
                }
                Question::choice(instructions, options)
            }
            other => return Err(ToolError::new("bad-args", format!("不认识的题型：{other}"))),
        };

        let state = match args.get("taskId").and_then(Value::as_str) {
            Some(task_id) => self
                .input
                .candidates
                .iter()
                .find(|candidate| candidate.task_id == task_id)
                .map(|candidate| {
                    json!({
                        "task": {
                            "taskId": candidate.task_id,
                            "title": candidate.title,
                            "status": candidate.status,
                            "dependencies": candidate.dependencies,
                            "detail": candidate.run.as_ref().and_then(|run| run.detail.clone()),
                        },
                        "excerpt": read_excerpt(candidate),
                    })
                })
                .unwrap_or(Value::Null),
            None => {
                json!({ "candidates": self.input.candidates.iter().map(view).collect::<Vec<_>>() })
            }
        };

        self.judge_calls += 1;
        self.judge_left -= 1;

        let mut questions = BTreeMap::new();
        questions.insert("q".to_string(), question);
        let reply = judge
            .ask(self.input.judge_model, state, questions)
            .await
            .map_err(|error| match error {
                JudgeError::Unavailable(reason) => ToolError::new("judge-unavailable", reason),
                JudgeError::Failed(reason) => ToolError::new("judge-failed", reason),
                JudgeError::Unusable(reason) => ToolError::new("judge-unusable", reason),
            })?;

        let thresholds = Thresholds::default();
        let answer = match kind {
            "choice" => match reply.choice_with_margin("q") {
                // 差距不够就是「判官也不确定」，交给模型按确定性规则兜底，不赌第一个。
                Some((choice, margin)) => json!({
                    "choice": choice,
                    "margin": margin,
                    "certain": margin >= thresholds.margin,
                }),
                None => json!({ "choice": Value::Null, "certain": false }),
            },
            "score" => json!({ "score": reply.score("q") }),
            _ => match reply.noul("q") {
                Some(probability) => json!({
                    "probability": probability,
                    "certain": probability >= thresholds.act,
                }),
                None => json!({ "probability": Value::Null, "certain": false }),
            },
        };
        Ok(answer)
    }

    /// 闸门：候选集与 worker 表都由 Rust 给，模型只能在里面挑。
    /// 「这张卡配不配这个 worker」的判官判定还没接（见设计文档第 11 节）。
    fn nominate(&mut self, args: &Value) -> Result<Value, ToolError> {
        let app_id = args
            .get("appId")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::new("bad-args", "缺少 appId"))?;
        if !self
            .input
            .settings
            .worker_apps
            .iter()
            .any(|app| app == app_id)
        {
            return Err(ToolError::new(
                "gate-denied",
                format!("{app_id} 不在这一轮允许的 worker 里"),
            ));
        }
        let task_id = self.candidate(args)?.task_id.clone();
        if self.decisions.iter().any(|d| d.task_id == task_id) {
            return Err(ToolError::new(
                "gate-denied",
                format!("{task_id} 这一轮已经有结论了，不要重复提名"),
            ));
        }
        let reason = args
            .get("reason")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        self.decisions
            .push(Decision::dispatch(task_id, app_id, reason));
        Ok(json!({ "accepted": true }))
    }

    fn ask(&mut self, args: &Value) -> Result<Value, ToolError> {
        let question = args
            .get("question")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if question.is_empty() {
            return Err(ToolError::new("bad-args", "要问人就得写清问什么"));
        }
        let task_id = self.candidate(args)?.task_id.clone();
        if self.decisions.iter().any(|d| d.task_id == task_id) {
            return Err(ToolError::new(
                "gate-denied",
                format!("{task_id} 这一轮已经有结论了"),
            ));
        }
        let question = question.to_string();
        self.decisions.push(Decision::ask(task_id, question));
        Ok(json!({ "accepted": true }))
    }
}

/// 卡片正文摘要。读不到就返回 None：摘要缺失不该让一次 episode 失败。
fn read_excerpt(candidate: &Candidate) -> Option<String> {
    let path = Path::new(&candidate.root).join(&candidate.file);
    let text = std::fs::read_to_string(path).ok()?;
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    Some(text.chars().take(BODY_EXCERPT).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::super_agent::episode::EpisodeInput;
    use crate::super_agent::judge::{Judge, JudgeError, JudgeReply};
    use crate::super_agent::model::{Action, RouterSettings};
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    // ------------------------------------------------------------ 测试替身

    /// 按脚本回帧的管道：脚本里没有下一帧了就假装子进程退出。
    struct ScriptChannel {
        inbound: VecDeque<String>,
        sent: Arc<Mutex<Vec<Value>>>,
    }

    impl Channel for ScriptChannel {
        fn send<'a>(&'a mut self, line: String) -> BoxFuture<'a, Result<(), String>> {
            Box::pin(async move {
                if let Ok(value) = serde_json::from_str::<Value>(&line) {
                    self.sent.lock().unwrap().push(value);
                }
                Ok(())
            })
        }

        fn recv<'a>(&'a mut self) -> BoxFuture<'a, Result<Option<String>, String>> {
            Box::pin(async move { Ok(self.inbound.pop_front()) })
        }

        fn kill(&mut self) {}
    }

    /// 送完预置的帧就装死：用来看「超时，但已经拿到决策」的行为。
    struct StallAfter {
        inbound: VecDeque<String>,
        sent: Arc<Mutex<Vec<Value>>>,
    }

    impl Channel for StallAfter {
        fn send<'a>(&'a mut self, line: String) -> BoxFuture<'a, Result<(), String>> {
            Box::pin(async move {
                if let Ok(value) = serde_json::from_str::<Value>(&line) {
                    self.sent.lock().unwrap().push(value);
                }
                Ok(())
            })
        }

        fn recv<'a>(&'a mut self) -> BoxFuture<'a, Result<Option<String>, String>> {
            Box::pin(async move {
                if let Some(line) = self.inbound.pop_front() {
                    return Ok(Some(line));
                }
                tokio::time::sleep(Duration::from_secs(30)).await;
                Ok(None)
            })
        }

        fn kill(&mut self) {}
    }

    fn scripted(frames: Vec<Value>) -> (SidecarEpisode, Arc<Mutex<Vec<Value>>>) {
        let sent = Arc::new(Mutex::new(Vec::new()));
        let lines: VecDeque<String> = frames.iter().map(|frame| frame.to_string()).collect();
        let handle = sent.clone();
        let episode = SidecarEpisode::with_factory(
            Duration::from_secs(5),
            Box::new(move || {
                let lines = lines.clone();
                let sent = handle.clone();
                Box::pin(async move {
                    Ok(Box::new(ScriptChannel {
                        inbound: lines,
                        sent,
                    }) as Box<dyn Channel>)
                })
            }),
        );
        (episode, sent)
    }

    fn call(id: &str, name: &str, args: Value) -> Value {
        json!({ "type": "tool.call", "id": id, "name": name, "args": args })
    }

    fn candidate(id: &str, title: &str) -> Candidate {
        Candidate {
            task_id: id.into(),
            root: "/nonexistent".into(),
            title: title.into(),
            status: "In Progress".into(),
            file: format!("backlog/tasks/{id}.md"),
            fingerprint: "fp".into(),
            dependencies: Vec::new(),
            run: None,
        }
    }

    fn input<'a>(candidates: &'a [Candidate], settings: &'a RouterSettings) -> EpisodeInput<'a> {
        EpisodeInput {
            candidates,
            settings,
            steps: 8,
            judge_calls: 5,
            judge: None,
            judge_model: "jev-latest",
        }
    }

    /// 数调用的判官替身。
    struct StubJudge {
        calls: AtomicUsize,
        probability: Option<f64>,
    }

    impl Judge for StubJudge {
        fn ask<'a>(
            &'a self,
            _model: &'a str,
            _state: Value,
            _questions: BTreeMap<String, Question>,
        ) -> BoxFuture<'a, Result<JudgeReply, JudgeError>> {
            Box::pin(async move {
                self.calls.fetch_add(1, Ordering::SeqCst);
                let mut answers = BTreeMap::new();
                if let Some(probability) = self.probability {
                    answers.insert("q".to_string(), json!({ "noul": probability }));
                }
                Ok(JudgeReply { answers })
            })
        }
    }

    fn tool_results(sent: &Mutex<Vec<Value>>) -> Vec<Value> {
        sent.lock()
            .unwrap()
            .iter()
            .filter(|frame| frame["type"] == "tool.result")
            .cloned()
            .collect()
    }

    // ------------------------------------------------------------ 用例

    #[tokio::test]
    async fn request_carries_candidates_budget_and_the_closed_tool_table() {
        let settings = RouterSettings::default();
        let candidates = vec![candidate("TASK-1", "改个错字")];
        let (episode, sent) = scripted(vec![json!({ "type": "episode.done" })]);
        episode
            .run(input(&candidates, &settings))
            .await
            .expect("episode");

        let sent = sent.lock().unwrap();
        let request = &sent[0];
        assert_eq!(request["type"], "episode.request");
        assert_eq!(request["budget"]["steps"], 8);
        assert_eq!(request["candidates"][0]["taskId"], "TASK-1");
        let tools: Vec<&str> = request["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .collect();
        assert!(tools.contains(&"nominate_worker"));
        // 没有手：这三个词一次都不该出现在工具表里。
        assert!(!tools.contains(&"shell"));
        assert!(!tools.contains(&"write_file"));
    }

    #[tokio::test]
    async fn nomination_through_the_gate_becomes_a_dispatch_decision() {
        let settings = RouterSettings::default();
        let candidates = vec![candidate("TASK-1", "改个错字")];
        let (episode, sent) = scripted(vec![
            call(
                "c1",
                "nominate_worker",
                json!({ "taskId": "TASK-1", "appId": "claude", "reason": "小改动" }),
            ),
            json!({ "type": "episode.done", "note": "一处" }),
        ]);
        let outcome = episode
            .run(input(&candidates, &settings))
            .await
            .expect("episode");

        assert_eq!(outcome.decisions.decisions.len(), 1);
        let decision = &outcome.decisions.decisions[0];
        assert_eq!(decision.action, Action::Dispatch);
        assert_eq!(decision.app_id.as_deref(), Some("claude"));
        assert!(!outcome.decisions.unfinished);

        let results = tool_results(&sent);
        assert_eq!(results[0]["ok"], true);
    }

    #[tokio::test]
    async fn unknown_worker_is_refused_and_the_loop_keeps_going() {
        let settings = RouterSettings::default();
        let candidates = vec![candidate("TASK-1", "改个错字")];
        let (episode, sent) = scripted(vec![
            call(
                "c1",
                "nominate_worker",
                json!({ "taskId": "TASK-1", "appId": "gemini" }),
            ),
            call(
                "c2",
                "nominate_worker",
                json!({ "taskId": "TASK-1", "appId": "codex" }),
            ),
            json!({ "type": "episode.done" }),
        ]);
        let outcome = episode
            .run(input(&candidates, &settings))
            .await
            .expect("episode");

        let results = tool_results(&sent);
        assert_eq!(results[0]["ok"], false);
        assert_eq!(results[0]["error"]["code"], "gate-denied");
        assert_eq!(results[1]["ok"], true);
        assert_eq!(outcome.decisions.decisions.len(), 1);
        assert_eq!(
            outcome.decisions.decisions[0].app_id.as_deref(),
            Some("codex")
        );
    }

    #[tokio::test]
    async fn no_done_frame_degrades_instead_of_dropping_the_decision() {
        let settings = RouterSettings::default();
        let candidates = vec![candidate("TASK-1", "改个错字")];
        // 只有提名，子进程就退出了：不补 finish 是常见情况（超时、崩溃）。
        let (episode, _sent) = scripted(vec![call(
            "c1",
            "nominate_worker",
            json!({ "taskId": "TASK-1", "appId": "claude" }),
        )]);
        let outcome = episode
            .run(input(&candidates, &settings))
            .await
            .expect("episode");

        assert!(outcome.decisions.unfinished);
        assert_eq!(outcome.decisions.decisions.len(), 1);
        assert!(outcome
            .steps
            .iter()
            .any(|step| step == "sidecar: unfinished"));
    }

    #[tokio::test]
    async fn step_budget_turns_into_a_tool_error_not_a_crash() {
        let settings = RouterSettings::default();
        let candidates = vec![candidate("TASK-1", "改个错字")];
        let (episode, sent) = scripted(vec![
            call("c1", "list_workers", json!({})),
            call("c2", "list_workers", json!({})),
            json!({ "type": "episode.done" }),
        ]);
        let mut episode_input = input(&candidates, &settings);
        episode_input.steps = 1;
        episode.run(episode_input).await.expect("episode");

        let results = tool_results(&sent);
        assert_eq!(results[0]["ok"], true);
        assert_eq!(results[1]["ok"], false);
        assert_eq!(results[1]["error"]["code"], "step-budget-exhausted");
    }

    #[tokio::test]
    async fn judge_budget_zero_keeps_the_judge_tool_unavailable() {
        let settings = RouterSettings::default();
        let candidates = vec![candidate("TASK-1", "改个错字")];
        let judge = StubJudge {
            calls: AtomicUsize::new(0),
            probability: Some(0.9),
        };
        let (episode, sent) = scripted(vec![
            call(
                "c1",
                "judge",
                json!({ "kind": "noul", "instructions": "值得动吗", "taskId": "TASK-1" }),
            ),
            json!({ "type": "episode.done" }),
        ]);
        let mut episode_input = input(&candidates, &settings);
        episode_input.judge = Some(&judge);
        episode_input.judge_calls = 0;
        let outcome = episode.run(episode_input).await.expect("episode");

        let results = tool_results(&sent);
        assert_eq!(results[0]["error"]["code"], "judge-budget-exhausted");
        assert_eq!(judge.calls.load(Ordering::SeqCst), 0);
        assert_eq!(outcome.judge_calls, 0);
    }

    #[tokio::test]
    async fn judge_choice_refuses_options_the_code_did_not_offer() {
        let settings = RouterSettings::default();
        let candidates = vec![candidate("TASK-1", "改个错字")];
        let judge = StubJudge {
            calls: AtomicUsize::new(0),
            probability: None,
        };
        let (episode, sent) = scripted(vec![
            call(
                "c1",
                "judge",
                json!({
                    "kind": "choice",
                    "instructions": "派给谁",
                    "options": ["claude", "gemini"],
                }),
            ),
            json!({ "type": "episode.done" }),
        ]);
        let mut episode_input = input(&candidates, &settings);
        episode_input.judge = Some(&judge);
        episode.run(episode_input).await.expect("episode");

        let results = tool_results(&sent);
        assert_eq!(results[0]["error"]["code"], "options-not-closed");
    }

    #[tokio::test]
    async fn a_judge_call_is_counted_and_reported() {
        let settings = RouterSettings::default();
        let candidates = vec![candidate("TASK-1", "改个错字")];
        let judge = StubJudge {
            calls: AtomicUsize::new(0),
            probability: Some(0.8),
        };
        let (episode, sent) = scripted(vec![
            call(
                "c1",
                "judge",
                json!({ "kind": "noul", "instructions": "值得动吗", "taskId": "TASK-1" }),
            ),
            json!({ "type": "episode.done" }),
        ]);
        let mut episode_input = input(&candidates, &settings);
        episode_input.judge = Some(&judge);
        let outcome = episode.run(episode_input).await.expect("episode");

        let results = tool_results(&sent);
        assert_eq!(results[0]["ok"], true);
        assert_eq!(results[0]["result"]["probability"], 0.8);
        assert_eq!(results[0]["result"]["certain"], true);
        assert_eq!(outcome.judge_calls, 1);
        assert_eq!(judge.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn garbage_frames_fail_the_episode_so_the_caller_can_fall_back() {
        let settings = RouterSettings::default();
        let candidates = vec![candidate("TASK-1", "改个错字")];
        let sent = Arc::new(Mutex::new(Vec::new()));
        let handle = sent.clone();
        let episode = SidecarEpisode::with_factory(
            Duration::from_secs(5),
            Box::new(move || {
                let sent = handle.clone();
                Box::pin(async move {
                    Ok(Box::new(ScriptChannel {
                        inbound: VecDeque::from(vec!["not json".to_string()]),
                        sent,
                    }) as Box<dyn Channel>)
                })
            }),
        );
        let error = episode
            .run(input(&candidates, &settings))
            .await
            .expect_err("garbage should fail");
        assert!(matches!(error, EpisodeError::Failed(reason) if reason.contains("protocol")));
    }

    #[tokio::test]
    async fn a_stalled_child_that_decided_nothing_fails_so_the_caller_falls_back() {
        let settings = RouterSettings::default();
        let candidates = vec![candidate("TASK-1", "改个错字")];

        /// 收下请求后永远不再说话。
        struct Silent {
            sent: Arc<Mutex<Vec<Value>>>,
        }
        impl Channel for Silent {
            fn send<'a>(&'a mut self, line: String) -> BoxFuture<'a, Result<(), String>> {
                Box::pin(async move {
                    if let Ok(value) = serde_json::from_str::<Value>(&line) {
                        self.sent.lock().unwrap().push(value);
                    }
                    Ok(())
                })
            }
            fn recv<'a>(&'a mut self) -> BoxFuture<'a, Result<Option<String>, String>> {
                Box::pin(async move {
                    tokio::time::sleep(Duration::from_secs(30)).await;
                    Ok(None)
                })
            }
            fn kill(&mut self) {}
        }

        let sent = Arc::new(Mutex::new(Vec::new()));
        let handle = sent.clone();
        let episode = SidecarEpisode::with_factory(
            Duration::from_millis(150),
            Box::new(move || {
                let sent = handle.clone();
                Box::pin(async move { Ok(Box::new(Silent { sent }) as Box<dyn Channel>) })
            }),
        );
        // 一条决策都没有的「超时」不是「模型认为不该动」，是这一轮什么都没判断出来。
        // 返回 Ok 会让 tick 空转一轮（不派发、卡上也不留状态），必须退回规则版。
        let error = episode
            .run(input(&candidates, &settings))
            .await
            .expect_err("deadline without decisions should fail");
        assert!(matches!(error, EpisodeError::Failed(reason) if reason == TIMEOUT));
    }

    #[tokio::test]
    async fn a_stalled_child_hits_the_deadline_and_keeps_what_it_already_decided() {
        let settings = RouterSettings::default();
        let candidates = vec![candidate("TASK-1", "改个错字")];
        let sent = Arc::new(Mutex::new(Vec::new()));
        let handle = sent.clone();
        let episode = SidecarEpisode::with_factory(
            Duration::from_millis(150),
            Box::new(move || {
                let sent = handle.clone();
                Box::pin(async move {
                    Ok(Box::new(StallAfter {
                        inbound: VecDeque::from(vec![call(
                            "c1",
                            "nominate_worker",
                            json!({ "taskId": "TASK-1", "appId": "claude" }),
                        )
                        .to_string()]),
                        sent,
                    }) as Box<dyn Channel>)
                })
            }),
        );
        let outcome = episode
            .run(input(&candidates, &settings))
            .await
            .expect("deadline keeps the decision");

        assert!(outcome.decisions.unfinished);
        assert_eq!(outcome.decisions.decisions.len(), 1);
        assert!(outcome
            .steps
            .iter()
            .any(|step| step == "sidecar: deadline-exceeded"));
    }

    /// 找一个能跑侧车的运行时 + 脚本。优先用随包分发的那一对（自带的 node 与打好的
    /// dist 产物），这样这条测试验的就是真实的分发形态，而不是开发机上的 node。
    fn shipped_sidecar() -> Option<(String, String)> {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        let script = [
            repo.join("sidecar/dist/router-episode.mjs"),
            repo.join("sidecar/src/episode.mjs"),
        ]
        .into_iter()
        .find(|path| path.is_file())?;
        let triple = option_env!("PHI_TARGET_TRIPLE").unwrap_or("");
        let bundled = repo
            .join("src-tauri/binaries")
            .join(format!("phi-node-{triple}"));
        let program = if bundled.is_file() {
            bundled.to_string_lossy().to_string()
        } else if std::process::Command::new("node")
            .arg("--version")
            .output()
            .is_ok()
        {
            "node".to_string()
        } else {
            return None;
        };
        Some((program, script.to_string_lossy().to_string()))
    }

    /// 端到端：真的起一个子进程跑侧车。没有运行时或没构建过脚本时跳过（而不是假装通过）。
    #[tokio::test]
    async fn the_shipped_sidecar_speaks_the_protocol() {
        let Some((program, script)) = shipped_sidecar() else {
            eprintln!("skip: 没有可用的 node 运行时或侧车脚本");
            return;
        };

        let settings = RouterSettings::default();
        let candidates = vec![
            candidate("TASK-1", "把错误提示改成中文"),
            candidate("TASK-2", "  "),
        ];
        let episode = SidecarEpisode::new(program, vec![script], Duration::from_secs(20));
        let outcome = episode
            .run(input(&candidates, &settings))
            .await
            .expect("sidecar runs");

        assert!(!outcome.decisions.unfinished, "侧车会调 finish");
        assert_eq!(outcome.decisions.decisions.len(), 2);
        // 有标题的那张被派发；没标题的那张转人工问一句。
        assert_eq!(outcome.decisions.decisions[0].action, Action::Dispatch);
        assert_eq!(outcome.decisions.decisions[1].action, Action::Ask);
    }
}
