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
  maxAttempts: 3,
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
