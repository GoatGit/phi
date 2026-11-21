// 侧车的集成测试：不碰真的 phi 网关，用一个假的 OpenAI 兼容服务把 pi 的循环跑起来。
//
// 验的是这一段链路：帧进 → pi 的 agent 循环 → 模型要调工具 → 工具转发成 `tool.call`
// → 结果回给模型 → 收尾。真网关那一段（鉴权、路由、故障转移）由 phi 自己的测试负责。
//
// 跑法：cd sidecar && npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import readline from "node:readline";

const entry = fileURLToPath(new URL("../src/episode.mjs", import.meta.url));

/** 假上游：按次序回答，前三次是工具调用，之后是普通文本收尾。 */
function startStubModel(script) {
  let calls = 0;
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const next = script[Math.min(calls, script.length - 1)];
      calls += 1;
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const chunk = (delta, finish = null) =>
        `data: ${JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion.chunk",
          created: 0,
          model: "phi-test",
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;

      if (next.tool) {
        response.write(
          chunk({
            tool_calls: [
              {
                index: 0,
                id: `call_${calls}`,
                type: "function",
                function: { name: next.tool, arguments: JSON.stringify(next.args ?? {}) },
              },
            ],
          }),
        );
        response.write(chunk({}, "tool_calls"));
      } else {
        response.write(chunk({ content: next.text ?? "done" }));
        response.write(chunk({}, "stop"));
      }
      response.write("data: [DONE]\n\n");
      response.end();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ port, server, calls: () => calls });
    });
  });
}

/** 起侧车，把它的输出帧读出来，按需要回帧。 */
function runSidecar(request, onToolCall) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry], { stdio: ["pipe", "pipe", "pipe"] });
    const frames = [];
    let stderr = "";

    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", async (line) => {
      const frame = JSON.parse(line);
      frames.push(frame);
      if (frame.type !== "tool.call") return;

      const reply = await onToolCall(frame);
      child.stdin.write(
        `${JSON.stringify({
          type: "tool.result",
          id: frame.id,
          ok: !reply.error,
          ...(reply.error
            ? { error: { code: reply.error.code, message: reply.error.message } }
            : { result: reply.result }),
        })}\n`,
      );
    });

    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, frames, stderr }));
    child.stdin.write(`${JSON.stringify(request)}\n`);
  });
}

test("模型要工具时，转发成 tool.call；闸门放行的提名进入决策", async () => {
  const stub = await startStubModel([
    { tool: "list_workers" },
    { tool: "nominate_worker", args: { taskId: "TASK-1", appId: "claude", reason: "小改动" } },
    { tool: "finish", args: { note: "done" } },
  ]);

  const { code, frames, stderr } = await runSidecar(
    {
      type: "episode.request",
      id: "r1",
      budget: { steps: 8, judgeCalls: 5 },
      settings: { workerApps: ["claude", "codex"] },
      candidates: [{ taskId: "TASK-1", title: "改个错字", status: "In Progress" }],
      model: {
        baseUrl: `http://127.0.0.1:${stub.port}/pi/v1`,
        apiKey: "phi-local-v1:pi:test",
        model: "phi-test",
      },
    },
    (frame) => {
      if (frame.name === "list_workers") return { result: { workers: ["claude", "codex"], default: "claude" } };
      return { result: { accepted: true } };
    },
  );
  stub.server.close();

  assert.equal(code, 0, `侧车应正常退出；stderr=${stderr}`);
  const names = frames.filter((frame) => frame.type === "tool.call").map((frame) => frame.name);
  assert.deepEqual(names, ["list_workers", "nominate_worker", "finish"]);
  // 工具参数原样传过来了，没有在 JS 侧被改写。
  const nominate = frames.find((frame) => frame.name === "nominate_worker");
  assert.equal(nominate.args.appId, "claude");
});

test("模型这条路失败时退回确定性策略，不会让这一轮空转", async () => {
  // 指向一个没人监听的口子：pi 一开口就连接失败。
  const { code, frames, stderr } = await runSidecar(
    {
      type: "episode.request",
      id: "r2",
      budget: { steps: 8, judgeCalls: 5 },
      settings: { workerApps: ["claude"] },
      candidates: [{ taskId: "TASK-1", title: "改个错字", status: "In Progress" }],
      model: { baseUrl: "http://127.0.0.1:9/pi/v1", apiKey: "phi-local-v1:pi:test", model: "phi-test" },
    },
    (frame) => {
      if (frame.name === "list_workers") return { result: { workers: ["claude"], default: "claude" } };
      if (frame.name === "read_task") return { result: { taskId: "TASK-1", title: "改个错字" } };
      return { result: { accepted: true } };
    },
  );

  assert.equal(code, 0);
  assert.match(stderr, /model path failed/);
  const names = frames.filter((frame) => frame.type === "tool.call").map((frame) => frame.name);
  // 确定性策略的固定次序：先看 worker 表，再读卡，再提名，最后收尾。
  assert.deepEqual(names, ["list_workers", "read_task", "nominate_worker", "finish"]);
});

test("没有 model 字段时完全走确定性策略，不会去连模型", async () => {
  const { code, frames } = await runSidecar(
    {
      type: "episode.request",
      id: "r3",
      budget: { steps: 8, judgeCalls: 0 },
      settings: { workerApps: ["claude"] },
      candidates: [{ taskId: "TASK-2", title: "  ", status: "In Progress" }],
    },
    (frame) => {
      if (frame.name === "list_workers") return { result: { workers: ["claude"], default: "claude" } };
      return { result: { taskId: "TASK-2", title: "  " } };
    },
  );

  assert.equal(code, 0);
  const names = frames.filter((frame) => frame.type === "tool.call").map((frame) => frame.name);
  // 没标题的卡转人工，不提名。
  assert.deepEqual(names, ["list_workers", "read_task", "ask_user", "finish"]);
});

test("讨论只回一段文本：不调工具，也不产出决策", async () => {
  const stub = await startStubModel([{ text: "建议先改验收，再拆成两张。" }]);

  const { code, frames, stderr } = await runSidecar(
    {
      type: "discussion.request",
      id: "d1",
      system: "你是 phi 的 Router",
      prompt: "用户刚说：先定范围",
      model: {
        baseUrl: `http://127.0.0.1:${stub.port}/pi/v1`,
        apiKey: "phi-local-v1:pi:test",
        model: "phi-test",
      },
    },
    () => ({ result: {} }),
  );
  stub.server.close();

  assert.equal(code, 0, `侧车应正常退出；stderr=${stderr}`);
  const reply = frames.find((frame) => frame.type === "discussion.reply");
  assert.ok(reply, `应有 discussion.reply；frames=${JSON.stringify(frames)}`);
  assert.equal(reply.id, "d1");
  assert.match(reply.text, /建议先改验收/);
  // 讨论阶段没有手：工具表是空的，一个 tool.call 都不该出现。
  assert.equal(frames.filter((frame) => frame.type === "tool.call").length, 0);
});

test("讨论连不上模型时回 discussion.error，不让 Rust 等到超时", async () => {
  const { code, frames, stderr } = await runSidecar(
    {
      type: "discussion.request",
      id: "d2",
      system: "",
      prompt: "在吗",
      model: {
        baseUrl: "http://127.0.0.1:9/pi/v1",
        apiKey: "phi-local-v1:pi:test",
        model: "phi-test",
      },
    },
    () => ({ result: {} }),
  );

  assert.equal(code, 0, `侧车应正常退出；stderr=${stderr}`);
  const failed = frames.find((frame) => frame.type === "discussion.error");
  assert.ok(failed, `应有 discussion.error；frames=${JSON.stringify(frames)}`);
  assert.equal(failed.id, "d2");
});
