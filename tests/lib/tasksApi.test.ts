import { beforeEach, describe, expect, it, vi } from "vitest";

const core = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => core);

import { orchestrationApi } from "@/lib/api/orchestration";
import { taskErrorMessage, tasksApi } from "@/lib/api/tasks";

/**
 * 这层是 Rust 命令名的契约：命令名拼错或参数名从 camelCase 退回 snake_case，
 * 运行时才会炸，所以在这里钉住。
 */
describe("tasksApi · 看板命令契约", () => {
  beforeEach(() => {
    core.invoke.mockReset();
    core.invoke.mockResolvedValue(null);
  });

  it("工作区：登记、初始化、移除", async () => {
    await tasksApi.workspaces();
    await tasksApi.addWorkspace("/repo");
    await tasksApi.initWorkspace("/repo", "phi");
    await tasksApi.removeWorkspace("/repo");

    expect(core.invoke.mock.calls).toEqual([
      ["task_workspaces"],
      ["task_workspace_add", { root: "/repo" }],
      ["task_workspace_init", { root: "/repo", projectName: "phi" }],
      ["task_workspace_remove", { root: "/repo" }],
    ]);
  });

  it("读：看板与详情都带 root / taskId", async () => {
    await tasksApi.board("/repo");
    await tasksApi.detail("/repo", "TASK-1");

    expect(core.invoke.mock.calls).toEqual([
      ["task_board", { root: "/repo" }],
      ["task_detail", { root: "/repo", taskId: "TASK-1" }],
    ]);
  });

  it("写：改状态必须带指纹，归档同理", async () => {
    await tasksApi.setStatus("/repo", "TASK-1", "Done", "12:abcd");
    await tasksApi.archive("/repo", "TASK-1", "12:abcd");

    expect(core.invoke.mock.calls).toEqual([
      [
        "task_set_status",
        {
          root: "/repo",
          taskId: "TASK-1",
          status: "Done",
          fingerprint: "12:abcd",
        },
      ],
      [
        "task_archive",
        { root: "/repo", taskId: "TASK-1", fingerprint: "12:abcd" },
      ],
    ]);
  });

  it("新建任务把 input 原样交给 Rust，由 Rust 决定默认值", async () => {
    const input = { title: "Board", acceptance: ["a"] };
    await tasksApi.create("/repo", input);
    expect(core.invoke).toHaveBeenCalledWith("task_create", {
      root: "/repo",
      input,
    });
  });

  it("会话关联：建立与取消都用 sessionId / appId", async () => {
    await tasksApi.linkSession("/repo", "TASK-1", "session-1", "codex");
    await tasksApi.unlinkSession("/repo", "TASK-1", "session-1");

    expect(core.invoke.mock.calls).toEqual([
      [
        "task_link_session",
        {
          root: "/repo",
          taskId: "TASK-1",
          sessionId: "session-1",
          appId: "codex",
        },
      ],
      [
        "task_unlink_session",
        {
          root: "/repo",
          taskId: "TASK-1",
          sessionId: "session-1",
        },
      ],
    ]);
  });
});

describe("orchestrationApi · 编排接力命令契约", () => {
  it("读接力视图：gateNumber 用 camelCase，门判定带 2 / 3", async () => {
    await orchestrationApi.relay("/repo", "TASK-1");
    await orchestrationApi.runGate("/repo", "TASK-1", 2);
    await orchestrationApi.runGate("/repo", "TASK-1", 3);

    expect(core.invoke.mock.calls).toEqual([
      ["task_relay", { root: "/repo", taskId: "TASK-1" }],
      ["task_gate_run", { root: "/repo", taskId: "TASK-1", gateNumber: 2 }],
      ["task_gate_run", { root: "/repo", taskId: "TASK-1", gateNumber: 3 }],
    ]);
  });
});

describe("taskErrorMessage", () => {
  const t = (key: string) => key;

  it("把 Rust 错误码翻成文案，未知错误原样显示", () => {
    expect(taskErrorMessage("no-backlog", t)).toBe("tasks.errors.noBacklog");
    expect(taskErrorMessage("stale-fingerprint", t)).toBe("tasks.errors.stale");
    expect(taskErrorMessage(new Error("terminal-unsupported"), t)).toBe(
      "tasks.errors.terminalUnsupported",
    );
    expect(taskErrorMessage("boom", t)).toBe("boom");
  });
});
