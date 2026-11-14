import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "i18next";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import zh from "@/i18n/locales/zh.json";
import { McpRouterPanel } from "@/components/plugins/McpRouterPanel";
import { PrivacyPanel } from "@/components/plugins/PrivacyPanel";
import type {
  McpRouterConfig,
  PrivacyConfig,
  RouterCatalog,
} from "@/lib/api/plugins";

const apiMocks = vi.hoisted(() => ({
  privacyGet: vi.fn(),
  routerGet: vi.fn(),
  catalog: vi.fn(),
}));

vi.mock("@/lib/api/plugins", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/plugins")>();
  return {
    ...actual,
    privacyApi: {
      ...actual.privacyApi,
      get: (...args: unknown[]) => apiMocks.privacyGet(...args),
    },
    mcpRouterApi: {
      ...actual.mcpRouterApi,
      get: (...args: unknown[]) => apiMocks.routerGet(...args),
      catalog: (...args: unknown[]) => apiMocks.catalog(...args),
    },
  };
});

beforeAll(() => {
  i18n.addResourceBundle("zh", "translation", zh, true, true);
});

const privacyConfig: PrivacyConfig = {
  version: 1,
  enabled: true,
  applyToRequestBody: false,
  redactErrorLogs: true,
  rules: [
    {
      detector: "api-key",
      action: "mask",
      replacement: null,
      customPattern: null,
    },
  ],
};

const routerConfig: McpRouterConfig = {
  version: 1,
  enabled: true,
  namespaceSeparator: "__",
  routes: [
    {
      serverId: "time",
      alias: null,
      namespace: null,
      apps: [],
      enabled: true,
      priority: 0,
      tags: [],
    },
  ],
};

const catalog: RouterCatalog = {
  entries: [
    {
      serverId: "time",
      name: "time",
      exposedId: "time",
      enabled: true,
      routedApps: [],
      sourceApps: [],
      routeConfigured: false,
    },
  ],
  conflicts: [],
};

describe("plugin panels", () => {
  beforeEach(() => {
    apiMocks.privacyGet.mockResolvedValue({
      path: "/tmp/privacy.json",
      config: privacyConfig,
      detectors: [
        { id: "api-key", builtin: true },
        { id: "email", builtin: true },
        { id: "custom", builtin: false },
      ],
    });
    apiMocks.routerGet.mockResolvedValue({
      path: "/tmp/mcp-router.json",
      config: routerConfig,
    });
    apiMocks.catalog.mockResolvedValue(catalog);
  });

  it("labels every field of a privacy rule instead of relying on placeholders", async () => {
    render(<PrivacyPanel />);

    // 三个并排的控件各有一行小字说明，填完之后也知道这一格是什么。
    expect(await screen.findByText("检测器")).toBeInTheDocument();
    expect(screen.getByText("处置")).toBeInTheDocument();
    expect(screen.getByText("占位文本")).toBeInTheDocument();
    expect(screen.getByText("待检测文本")).toBeInTheDocument();

    // 页尾要说清这个插件做什么、怎么用，不是只有一排控件
    expect(
      screen.getByRole("heading", { name: "这个插件做什么" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/在本机拦下凭据和个人信息/)).toBeInTheDocument();
    expect(
      screen.getByText(/保存之后去「试跑」贴一段真实文本/),
    ).toBeInTheDocument();
  });

  it("shows the save bar only when the privacy draft differs from what is saved", async () => {
    render(<PrivacyPanel />);
    const user = userEvent.setup();

    await screen.findByText("检测器");
    expect(screen.queryByText("有未保存的改动")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /添加规则/ }));
    expect(await screen.findByText("有未保存的改动")).toBeInTheDocument();
  });

  it("labels the MCP route fields and keeps one save button at the page end", async () => {
    render(<McpRouterPanel />);

    for (const label of ["服务器", "别名", "命名空间", "撞名优先级", "标签"]) {
      expect(await screen.findByText(label)).toBeInTheDocument();
    }
    expect(
      screen.getByRole("button", { name: "保存并应用" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "这个插件做什么" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/决定每个 MCP 服务器写进客户端配置时/),
    ).toBeInTheDocument();
  });
});
