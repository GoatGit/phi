import {
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../msw/server";
import { defaultRouterSettings } from "../msw/handlers";

const TAURI_ENDPOINT = "http://tauri.local";
import userEvent from "@testing-library/user-event";
import i18n from "i18next";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import zh from "@/i18n/locales/zh.json";
import { TaskBoardPage } from "@/components/tasks/TaskBoardPage";
import { renderWithQueryClient } from "../utils/testQueryClient";
import { formatStamp } from "@/components/tasks/schedule";
import type { TaskBoard, TaskCard, TaskWorkspace } from "@/lib/api/tasks";

const apiMocks = vi.hoisted(() => ({
  workspaces: vi.fn(),
  board: vi.fn(),
  create: vi.fn(),
  detail: vi.fn(),
  linkSession: vi.fn(),
  setStatus: vi.fn(),
  discussionUpdate: vi.fn(),
  discussionSay: vi.fn(),
  deriveDiscussion: vi.fn(),
  convertDiscussion: vi.fn(),
  discardDiscussion: vi.fn(),
}));

vi.mock("@/lib/api/tasks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/tasks")>();
  return {
    ...actual,
    tasksApi: {
      ...actual.tasksApi,
      workspaces: () => apiMocks.workspaces(),
      board: (root: string) => apiMocks.board(root),
      create: (root: string, input: unknown) => apiMocks.create(root, input),
      detail: (root: string, taskId: string) => apiMocks.detail(root, taskId),
      linkSession: (
        root: string,
        taskId: string,
        sessionId: string,
        appId: string,
      ) => apiMocks.linkSession(root, taskId, sessionId, appId),
      setStatus: (
        root: string,
        taskId: string,
        status: string,
        fingerprint: string,
      ) => apiMocks.setStatus(root, taskId, status, fingerprint),
      discussionUpdate: (
        root: string,
        taskId: string,
        question: string | null,
        confirmed: string | null,
        fingerprint: string,
      ) =>
        apiMocks.discussionUpdate(
          root,
          taskId,
          question,
          confirmed,
          fingerprint,
        ),
      discussionSay: (
        root: string,
        taskId: string,
        message: string,
        fingerprint: string,
      ) => apiMocks.discussionSay(root, taskId, message, fingerprint),
      deriveDiscussion: (root: string, taskId: string, note: string) =>
        apiMocks.deriveDiscussion(root, taskId, note),
      convertDiscussion: (root: string, taskId: string, fingerprint: string) =>
        apiMocks.convertDiscussion(root, taskId, fingerprint),
      discardDiscussion: (root: string, taskId: string, fingerprint: string) =>
        apiMocks.discardDiscussion(root, taskId, fingerprint),
    },
  };
});

beforeAll(() => {
  i18n.addResourceBundle("zh", "translation", zh, true, true);
});

beforeEach(() => {
  apiMocks.workspaces.mockReset();
  apiMocks.board.mockReset();
  apiMocks.create.mockReset();
  apiMocks.detail.mockReset();
  apiMocks.linkSession.mockReset();
  apiMocks.setStatus.mockReset();
  apiMocks.discussionUpdate.mockReset();
  apiMocks.discussionSay.mockReset();
  // 建完讨论卡会立刻把第一句发给 Router：默认给一个能直接铺进 timeline 的回复
  apiMocks.discussionSay.mockResolvedValue({
    task: { ...card, kind: "discussion", discussionHold: true },
    body: "",
    sections: [],
    acceptance: [],
    links: [],
    outcome: null,
    artifacts: [],
    discussionTurns: [],
  });
  apiMocks.deriveDiscussion.mockReset();
  apiMocks.convertDiscussion.mockReset();
  apiMocks.discardDiscussion.mockReset();
  // 智能体视图会读一次 MCP 服务数（Lead 的输入之一）：给一个空目录，
  // 免得每个用例都报一条未拦截的请求。
  server.use(
    http.post(`${TAURI_ENDPOINT}/get_mcp_servers`, () => HttpResponse.json({})),
  );
  localStorage.clear();
});

const card: TaskCard = {
  id: "TASK-1",
  kind: "task",
  sourceTask: null,
  round: null,
  discussionHold: false,
  discussionQuestion: null,
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
  session: null,
  file: "backlog/tasks/task-1.md",
  fingerprint: "12:abcd",
};

const workspace: TaskWorkspace = {
  root: "/repo",
  name: "repo",
  projectName: "ai.md",
  statuses: ["To Do", "In Progress", "Done"],
  defaultStatus: "To Do",
  taskPrefix: "TASK",
  valid: true,
  error: null,
};

const board: TaskBoard = {
  root: "/repo",
  projectName: "ai.md",
  defaultStatus: "To Do",
  taskPrefix: "TASK",
  statuses: ["To Do", "In Progress", "Done"],
  columns: [
    { status: "To Do", tasks: [card] },
    { status: "In Progress", tasks: [] },
    { status: "Done", tasks: [] },
  ],
};

interface BoardOptions {
  terminalApps?: string[];
  embedded?: boolean;
  onStartSession?: (
    root: string,
    appId: string,
    argumentsText?: string,
  ) => Promise<string>;
  onOpenSession?: (appId: string, sessionId: string) => Promise<boolean>;
}

/** 渲染这一页，不动视图。验默认视图时用它。 */
function renderBoardDefaultView(options: BoardOptions = {}) {
  // 卡片详情里的「续接会话」要读一次会话清单：真实应用里这一页就在
  // QueryClientProvider 里，测试也照同一层挂上。
  return renderWithQueryClient(
    <TaskBoardPage
      embedded={options.embedded}
      terminalApps={options.terminalApps ?? ["ghostty"]}
      onStartSession={options.onStartSession ?? vi.fn()}
      onOpenSession={options.onOpenSession ?? vi.fn()}
      onOpenWorker={vi.fn().mockResolvedValue(true)}
      liveSessionIds={[]}
    />,
  );
}

/**
 * 页面默认落在智能体视图；看板用例先切过去。
 *
 * 这一步取代的是「以前看板就是默认」的前置条件，不是在绕开产品行为：
 * 每条看板用例验的仍然是看板读法。
 */
async function renderBoard(options: BoardOptions = {}) {
  const result = renderBoardDefaultView(options);
  fireEvent.click(
    await screen.findByRole("button", { name: zh.tasks.agentView.board }),
  );
  return result;
}

describe("TaskBoardPage — 快速新建任务", () => {
  beforeEach(() => {
    apiMocks.workspaces.mockResolvedValue([workspace]);
    apiMocks.board.mockResolvedValue(board);
    apiMocks.create.mockResolvedValue({
      task: card,
      body: "",
      sections: [],
      acceptance: [],
      links: [],
      outcome: null,
      artifacts: [],
      discussionTurns: [],
    });
  });

  it("默认落在智能体视图：不点任何东西先看到这队人", async () => {
    renderBoardDefaultView();

    expect(
      await screen.findByRole("heading", { name: zh.tasks.agentView.title }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: zh.tasks.agentView.agents }),
    ).toHaveAttribute("aria-pressed", "true");
    // 阶段列是另一种读法：默认不该同时铺开三列。
    expect(screen.queryByRole("region", { name: "To Do" })).toBeNull();
  });

  it("入口在 To Do 栏的第一条，点开是一个输入框", async () => {
    await renderBoard();
    const todo = await screen.findByRole("region", { name: "To Do" });

    const [first] = within(todo).getAllByRole("button");
    expect(first).toHaveTextContent(zh.tasks.newTask);

    // 页头不再有另一个「新建任务」按钮
    expect(screen.getAllByText(zh.tasks.newTask)).toHaveLength(1);
  });

  it("只填标题就能建卡：状态走默认列，其余字段不传", async () => {
    const user = userEvent.setup();
    await renderBoard();
    const todo = await screen.findByRole("region", { name: "To Do" });

    await user.click(
      within(todo).getByRole("button", { name: zh.tasks.newTask }),
    );
    const input = within(todo).getByPlaceholderText(
      zh.tasks.newTaskPlaceholder,
    );
    await user.type(input, "补上验收清单{Enter}");
    expect(apiMocks.create).not.toHaveBeenCalled();
    await user.keyboard("{Control>}{Enter}{/Control}");

    await waitFor(() =>
      expect(apiMocks.create).toHaveBeenCalledWith("/repo", {
        title: "补上验收清单",
      }),
    );
    // 建完清空、留在原地，可以接着写第二条
    await waitFor(() => expect(input).toHaveValue(""));
    expect(apiMocks.board).toHaveBeenCalledTimes(2);
  });

  it("一句话就能进讨论：卡带着「讨论中」建出来，详情页的讨论区直接展开", async () => {
    const user = userEvent.setup();
    apiMocks.create.mockResolvedValue({
      task: { ...card, kind: "discussion", discussionHold: true },
      body: "",
      sections: [],
      acceptance: [],
      links: [],
      outcome: null,
      artifacts: [],
      discussionTurns: [],
    });
    await renderBoard();
    const todo = await screen.findByRole("region", { name: "To Do" });

    await user.click(
      within(todo).getByRole("button", { name: zh.tasks.discussion.start }),
    );
    const input = within(todo).getByPlaceholderText(
      zh.tasks.discussion.newPlaceholder,
    );
    // 还在讨论就先不排期：这个模式下不该出现任务类型
    expect(
      within(todo).queryByRole("combobox", { name: zh.tasks.schedule.title }),
    ).toBeNull();

    await user.type(input, "每天整理 AI 新闻，是不是该换个做法？");
    expect(apiMocks.create).not.toHaveBeenCalled();
    apiMocks.discussionSay.mockResolvedValue({
      task: { ...card, kind: "discussion", discussionHold: true },
      body: "",
      sections: [],
      acceptance: [],
      links: [],
      outcome: null,
      artifacts: [],
      discussionTurns: [
        {
          role: "user",
          text: "每天整理 AI 新闻，是不是该换个做法？",
          createdAt: 1,
        },
        { role: "router", text: "先看现在的入口在哪。", createdAt: 2 },
      ],
    });
    await user.keyboard("{Control>}{Enter}{/Control}");

    await waitFor(() =>
      expect(apiMocks.create).toHaveBeenCalledWith("/repo", {
        title: "每天整理 AI 新闻，是不是该换个做法？",
        discussionHold: true,
      }),
    );
    // 这一句就是第一轮发言：建完卡立刻交给 Router，不用到详情页再打一遍
    await waitFor(() =>
      expect(apiMocks.discussionSay).toHaveBeenCalledWith(
        "/repo",
        "TASK-1",
        "每天整理 AI 新闻，是不是该换个做法？",
        "12:abcd",
      ),
    );
    // 详情页自己展开，后面的对话直接在输入框里说
    expect(
      await screen.findByPlaceholderText(zh.tasks.discussion.sayPlaceholder),
    ).toBeInTheDocument();
  });

  it("讨论不需要终端应用：没有可用应用也能建卡进讨论", async () => {
    const user = userEvent.setup();
    await renderBoard({ terminalApps: [] });
    const todo = await screen.findByRole("region", { name: "To Do" });

    await user.click(
      within(todo).getByRole("button", { name: zh.tasks.discussion.start }),
    );
    const input = within(todo).getByPlaceholderText(
      zh.tasks.discussion.newPlaceholder,
    );
    await user.type(input, "先讨论清楚再说");
    await user.keyboard("{Control>}{Enter}{/Control}");

    await waitFor(() =>
      expect(apiMocks.create).toHaveBeenCalledWith("/repo", {
        title: "先讨论清楚再说",
        discussionHold: true,
      }),
    );
    // 讨论入口不再被终端能力卡住
    await waitFor(() =>
      expect(
        within(todo).queryByPlaceholderText(zh.tasks.discussion.newPlaceholder),
      ).toBeNull(),
    );
  });

  it("建卡时就能选持续任务，间隔跟着带进去", async () => {
    const user = userEvent.setup();
    Element.prototype.scrollIntoView = vi.fn();
    await renderBoard();
    const todo = await screen.findByRole("region", { name: "To Do" });

    await user.click(
      within(todo).getByRole("button", { name: zh.tasks.newTask }),
    );
    await user.click(
      within(todo).getByRole("combobox", { name: zh.tasks.schedule.title }),
    );
    await user.click(
      await screen.findByRole("option", {
        name: zh.tasks.schedule.mode.interval,
      }),
    );

    fireEvent.change(
      within(todo).getByLabelText(zh.tasks.schedule.intervalAmount),
      { target: { value: "2" } },
    );
    await user.click(
      within(todo).getByRole("combobox", {
        name: zh.tasks.schedule.intervalUnit,
      }),
    );
    await user.click(
      await screen.findByRole("option", { name: zh.tasks.schedule.unit.h }),
    );

    await user.type(
      within(todo).getByPlaceholderText(zh.tasks.newTaskPlaceholder),
      "每两小时巡检",
    );
    await user.click(
      within(todo).getByRole("button", { name: zh.tasks.newTaskSend }),
    );

    await waitFor(() =>
      expect(apiMocks.create).toHaveBeenCalledWith("/repo", {
        title: "每两小时巡检",
        recurrence: "2h",
      }),
    );
    // 建完回到「不重复」：下一张卡不默默继承上一张的排期
    expect(
      within(todo).getByRole("combobox", { name: zh.tasks.schedule.title }),
    ).toHaveTextContent(zh.tasks.schedule.mode.none);
  });

  it("建卡时选定时任务：没填时刻不能提交，填了才带 schedule", async () => {
    const user = userEvent.setup();
    Element.prototype.scrollIntoView = vi.fn();
    await renderBoard();
    const todo = await screen.findByRole("region", { name: "To Do" });

    await user.click(
      within(todo).getByRole("button", { name: zh.tasks.newTask }),
    );
    await user.type(
      within(todo).getByPlaceholderText(zh.tasks.newTaskPlaceholder),
      "早上汇总",
    );
    await user.click(
      within(todo).getByRole("combobox", { name: zh.tasks.schedule.title }),
    );
    await user.click(
      await screen.findByRole("option", {
        name: zh.tasks.schedule.mode.daily,
      }),
    );

    // 类型选了但时刻还空着：建出来会是一张不会跑的卡，所以先不让提交
    const send = within(todo).getByRole("button", {
      name: zh.tasks.newTaskSend,
    });
    expect(send).toBeDisabled();

    fireEvent.change(within(todo).getByLabelText(zh.tasks.schedule.timeLabel), {
      target: { value: "09:30" },
    });
    await user.click(send);

    await waitFor(() =>
      expect(apiMocks.create).toHaveBeenCalledWith("/repo", {
        title: "早上汇总",
        schedule: "09:30",
      }),
    );
  });
});

it("Done 只预览最近五张；日期回退后按任务号倒序，展开后可以收起", async () => {
  const tasks = [2, 10, 3, 4, 5, 6, 7].map((n) => ({
    ...card,
    status: "Done",
    id: `TASK-${n}`,
    updatedDate: n === 3 ? "2026-11-20 10:00" : null,
    createdDate:
      n === 4 ? "2026-11-21" : [5, 6, 7].includes(n) ? "2026-11-19" : null,
  }));
  apiMocks.workspaces.mockResolvedValue([workspace]);
  apiMocks.board.mockResolvedValue({
    ...board,
    columns: [...board.columns.slice(0, 2), { status: "Done", tasks }],
  });
  await renderBoard();
  const done = within(await screen.findByRole("region", { name: "Done" }));
  const ids = () => done.getAllByText(/^TASK-/).map((el) => el.textContent);
  const preview = ["TASK-4", "TASK-3", "TASK-7", "TASK-6", "TASK-5"];
  expect(ids()).toEqual(preview);
  await userEvent.click(done.getByRole("button", { name: "展开其余 2 张" }));
  expect(ids()).toEqual([...preview, "TASK-10", "TASK-2"]);
  await userEvent.click(done.getByRole("button", { name: "收起" }));
  expect(ids()).toEqual(preview);
});

describe("TaskBoardPage — 仓库下拉", () => {
  beforeEach(() => {
    apiMocks.workspaces.mockResolvedValue([workspace]);
    apiMocks.board.mockResolvedValue(board);
  });

  it("仓库列表、添加仓库、移出看板在同一个下拉里", async () => {
    const user = userEvent.setup();
    await renderBoard();

    await user.click(
      await screen.findByRole("button", { name: zh.tasks.workspace }),
    );
    const menu = await screen.findByRole("menu");

    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["ai.md", zh.tasks.addWorkspace, zh.tasks.removeWorkspace]);

    // 旧的那个「⋯」菜单不再单独存在
    expect(screen.queryByRole("button", { name: "更多操作" })).toBeNull();
  });
});

describe("TaskBoardPage — 开始会话", () => {
  beforeEach(() => {
    apiMocks.workspaces.mockResolvedValue([workspace]);
    apiMocks.board.mockResolvedValue(board);
    apiMocks.detail.mockResolvedValue({
      task: card,
      body: "",
      sections: [],
      acceptance: [],
      links: [],
      outcome: null,
      artifacts: [],
    });
    apiMocks.linkSession.mockResolvedValue({
      sessionId: "s-1",
      appId: "codex",
      costUsd: 0,
      requests: 0,
    });
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("卡片上不再显示优先级徽标", async () => {
    apiMocks.workspaces.mockResolvedValue([workspace]);
    apiMocks.board.mockResolvedValue(board);
    await renderBoard();

    const todo = await screen.findByRole("region", { name: "To Do" });
    const cardButton = within(todo).getByRole("button", { name: card.title });
    // 旧卡片里残留 priority 也不展示：这个字段对每张卡都是同一个值，没有区分度
    expect(within(cardButton).queryByText("中")).toBeNull();
    expect(within(cardButton).getByText("TASK-1")).toBeInTheDocument();
  });

  it("统一启动交给 router，不再从前端开无运行态的会话", async () => {
    const onStartSession = vi.fn().mockResolvedValue("s-1");
    const user = userEvent.setup();
    await renderBoard({ terminalApps: ["codex"], onStartSession });

    const todo = await screen.findByRole("region", { name: "To Do" });
    await user.click(within(todo).getByRole("button", { name: card.title }));

    const start = vi.fn();
    server.use(
      http.post(`${TAURI_ENDPOINT}/router_start_task`, async ({ request }) => {
        start(await request.json());
        return HttpResponse.json(null);
      }),
    );
    expect(
      screen.queryByRole("button", { name: zh.tasks.startSession }),
    ).toBeNull();
    await user.click(
      await screen.findByRole("button", { name: zh.tasks.router.start }),
    );
    await waitFor(() =>
      expect(start).toHaveBeenCalledWith({ root: "/repo", taskId: "TASK-1" }),
    );
    expect(onStartSession).not.toHaveBeenCalled();
    expect(apiMocks.linkSession).not.toHaveBeenCalled();
  });
});

describe("TaskBoardPage — 派发后打开会话", () => {
  beforeEach(() => {
    apiMocks.workspaces.mockResolvedValue([workspace]);
    apiMocks.board.mockResolvedValue(board);
    apiMocks.detail.mockResolvedValue({
      task: card,
      body: "",
      sections: [],
      acceptance: [],
      links: [],
      outcome: null,
      artifacts: [],
    });
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("点「开始」后把人带到这次派发出去的终端会话", async () => {
    const onOpenSession = vi.fn().mockResolvedValue(true);
    const user = userEvent.setup();
    // 派发前没有任何运行态（所以详情里是「开始」），按下之后才出现这次运行。
    let dispatched = false;
    server.use(
      http.post(`${TAURI_ENDPOINT}/router_start_task`, () => {
        dispatched = true;
        return HttpResponse.json(null);
      }),
      http.post(`${TAURI_ENDPOINT}/router_status`, () =>
        HttpResponse.json({
          settings: defaultRouterSettings,
          runs: dispatched
            ? [
                {
                  taskId: "TASK-1",
                  root: "/repo",
                  state: "dispatched",
                  workerApp: "codex",
                  sessionId: "s-9",
                  attempts: 1,
                  detail: null,
                  cardFingerprint: "12:abcd",
                  shadow: false,
                  updatedAt: 1,
                },
              ]
            : [],
          traces: [],
          today: { dispatches: 0, judgeCalls: 0 },
        }),
      ),
    );
    await renderBoard({ terminalApps: ["codex"], onOpenSession });

    const todo = await screen.findByRole("region", { name: "To Do" });
    await user.click(within(todo).getByRole("button", { name: card.title }));
    await user.click(
      await screen.findByRole("button", { name: zh.tasks.router.start }),
    );

    await waitFor(() =>
      expect(onOpenSession).toHaveBeenCalledWith("codex", "s-9"),
    );
  });
});

describe("TaskBoardPage — 版心与列宽", () => {
  beforeEach(() => {
    apiMocks.workspaces.mockResolvedValue([workspace]);
    apiMocks.board.mockResolvedValue(board);
  });

  it("三列平分看板宽度，并与上方工具栏、下方说明块落在同一条版心上", async () => {
    const { container } = await renderBoard({ embedded: true });

    const todo = await screen.findByRole("region", { name: "To Do" });
    // 列不再写死宽度：写死 300 时三列右边缘会比上下板块短一截
    expect(todo.className).toContain("flex-1");
    expect(todo.className).toContain("basis-0");
    expect(todo.className).not.toContain("w-[300px]");
    // 版心与其它插件页一致，切页签时左右边缘不跳
    expect(container.firstElementChild?.className).toContain("max-w-[1080px]");
  });

  it("列高度被看板框住，滚动发生在列内的卡片区", async () => {
    await renderBoard();

    const todo = await screen.findByRole("region", { name: "To Do" });
    // 少了 min-h-0/overflow-hidden，卡片一多整列会跟着长高，看板变成长列表且没有滚动条
    expect(todo.className).toContain("min-h-0");
    expect(todo.className).toContain("overflow-hidden");

    const list = within(todo)
      .getByText(card.title)
      .closest("article")?.parentElement;
    expect(list?.className).toContain("overflow-y-auto");
    expect(list?.className).toContain("min-h-0");
  });
});

describe("TaskBoardPage — 卡片浮在列的底色上", () => {
  beforeEach(() => {
    apiMocks.workspaces.mockResolvedValue([workspace]);
    apiMocks.board.mockResolvedValue(board);
  });

  it("列是满色托盘、卡片自带浮起投影", async () => {
    await renderBoard();

    const todo = await screen.findByRole("region", { name: "To Do" });
    // 托盘不能靠透明度写法：主题色是 var(--bg-*) 形式，bg-subtle/40 生成不出类，会静默失效
    expect(todo.className).toContain("bg-subtle");
    expect(todo.className).not.toMatch(/bg-subtle\/\d+/);

    const article = within(todo).getByText(card.title).closest("article");
    expect(article?.className).toContain("shadow-v7-card");
    expect(article?.className).toContain("bg-surface");
  });
});

describe("TaskBoardPage — 自动调度", () => {
  const status = (run: unknown) => ({
    settings: {
      enabled: true,
      shadow: false,
      triggerStatus: "In Progress",
      concurrency: 2,
      dispatchesPerTick: 2,
      dispatchesPerDay: 40,
      judgeCallsPerDay: 200,
      attentionThreshold: 8,
      workerApps: ["claude"],
      agents: [],
      maxAttempts: 3,
      stallSeconds: 3600,
      monitorIntervalSeconds: 120,
      needsYouSeconds: 3600,
      trustExitZero: true,
      leaseSeconds: 90,
      cooldownSeconds: 120,
      judgeModel: "jev-latest",
      episodeModel: "",
    },
    runs: run ? [run] : [],
    traces: [],
    today: { dispatches: 1, judgeCalls: 2 },
  });

  beforeEach(() => {
    apiMocks.workspaces.mockResolvedValue([workspace]);
    apiMocks.board.mockResolvedValue({
      ...board,
      columns: [
        { status: "To Do", tasks: [] },
        { status: "In Progress", tasks: [card] },
        { status: "Done", tasks: [] },
      ],
    });
  });

  it("卡片上直接标出「运行中」，同一个 id 在别的仓库不会串过来", async () => {
    server.use(
      http.post(`${TAURI_ENDPOINT}/router_status`, () =>
        HttpResponse.json(
          status({
            taskId: "TASK-1",
            root: "/repo",
            state: "working",
            workerApp: "claude",
            sessionId: "s1",
            attempts: 1,
            detail: null,
            cardFingerprint: "12:abcd",
            shadow: false,
            updatedAt: 1,
          }),
        ),
      ),
    );
    await renderBoard();
    const column = await screen.findByRole("region", { name: "In Progress" });
    expect(
      await within(column).findByText(zh.tasks.router.state.working),
    ).toBeInTheDocument();
  });

  it("影子模式标「影子」，不冒充运行中", async () => {
    server.use(
      http.post(`${TAURI_ENDPOINT}/router_status`, () =>
        HttpResponse.json(
          status({
            taskId: "TASK-1",
            root: "/repo",
            state: "queued",
            workerApp: "claude",
            sessionId: null,
            attempts: 0,
            detail: "shadow: would dispatch to claude",
            cardFingerprint: "12:abcd",
            shadow: true,
            updatedAt: 1,
          }),
        ),
      ),
    );
    await renderBoard();
    const column = await screen.findByRole("region", { name: "In Progress" });
    expect(
      await within(column).findByText(zh.tasks.router.state.shadow),
    ).toBeInTheDocument();
    expect(within(column).queryByText(zh.tasks.router.state.queued)).toBeNull();
  });

  it("头部按钮打开的是开关面板，改开关会写回设置", async () => {
    server.use(
      http.post(`${TAURI_ENDPOINT}/router_status`, () =>
        HttpResponse.json(status(null)),
      ),
    );
    const user = userEvent.setup();
    await renderBoard();

    await user.click(
      await screen.findByRole("button", { name: zh.tasks.router.button }),
    );
    expect(
      await screen.findByText(zh.tasks.router.enabledHint),
    ).toBeInTheDocument();
    expect(screen.getByText(zh.tasks.router.modeOn)).toBeInTheDocument();
    // 今天用掉的配额要看得见
    expect(screen.getByText(/今天已派发 1 次/)).toBeInTheDocument();
  });

  it("调度模型只列包含 pi 的路由组，选中后按组别名写回设置", async () => {
    server.use(
      http.post(`${TAURI_ENDPOINT}/router_status`, () =>
        HttpResponse.json(status(null)),
      ),
      http.post(`${TAURI_ENDPOINT}/get_gateway_catalog`, () =>
        HttpResponse.json({
          revision: 1,
          suppliers: [],
          policies: [],
          groups: [
            {
              id: "g-1",
              name: "日常",
              enabled: true,
              appIds: ["pi"],
              strategy: "priority",
              members: [],
              sessionAffinity: false,
              affinityTtlSeconds: 0,
              failover: true,
              maxAttempts: 2,
            },
            {
              id: "g-2",
              name: "只有 claude",
              enabled: true,
              appIds: ["claude"],
              strategy: "priority",
              members: [],
              sessionAffinity: false,
              affinityTtlSeconds: 0,
              failover: true,
              maxAttempts: 2,
            },
          ],
        }),
      ),
    );

    let saved: { settings?: { episodeModel?: string } } | null = null;
    server.use(
      http.post(
        `${TAURI_ENDPOINT}/router_save_settings`,
        async ({ request }) => {
          const body = (await request.json()) as {
            settings: Record<string, unknown>;
          };
          saved = body;
          return HttpResponse.json(body.settings);
        },
      ),
    );

    // jsdom 没有 scrollIntoView，Radix 的下拉打开时会调它。
    Element.prototype.scrollIntoView = vi.fn();

    const user = userEvent.setup();
    await renderBoard();
    await user.click(
      await screen.findByRole("button", { name: zh.tasks.router.button }),
    );

    // 默认按规则跑，模型是可选项而不是默认项。
    const picker = await screen.findByRole("combobox", {
      name: zh.tasks.router.episodeModel,
    });
    expect(picker).toHaveTextContent(zh.tasks.router.episodeModelRules);

    await user.click(picker);
    // 不含 pi 的组不会出现在这里：网关按 app 过滤，选了也解析不出来。
    expect(screen.queryByText("只有 claude")).toBeNull();
    await user.click(await screen.findByText("日常"));

    await waitFor(() =>
      expect(saved?.settings?.episodeModel).toBe("group/日常"),
    );
  });
});

describe("TaskBoardPage — 持续 / 定时任务", () => {
  beforeEach(() => {
    apiMocks.workspaces.mockResolvedValue([workspace]);
    apiMocks.board.mockResolvedValue({
      ...board,
      columns: [
        {
          status: "To Do",
          tasks: [
            {
              ...card,
              schedule: {
                kind: "interval",
                minutes: 120,
                time: null,
                at: null,
                lastRunAt: null,
                nextRunAt: null,
              },
            },
            {
              ...card,
              id: "TASK-2",
              title: "每天的日报",
              schedule: {
                kind: "daily",
                minutes: null,
                time: "09:30",
                at: null,
                lastRunAt: null,
                nextRunAt: null,
              },
            },
          ],
        },
        { status: "In Progress", tasks: [] },
        { status: "Done", tasks: [] },
      ],
    });
  });

  it("卡片上直接标出「每 2 小时」与「每天 09:30」", async () => {
    await renderBoard();
    const todo = await screen.findByRole("region", { name: "To Do" });
    expect(
      within(todo).getByText(
        zh.tasks.schedule.everyHours.replace("{{count}}", "2"),
      ),
    ).toBeTruthy();
    expect(
      within(todo).getByText(
        zh.tasks.schedule.daily.replace("{{time}}", "09:30"),
      ),
    ).toBeTruthy();
  });
});

describe("TaskBoardPage — 排期的等待提示", () => {
  /** 一张带排期的卡；`nextRunAt` 由后端按上次触发算好。 */
  function scheduled(input: {
    kind: "interval" | "daily" | "once";
    minutes?: number | null;
    time?: string | null;
    at?: string | null;
    nextRunAt: number | null;
  }): TaskCard {
    return {
      ...card,
      schedule: {
        kind: input.kind,
        minutes: input.minutes ?? null,
        time: input.time ?? null,
        at: input.at ?? null,
        lastRunAt: null,
        nextRunAt: input.nextRunAt,
      },
    };
  }

  function boardWith(tasks: TaskCard[], status = "To Do"): TaskBoard {
    return {
      ...board,
      columns: [
        { status: "To Do", tasks: status === "To Do" ? tasks : [] },
        { status: "In Progress", tasks: status === "In Progress" ? tasks : [] },
        { status: "Done", tasks: [] },
      ],
    };
  }

  const run = (state: string) => ({
    taskId: "TASK-1",
    root: "/repo",
    state,
    workerApp: "claude",
    sessionId: "s1",
    attempts: 1,
    detail: null,
    cardFingerprint: "12:abcd",
    shadow: false,
    updatedAt: 1,
  });

  beforeEach(() => {
    apiMocks.workspaces.mockResolvedValue([workspace]);
  });

  it("等待期就标出下次什么时候跑", async () => {
    const nextRunAt = new Date(2030, 0, 2, 18, 30).getTime();
    apiMocks.board.mockResolvedValue(
      boardWith([scheduled({ kind: "interval", minutes: 120, nextRunAt })]),
    );
    await renderBoard();

    const todo = await screen.findByRole("region", { name: "To Do" });
    expect(
      within(todo).getByText(
        zh.tasks.schedule.next.replace("{{time}}", formatStamp(nextRunAt)),
      ),
    ).toBeTruthy();
  });

  it("到点后换成「已到点」，整句解释放在 title 里", async () => {
    const nextRunAt = Date.now() - 60_000;
    apiMocks.board.mockResolvedValue(
      boardWith([scheduled({ kind: "interval", minutes: 120, nextRunAt })]),
    );
    await renderBoard();

    const todo = await screen.findByRole("region", { name: "To Do" });
    const hint = within(todo).getByText(zh.tasks.schedule.dueShort);
    expect(hint.getAttribute("title")).toBe(zh.tasks.schedule.due);
    expect(within(todo).queryByText(/下次 /)).toBeNull();
  });

  it("还在跑的卡不承诺下次时间，这个时间不会真的触发", async () => {
    // 后端 advance_schedules 会跳过在跑 / 等人回话 / 被暂停的卡，到点也不会被挪走。
    server.use(
      http.post(`${TAURI_ENDPOINT}/router_status`, () =>
        HttpResponse.json({
          settings: defaultRouterSettings,
          runs: [run("working")],
          traces: [],
          today: { dispatches: 0, judgeCalls: 0 },
        }),
      ),
    );
    apiMocks.board.mockResolvedValue(
      boardWith(
        [
          scheduled({
            kind: "interval",
            minutes: 120,
            nextRunAt: Date.now() - 60_000,
          }),
        ],
        "In Progress",
      ),
    );
    await renderBoard();

    const column = await screen.findByRole("region", { name: "In Progress" });
    expect(
      await within(column).findByText(zh.tasks.router.state.working),
    ).toBeTruthy();
    expect(within(column).queryByText(zh.tasks.schedule.dueShort)).toBeNull();
    expect(within(column).queryByText(/下次 /)).toBeNull();
  });

  it("一次性任务的时刻只写一遍，不再重复一个「下次」", async () => {
    const at = new Date(2030, 0, 2, 18, 30);
    apiMocks.board.mockResolvedValue(
      boardWith([
        scheduled({
          kind: "once",
          at: "2030-01-02 18:30",
          nextRunAt: at.getTime(),
        }),
      ]),
    );
    await renderBoard();

    const todo = await screen.findByRole("region", { name: "To Do" });
    expect(
      within(todo).getByText(
        zh.tasks.schedule.once.replace("{{at}}", "2030-01-02 18:30"),
      ),
    ).toBeTruthy();
    expect(within(todo).queryByText(/下次 /)).toBeNull();
  });
});

describe("TaskBoardPage — 需求讨论", () => {
  const question = "默认看最近 5 条，还是按日期分组？";
  const talking = {
    ...card,
    kind: "discussion" as const,
    discussionHold: true,
    discussionQuestion: question,
  };

  beforeEach(() => {
    apiMocks.workspaces.mockResolvedValue([workspace]);
    apiMocks.board.mockResolvedValue({
      ...board,
      columns: [
        { status: "To Do", tasks: [talking] },
        { status: "In Progress", tasks: [] },
        { status: "Done", tasks: [] },
      ],
    });
    apiMocks.detail.mockResolvedValue({
      task: talking,
      body: "",
      sections: [],
      acceptance: [],
      links: [],
      outcome: null,
      confirmed: null,
      artifacts: [],
    });
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("待办卡面直接写出待决定的问题，并标出讨论中", async () => {
    await renderBoard();

    const todo = await screen.findByRole("region", { name: "To Do" });
    expect(within(todo).getByText(question)).toBeInTheDocument();
    expect(
      within(todo).getByText(zh.tasks.discussion.held),
    ).toBeInTheDocument();
  });

  it("讨论交给 Router：在详情里说一句，走 discussionSay，不开终端会话", async () => {
    const onStartSession = vi.fn().mockResolvedValue("s-talk");
    const said = {
      task: talking,
      body: "",
      sections: [],
      acceptance: [],
      links: [],
      outcome: null,
      confirmed: null,
      artifacts: [],
      discussionTurns: [{ role: "user", text: "先定范围", createdAt: 1 }],
    };
    apiMocks.discussionSay.mockResolvedValue(said);
    const user = userEvent.setup();
    await renderBoard({ terminalApps: ["codex"], onStartSession });

    const todo = await screen.findByRole("region", { name: "To Do" });
    await user.click(within(todo).getByRole("button", { name: card.title }));

    const input = await screen.findByPlaceholderText(
      zh.tasks.discussion.sayPlaceholder,
    );
    await user.type(input, "先定范围");
    await user.click(
      screen.getByRole("button", { name: zh.tasks.discussion.send }),
    );

    await waitFor(() =>
      expect(apiMocks.discussionSay).toHaveBeenCalledWith(
        "/repo",
        "TASK-1",
        "先定范围",
        "12:abcd",
      ),
    );
    // 讨论不派 worker，也不开终端会话
    expect(onStartSession).not.toHaveBeenCalled();
  });

  it("已完成的任务不回退讨论态，而是派生一张新的讨论卡", async () => {
    const doneCard = { ...card, status: "Done" };
    const derivedCard = {
      ...card,
      id: "TASK-2",
      kind: "discussion" as const,
      round: 2,
      sourceTask: "TASK-1",
      status: "To Do",
      discussionHold: true,
      discussionQuestion: "按日期分组？",
      title: "讨论：芳芳说的发生",
    };
    apiMocks.workspaces.mockResolvedValue([workspace]);
    apiMocks.board.mockResolvedValue({
      ...board,
      columns: [
        { status: "To Do", tasks: [] },
        { status: "In Progress", tasks: [] },
        { status: "Done", tasks: [doneCard] },
      ],
    });
    apiMocks.detail.mockResolvedValue({
      task: doneCard,
      body: "",
      sections: [],
      acceptance: [],
      links: [],
      outcome: null,
      confirmed: null,
      derived: [],
      artifacts: [],
    });
    apiMocks.deriveDiscussion.mockResolvedValue({
      task: derivedCard,
      body: "",
      sections: [],
      acceptance: [],
      links: [],
      outcome: null,
      confirmed: null,
      derived: [],
      artifacts: [],
    });
    const user = userEvent.setup();
    await renderBoard();

    const done = await screen.findByRole("region", { name: "Done" });
    await user.click(
      within(done).getByRole("button", { name: doneCard.title }),
    );
    // 已完成的任务没有输入框，只有「重新讨论」与一句话输入
    expect(
      screen.queryByRole("button", { name: zh.tasks.discussion.sendTask }),
    ).toBeNull();
    const note = await screen.findByLabelText(zh.tasks.discussion.deriveLabel);
    await user.type(note, "按日期分组？");
    await user.click(
      screen.getByRole("button", { name: zh.tasks.discussion.derive }),
    );

    await waitFor(() =>
      expect(apiMocks.deriveDiscussion).toHaveBeenCalledWith(
        "/repo",
        "TASK-1",
        "按日期分组？",
      ),
    );
    // 跳到新卡：第 2 轮、指向原卡，输入框就在这一页
    expect(await screen.findByText("第 2 轮讨论")).toBeInTheDocument();
    expect(screen.getByText("来自 TASK-1")).toBeInTheDocument();
    // 派生时写下的那句话就是第一句发言，不用到详情页再打一遍
    await waitFor(() =>
      expect(apiMocks.discussionSay).toHaveBeenCalledWith(
        "/repo",
        "TASK-2",
        "按日期分组？",
        "12:abcd",
      ),
    );
    expect(screen.getByText("按日期分组？")).toBeInTheDocument();
  });

  it("只有讨论卡能发起讨论：待办卡先转成讨论卡，转换后输入框才出现", async () => {
    const converted = {
      ...card,
      kind: "discussion" as const,
      discussionHold: true,
    };
    apiMocks.workspaces.mockResolvedValue([workspace]);
    apiMocks.board.mockResolvedValue({
      ...board,
      columns: [
        { status: "To Do", tasks: [card] },
        { status: "In Progress", tasks: [] },
        { status: "Done", tasks: [] },
      ],
    });
    apiMocks.detail.mockResolvedValue({
      task: card,
      body: "",
      sections: [],
      acceptance: [],
      links: [],
      outcome: null,
      confirmed: null,
      derived: [],
      artifacts: [],
    });
    apiMocks.convertDiscussion.mockResolvedValue({
      task: converted,
      body: "",
      sections: [],
      acceptance: [],
      links: [],
      outcome: null,
      confirmed: null,
      derived: [],
      artifacts: [],
    });
    const user = userEvent.setup();
    await renderBoard();

    const todo = await screen.findByRole("region", { name: "To Do" });
    await user.click(within(todo).getByRole("button", { name: card.title }));

    // 普通待办卡不能就地讨论：没有输入框，只有一次显式类型转换。
    expect(
      screen.queryByPlaceholderText(zh.tasks.discussion.sayPlaceholder),
    ).toBeNull();
    await user.click(
      screen.getByRole("button", { name: zh.tasks.discussion.pendingConvert }),
    );

    await waitFor(() =>
      expect(apiMocks.convertDiscussion).toHaveBeenCalledWith(
        "/repo",
        "TASK-1",
        "12:abcd",
      ),
    );
    // 转换后仍是同一张卡，只是现在是讨论卡：输入框出现在这一页。
    expect(
      await screen.findByPlaceholderText(zh.tasks.discussion.sayPlaceholder),
    ).toBeInTheDocument();
  });

  it("运行中的任务不显示需求讨论板块", async () => {
    const runningCard = { ...card, status: "In Progress" };
    apiMocks.workspaces.mockResolvedValue([workspace]);
    apiMocks.board.mockResolvedValue({
      ...board,
      columns: [
        { status: "To Do", tasks: [] },
        { status: "In Progress", tasks: [runningCard] },
        { status: "Done", tasks: [] },
      ],
    });
    apiMocks.detail.mockResolvedValue({
      task: runningCard,
      body: "",
      sections: [],
      acceptance: [],
      links: [],
      outcome: null,
      confirmed: null,
      derived: [],
      artifacts: [],
    });
    const user = userEvent.setup();
    await renderBoard();

    const running = await screen.findByRole("region", { name: "In Progress" });
    await user.click(
      within(running).getByRole("button", { name: runningCard.title }),
    );

    // 详情页确实打开了（验收为空时的说明能在），但这一页没有「需求讨论」这一块：
    // 既没有说明，也没有输入框或任何入口。
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText(zh.tasks.noAcceptance)).toBeInTheDocument();
    expect(within(sheet).queryByText(zh.tasks.discussion.title)).toBeNull();
    expect(
      within(sheet).queryByPlaceholderText(zh.tasks.discussion.sayPlaceholder),
    ).toBeNull();
    expect(
      within(sheet).queryByPlaceholderText(
        zh.tasks.discussion.derivePlaceholder,
      ),
    ).toBeNull();
    for (const label of [
      zh.tasks.discussion.pendingConvert,
      zh.tasks.discussion.derive,
      zh.tasks.discussion.sendTask,
    ]) {
      expect(within(sheet).queryByRole("button", { name: label })).toBeNull();
    }
  });

  it("看板仅为讨论卡提供删除入口，取消不删除，确认删除指定卡片", async () => {
    const discussionCard = {
      ...card,
      id: "TASK-2",
      title: "讨论范围",
      kind: "discussion" as const,
      fingerprint: "discussion:123",
    };
    apiMocks.workspaces.mockResolvedValue([workspace]);
    apiMocks.board.mockResolvedValue({
      ...board,
      columns: [
        { status: "To Do", tasks: [card, discussionCard] },
        { status: "In Progress", tasks: [] },
        { status: "Done", tasks: [] },
      ],
    });
    apiMocks.discardDiscussion.mockResolvedValue(undefined);
    const user = userEvent.setup();
    await renderBoard();

    const todo = await screen.findByRole("region", { name: "To Do" });
    expect(
      within(todo).queryByRole("button", {
        name: `${zh.tasks.discussion.discard}：${card.title}`,
      }),
    ).toBeNull();
    const deleteButton = within(todo).getByRole("button", {
      name: `${zh.tasks.discussion.discard}：${discussionCard.title}`,
    });
    await user.click(deleteButton);
    expect(apiMocks.detail).not.toHaveBeenCalled();
    expect(apiMocks.discardDiscussion).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: zh.common.cancel }));
    expect(apiMocks.discardDiscussion).not.toHaveBeenCalled();

    await user.click(deleteButton);
    await user.click(
      screen.getByRole("button", { name: zh.tasks.discussion.discard }),
    );
    await waitFor(() =>
      expect(apiMocks.discardDiscussion).toHaveBeenCalledWith(
        "/repo",
        "TASK-2",
        "discussion:123",
      ),
    );
  });

  it("关掉讨论卡要再确认一次：删文件不可撤销，误点不应该就没了", async () => {
    const discussionCard = {
      ...card,
      kind: "discussion" as const,
      discussionHold: true,
      discussionQuestion: "按日期分组？",
    };
    apiMocks.workspaces.mockResolvedValue([workspace]);
    apiMocks.board.mockResolvedValue({
      ...board,
      columns: [
        { status: "To Do", tasks: [discussionCard] },
        { status: "In Progress", tasks: [] },
        { status: "Done", tasks: [] },
      ],
    });
    apiMocks.detail.mockResolvedValue({
      task: discussionCard,
      body: "",
      sections: [],
      acceptance: [],
      links: [],
      outcome: null,
      confirmed: null,
      derived: [],
      artifacts: [],
    });
    apiMocks.discardDiscussion.mockResolvedValue(undefined);
    const user = userEvent.setup();
    await renderBoard();

    const todo = await screen.findByRole("region", { name: "To Do" });
    await user.click(
      within(todo).getByRole("button", { name: discussionCard.title }),
    );

    const close = await screen.findByRole("button", {
      name: zh.tasks.discussion.discard,
    });
    await user.click(close);
    // 第一次点击只是问一句，文件还在
    expect(
      await screen.findByText(zh.tasks.discussion.discardTitle),
    ).toBeInTheDocument();
    expect(apiMocks.discardDiscussion).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", { name: zh.tasks.discussion.discard }),
    );
    await waitFor(() =>
      expect(apiMocks.discardDiscussion).toHaveBeenCalledWith(
        "/repo",
        "TASK-1",
        "12:abcd",
      ),
    );
  });

  it("发送任务：讨论结束的卡直接进执行列，不用自己拖", async () => {
    const discussionCard = {
      ...card,
      kind: "discussion" as const,
      discussionHold: true,
      discussionQuestion: "按日期分组？",
    };
    apiMocks.workspaces.mockResolvedValue([workspace]);
    apiMocks.board.mockResolvedValue({
      ...board,
      columns: [
        { status: "To Do", tasks: [discussionCard] },
        { status: "In Progress", tasks: [] },
        { status: "Done", tasks: [] },
      ],
    });
    apiMocks.detail.mockResolvedValue({
      task: discussionCard,
      body: "",
      sections: [],
      acceptance: [],
      links: [],
      outcome: null,
      confirmed: "其他列不动",
      derived: [],
      artifacts: [],
      discussionTurns: [],
    });
    apiMocks.setStatus.mockResolvedValue({
      task: {
        ...discussionCard,
        kind: "task",
        discussionHold: false,
        status: "In Progress",
      },
      body: "",
      sections: [],
      acceptance: [],
      links: [],
      outcome: null,
      confirmed: "其他列不动",
      derived: [],
      artifacts: [],
      discussionTurns: [],
    });
    const user = userEvent.setup();
    await renderBoard();

    const todo = await screen.findByRole("region", { name: "To Do" });
    await user.click(
      within(todo).getByRole("button", { name: discussionCard.title }),
    );
    await user.click(
      await screen.findByRole("button", {
        name: zh.tasks.discussion.sendTask,
      }),
    );

    await waitFor(() =>
      expect(apiMocks.setStatus).toHaveBeenCalledWith(
        "/repo",
        "TASK-1",
        "In Progress",
        "12:abcd",
      ),
    );
  });

  it("保存草稿退出：详情收起，卡片与讨论记录都留着", async () => {
    const discussionCard = {
      ...card,
      kind: "discussion" as const,
      discussionHold: true,
    };
    apiMocks.workspaces.mockResolvedValue([workspace]);
    apiMocks.board.mockResolvedValue({
      ...board,
      columns: [
        { status: "To Do", tasks: [discussionCard] },
        { status: "In Progress", tasks: [] },
        { status: "Done", tasks: [] },
      ],
    });
    apiMocks.detail.mockResolvedValue({
      task: discussionCard,
      body: "",
      sections: [],
      acceptance: [],
      links: [],
      outcome: null,
      confirmed: null,
      derived: [],
      artifacts: [],
      discussionTurns: [{ role: "user", text: "先定范围", createdAt: 1 }],
    });
    const user = userEvent.setup();
    await renderBoard();

    const todo = await screen.findByRole("region", { name: "To Do" });
    await user.click(
      within(todo).getByRole("button", { name: discussionCard.title }),
    );
    await user.click(
      await screen.findByRole("button", {
        name: zh.tasks.discussion.closeDraft,
      }),
    );

    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: zh.tasks.discussion.sendTask }),
      ).toBeNull(),
    );
    // 退出不等于丢弃：卡片文件与这一轮的记录都还在
    expect(apiMocks.discardDiscussion).not.toHaveBeenCalled();
  });

  it("讨论卡在卡面标出轮次与来源", async () => {
    const round2 = {
      ...card,
      kind: "discussion" as const,
      round: 2,
      sourceTask: "TASK-9",
      discussionHold: true,
    };
    apiMocks.workspaces.mockResolvedValue([workspace]);
    apiMocks.board.mockResolvedValue({
      ...board,
      columns: [
        { status: "To Do", tasks: [round2] },
        { status: "In Progress", tasks: [] },
        { status: "Done", tasks: [] },
      ],
    });
    await renderBoard();

    const todo = await screen.findByRole("region", { name: "To Do" });
    expect(within(todo).getByText("讨论 · 第 2 轮")).toBeInTheDocument();
    expect(within(todo).getByText("来自 TASK-9")).toBeInTheDocument();
  });
});

describe("TaskBoardPage — 智能体视图", () => {
  const writer = {
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

  beforeEach(() => {
    apiMocks.workspaces.mockResolvedValue([workspace]);
    apiMocks.board.mockResolvedValue(board);
    server.use(
      http.post(`${TAURI_ENDPOINT}/router_status`, () =>
        HttpResponse.json({
          settings: {
            ...defaultRouterSettings,
            agents: [writer],
            workerApps: ["writer"],
          },
          runs: [],
          traces: [],
          today: { dispatches: 0, judgeCalls: 0 },
        }),
      ),
    );
  });

  it("智能体视图是一张编制图：输入 → Lead → 智能体，切过去先看未分配", async () => {
    const user = userEvent.setup();
    await renderBoard();
    await screen.findByRole("region", { name: "To Do" });

    await user.click(
      screen.getByRole("button", { name: zh.tasks.agentView.agents }),
    );

    expect(
      await screen.findByRole("heading", { name: zh.tasks.agentView.title }),
    ).toBeInTheDocument();
    // 图里的节点：输入列里的讨论、Lead、每个智能体，还有未分配
    for (const key of ["discussion", "lead", "agent:writer", "unassigned"]) {
      expect(
        document.querySelector(`[data-flow-node="${key}"]`),
      ).not.toBeNull();
    }
    // 没指派的卡落在「未分配」，不会凭空消失
    expect(screen.getAllByText(card.title).length).toBeGreaterThan(0);
  });

  it("行内 ▶ 走「指派并开工」，不是只改归属", async () => {
    const user = userEvent.setup();
    const calls: unknown[] = [];
    server.use(
      http.post(`${TAURI_ENDPOINT}/router_assign_task`, async ({ request }) => {
        calls.push(await request.json());
        return HttpResponse.json({
          assignees: ["writer"],
          started: true,
          detail: null,
        });
      }),
    );
    apiMocks.board.mockResolvedValue({
      ...board,
      columns: [
        {
          status: "In Progress",
          tasks: [{ ...card, status: "In Progress", assignees: ["writer"] }],
        },
        { status: "To Do", tasks: [] },
        { status: "Done", tasks: [] },
      ],
    });
    await renderBoard();
    await screen.findByRole("region", { name: "In Progress" });
    await user.click(
      screen.getByRole("button", { name: zh.tasks.agentView.agents }),
    );
    await user.click(
      await screen.findByRole("button", { name: zh.tasks.agentView.start }),
    );

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      taskId: "TASK-1",
      agentId: "writer",
      start: true,
    });
  });

  it("一栏里的 + 建出来的卡直接归这一栏：建卡时就写 assignee", async () => {
    const user = userEvent.setup();
    apiMocks.create.mockResolvedValue({
      task: card,
      body: "",
      sections: [],
      acceptance: [],
      links: [],
      outcome: null,
      artifacts: [],
      discussionTurns: [],
    });
    await renderBoard();
    await screen.findByRole("region", { name: "To Do" });
    await user.click(
      screen.getByRole("button", { name: zh.tasks.agentView.agents }),
    );

    // 先聚焦到它那一栏（不送的话右栏还停在「未分配」）
    await user.click(
      await screen.findByRole("button", {
        name: zh.tasks.agentView.focusNode.replace("{{name}}", "文档写手"),
      }),
    );
    const writerLane = document.querySelector<HTMLElement>(
      '[data-lane="agent:writer"]',
    ) as HTMLElement;
    await user.click(
      within(writerLane).getByRole("button", {
        name: zh.tasks.agentView.addTask.replace("{{name}}", "文档写手"),
      }),
    );
    await user.type(
      within(writerLane).getByPlaceholderText(
        zh.tasks.agentView.addTaskPlaceholder,
      ),
      "补一段迁移说明",
    );
    await user.click(
      within(writerLane).getByRole("button", { name: zh.tasks.newTaskSend }),
    );

    // 一张卡一次请求：归属写在 assignee 里，不单开一次指派
    await waitFor(() =>
      expect(apiMocks.create).toHaveBeenCalledWith("/repo", {
        title: "补一段迁移说明",
        assignees: ["writer"],
      }),
    );
  });
});
