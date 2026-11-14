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

function renderSheet() {
  const onClose = vi.fn();
  const onStartSession = vi.fn();
  render(
    <TaskDetailSheet
      detail={detail}
      statuses={["To Do", "In Progress", "Done"]}
      terminalApps={["codex"]}
      busy={false}
      run={undefined}
      plan={[]}
      onClose={onClose}
      onAutoStart={vi.fn()}
      onAutoPause={vi.fn()}
      onAutoResume={vi.fn()}
      onSetStatus={vi.fn()}
      onArchive={vi.fn()}
      onStartSession={onStartSession}
      onUnlink={vi.fn()}
    />,
  );
  return { onClose, onStartSession };
}

describe("TaskDetailSheet — 开始会话", () => {
  it("先收起抽屉再开终端，避免两层模态和整页替换同时卸载", async () => {
    const user = userEvent.setup();
    const { onClose, onStartSession } = renderSheet();

    await user.click(
      await screen.findByRole("button", { name: zh.tasks.startSession }),
    );
    const item = await screen.findByRole("menuitem", { name: "Codex" });
    await user.click(item);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onStartSession).toHaveBeenCalledWith("codex");
    expect(onClose.mock.invocationCallOrder[0]).toBeLessThan(
      onStartSession.mock.invocationCallOrder[0],
    );
  });
});
