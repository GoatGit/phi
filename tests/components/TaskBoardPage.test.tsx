import { render, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../msw/server";
import { defaultRouterSettings } from "../msw/handlers";

const TAURI_ENDPOINT = "http://tauri.local";
import userEvent from "@testing-library/user-event";
import i18n from "i18next";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import zh from "@/i18n/locales/zh.json";
import { TaskBoardPage } from "@/components/tasks/TaskBoardPage";
import type { TaskBoard, TaskCard, TaskWorkspace } from "@/lib/api/tasks";

const apiMocks = vi.hoisted(() => ({
  workspaces: vi.fn(),
  board: vi.fn(),
  create: vi.fn(),
  detail: vi.fn(),
  linkSession: vi.fn(),
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
  localStorage.clear();
});

const card: TaskCard = {
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

function renderBoard() {
  return render(
    <TaskBoardPage
      terminalApps={["ghostty"]}
      onStartSession={vi.fn()}
      onOpenSession={vi.fn()}
      onOpenWorker={vi.fn().mockResolvedValue(true)}
      liveSessionIds={[]}
    />,
  );
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
    });
  });

  it("入口在 To Do 栏的第一条，点开是一个输入框", async () => {
    renderBoard();
    const todo = await screen.findByRole("region", { name: "To Do" });

    const [first] = within(todo).getAllByRole("button");
    expect(first).toHaveTextContent(zh.tasks.newTask);

    // 页头不再有另一个「新建任务」按钮
    expect(screen.getAllByText(zh.tasks.newTask)).toHaveLength(1);
  });

  it("只填标题就能建卡：状态走默认列，其余字段不传", async () => {
    const user = userEvent.setup();
    renderBoard();
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
});

describe("TaskBoardPage — 仓库下拉", () => {
  beforeEach(() => {
    apiMocks.workspaces.mockResolvedValue([workspace]);
    apiMocks.board.mockResolvedValue(board);
  });

  it("仓库列表、添加仓库、移出看板在同一个下拉里", async () => {
    const user = userEvent.setup();
    renderBoard();

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
    });
    apiMocks.linkSession.mockResolvedValue({
      sessionId: "s-1",
      appId: "codex",
      costUsd: 0,
      requests: 0,
    });
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("统一启动交给 router，不再从前端开无运行态的会话", async () => {
    const onStartSession = vi.fn().mockResolvedValue("s-1");
    const user = userEvent.setup();
    render(
      <TaskBoardPage
        terminalApps={["codex"]}
        onStartSession={onStartSession}
        onOpenSession={vi.fn()}
        onOpenWorker={vi.fn().mockResolvedValue(true)}
        liveSessionIds={[]}
      />,
    );

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
    render(
      <TaskBoardPage
        terminalApps={["codex"]}
        onStartSession={vi.fn()}
        onOpenSession={onOpenSession}
        onOpenWorker={vi.fn().mockResolvedValue(true)}
        liveSessionIds={[]}
      />,
    );

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
    const { container } = render(
      <TaskBoardPage
        embedded
        terminalApps={["ghostty"]}
        onStartSession={vi.fn()}
        onOpenSession={vi.fn()}
        onOpenWorker={vi.fn().mockResolvedValue(true)}
        liveSessionIds={[]}
      />,
    );

    const todo = await screen.findByRole("region", { name: "To Do" });
    // 列不再写死宽度：写死 300 时三列右边缘会比上下板块短一截
    expect(todo.className).toContain("flex-1");
    expect(todo.className).toContain("basis-0");
    expect(todo.className).not.toContain("w-[300px]");
    // 版心与其它插件页一致，切页签时左右边缘不跳
    expect(container.firstElementChild?.className).toContain("max-w-[1080px]");
  });
});

describe("TaskBoardPage — 卡片浮在列的底色上", () => {
  beforeEach(() => {
    apiMocks.workspaces.mockResolvedValue([workspace]);
    apiMocks.board.mockResolvedValue(board);
  });

  it("列是满色托盘、卡片自带浮起投影", async () => {
    renderBoard();

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
      maxAttempts: 3,
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
    renderBoard();
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
    renderBoard();
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
    renderBoard();

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
    renderBoard();
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
