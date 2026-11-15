#!/usr/bin/env node
// 侧车入口：一次 tick 一段「有判断」的循环。
//
// 两条路，同一套帧：
//
// - **有模型**（请求里带 `model`）：用 pi 的 agent 循环，工具表就是我们这七个工具，
//   模型请求经 phi 自己的网关（`/pi/v1/chat/completions`）出去，因此凭据、故障转移、
//   记账都走 phi 已有那条链路，这里不需要任何供应商配置。
// - **没有模型**：确定性策略（读卡 → 提名 → finish）。网关没起来或没配模型时用它，
//   行为与 Rust 里的规则版 episode 一致。
//
// 分工没有变：这里只有「先问哪个工具」的自由，闸门与结算全在 Rust。
// 协议见 src-tauri/src/super_agent/sidecar.rs 的模块注释。

import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

/** 等待中的工具调用：id → resolve。协议一问一答，但模型可以并发提问，所以按 id 对账。 */
const pending = new Map();
let nextId = 0;
let finished = false;

function write(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

/** 调一个 Rust 侧的工具。失败时抛出的错误里带 code，调用方自己应变。 */
function callTool(name, args = {}) {
  const id = `c${++nextId}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    write({ type: "tool.call", id, name, args });
  });
}

function onFrame(frame) {
  if (frame.type !== "tool.result") return;
  const waiter = pending.get(frame.id);
  if (!waiter) return;
  pending.delete(frame.id);
  if (frame.ok) {
    waiter.resolve(frame.result);
  } else {
    const error = new Error(frame.error?.message ?? "tool failed");
    error.code = frame.error?.code ?? "unknown";
    waiter.reject(error);
  }
}

async function finish(note) {
  if (finished) return;
  finished = true;
  try {
    await callTool("finish", { note });
  } catch (error) {
    process.stderr.write(`finish failed: ${error.code}\n`);
  }
}

async function ask(taskId, question) {
  try {
    await callTool("ask_user", { taskId, question });
  } catch (error) {
    process.stderr.write(`ask ${taskId}: ${error.code}\n`);
  }
}

// ---------------------------------------------------------------- 确定性策略

async function planDeterministic(request) {
  const candidates = request.candidates ?? [];

  let defaultWorker = null;
  try {
    const workers = await callTool("list_workers");
    defaultWorker = workers.default ?? workers.workers?.[0] ?? null;
  } catch (error) {
    // 拿不到 worker 表就没法提名，但不必中断：后面每张卡都会拿到同样的错误。
    process.stderr.write(`list_workers failed: ${error.code}\n`);
  }

  for (const candidate of candidates) {
    let task;
    try {
      task = await callTool("read_task", { taskId: candidate.taskId });
    } catch (error) {
      process.stderr.write(`read_task ${candidate.taskId}: ${error.code}\n`);
      continue;
    }

    if (!String(task.title ?? "").trim()) {
      await ask(candidate.taskId, "这张卡没有标题，看不出要做什么，先补一句。");
      continue;
    }

    if (!defaultWorker) {
      await ask(candidate.taskId, "没有配置可派发的 worker，先在自动调度设置里选一个。");
      continue;
    }

    const run = task.run;
    const reason =
      run?.state === "failed"
        ? `重试（第 ${(run.attempts ?? 0) + 1} 次）：${run.detail ?? "上一次失败，原因未记录"}`
        : "侧车：卡片位于触发列、依赖已满足。";

    try {
      await callTool("nominate_worker", {
        taskId: candidate.taskId,
        appId: defaultWorker,
        reason,
      });
    } catch (error) {
      // 闸门拒绝就是拒绝：不换个人再试一次，那是绕过闸门。
      process.stderr.write(`nominate ${candidate.taskId}: ${error.code}\n`);
    }
  }
}

// ---------------------------------------------------------------- pi 循环

const SYSTEM_PROMPT = `你是 phi 任务看板的调度器。你没有 shell、没有文件写、没有网络，只有下面这些工具。

目标：对每一张候选卡决定「派给谁」或「问人一句」，然后调 finish 收尾。

纪律：
- 只处理请求里给出的候选卡，不要臆造任务。
- 派发用 nominate_worker，worker 必须是 list_workers 里的人。被闸门拒绝就接受结论，不要换个名字重试。
- 卡片信息不够、或者这件事本来就需要人拍板，用 ask_user 问一句具体的问题。
- 判官（judge）是可选的。不确定时问它，但别为每张卡都问；它的额度有限。
- 决策要快：每张卡最多读一次卡、最多一次提名。

finish 之后这一轮就结束了。`;

function textResult(text) {
  return { content: [{ type: "text", text }], details: {} };
}

/** 把七个工具接进 pi 的工具表。函数体只做转发，判断留在 Rust。 */
function buildTools() {
  const tool = (name, label, description, parameters) => ({
    name,
    label,
    description,
    parameters,
    execute: async (_toolCallId, params) => {
      const result = await callTool(name, params ?? {});
      if (name === "finish") {
        finished = true;
        return { ...textResult("已收尾"), terminate: true };
      }
      return textResult(JSON.stringify(result));
    },
  });

  return [
    tool("read_task", "读卡", "读一张候选卡的标题、状态、依赖与正文摘要", {
      type: "object",
      properties: { taskId: { type: "string" } },
      required: ["taskId"],
    }),
    tool("list_workers", "看 worker", "看这一轮允许派给哪些应用", {
      type: "object",
      properties: {},
    }),
    tool("read_budget", "看预算", "看还剩几步、还能问判官几次", {
      type: "object",
      properties: {},
    }),
    tool("judge", "问判官", "问 Jev 一个判断。kind=choice 时 options 只能来自 list_workers。", {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["noul", "choice", "score"] },
        instructions: { type: "string" },
        taskId: { type: "string" },
        options: { type: "array", items: { type: "string" } },
      },
      required: ["kind", "instructions"],
    }),
    tool("nominate_worker", "提名", "提议把这张卡派给某个应用。只有 Rust 闸门通过才生效。", {
      type: "object",
      properties: {
        taskId: { type: "string" },
        appId: { type: "string" },
        reason: { type: "string" },
      },
      required: ["taskId", "appId"],
    }),
    tool("ask_user", "问人", "把一张卡转成「等你看」，并写给人的那一句话。", {
      type: "object",
      properties: { taskId: { type: "string" }, question: { type: "string" } },
      required: ["taskId", "question"],
    }),
    tool("finish", "收尾", "这一轮结束了", {
      type: "object",
      properties: { note: { type: "string" } },
    }),
  ];
}

async function planWithModel(request) {
  const channel = request.model;
  const [{ Agent }, { streamSimple }] = await Promise.all([
    import("@mariozechner/pi-agent-core"),
    import("@mariozechner/pi-ai"),
  ]);

  // 走 phi 自己的网关：baseUrl 指向 `/pi/v1`，SDK 会拼上 `/chat/completions`，
  // 凭据是 phi 为本机 pi 身份签的令牌，所以这里不需要任何供应商 key。
  const model = {
    id: channel.model,
    name: channel.model,
    api: "openai-completions",
    provider: "phi",
    baseUrl: channel.baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: channel.contextWindow ?? 200000,
    maxTokens: channel.maxTokens ?? 4096,
  };

  const agent = new Agent({
    initialState: {
      systemPrompt: SYSTEM_PROMPT,
      model,
      tools: buildTools(),
    },
    streamFn: streamSimple,
    getApiKey: () => channel.apiKey,
  });

  const prompt = [
    "本轮候选（JSON）：",
    JSON.stringify(
      (request.candidates ?? []).map((candidate) => ({
        taskId: candidate.taskId,
        title: candidate.title,
        status: candidate.status,
        dependencies: candidate.dependencies,
        run: candidate.run,
      })),
    ),
    `允许的 worker：${JSON.stringify(request.settings?.workerApps ?? [])}`,
    `步数上限 ${request.budget?.steps ?? "?"}，判官上限 ${request.budget?.judgeCalls ?? "?"}。`,
  ].join("\n");

  await agent.prompt(prompt);

  // pi 的循环把上游错误收进 state 而不是抛出来（这样一次失败不会打断整段对话）。
  // 但对我们来说「这一轮模型一句话都没说出来」就是要退回确定性策略的信号，
  // 否则会静默产出一轮空决策，看起来像「模型认为什么都不该动」。
  const failure = agent.state?.errorMessage;
  if (failure) throw new Error(failure);
}

// ---------------------------------------------------------------- 生命周期

async function runEpisode(request) {
  if (request.model) {
    try {
      await planWithModel(request);
    } catch (error) {
      // 模型这条路失败就退回确定性策略：一轮 tick 不该因为模型不可用而空转。
      process.stderr.write(`model path failed: ${error?.message ?? error}\n`);
      await planDeterministic(request);
    }
  } else {
    await planDeterministic(request);
  }
  await finish(`${request.candidates?.length ?? 0} 张卡`);
}

lines.on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  let frame;
  try {
    frame = JSON.parse(text);
  } catch {
    process.stderr.write("坏帧，忽略\n");
    return;
  }

  if (frame.type === "tool.result") {
    onFrame(frame);
    return;
  }

  if (frame.type !== "episode.request") return;

  runEpisode(frame)
    .catch((error) => process.stderr.write(`episode crashed: ${error?.message}\n`))
    .finally(() => {
      // 收尾即退出：一次 episode 一个进程，不留上下文给下一轮。
      lines.close();
      process.exit(0);
    });
});
