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
  artifactCount: 0,
  schedule: null,
  file: "backlog/tasks/task-1.md",
  fingerprint: "12:abcd",
};

const detail: TaskDetail = {
  task,
  body: "",
  sections: [],
  acceptance: [],
  links: [],
  outcome: null,
  artifacts: [],
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
      onSetSchedule={vi.fn()}
      onRevealArtifact={vi.fn()}
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

describe("TaskDetailSheet — 结果与产物", () => {
  const withResult = (): TaskDetail => ({
    ...detail,
    outcome: "整理完 7 条新闻，附来源。",
    artifacts: [
      {
        label: "今日简报",
        path: "daily/report.md",
        exists: true,
        size: 2048,
        url: null,
      },
      {
        label: "在线版本",
        path: "https://example.com/report",
        exists: true,
        size: null,
        url: "https://example.com/report",
      },
    ],
    sections: [{ title: "Conclusion", body: "跑了很久。" }],
  });

  it("结果与产物排在运行细节之前，正文不再重复同一段", async () => {
    const user = userEvent.setup();
    const onRevealArtifact = vi.fn();
    renderSheet({ detail: withResult(), onRevealArtifact });

    expect(await screen.findByText("整理完 7 条新闻，附来源。")).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: zh.tasks.result.reveal }),
    );
    expect(onRevealArtifact).toHaveBeenCalledWith("daily/report.md");

    const result = screen.getByRole("region", {
      name: zh.tasks.result.title,
    });
    const router = screen.getByText(zh.tasks.router.section);
    // 结果块必须在自动调度之前：用户先看交付了什么，再看跑了第几次
    expect(
      result.compareDocumentPosition(router) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("没有结果摘要时如实说明，而不是编一段过程", () => {
    renderSheet();
    expect(screen.getByText(zh.tasks.result.empty)).toBeTruthy();
  });
});

describe("TaskDetailSheet — 任务类型", () => {
  it("设成持续任务：选类型、填间隔、保存", async () => {
    const user = userEvent.setup();
    const onSetSchedule = vi.fn();
    Element.prototype.scrollIntoView = vi.fn();
    renderSheet({ onSetSchedule });

    await user.click(
      screen.getByRole("combobox", { name: zh.tasks.schedule.title }),
    );
    await user.click(
      await screen.findByRole("option", {
        name: zh.tasks.schedule.mode.interval,
      }),
    );
    await user.type(
      screen.getByRole("textbox", { name: zh.tasks.schedule.value }),
      "2h",
    );
    await user.click(
      screen.getByRole("button", { name: zh.tasks.schedule.save }),
    );

    expect(onSetSchedule).toHaveBeenCalledWith("2h", null);
  });

  it("取消排期时两个参数都给 null", async () => {
    const user = userEvent.setup();
    const onSetSchedule = vi.fn();
    renderSheet({
      detail: {
        ...detail,
        task: {
          ...task,
          schedule: {
            kind: "interval",
            minutes: 120,
            time: null,
            at: null,
            lastRunAt: null,
            nextRunAt: null,
          },
        },
      },
      onSetSchedule,
    });

    await user.click(
      screen.getByRole("combobox", { name: zh.tasks.schedule.title }),
    );
    await user.click(
      await screen.findByRole("option", {
        name: zh.tasks.schedule.mode.none,
      }),
    );
    await user.click(
      screen.getByRole("button", { name: zh.tasks.schedule.save }),
    );
    expect(onSetSchedule).toHaveBeenCalledWith(null, null);
  });
});
