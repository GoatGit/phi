import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";
import zh from "@/i18n/locales/zh.json";
import { AgentBoardView } from "@/components/tasks/AgentBoardView";
import type { RouterAgent, RouterTaskRun } from "@/lib/api/superAgent";
import type { TaskCard } from "@/lib/api/tasks";

beforeAll(() => {
  // jsdom 没有 scrollIntoView，下拉打开时 Radix 会调它。
  Element.prototype.scrollIntoView = vi.fn();
  i18n.addResourceBundle("zh", "translation", zh, true, true);
});

const writer: RouterAgent = {
  id: "writer",
  name: "文档写手",
  description: "改文档",
  appId: "claude",
  prompt: "",
  model: "",
  arguments: [],
  outcome: "",
  boundary: "",
  askUserWhen: [],
  steps: [],
  constraints: [],
  completion: { result: "", evidence: [] },
};

function card(overrides: Partial<TaskCard> = {}): TaskCard {
  return {
    id: "TASK-1",
    kind: "task",
    sourceTask: null,
    round: null,
    discussionHold: false,
    discussionQuestion: null,
    title: "任务",
    status: "To Do",
    assignees: [],
    priority: null,
    labels: [],
    dependencies: [],
    createdDate: "2026-11-01",
    updatedDate: "2026-11-02",
    acceptanceTotal: 0,
    acceptanceDone: 0,
    artifactCount: 0,
    schedule: null,
    file: "backlog/tasks/task-1.md",
    fingerprint: "1:aa",
    ...overrides,
  };
}

const run = (state: string, taskId = "TASK-1"): RouterTaskRun => ({
  taskId,
  root: "/repo",
  state: state as RouterTaskRun["state"],
  workerApp: "claude",
  agentId: "writer",
  agentName: "文档写手",
  agentModel: null,
  sessionId: null,
  attempts: 1,
  detail: null,
  cardFingerprint: "1:aa",
  shadow: false,
  updatedAt: 1,
});

function renderView(
  overrides: Partial<Parameters<typeof AgentBoardView>[0]> = {},
) {
  const handlers = {
    onOpenTask: vi.fn(),
    onAssign: vi.fn(),
    onAssignAndStart: vi.fn(),
    onEditAgent: vi.fn(),
    onAddAgent: vi.fn(),
    onToggleAgent: vi.fn(),
    onSetAgentAvatar: vi.fn(),
    onDeleteAgent: vi.fn(),
    onSetRouterAvatar: vi.fn(),
    onCreateForAgent: vi.fn(async () => true),
    onCreateDraft: vi.fn(async () => true),
    onUseSuggestion: vi.fn(),
    onDismissSuggestion: vi.fn(),
  };
  render(
    <AgentBoardView
      tasks={[]}
      agents={[writer]}
      allowed={["writer"]}
      runsByTask={new Map()}
      routerAvatar=""
      busy={false}
      suggestion={null}
      {...handlers}
      {...overrides}
    />,
  );
  return handlers;
}

/** 一个行区块：行头是 h3，整行是它的 section。 */
function row(name: string): HTMLElement {
  const heading = screen.getByRole("heading", { name });
  return heading.closest("section") as HTMLElement;
}

describe("AgentBoardView", () => {
  it("讨论卡固定在第 0 行，且没有「指派并开工」", () => {
    renderView({
      tasks: [
        card({ id: "TASK-9", kind: "discussion", title: "要不要拆卡" }),
        card({ id: "TASK-1", title: "写文档", assignees: ["writer"] }),
      ],
    });
    const discussion = row(zh.tasks.agentView.discussionRow);
    expect(within(discussion).getByText("要不要拆卡")).toBeInTheDocument();
    expect(
      within(discussion).queryByRole("button", {
        name: zh.tasks.agentView.start,
      }),
    ).toBeNull();
    expect(within(row("文档写手")).getByText("写文档")).toBeInTheDocument();
  });

  it("归属认不出来时落在「未分配」，并写明未注册的是谁", () => {
    renderView({
      tasks: [
        card({ id: "TASK-1", title: "没主的活" }),
        card({ id: "TASK-2", title: "写了旧 id", assignees: ["ghost"] }),
      ],
    });
    const unassigned = row(zh.tasks.agentView.unassigned);
    expect(within(unassigned).getByText("没主的活")).toBeInTheDocument();
    expect(within(unassigned).getByText("写了旧 id")).toBeInTheDocument();
    expect(
      within(unassigned).getByText(
        zh.tasks.agentView.unknownAgent.replace("{{id}}", "ghost"),
      ),
    ).toBeInTheDocument();
  });

  it("行内 Done 默认只留 3 张，计数可展开", async () => {
    const done = Array.from({ length: 5 }, (_, index) =>
      card({
        id: `TASK-${index + 1}`,
        title: `完成 ${index + 1}`,
        status: "Done",
        assignees: ["writer"],
        updatedDate: `2026-11-0${index + 1}`,
      }),
    );
    renderView({ tasks: done });
    const writerRow = row("文档写手");
    // 已完成按最近更新排：行内先看到最新的三张。
    expect(within(writerRow).getByText("完成 5")).toBeInTheDocument();
    expect(within(writerRow).queryByText("完成 1")).toBeNull();
    await userEvent.click(
      within(writerRow).getByRole("button", {
        name: zh.tasks.agentView.doneCount.replace("{{count}}", "5"),
      }),
    );
    expect(within(writerRow).getByText("完成 1")).toBeInTheDocument();
  });

  it("行内 ▶ 是第二个动作：指派并开工", async () => {
    const handlers = renderView({
      tasks: [card({ id: "TASK-1", title: "写文档", assignees: ["writer"] })],
    });
    await userEvent.click(
      screen.getByRole("button", { name: zh.tasks.agentView.start }),
    );
    expect(handlers.onAssignAndStart).toHaveBeenCalledWith(
      expect.objectContaining({ id: "TASK-1" }),
      "writer",
    );
  });

  it("拖到某一行只做指派，不顺手开工", () => {
    const handlers = renderView({
      tasks: [card({ id: "TASK-1", title: "写文档" })],
    });
    const dataTransfer = {
      getData: () => "TASK-1",
      setData: vi.fn(),
      effectAllowed: "",
      dropEffect: "",
    };
    fireEvent.drop(row("文档写手"), { dataTransfer });
    expect(handlers.onAssign).toHaveBeenCalledWith(
      expect.objectContaining({ id: "TASK-1" }),
      "writer",
    );
    expect(handlers.onAssignAndStart).not.toHaveBeenCalled();
  });

  it("未参与派发的智能体只展示卡片，不接受拖放", () => {
    const handlers = renderView({
      tasks: [card({ id: "TASK-1", title: "写文档" })],
      allowed: [],
    });
    const dataTransfer = {
      getData: () => "TASK-1",
      setData: vi.fn(),
      effectAllowed: "",
      dropEffect: "",
    };
    fireEvent.drop(row("文档写手"), { dataTransfer });
    expect(handlers.onAssign).not.toHaveBeenCalled();
    expect(
      within(row("文档写手")).getByText(zh.tasks.agentView.notAllowed),
    ).toBeInTheDocument();
  });

  it("每个智能体有自己的头像，同一 id 不变", () => {
    const editor: RouterAgent = { ...writer, id: "editor", name: "文档审查员" };
    renderView({
      agents: [writer, editor],
      allowed: ["writer", "editor"],
      tasks: [
        card({ id: "TASK-1", title: "写文档", assignees: ["writer"] }),
        card({ id: "TASK-2", title: "审文档", assignees: ["editor"] }),
      ],
    });
    const inWriter = row("文档写手").querySelector("img[data-avatar-key]");
    const inEditor = row("文档审查员").querySelector("img[data-avatar-key]");
    expect(inWriter).not.toBeNull();
    expect(inEditor).not.toBeNull();
    // 头像是装饰：名称已经说了它是谁，不再给读屏念一遍。
    expect(inWriter?.getAttribute("aria-hidden")).toBe("true");
    // 两个不同的智能体不该长得一模一样。
    expect(inWriter?.getAttribute("data-avatar-key")).not.toBe(
      inEditor?.getAttribute("data-avatar-key"),
    );
  });

  it("选过的头像优先于按 id 派生的一张", () => {
    renderView({
      agents: [{ ...writer, avatar: "avatar-16" }],
      tasks: [card({ id: "TASK-1", title: "写文档", assignees: ["writer"] })],
    });
    const img = row("文档写手").querySelector("img[data-avatar-key]");
    expect(img?.getAttribute("data-avatar-key")).toBe("avatar-16");
  });

  it("点头像可以换一张，选中即保存", async () => {
    const handlers = renderView({
      tasks: [card({ id: "TASK-1", title: "写文档", assignees: ["writer"] })],
    });
    await userEvent.click(
      screen.getByRole("button", {
        name: zh.tasks.agentView.avatarSet.replace("{{name}}", "文档写手"),
      }),
    );
    await userEvent.click(
      await screen.findByRole("button", {
        name: zh.tasks.agentView.avatarPick.replace("{{key}}", "avatar-16"),
      }),
    );
    expect(handlers.onSetAgentAvatar).toHaveBeenCalledWith(
      expect.objectContaining({ id: "writer" }),
      "avatar-16",
    );
  });

  it("选过的头像可以回到默认（按 id 派生）", async () => {
    const handlers = renderView({
      agents: [{ ...writer, avatar: "avatar-16" }],
      tasks: [card({ id: "TASK-1", title: "写文档", assignees: ["writer"] })],
    });
    await userEvent.click(
      screen.getByRole("button", {
        name: zh.tasks.agentView.avatarSet.replace("{{name}}", "文档写手"),
      }),
    );
    // 选完一张之后才意味着「有一个默认可回」；没选过时这一项不出现。
    await userEvent.click(
      await screen.findByRole("button", {
        name: zh.tasks.agentView.avatarReset,
      }),
    );
    expect(handlers.onSetAgentAvatar).toHaveBeenCalledWith(
      expect.objectContaining({ id: "writer" }),
      "",
    );
  });

  it("Router 那一行也有头像，与智能体同一种，点了也能换", async () => {
    const handlers = renderView({
      tasks: [card({ id: "TASK-9", kind: "discussion", title: "还没想清楚" })],
    });
    const discussion = row(zh.tasks.agentView.discussionRow);
    expect(
      discussion.querySelector("header img[data-avatar-key]"),
    ).not.toBeNull();
    // 头像在行头，不在卡片里
    expect(discussion.querySelector("article img[data-avatar-key]")).toBeNull();

    await userEvent.click(
      within(discussion).getByRole("button", {
        name: zh.tasks.agentView.avatarSet.replace(
          "{{name}}",
          zh.tasks.agentView.routerName,
        ),
      }),
    );
    await userEvent.click(
      await screen.findByRole("button", {
        name: zh.tasks.agentView.avatarPick.replace("{{key}}", "avatar-15"),
      }),
    );
    expect(handlers.onSetRouterAvatar).toHaveBeenCalledWith("avatar-15");
  });

  it("行里的 + 建卡就归这一行：标题与任务类型一起交给看板", async () => {
    const user = userEvent.setup();
    const handlers = renderView();
    const writerRow = row("文档写手");

    await user.click(
      within(writerRow).getByRole("button", {
        name: zh.tasks.agentView.addTask.replace("{{name}}", "文档写手"),
      }),
    );
    const input = within(writerRow).getByPlaceholderText(
      zh.tasks.agentView.addTaskPlaceholder,
    );
    await user.type(input, "补一段说明{Enter}");
    // 回车只是换行：与列头一致，Ctrl+Enter 才提交
    expect(handlers.onCreateForAgent).not.toHaveBeenCalled();
    await user.keyboard("{Control>}{Enter}{/Control}");

    await waitFor(() =>
      expect(handlers.onCreateForAgent).toHaveBeenCalledWith(
        "writer",
        "补一段说明",
        { recurrence: null, schedule: null },
      ),
    );
    // 建完清空、留在原地，可以接着写第二件
    await waitFor(() => expect(input).toHaveValue(""));
  });

  it("行里新建也能选任务类型：定时任务带着时刻落盘", async () => {
    const user = userEvent.setup();
    const handlers = renderView();
    const writerRow = row("文档写手");

    await user.click(
      within(writerRow).getByRole("button", {
        name: zh.tasks.agentView.addTask.replace("{{name}}", "文档写手"),
      }),
    );
    await user.click(
      within(writerRow).getByRole("combobox", {
        name: zh.tasks.schedule.title,
      }),
    );
    await user.click(
      await screen.findByRole("option", {
        name: zh.tasks.schedule.mode.daily,
      }),
    );
    fireEvent.change(
      within(writerRow).getByLabelText(zh.tasks.schedule.timeLabel),
      { target: { value: "09:30" } },
    );
    await user.type(
      within(writerRow).getByPlaceholderText(
        zh.tasks.agentView.addTaskPlaceholder,
      ),
      "每天整理一次",
    );
    await user.keyboard("{Control>}{Enter}{/Control}");

    await waitFor(() =>
      expect(handlers.onCreateForAgent).toHaveBeenCalledWith(
        "writer",
        "每天整理一次",
        { recurrence: null, schedule: "09:30" },
      ),
    );
  });

  it("Router 行里的 + 记一张草稿：不排期，交给讨论入口", async () => {
    const user = userEvent.setup();
    const handlers = renderView();
    const discussion = row(zh.tasks.agentView.discussionRow);

    await user.click(
      within(discussion).getByRole("button", {
        name: zh.tasks.agentView.routerAdd,
      }),
    );
    // 还在讨论就不该先承诺什么时候跑：草稿不排期
    expect(
      within(discussion).queryByRole("combobox", {
        name: zh.tasks.schedule.title,
      }),
    ).toBeNull();

    await user.type(
      within(discussion).getByPlaceholderText(
        zh.tasks.agentView.routerAddPlaceholder,
      ),
      "要不要每天发一份周报",
    );
    await user.keyboard("{Control>}{Enter}{/Control}");

    await waitFor(() =>
      expect(handlers.onCreateDraft).toHaveBeenCalledWith(
        "要不要每天发一份周报",
      ),
    );
  });

  it("未参与派发的智能体不能加任务：先得让它上班", () => {
    renderView({ allowed: [] });
    expect(
      within(row("文档写手")).getByRole("button", {
        name: zh.tasks.agentView.addTask.replace("{{name}}", "文档写手"),
      }),
    ).toBeDisabled();
  });

  it("头像是行头，压在自己的卡片上方，不被卡片包着", () => {
    renderView({
      tasks: [card({ id: "TASK-1", title: "写文档", assignees: ["writer"] })],
    });
    const block = row("文档写手");
    // 行本身不再是一张卡：没有卡片底色，头像也不能落在卡片里面。
    expect(block).not.toHaveClass("bg-surface/60");
    const cardEl = within(block).getByText("写文档").closest("article");
    expect(cardEl).not.toBeNull();
    expect(cardEl?.querySelector("img[data-avatar-key]")).toBeNull();
    expect(block.querySelector("header img[data-avatar-key]")).not.toBeNull();
  });

  it("有提议时给一条可点开的预填草稿，可关掉", async () => {
    const handlers = renderView({
      suggestion: {
        name: "文档",
        appId: "claude",
        summary: "近 14 天已完成 3 张",
        steps: [],
        evidence: [],
        completed: 3,
      },
    });
    expect(screen.getByText("近 14 天已完成 3 张")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", {
        name: zh.tasks.agentView.suggestionUse.replace("{{name}}", "文档"),
      }),
    );
    expect(handlers.onUseSuggestion).toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole("button", {
        name: zh.tasks.agentView.suggestionDismiss,
      }),
    );
    expect(handlers.onDismissSuggestion).toHaveBeenCalled();
  });

  it("讨论卡不接受拖放指派：它没有归属", () => {
    const handlers = renderView({
      tasks: [card({ id: "TASK-9", kind: "discussion", title: "要不要拆卡" })],
    });
    const dataTransfer = {
      getData: () => "TASK-9",
      setData: vi.fn(),
      effectAllowed: "",
      dropEffect: "",
    };
    fireEvent.drop(row("文档写手"), { dataTransfer });
    fireEvent.drop(row(zh.tasks.agentView.unassigned), { dataTransfer });
    expect(handlers.onAssign).not.toHaveBeenCalled();
  });

  it("允许名单就在行头改：关掉派发不删定义", async () => {
    const handlers = renderView({
      tasks: [card({ id: "TASK-1", title: "写文档", assignees: ["writer"] })],
    });
    const toggle = within(row("文档写手")).getByRole("switch", {
      name: zh.tasks.agentView.allow.replace("{{name}}", "文档写手"),
    });
    expect(toggle).toBeChecked();
    await userEvent.click(toggle);
    expect(handlers.onToggleAgent).toHaveBeenCalledWith(
      expect.objectContaining({ id: "writer" }),
      false,
    );
  });

  it("删除要二次确认，点一下不会把人删掉", async () => {
    const handlers = renderView({
      tasks: [card({ id: "TASK-1", title: "写文档", assignees: ["writer"] })],
    });
    await userEvent.click(
      within(row("文档写手")).getByRole("button", {
        name: zh.tasks.agentView.delete.replace("{{name}}", "文档写手"),
      }),
    );
    expect(handlers.onDeleteAgent).not.toHaveBeenCalled();
    await userEvent.click(
      within(row("文档写手")).getByRole("button", {
        name: zh.tasks.agentView.deleteConfirm.replace("{{name}}", "文档写手"),
      }),
    );
    expect(handlers.onDeleteAgent).toHaveBeenCalledWith(
      expect.objectContaining({ id: "writer" }),
    );
  });

  it("运行中的行写清几张在跑", () => {
    renderView({
      tasks: [card({ id: "TASK-1", title: "写文档", assignees: ["writer"] })],
      runsByTask: new Map([["TASK-1", run("working")]]),
    });
    expect(
      within(row("文档写手")).getByText(
        zh.tasks.agentView.running.replace("{{count}}", "1"),
      ),
    ).toBeInTheDocument();
  });
});
