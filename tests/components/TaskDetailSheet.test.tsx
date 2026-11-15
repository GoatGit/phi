import { describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { render, screen } from "@testing-library/react";
import i18n from "i18next";
import { beforeAll } from "vitest";
import zh from "@/i18n/locales/zh.json";
import { TaskDetailSheet } from "@/components/tasks/TaskDetailSheet";
import type { TaskCard, TaskDetail } from "@/lib/api/tasks";

beforeAll(() => {
  i18n.addResourceBundle("zh", "translation", zh, true, true);
});

const task: TaskCard = {
  id: "TASK-1",
  title: "芳芳说的发生",
  status: "To Do",
  assignees: [],
  priority: "medium",
  labels: [],
  dependencies: [],
  createdDate: "2026-11-13",
  updatedDate: null,
  acceptanceTotal: 0,
  acceptanceDone: 0,
  file: "backlog/tasks/task-1.md",
  fingerprint: "12:abcd",
};

const detail: TaskDetail = {
  task,
  body: "",
  sections: [],
  acceptance: [],
  links: [],
};

function renderSheet(
  overrides: Partial<Parameters<typeof TaskDetailSheet>[0]> = {},
) {
  const onClose = vi.fn();
  const onAutoStart = vi.fn();
  render(
    <TaskDetailSheet
      detail={detail}
      statuses={["To Do", "In Progress", "Done"]}
      busy={false}
      run={undefined}
      plan={[]}
      onClose={onClose}
      onAutoStart={onAutoStart}
      onAutoPause={vi.fn()}
      onAutoResume={vi.fn()}
      onSetStatus={vi.fn()}
      onArchive={vi.fn()}
      onResolve={vi.fn()}
      onUnlink={vi.fn()}
      {...overrides}
    />,
  );
  return { onClose, onAutoStart };
}

describe("TaskDetailSheet — 统一启动", () => {
  it("只保留调度开始入口，不再提供绕过运行态的开始会话", async () => {
    const user = userEvent.setup();
    const { onAutoStart } = renderSheet();

    await user.click(
      await screen.findByRole("button", { name: zh.tasks.router.start }),
    );
    expect(onAutoStart).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("button", { name: zh.tasks.startSession }),
    ).toBeNull();
  });
});

describe("TaskDetailSheet — 跳转到终端会话", () => {
  const linked = (): TaskDetail => ({
    ...detail,
    links: [
      {
        sessionId: "s-live",
        appId: "codex",
        createdAt: 0,
        costUsd: 0,
        requests: 3,
      },
    ],
  });

  it("后台派发的会话能从这里打开终端", async () => {
    const user = userEvent.setup();
    const onOpenSession = vi.fn();
    renderSheet({
      detail: linked(),
      liveSessionIds: new Set(["s-live"]),
      onOpenSession,
    });

    await user.click(
      await screen.findByRole("button", { name: zh.tasks.openSession }),
    );
    expect(onOpenSession).toHaveBeenCalledWith("codex", "s-live");
  });

  it("应用重启后会话不在了，如实写「会话已结束」而不是给一个打不开的按钮", () => {
    renderSheet({
      detail: linked(),
      liveSessionIds: new Set<string>(),
      onOpenSession: vi.fn(),
    });

    expect(
      screen.queryByRole("button", { name: zh.tasks.openSession }),
    ).toBeNull();
    expect(screen.getByText(zh.tasks.sessionEnded)).toBeTruthy();
  });
});
