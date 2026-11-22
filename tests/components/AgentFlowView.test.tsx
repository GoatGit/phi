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
import { AgentFlowView } from "@/components/tasks/AgentFlowView";
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
    session: null,
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
  overrides: Partial<Parameters<typeof AgentFlowView>[0]> = {},
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
    onCreateTask: vi.fn(async () => true),
    onCreateDraft: vi.fn(async () => true),
  };
  render(
    <AgentFlowView
      tasks={[]}
      agents={[writer]}
      allowed={["writer"]}
      runsByTask={new Map()}
      routerAvatar=""
      busy={false}
      {...handlers}
      {...overrides}
    />,
  );
  return handlers;
}

/** 图里的一个节点。节点是唯一的身份，连线也按这个键找它。 */
function node(key: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-flow-node="${key}"]`);
  if (!el) throw new Error(`图里没有 ${key} 这个节点`);
  return el;
}

/** 右栏（聚焦那一支的卡片）。data-lane 写着它现在属于谁。 */
function laneColumn(): HTMLElement {
  const el = document.querySelector<HTMLElement>("[data-lane]");
  if (!el) throw new Error("没有任务栏");
  return el;
}

function laneKey(): string | null {
  return laneColumn().getAttribute("data-lane");
}

function focusLane(name: string) {
  fireEvent.click(
    screen.getByRole("button", {
      name: zh.tasks.agentView.focusNode.replace("{{name}}", name),
    }),
  );
}

const dataTransfer = (taskId: string) => ({
  getData: () => taskId,
  setData: vi.fn(),
  effectAllowed: "",
  dropEffect: "",
});

describe("AgentFlowView", () => {
  it("编制图有四列：输入、Lead、智能体，第四列是聚焦那一支的卡", () => {
    renderView({
      tasks: [card({ id: "TASK-1", title: "写文档", assignees: ["writer"] })],
    });
    expect(node("lead")).toBeInTheDocument();
    expect(node("agent:writer")).toBeInTheDocument();
    expect(node("unassigned")).toBeInTheDocument();
    expect(node("discussion")).toBeInTheDocument();
    expect(laneKey()).toBe("agent:writer");
  });

  it("「与 Lead 讨论」在输入列，原来的会话与 MCP 卡片不再出现", () => {
    renderView({
      tasks: [card({ id: "TASK-1", title: "写文档", assignees: ["writer"] })],
    });
    const columns = [
      ...document.querySelectorAll(".phi-flow-stage > .phi-flow-col"),
    ];
    // 输入列里就是那一件事，别处不再复述 Lead 读什么
    expect(columns[0].contains(node("discussion"))).toBe(true);
    expect(columns[1].contains(node("lead"))).toBe(true);
    expect(document.querySelector('[data-flow-node^="input:"]')).toBeNull();
    expect(
      document.querySelector('.phi-flow-node[data-kind="input"]'),
    ).toBeNull();
    // 旁路线从输入列连到 Lead，紫色是它唯一的颜色
    expect(
      document.querySelector('.agent-flow-wires path[data-state="human"]'),
    ).not.toBeNull();
  });

  it("卡上写明它会接着某段对话干：不写的话看不出它为什么不是从零开始", () => {
    renderView({
      tasks: [
        card({
          id: "TASK-1",
          title: "写文档",
          assignees: ["writer"],
          session: "6f1c8f0e-33c4",
        }),
      ],
    });
    const column = laneColumn();
    expect(
      within(column).getByText(zh.tasks.session.cardBadge),
    ).toBeInTheDocument();
    // 具体 id 放在 title 里：卡片上只留一句人话。
    expect(
      within(column).getByTitle(
        zh.tasks.session.cardBadgeTitle.replace("{{id}}", "6f1c8f0e-33c4"),
      ),
    ).toBeInTheDocument();
  });

  it("任务列不重复智能体卡片：只留一排图标与卡", () => {
    renderView({
      tasks: [card({ id: "TASK-1", title: "写文档", assignees: ["writer"] })],
    });
    const column = laneColumn();
    // 头像与名字已经在左边那个节点上了
    expect(column.querySelector("img[data-avatar-key]")).toBeNull();
    expect(column.querySelector(".agent-lane-head")).toBeNull();
    expect(
      within(column).getByText(
        zh.tasks.agentView.laneTasksFor.replace("{{name}}", "文档写手"),
      ),
    ).toBeInTheDocument();
    // 四个操作一个不少
    expect(
      within(column).getByRole("switch", {
        name: zh.tasks.agentView.enableAgent.replace("{{name}}", "文档写手"),
      }),
    ).toBeInTheDocument();
    for (const key of ["edit", "delete"] as const) {
      expect(
        within(column).getByRole("button", {
          name: zh.tasks.agentView[key].replace("{{name}}", "文档写手"),
        }),
      ).toBeInTheDocument();
    }
    // 新建任务只剩一枚 ＋：名字在 aria-label 与提示里，不在字面上
    const add = within(column).getByRole("button", {
      name: zh.tasks.agentView.addTask.replace("{{name}}", "文档写手"),
    });
    expect(add).toBeInTheDocument();
    expect(add.textContent).toBe("");
  });

  it("归属边一张卡一根：在跑的那张走主题色，其余的仍是静态", () => {
    renderView({
      tasks: [
        card({ id: "TASK-1", title: "写文档", assignees: ["writer"] }),
        card({ id: "TASK-2", title: "补说明", assignees: ["writer"] }),
      ],
      runsByTask: new Map([["TASK-2", run("working", "TASK-2")]]),
    });
    // 一张卡各自是一个落点：不是一根线落到「卡堆中间」
    expect(node("card:TASK-1")).toBeInTheDocument();
    expect(node("card:TASK-2")).toBeInTheDocument();
    // 1 旁路 + 1 分派 + 1 未分配 + 2 归属：每张卡一根
    const paths = [...document.querySelectorAll(".agent-flow-wires path")];
    expect(paths).toHaveLength(5);
    // 最后两根就是卡上那两根：在跑的那张动，另一张不跟着动
    const [idle, busy] = paths.slice(-2);
    expect(idle.getAttribute("data-state")).toBe("own");
    expect(busy.getAttribute("data-state")).toBe("busy");
  });

  it("连线按语义分开画：一条旁路、每个智能体一条分派边", () => {
    renderView({
      tasks: [card({ id: "TASK-1", title: "写文档", assignees: ["writer"] })],
    });
    const wires = document.querySelectorAll(".agent-flow-wires path");
    // 1 旁路 + 1 智能体 + 1 未分配 + 1 归属
    expect(wires).toHaveLength(4);
    expect(
      document.querySelector('.agent-flow-wires path[data-state="human"]'),
    ).not.toBeNull();
    // 输入边随那两张卡片一起没了
    expect(
      document.querySelectorAll('.agent-flow-wires path[data-state="input"]'),
    ).toHaveLength(0);
    // 智能体这条走的是「有活但没在跑」的实线
    expect(
      document.querySelector('.agent-flow-wires path[data-state="idle"]'),
    ).not.toBeNull();
    // 智能体与它手上的卡之间还有一条归属边
    expect(
      document.querySelector('.agent-flow-wires path[data-state="own"]'),
    ).not.toBeNull();
  });

  it("有活在跑时，它那条边跟着变成在跑；影子模式不算", () => {
    const { unmount } = render(
      <AgentFlowView
        tasks={[card({ id: "TASK-1", assignees: ["writer"] })]}
        agents={[writer]}
        allowed={["writer"]}
        runsByTask={new Map([["TASK-1", run("working")]])}
        routerAvatar=""
        busy={false}
        onOpenTask={vi.fn()}
        onAssign={vi.fn()}
        onAssignAndStart={vi.fn()}
        onEditAgent={vi.fn()}
        onAddAgent={vi.fn()}
        onToggleAgent={vi.fn()}
        onSetAgentAvatar={vi.fn()}
        onDeleteAgent={vi.fn()}
        onSetRouterAvatar={vi.fn()}
        onCreateForAgent={vi.fn(async () => true)}
        onCreateTask={vi.fn(async () => true)}
        onCreateDraft={vi.fn(async () => true)}
      />,
    );
    expect(
      document.querySelector('.agent-flow-wires path[data-state="busy"]'),
    ).not.toBeNull();
    expect(
      within(node("agent:writer")).getByText(
        zh.tasks.agentView.running.replace("{{count}}", "1"),
      ),
    ).toBeInTheDocument();
    unmount();

    render(
      <AgentFlowView
        tasks={[card({ id: "TASK-1", assignees: ["writer"] })]}
        agents={[writer]}
        allowed={["writer"]}
        runsByTask={new Map([["TASK-1", { ...run("working"), shadow: true }]])}
        routerAvatar=""
        busy={false}
        onOpenTask={vi.fn()}
        onAssign={vi.fn()}
        onAssignAndStart={vi.fn()}
        onEditAgent={vi.fn()}
        onAddAgent={vi.fn()}
        onToggleAgent={vi.fn()}
        onSetAgentAvatar={vi.fn()}
        onDeleteAgent={vi.fn()}
        onSetRouterAvatar={vi.fn()}
        onCreateForAgent={vi.fn(async () => true)}
        onCreateTask={vi.fn(async () => true)}
        onCreateDraft={vi.fn(async () => true)}
      />,
    );
    // 影子模式没有真的派发：不算在跑，边也不亮
    expect(
      document.querySelector('.agent-flow-wires path[data-state="busy"]'),
    ).toBeNull();
    expect(
      within(node("agent:writer")).queryByText(
        zh.tasks.agentView.running.replace("{{count}}", "1"),
      ),
    ).toBeNull();
  });

  it("未参与派发的智能体：边是虚线，节点写明，也不接受拖放", () => {
    const handlers = renderView({
      allowed: [],
      tasks: [card({ id: "TASK-1", title: "写文档" })],
    });
    expect(
      within(node("agent:writer")).getByText(zh.tasks.agentView.notAllowed),
    ).toBeInTheDocument();
    const off = [
      ...document.querySelectorAll('.agent-flow-wires path[data-state="off"]'),
    ];
    // 未分配那条本来就不走活，所以两条虚线：未分配 + 未参与派发
    expect(off.length).toBe(2);
    fireEvent.drop(node("agent:writer"), {
      dataTransfer: dataTransfer("TASK-1"),
    });
    expect(handlers.onAssign).not.toHaveBeenCalled();
  });

  it("打开时先看未分配：有主的活不该抢在没主的活前面", () => {
    renderView({
      tasks: [
        card({ id: "TASK-1", title: "写文档", assignees: ["writer"] }),
        card({ id: "TASK-2", title: "没人认领" }),
      ],
    });
    expect(laneKey()).toBe("unassigned");
    expect(within(laneColumn()).getByText("没人认领")).toBeInTheDocument();
    expect(within(laneColumn()).queryByText("写文档")).toBeNull();
  });

  it("点节点聚焦：右栏换成它的卡", () => {
    renderView({
      tasks: [
        card({ id: "TASK-1", title: "写文档", assignees: ["writer"] }),
        card({ id: "TASK-2", title: "没人认领" }),
      ],
    });
    focusLane("文档写手");
    expect(laneKey()).toBe("agent:writer");
    expect(within(laneColumn()).getByText("写文档")).toBeInTheDocument();
    expect(within(laneColumn()).queryByText("没人认领")).toBeNull();
    // 聚焦那一支描一圈，其余降一档
    expect(node("agent:writer").getAttribute("data-focus")).toBe("true");
    expect(node("unassigned").getAttribute("data-muted")).toBe("true");
  });

  it("归属认不出来时落在「未分配」，并写明未注册的是谁", () => {
    renderView({
      tasks: [card({ id: "TASK-2", title: "写了旧 id", assignees: ["ghost"] })],
    });
    expect(laneKey()).toBe("unassigned");
    expect(
      within(laneColumn()).getByText(
        zh.tasks.agentView.unknownAgent.replace("{{id}}", "ghost"),
      ),
    ).toBeInTheDocument();
  });

  it("拖到某个智能体节点上只做指派，不顺手开工", () => {
    const handlers = renderView({
      tasks: [card({ id: "TASK-1", title: "写文档" })],
    });
    const payload = dataTransfer("TASK-1");
    const cardEl = within(laneColumn()).getByText("写文档").closest("article");
    expect(cardEl).not.toBeNull();
    fireEvent.dragStart(cardEl!, { dataTransfer: payload });
    fireEvent.drop(node("agent:writer"), { dataTransfer: payload });
    expect(handlers.onAssign).toHaveBeenCalledWith(
      expect.objectContaining({ id: "TASK-1" }),
      "writer",
    );
    expect(handlers.onAssignAndStart).not.toHaveBeenCalled();
  });

  it("拖到「未分配」等于取消指派", () => {
    const handlers = renderView({
      tasks: [card({ id: "TASK-1", title: "写文档", assignees: ["writer"] })],
    });
    const payload = dataTransfer("TASK-1");
    const cardEl = within(laneColumn()).getByText("写文档").closest("article");
    fireEvent.dragStart(cardEl!, { dataTransfer: payload });
    fireEvent.drop(node("unassigned"), { dataTransfer: payload });
    expect(handlers.onAssign).toHaveBeenCalledWith(
      expect.objectContaining({ id: "TASK-1" }),
      null,
    );
  });

  it("讨论卡没有归属：拖不动，也没有「指派并开工」", () => {
    const handlers = renderView({
      tasks: [card({ id: "TASK-9", kind: "discussion", title: "要不要拆卡" })],
    });
    const panel = document.getElementById("agent-talk");
    expect(panel).not.toBeNull();
    const talk = within(panel!).getByText("要不要拆卡").closest("article");
    expect(talk?.getAttribute("draggable")).toBe("false");
    expect(
      within(panel!).queryByRole("button", { name: zh.tasks.agentView.start }),
    ).toBeNull();
    fireEvent.drop(node("agent:writer"), {
      dataTransfer: dataTransfer("TASK-9"),
    });
    expect(handlers.onAssign).not.toHaveBeenCalled();
    // 讨论卡不占「某个人手上的活」那一栏
    expect(laneKey()).toBe("agent:writer");
  });

  it("「与 Lead 讨论」默认展开：讨论卡与两个新建入口一进来就在", async () => {
    const user = userEvent.setup();
    renderView({
      tasks: [card({ id: "TASK-9", kind: "discussion", title: "要不要拆卡" })],
    });
    const nodeButton = screen.getByRole("button", { name: "与 Lead 讨论" });
    expect(nodeButton).toHaveAttribute("aria-expanded", "true");
    const panel = document.getElementById("agent-talk")!;
    expect(within(panel).getByText("要不要拆卡")).toBeInTheDocument();
    expect(
      within(panel).getByRole("button", {
        name: zh.tasks.agentView.discussionNewDraft,
      }),
    ).toBeInTheDocument();
    expect(
      within(panel).getByRole("button", {
        name: zh.tasks.agentView.discussionNewTask,
      }),
    ).toBeInTheDocument();
    // 点一下收起来，再点一下重新展开
    await user.click(nodeButton);
    expect(document.getElementById("agent-talk")).toBeNull();
    expect(nodeButton).toHaveAttribute("aria-expanded", "false");
    await user.click(nodeButton);
    expect(document.getElementById("agent-talk")).not.toBeNull();
  });

  it("讨论栏的「新建讨论卡片」只是草稿：不排期", async () => {
    const user = userEvent.setup();
    const handlers = renderView();
    await user.click(
      screen.getByRole("button", {
        name: zh.tasks.agentView.discussionNewDraft,
      }),
    );
    // 还在讨论就不该先承诺什么时候跑
    expect(
      screen.queryByRole("combobox", { name: zh.tasks.schedule.title }),
    ).toBeNull();
    await user.type(
      screen.getByPlaceholderText(zh.tasks.agentView.routerAddPlaceholder),
      "要不要每天发一份周报",
    );
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() =>
      expect(handlers.onCreateDraft).toHaveBeenCalledWith(
        "要不要每天发一份周报",
      ),
    );
    expect(handlers.onCreateTask).not.toHaveBeenCalled();
  });

  it("讨论栏的「新建任务卡片」不写归属：建好交给 Lead 挑人", async () => {
    const user = userEvent.setup();
    const handlers = renderView();
    await user.click(
      screen.getByRole("button", {
        name: zh.tasks.agentView.discussionNewTask,
      }),
    );
    // 任务卡可以排期：它一建好就要真的跑
    expect(
      screen.getByRole("combobox", { name: zh.tasks.schedule.title }),
    ).toBeInTheDocument();
    await user.type(
      screen.getByPlaceholderText(zh.tasks.agentView.addTaskPlaceholder),
      "整理今天的芯片新闻",
    );
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() =>
      expect(handlers.onCreateTask).toHaveBeenCalledWith("整理今天的芯片新闻", {
        recurrence: null,
        schedule: null,
      }),
    );
    expect(handlers.onCreateDraft).not.toHaveBeenCalled();
  });

  it("卡上的 ▶ 是第二个动作：指派并开工", async () => {
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

  it("一栏里的 + 建卡就归这一栏：标题与任务类型一起交给看板", async () => {
    const user = userEvent.setup();
    const handlers = renderView({
      tasks: [card({ id: "TASK-1", title: "写文档", assignees: ["writer"] })],
    });

    await user.click(
      screen.getByRole("button", {
        name: zh.tasks.agentView.addTask.replace("{{name}}", "文档写手"),
      }),
    );
    const input = screen.getByPlaceholderText(
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

  it("一栏里新建也能选任务类型：定时任务带着时刻落盘", async () => {
    const user = userEvent.setup();
    const handlers = renderView({
      tasks: [card({ id: "TASK-1", title: "写文档", assignees: ["writer"] })],
    });
    await user.click(
      screen.getByRole("button", {
        name: zh.tasks.agentView.addTask.replace("{{name}}", "文档写手"),
      }),
    );
    await user.click(
      screen.getByRole("combobox", { name: zh.tasks.schedule.title }),
    );
    await user.click(
      await screen.findByRole("option", { name: zh.tasks.schedule.mode.daily }),
    );
    fireEvent.change(screen.getByLabelText(zh.tasks.schedule.timeLabel), {
      target: { value: "09:30" },
    });
    await user.type(
      screen.getByPlaceholderText(zh.tasks.agentView.addTaskPlaceholder),
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

  it("未参与派发的智能体不能加任务：先得让它上班", () => {
    renderView({
      allowed: [],
      tasks: [card({ id: "TASK-1", title: "写文档", assignees: ["writer"] })],
    });
    focusLane("文档写手");
    expect(
      screen.getByRole("button", {
        name: zh.tasks.agentView.addTask.replace("{{name}}", "文档写手"),
      }),
    ).toBeDisabled();
  });

  it("未分配这一栏也能直接建卡：建好仍是没主的，等 Lead 挑人", async () => {
    const user = userEvent.setup();
    const handlers = renderView({
      tasks: [card({ id: "TASK-1", title: "没人认领" })],
    });
    await user.click(
      screen.getByRole("button", { name: zh.tasks.agentView.addUnassigned }),
    );
    await user.type(
      screen.getByPlaceholderText(zh.tasks.agentView.addTaskPlaceholder),
      "再整理一份",
    );
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() =>
      expect(handlers.onCreateTask).toHaveBeenCalledWith("再整理一份", {
        recurrence: null,
        schedule: null,
      }),
    );
    expect(handlers.onCreateForAgent).not.toHaveBeenCalled();
  });

  it("参与派发的开关就在它自己那一栏：关掉不删定义", async () => {
    const handlers = renderView({
      tasks: [card({ id: "TASK-1", title: "写文档", assignees: ["writer"] })],
    });
    const toggle = within(laneColumn()).getByRole("switch", {
      name: zh.tasks.agentView.enableAgent.replace("{{name}}", "文档写手"),
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
      within(laneColumn()).getByRole("button", {
        name: zh.tasks.agentView.delete.replace("{{name}}", "文档写手"),
      }),
    );
    expect(handlers.onDeleteAgent).not.toHaveBeenCalled();
    await userEvent.click(
      within(laneColumn()).getByRole("button", {
        name: zh.tasks.agentView.deleteConfirm.replace("{{name}}", "文档写手"),
      }),
    );
    expect(handlers.onDeleteAgent).toHaveBeenCalledWith(
      expect.objectContaining({ id: "writer" }),
    );
  });

  it("节点上写清几张在跑、几张等你、几张没跑成", () => {
    renderView({
      tasks: [
        card({ id: "TASK-1", title: "跑着的", assignees: ["writer"] }),
        card({ id: "TASK-2", title: "等你的", assignees: ["writer"] }),
        card({ id: "TASK-3", title: "没跑成的", assignees: ["writer"] }),
        card({
          id: "TASK-4",
          title: "已经收了的",
          status: "Done",
          assignees: ["writer"],
        }),
      ],
      runsByTask: new Map([
        ["TASK-1", run("working", "TASK-1")],
        ["TASK-2", run("needs-you", "TASK-2")],
        ["TASK-3", run("failed", "TASK-3")],
        ["TASK-4", run("failed", "TASK-4")],
      ]),
    });
    const block = node("agent:writer");
    expect(
      within(block).getByText(
        zh.tasks.agentView.running.replace("{{count}}", "1"),
      ),
    ).toBeInTheDocument();
    expect(
      within(block).getByText(
        zh.tasks.agentView.waiting.replace("{{count}}", "1"),
      ),
    ).toBeInTheDocument();
    expect(
      within(block).getByText(
        zh.tasks.agentView.failed.replace("{{count}}", "1"),
      ),
    ).toBeInTheDocument();
  });

  it("已完成默认只留 3 张，计数可展开", async () => {
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
    focusLane("文档写手");
    // 已完成按最近更新排：先看到最新的三张
    expect(within(laneColumn()).getByText("完成 5")).toBeInTheDocument();
    expect(within(laneColumn()).queryByText("完成 1")).toBeNull();
    await userEvent.click(
      within(laneColumn()).getByRole("button", {
        name: zh.tasks.agentView.doneCount.replace("{{count}}", "5"),
      }),
    );
    expect(within(laneColumn()).getByText("完成 1")).toBeInTheDocument();
  });

  it("每个智能体有自己的头像，选过的优先", async () => {
    const handlers = renderView({
      agents: [{ ...writer, avatar: "avatar-16" }],
      tasks: [card({ id: "TASK-1", title: "写文档", assignees: ["writer"] })],
    });
    const img = node("agent:writer").querySelector("img[data-avatar-key]");
    expect(img?.getAttribute("data-avatar-key")).toBe("avatar-16");
    // 头像是装饰：名称已经说了它是谁
    expect(img?.getAttribute("aria-hidden")).toBe("true");

    await userEvent.click(
      within(node("agent:writer")).getByRole("button", {
        name: zh.tasks.agentView.avatarSet.replace("{{name}}", "文档写手"),
      }),
    );
    await userEvent.click(
      await screen.findByRole("button", {
        name: zh.tasks.agentView.avatarPick.replace("{{key}}", "avatar-15"),
      }),
    );
    expect(handlers.onSetAgentAvatar).toHaveBeenCalledWith(
      expect.objectContaining({ id: "writer" }),
      "avatar-15",
    );
  });

  it("Lead 节点也有头像，点了能换", async () => {
    const handlers = renderView();
    const lead = node("lead");
    expect(lead.querySelector("img[data-avatar-key]")).not.toBeNull();
    await userEvent.click(
      within(lead).getByRole("button", {
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

  it("Lead 这一栏写清它用不用模型：空就是按规则派发", () => {
    renderView({ leadModel: null });
    expect(
      within(node("lead")).getByText(zh.tasks.agentView.leadRules),
    ).toBeInTheDocument();
  });

  it("Lead 的模型只显示路由组别名，不把网关前缀写到节点上", () => {
    renderView({ leadModel: "group/路由2" });
    expect(
      within(node("lead")).getByText(
        zh.tasks.agentView.leadModel.replace("{{model}}", "路由2"),
      ),
    ).toBeInTheDocument();
  });
});
