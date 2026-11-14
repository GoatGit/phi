import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18n from "i18next";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import zh from "@/i18n/locales/zh.json";
import { PluginCenterPage } from "@/components/plugins/PluginCenterPage";
import type {
  PluginSummary,
  PluginProtocol,
  PluginSummaryResponse,
} from "@/lib/api/plugins";

const apiMocks = vi.hoisted(() => ({ list: vi.fn(), protocol: vi.fn() }));

vi.mock("@/lib/api/plugins", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/plugins")>();
  return {
    ...actual,
    pluginsApi: {
      ...actual.pluginsApi,
      list: (...args: unknown[]) => apiMocks.list(...args),
      protocol: (...args: unknown[]) => apiMocks.protocol(...args),
    },
  };
});

beforeAll(() => {
  i18n.addResourceBundle("zh", "translation", zh, true, true);
});

function plugin(overrides: Partial<PluginSummary> = {}): PluginSummary {
  return {
    id: "report-card",
    name: "Report card",
    version: "1.0.4",
    kind: "feature",
    hooks: ["panel"],
    priority: 100,
    enabled: true,
    description: null,
    author: null,
    ruleCount: 0,
    sourceDir: "builtin",
    builtin: true,
    panel: { entry: "report-card", title: null, order: 10 },
    ...overrides,
  };
}

function summary(plugins: PluginSummary[]): PluginSummaryResponse {
  return { root: "/tmp/phi/plugins", plugins, errors: [] };
}

function protocol(): PluginProtocol {
  return {
    manifestFile: "plugin.json",
    manifestVersion: 1,
    stateFile: "plugins-state.json",
    requestEntry: "onRequest",
    sessionExitEntry: "onSessionExit",
    hooks: ["request", "session-exit", "panel"],
    kinds: ["rules", "script", "feature"],
    ruleOps: ["remove", "mask"],
    builtinPanels: ["report-card", "task-board"],
    limits: {
      manifestBytes: 65536,
      scriptBytes: 262144,
      maxPlugins: 128,
      maxRules: 32,
    },
    sandbox: {
      timeoutMs: 150,
      memoryBytes: 16 * 1024 * 1024,
      stackBytes: 256 * 1024,
      payloadChars: 512 * 1024,
    },
  };
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function renderPage(
  props: Partial<Parameters<typeof PluginCenterPage>[0]> = {},
) {
  const onSelectPlugin = vi.fn();
  const onTogglePin = vi.fn();
  render(
    <PluginCenterPage
      activePluginId={null}
      onSelectPlugin={onSelectPlugin}
      pinnedPluginIds={[]}
      onTogglePin={onTogglePin}
      terminalApps={["claude"]}
      onStartSession={vi.fn()}
      onOpenSession={vi.fn()}
      liveSessionIds={[]}
      {...props}
    />,
    { wrapper },
  );
  return { onSelectPlugin, onTogglePin };
}

describe("PluginCenterPage", () => {
  beforeEach(() => {
    apiMocks.list.mockResolvedValue(summary([plugin()]));
    apiMocks.protocol.mockResolvedValue(protocol());
  });

  it("lists the five capabilities as cards on the home page", async () => {
    renderPage();

    for (const title of ["成绩单", "接棒", "隐私脱敏", "MCP 路由", "教训库"]) {
      expect(await screen.findByText(title)).toBeInTheDocument();
    }
    // 卡片末尾留一格空位：插件从哪来、刷新入口都在这格。
    expect(screen.getByText("添加插件")).toBeInTheDocument();
    expect(screen.getByText("/tmp/phi/plugins")).toBeInTheDocument();
  });

  it("shows each card's current status", async () => {
    renderPage();

    // 每张卡都能直接看出当前状态：面板类与配置类都是宿主页，
    // 不需要另行安装，也不需要启停。
    expect(await screen.findByText("成绩单")).toBeInTheDocument();
    expect(screen.getAllByText("宿主自带").length).toBeGreaterThanOrEqual(5);
    // 清单里没有对应条目的磁盘插件不下结论。
    expect(screen.queryByText("已启用")).not.toBeInTheDocument();
    expect(screen.queryByText("已停用")).not.toBeInTheDocument();
  });

  it("marks a disabled plugin on its card", async () => {
    apiMocks.list.mockResolvedValue(
      summary([
        plugin(),
        plugin({
          id: "session-baton",
          name: "接棒",
          kind: "script",
          hooks: ["session-exit"],
          enabled: false,
          panel: null,
          builtin: false,
          sourceDir: "session-baton",
        }),
      ]),
    );
    renderPage();

    expect(await screen.findByText("已停用")).toBeInTheDocument();
  });

  it("opens a plugin as a tab instead of navigating away", async () => {
    const { onSelectPlugin } = renderPage();
    const user = userEvent.setup();

    await user.click(await screen.findByText("成绩单"));
    expect(onSelectPlugin).toHaveBeenCalledWith("report-card");
  });

  it("shows the opened plugin as the second tab and offers pinning", async () => {
    apiMocks.list.mockResolvedValue(
      summary([
        plugin(),
        plugin({
          id: "session-baton",
          name: "接棒",
          kind: "script",
          hooks: ["session-exit"],
          panel: null,
          builtin: false,
          sourceDir: "session-baton",
        }),
      ]),
    );
    const { onTogglePin } = renderPage({
      activePluginId: "session-baton",
      pinnedPluginIds: [],
    });
    const user = userEvent.setup();

    expect(
      await screen.findByRole("tab", { name: "插件中心" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("tab", { name: "接棒" }),
    ).toBeInTheDocument();

    await user.click(await screen.findByRole("button", { name: "钉在侧栏" }));
    expect(onTogglePin).toHaveBeenCalledWith("session-baton");
  });

  it("switches the pin button to unpin when the plugin is already pinned", async () => {
    apiMocks.list.mockResolvedValue(
      summary([
        plugin(),
        plugin({
          id: "custom.rules",
          name: "Custom rules",
          kind: "rules",
          hooks: ["request"],
          panel: null,
          builtin: false,
          sourceDir: "custom-rules",
        }),
      ]),
    );
    renderPage({
      activePluginId: "custom.rules",
      pinnedPluginIds: ["custom.rules"],
    });

    expect(
      await screen.findByRole("button", { name: "取消钉住" }),
    ).toBeInTheDocument();
  });

  it("explains when the opened plugin is gone", async () => {
    renderPage({ activePluginId: "gone" });

    expect(
      await screen.findByText("这个插件不存在，可能已经被卸载。"),
    ).toBeInTheDocument();
  });

  // 协议不是功能，而是写给插件作者的说明；它占一张卡片，点开在插件中心里看。
  it("opens the plugin protocol from its card and from the add-plugin slot", async () => {
    const { onSelectPlugin } = renderPage();
    const user = userEvent.setup();

    await user.click(await screen.findByText("插件协议"));
    expect(onSelectPlugin).toHaveBeenCalledWith("plugin-protocol");

    await user.click(screen.getByRole("button", { name: "插件协议与 SDK" }));
    expect(onSelectPlugin).toHaveBeenLastCalledWith("plugin-protocol");
  });

  it("renders the protocol as a plugin tab", async () => {
    renderPage({ activePluginId: "plugin-protocol" });

    expect(
      await screen.findByRole("tab", { name: "插件协议" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("heading", { name: "plugin.json" }),
    ).toBeInTheDocument();
  });

  // 五张卡片原来都是同一个灰图标：远处看成绩单和教训库一模一样。
  it("gives every card its own identity glyph", async () => {
    renderPage();

    const titles = ["成绩单", "接棒", "隐私脱敏", "MCP 路由", "教训库"];
    const tints = new Set<string>();
    for (const title of titles) {
      const card = (await screen.findByText(title)).closest("button")!;
      const glyph = card.querySelector("span[aria-hidden='true']")!;
      tints.add(glyph.className);
    }
    // 每张卡片的图标底色不同，才能在远处分清是谁
    expect(tints.size).toBe(titles.length);
  });
});
