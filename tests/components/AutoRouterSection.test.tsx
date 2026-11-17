import { beforeAll, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { render, screen } from "@testing-library/react";
import i18n from "i18next";
import zh from "@/i18n/locales/zh.json";
import { AutoRouterSection } from "@/components/tasks/AutoRouterSection";
import type { RouterTaskRun } from "@/lib/api/superAgent";

beforeAll(() => {
  i18n.addResourceBundle("zh", "translation", zh, true, true);
});

const run: RouterTaskRun = {
  taskId: "TASK-1",
  root: "/repo",
  state: "working",
  workerApp: "claude",
  sessionId: "s1",
  attempts: 2,
  detail: null,
  cardFingerprint: "12:abcd",
  shadow: false,
  updatedAt: 1,
};

function renderSection(
  overrides: Partial<Parameters<typeof AutoRouterSection>[0]> = {},
) {
  const onStart = vi.fn();
  const onPause = vi.fn();
  const onResume = vi.fn();
  render(
    <AutoRouterSection
      run={run}
      busy={false}
      onStart={onStart}
      onPause={onPause}
      onResume={onResume}
      onResolve={vi.fn()}
      {...overrides}
    />,
  );
  return { onStart, onPause, onResume };
}

describe("AutoRouterSection", () => {
  it("跑着的时候给的是「暂停」，并写清谁在跑、第几次", () => {
    renderSection();
    expect(screen.getByText(zh.tasks.router.state.working)).toBeInTheDocument();
    expect(screen.getAllByText(/Claude Code/).length).toBeGreaterThan(0);
    expect(screen.getByText("第 2 次尝试")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: zh.tasks.router.pause }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: zh.tasks.router.start }),
    ).toBeNull();
  });

  it("暂停之后给的是「恢复」", () => {
    renderSection({ run: { ...run, state: "paused" } });
    expect(
      screen.getByRole("button", { name: zh.tasks.router.resume }),
    ).toBeInTheDocument();
  });

  it("等你看的时候把问题原文显示出来", () => {
    renderSection({
      run: {
        ...run,
        state: "needs-you",
        detail: "这段要不要顺手重构，还是只修 bug？",
      },
    });
    expect(
      screen.getByText(zh.tasks.router.state.needsYou),
    ).toBeInTheDocument();
    expect(
      screen.getByText("这段要不要顺手重构，还是只修 bug？"),
    ).toBeInTheDocument();
  });

  it("没有运行态时只给开始按钮，不留永远为空的执行计划", async () => {
    const user = userEvent.setup();
    const { onStart } = renderSection({ run: undefined });
    expect(
      screen.queryByText(zh.tasks.router.planTitle),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: zh.tasks.router.start }),
    );
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("确认表单提交选择，不会通过开始按钮绕过确认", async () => {
    const user = userEvent.setup();
    const onResolve = vi.fn();
    renderSection({ run: { ...run, state: "needs-you" }, onResolve });
    expect(
      screen.queryByRole("button", { name: zh.tasks.router.start }),
    ).toBeNull();
    await user.selectOptions(screen.getByRole("combobox"), "complete");
    await user.click(
      screen.getByRole("button", { name: zh.tasks.router.confirmSubmit }),
    );
    expect(onResolve).toHaveBeenCalledWith("complete");
  });

  it("忙碌时确认不可提交，已完成任务没有重复开始入口", () => {
    renderSection({ run: { ...run, state: "needs-you" }, busy: true });
    expect(
      screen.getByRole("button", { name: zh.tasks.router.confirmSubmit }),
    ).toBeDisabled();
  });

  it("已完成任务不再显示开始", () => {
    renderSection({ run: { ...run, state: "done" } });
    expect(
      screen.queryByRole("button", { name: zh.tasks.router.start }),
    ).toBeNull();
  });

  it("有运行态时也只写运行事实，不再预告一个空的执行计划", () => {
    renderSection();
    expect(screen.getByText(zh.tasks.router.state.working)).toBeInTheDocument();
    expect(
      screen.queryByText(zh.tasks.router.planEmpty),
    ).not.toBeInTheDocument();
  });
});

describe("AutoRouterSection — 会话入口", () => {
  it("有 worker 就「打开终端」，点了把请求交给上层", async () => {
    const user = userEvent.setup();
    const onOpenWorker = vi.fn();
    renderSection({ onOpenWorker });

    await user.click(
      screen.getByRole("button", { name: zh.tasks.openSession }),
    );
    expect(onOpenWorker).toHaveBeenCalledTimes(1);
  });

  it("还没有派发过 worker 时不给一个打不开的按钮", () => {
    // 没有 sessionId 的卡（还没跑过）不该出现「打开终端」。
    renderSection({
      onOpenWorker: undefined,
      run: { ...run, sessionId: null },
    });

    expect(
      screen.queryByRole("button", { name: zh.tasks.openSession }),
    ).toBeNull();
  });
});
