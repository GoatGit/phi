import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";
import zh from "@/i18n/locales/zh.json";
import { AutoRouterPanel } from "@/components/tasks/AutoRouterPanel";
import type { RouterSettings, RouterStatus } from "@/lib/api/superAgent";

// 面板一打开会去读网关路由组；这里只测触发列，不需要真的问网关。
vi.mock("@/lib/api/gateway", () => ({
  gatewayApi: { getCatalog: () => Promise.resolve({ groups: [] }) },
  groupModelAlias: (group: { id: string }) => `group/${group.id}`,
}));

// 编辑器打开时会问这个应用可以按会话指定哪些模型；测试里给一份固定名单。
vi.mock("@/lib/api/superAgent", () => ({
  superAgentApi: {
    agentModels: () =>
      Promise.resolve({ models: ["claude-opus-x"], overridable: true }),
  },
}));

beforeAll(() => {
  // jsdom 没有 scrollIntoView，下拉打开时会调它。
  Element.prototype.scrollIntoView = vi.fn();
  i18n.addResourceBundle("zh", "translation", zh, true, true);
});

const settings: RouterSettings = {
  enabled: true,
  shadow: true,
  triggerStatus: "Done",
  concurrency: 2,
  dispatchesPerTick: 2,
  dispatchesPerDay: 40,
  judgeCallsPerDay: 200,
  attentionThreshold: 8,
  workerApps: ["claude"],
  agents: [],
  routerAvatar: "",
  maxAttempts: 3,
  stallSeconds: 3600,
  monitorIntervalSeconds: 120,
  needsYouSeconds: 3600,
  trustExitZero: true,
  leaseSeconds: 90,
  cooldownSeconds: 120,
  judgeModel: "jev-latest",
  episodeModel: "",
};

const status: RouterStatus = {
  settings,
  runs: [],
  traces: [],
  today: { dispatches: 0, judgeCalls: 0 },
};

describe("AutoRouterPanel — 影子模式", () => {
  const renderPanel = (next: RouterSettings) => {
    const runNow = vi.fn();
    render(
      <AutoRouterPanel
        status={{ ...status, settings: next }}
        statuses={["To Do", "In Progress"]}
        terminalApps={["claude"]}
        onSave={async () => {}}
        onRunNow={async () => {
          runNow();
          return {
            traceId: "t",
            at: 0,
            trigger: "manual",
            skipped: null,
            scanned: 0,
            candidates: 0,
            filtered: [],
            narrowed: false,
            degraded: [],
            decisions: [],
            dispatched: [],
            needsYou: [],
            judgeCalls: 0,
            durationMs: 0,
            shadow: next.shadow,
          };
        }}
      />,
    );
    return screen.getByRole("button", { name: zh.tasks.router.button });
  };

  it("影子模式开着时，按钮上直接写出来：启用了也不会真的派活", () => {
    const button = renderPanel({ ...settings, shadow: true });
    expect(button).toHaveTextContent(zh.tasks.router.button);
    expect(button).toHaveTextContent(zh.tasks.router.modeShadow);
  });

  it("关掉影子模式后不再挂着这句提示", () => {
    const button = renderPanel({ ...settings, shadow: false });
    expect(button).not.toHaveTextContent(zh.tasks.router.modeShadow);
  });
});

describe("AutoRouterPanel — 触发列", () => {
  it("保存的触发列已不在看板上时，照实显示它，不悄悄换成第一列", async () => {
    const user = userEvent.setup();
    render(
      <AutoRouterPanel
        status={status}
        // 看板上已经没有 Done 这一列了（列被改名或删掉）
        statuses={["To Do", "In Progress"]}
        terminalApps={["claude"]}
        onSave={async () => {}}
        onRunNow={async () => {
          throw new Error("unused");
        }}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: zh.tasks.router.button }),
    );
    await user.click(
      await screen.findByRole("combobox", {
        name: zh.tasks.router.triggerStatus,
      }),
    );

    // 显示成「To Do」会让人以为触发列已经换了，而实际派发一张都不会发生。
    expect(
      await screen.findByRole("option", { name: "Done" }),
    ).toBeInTheDocument();
  });
});

describe("AutoRouterPanel — 智能体", () => {
  const renderAgents = (next: RouterSettings) => {
    const onSave = vi.fn<(next: RouterSettings) => Promise<void>>(
      async () => {},
    );
    render(
      <AutoRouterPanel
        status={{ ...status, settings: next }}
        statuses={["To Do", "In Progress"]}
        terminalApps={["claude", "codex"]}
        onSave={onSave}
        onRunNow={async () => {
          throw new Error("unused");
        }}
      />,
    );
    return onSave;
  };

  const openPanel = async () => {
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: zh.tasks.router.button }),
    );
    return user;
  };

  it("旧配置只有应用 id 时，照旧当智能体列出来并保持参与派发", async () => {
    renderAgents({ ...settings, agents: [], workerApps: ["claude"] });
    const user = await openPanel();

    expect(await screen.findByText("Claude Code")).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", {
        name: zh.tasks.router.agentAllowed.replace("{{name}}", "Claude Code"),
      }),
    ).toBeChecked();
    // 只剩一个允许项时不能取消：取消就看不懂「自动又开了却没派」了。
    expect(
      screen.getByRole("checkbox", {
        name: zh.tasks.router.agentAllowed.replace("{{name}}", "Claude Code"),
      }),
    ).toBeDisabled();
    expect(user).toBeTruthy();
  });

  it("添加智能体：一次保存名称与用途，id 与允许名单交给后端", async () => {
    const onSave = renderAgents({ ...settings, agents: [], workerApps: [] });
    const user = await openPanel();

    await user.click(
      screen.getByRole("button", { name: zh.tasks.router.agentAdd }),
    );
    await user.type(
      screen.getByLabelText(zh.tasks.router.agentName),
      "文档写手",
    );
    await user.type(
      screen.getByLabelText(zh.tasks.router.agentPurpose),
      "写文档、补说明",
    );
    await user.click(
      screen.getByRole("button", { name: zh.tasks.router.agentSave }),
    );

    expect(onSave).toHaveBeenCalledTimes(1);
    const saved = onSave.mock.calls[0][0];
    expect(saved.agents).toHaveLength(1);
    expect(saved.agents[0]).toMatchObject({
      // id 留空：保存时由后端按名称派生，前端不猜 uniqueness。
      id: "",
      name: "文档写手",
      description: "写文档、补说明",
      appId: "claude",
      model: "",
    });
    // 新建的智能体由后端补进允许名单（那时才有 id），这里不改动原有名单。
    expect(saved.workerApps).toEqual([]);
  });

  it("名称空着不能保存，避免建出一个认不出来的智能体", async () => {
    renderAgents({ ...settings, agents: [], workerApps: [] });
    const user = await openPanel();

    await user.click(
      screen.getByRole("button", { name: zh.tasks.router.agentAdd }),
    );
    expect(
      screen.getByRole("button", { name: zh.tasks.router.agentSave }),
    ).toBeDisabled();
  });

  it("执行模型常开：名单里的能选，名单外的能自己填", async () => {
    const onSave = renderAgents({ ...settings, agents: [], workerApps: [] });
    const user = await openPanel();

    await user.click(
      screen.getByRole("button", { name: zh.tasks.router.agentAdd }),
    );
    await user.type(
      screen.getByLabelText(zh.tasks.router.agentName),
      "省钱的那个",
    );

    const trigger = screen.getByRole("combobox", {
      name: zh.tasks.router.agentModel,
    });
    // 先选名单里的，验证下拉不是置灰的。
    await user.click(trigger);
    await user.click(await screen.findByText("claude-opus-x"));
    // 再切到自定义，填一个名单外的模型。
    await user.click(trigger);
    await user.click(await screen.findByText(zh.tasks.router.agentModelCustom));
    const input = screen.getByPlaceholderText(
      zh.tasks.router.agentModelCustomPlaceholder,
    );
    await user.clear(input);
    await user.type(input, "glm-5.2");
    await user.click(
      screen.getByRole("button", { name: zh.tasks.router.agentSave }),
    );

    const saved = onSave.mock.calls[0][0];
    expect(saved.agents[0].model).toBe("glm-5.2");
  });

  it("追加参数从下拉里挑：点一项就落成命令行 token，可再点 × 去掉", async () => {
    const onSave = renderAgents({ ...settings, agents: [], workerApps: [] });
    const user = await openPanel();

    await user.click(
      screen.getByRole("button", { name: zh.tasks.router.agentAdd }),
    );
    await user.type(
      screen.getByLabelText(zh.tasks.router.agentName),
      "便宜的那个",
    );
    // 还没选任何一项时不摆原文输入框：默认只有「添加参数」这一个入口。
    expect(
      screen.queryByPlaceholderText(zh.tasks.router.agentArgumentsPlaceholder),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: zh.tasks.router.agentArgumentsAdd }),
    );
    // 下拉里摆的就是命令行的样子：不用先记住参数名再回来手打。
    await user.click(screen.getByRole("button", { name: "--effort high" }));
    expect(screen.getByText("--effort high")).toBeInTheDocument();

    // 加错了就地撤掉，不必清空整段原文。
    await user.click(
      screen.getByRole("button", {
        name: zh.tasks.router.agentArgumentsRemove.replace(
          "{{argument}}",
          "--effort high",
        ),
      }),
    );
    expect(screen.queryByText("--effort high")).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: zh.tasks.router.agentArgumentsAdd }),
    );
    await user.click(screen.getByRole("button", { name: "--verbose" }));
    await user.click(
      screen.getByRole("button", { name: zh.tasks.router.agentSave }),
    );
    const saved = onSave.mock.calls[0][0];
    expect(saved.agents[0].arguments).toEqual(["--verbose"]);
  });

  it("列表之外的写法走自定义输入：原文照存，两个 token 不会被吞", async () => {
    const onSave = renderAgents({ ...settings, agents: [], workerApps: [] });
    const user = await openPanel();

    await user.click(
      screen.getByRole("button", { name: zh.tasks.router.agentAdd }),
    );
    await user.type(
      screen.getByLabelText(zh.tasks.router.agentName),
      "便宜的那个",
    );
    await user.click(
      screen.getByRole("button", { name: zh.tasks.router.agentArgumentsAdd }),
    );
    await user.click(
      screen.getByRole("button", {
        name: zh.tasks.router.agentArgumentsCustom,
      }),
    );
    const args = screen.getByPlaceholderText(
      zh.tasks.router.agentArgumentsPlaceholder,
    );
    await user.type(args, "--model glm-5");
    expect((args as HTMLInputElement).value).toBe("--model glm-5");

    await user.click(
      screen.getByRole("button", { name: zh.tasks.router.agentSave }),
    );
    const saved = onSave.mock.calls[0][0];
    expect(saved.agents[0].arguments).toEqual(["--model", "glm-5"]);
  });

  it("编辑智能体只改定义，派发允许列表不受影响", async () => {
    const writer = {
      id: "writer",
      name: "文档写手",
      description: "写文档",
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
    const onSave = renderAgents({
      ...settings,
      agents: [writer],
      workerApps: ["writer"],
    });
    const user = await openPanel();

    await user.click(
      screen.getByRole("button", {
        name: zh.tasks.router.agentEdit.replace("{{name}}", "文档写手"),
      }),
    );
    const name = screen.getByLabelText(zh.tasks.router.agentName);
    await user.clear(name);
    await user.type(name, "资料写手");
    await user.click(
      screen.getByRole("button", { name: zh.tasks.router.agentSave }),
    );

    const saved = onSave.mock.calls[0][0];
    expect(saved.agents[0].name).toBe("资料写手");
    expect(saved.workerApps).toEqual(["writer"]);
  });

  it("删除智能体时一并取消允许，不留一个指向不存在定义的 id", async () => {
    const writer = {
      id: "writer",
      name: "文档写手",
      description: "写文档",
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
    const codex = {
      ...writer,
      id: "codex-reviewer",
      name: "代码审查",
      appId: "codex",
    };
    const onSave = renderAgents({
      ...settings,
      agents: [writer, codex],
      workerApps: ["writer", "codex-reviewer"],
    });
    const user = await openPanel();

    await user.click(
      screen.getByRole("button", {
        name: zh.tasks.router.agentDelete.replace("{{name}}", "文档写手"),
      }),
    );

    const saved = onSave.mock.calls[0][0];
    expect(saved.agents.map((agent) => agent.id)).toEqual(["codex-reviewer"]);
    expect(saved.workerApps).toEqual(["codex-reviewer"]);
  });

  it("角色上下文超过 6000 字时直接拦住保存，不让人白点一次", async () => {
    const verbose = {
      id: "writer",
      name: "文档写手",
      description: "写文档",
      appId: "claude",
      prompt: "",
      model: "",
      arguments: [],
      outcome: "",
      boundary: "",
      askUserWhen: [],
      // 10 × 300 个「步骤」＝ 6000 字，加上标题必然超限。
      steps: Array.from({ length: 10 }, () => "步骤".repeat(300)),
      constraints: [],
      completion: { result: "", evidence: [] },
    };
    renderAgents({
      ...settings,
      agents: [verbose],
      workerApps: ["writer"],
    });
    const user = await openPanel();
    await user.click(
      screen.getByRole("button", {
        name: zh.tasks.router.agentEdit.replace("{{name}}", "文档写手"),
      }),
    );

    expect(
      screen.getByRole("button", { name: zh.tasks.router.agentSave }),
    ).toBeDisabled();
    expect(screen.getByText(/角色上下文超过 6000 字/)).toBeInTheDocument();
  });
});
