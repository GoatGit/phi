import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { ReactElement } from "react";
import userEvent from "@testing-library/user-event";
import {
  GroupSection,
  inferGroupApps,
} from "@/components/gateway/GroupSection";
import {
  catalogWithoutGroup,
  catalogWithoutSupplier,
} from "@/components/gateway/useGatewayCatalog";
import type { GatewayRouteGroup } from "@/lib/api/gateway";
import { ResourcePoolSection } from "@/components/gateway/ResourcePoolSection";
import { RoutingStatus } from "@/components/gateway/RoutingStatus";
import type { GatewayCatalog } from "@/lib/api";
import { gatewayApi, providersApi } from "@/lib/api";
import { proxyApi } from "@/lib/api/proxy";
import { piApi } from "@/lib/api/pi";
import { ROUTABLE_APP_IDS, getAppLabel } from "@/config/appConfig";
import {
  ProviderCatalogPage,
  RoutingOverviewPage,
} from "@/components/gateway/GatewayPages";
import {
  isAppPage,
  isGlobalPage,
  parseView,
  readStoredView,
  storeView,
  VIEW_STORAGE_KEY,
} from "@/lib/navigation";

vi.mock("@/lib/api", () => ({
  providersApi: {
    getAll: vi.fn(),
    switch: vi.fn(),
    getCurrent: vi.fn(),
    getClaudeDesktopStatus: vi.fn(),
    getOpenCodeLiveProviderIds: vi.fn(),
    getOpenClawLiveProviderIds: vi.fn(),
    getHermesLiveProviderIds: vi.fn(),
  },
  gatewayApi: {
    fetchModels: vi.fn(),
    saveCatalog: vi.fn(),
    connectApp: vi.fn(),
    getAppStatus: vi.fn(),
    disconnectApp: vi.fn(),
    materializeSupplierProvider: vi.fn(),
    previewRoute: vi.fn(),
    getTraces: vi.fn(),
    getTracePage: vi.fn(),
    getCatalog: vi.fn(),
    createSupplier: vi.fn(),
    updateSupplier: vi.fn(),
  },
}));
vi.mock("@/lib/api/pi", () => ({ piApi: { getCurrentState: vi.fn() } }));
vi.mock("@/lib/api/proxy", () => ({
  proxyApi: {
    getGlobalProxyConfig: vi
      .fn()
      .mockResolvedValue({ listenAddress: "127.0.0.1", listenPort: 15821 }),
    startProxyServer: vi.fn(),
    stopProxyWithRestore: vi.fn(),
    setProxyTakeoverForApp: vi.fn(),
    getAppMode: vi.fn(),
    getProxyStatus: vi.fn(),
    getProxyTakeoverStatus: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock("@/components/gateway/AddPoolSupplier", () => ({
  AddPoolSupplier: () => <div>existing-provider-template-page</div>,
}));

// jsdom does not implement scrolling; keep the real Radix Select interactions.
const scrollDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollIntoView",
);
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});
afterAll(() => {
  if (scrollDescriptor)
    Object.defineProperty(
      HTMLElement.prototype,
      "scrollIntoView",
      scrollDescriptor,
    );
  else delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
});

function mount(element: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
  return client;
}

const sharedCatalog: GatewayCatalog = {
  revision: 1,
  suppliers: [
    {
      id: "shared",
      name: "Shared provider",
      endpoint: { protocol: "anthropic", baseUrl: "https://example.com" },
      models: ["model-a"],
    },
  ],
  policies: ["claude", "codex"].map((appId) => ({
    id: appId,
    name: appId,
    appId,
    enabled: true,
    matchModel: "",
    priority: 0,
    failover: false,
    candidates: [{ supplierId: "shared", model: "model-a" }],
  })),
};

beforeEach(() => {
  vi.mocked(gatewayApi.fetchModels).mockReset();
  vi.mocked(gatewayApi.saveCatalog)
    .mockReset()
    .mockImplementation(async (catalog) => ({
      ...catalog,
      revision: catalog.revision + 1,
    }));
  vi.mocked(gatewayApi.connectApp).mockReset().mockResolvedValue(undefined);
  vi.mocked(gatewayApi.getAppStatus).mockReset().mockResolvedValue(null);
  vi.mocked(gatewayApi.disconnectApp).mockReset().mockResolvedValue(undefined);
  vi.mocked(gatewayApi.materializeSupplierProvider)
    .mockReset()
    .mockImplementation(
      async (_app: string, supplierId: string) =>
        `gateway-supplier:${supplierId}`,
    );
  vi.mocked(proxyApi.setProxyTakeoverForApp)
    .mockReset()
    .mockResolvedValue(undefined);
  vi.mocked(proxyApi.stopProxyWithRestore)
    .mockReset()
    .mockResolvedValue(undefined as never);
  vi.mocked(gatewayApi.getTraces).mockReset().mockResolvedValue([]);
  vi.mocked(gatewayApi.getTracePage)
    .mockReset()
    .mockImplementation(async () => {
      const traces = await gatewayApi.getTraces();
      return {
        traces,
        total: traces.length,
        active: [],
        members: [],
        retainedSince: null,
        summary: {
          requests: traces.length,
          completed: 0,
          failed: 0,
          interrupted: 0,
          failovers: 0,
          inputTokens: 0,
          outputTokens: 0,
          unknownUsage: 0,
          estimatedCost: "0",
          unknownCost: 0,
          classifierCalls: 0,
          classifierCost: "0",
          classifierUnknownCost: 0,
          p50LatencyMs: 0,
          p95LatencyMs: 0,
        },
      };
    });
  vi.mocked(gatewayApi.createSupplier).mockReset();
  vi.mocked(gatewayApi.updateSupplier).mockReset();
  vi.mocked(providersApi.getAll).mockReset().mockResolvedValue({});
  vi.mocked(providersApi.switch)
    .mockReset()
    .mockResolvedValue({ warnings: [] });
  vi.mocked(providersApi.getCurrent).mockReset().mockResolvedValue("");
  vi.mocked(providersApi.getClaudeDesktopStatus).mockReset().mockResolvedValue({
    supported: true,
    configured: false,
    proxyRunning: false,
    staleRawModels: false,
    missingRouteMappings: false,
    gatewayTokenConfigured: false,
  });
  vi.mocked(providersApi.getOpenCodeLiveProviderIds)
    .mockReset()
    .mockResolvedValue([]);
  vi.mocked(providersApi.getOpenClawLiveProviderIds)
    .mockReset()
    .mockResolvedValue([]);
  vi.mocked(providersApi.getHermesLiveProviderIds)
    .mockReset()
    .mockResolvedValue([]);
  vi.mocked(piApi.getCurrentState)
    .mockReset()
    .mockResolvedValue({ enabledProviderIds: [], defaultProviderId: null });
  vi.mocked(gatewayApi.getCatalog)
    .mockReset()
    .mockResolvedValue({ suppliers: [], policies: [], revision: 0 } as Awaited<
      ReturnType<typeof gatewayApi.getCatalog>
    >);
  vi.mocked(proxyApi.getAppMode).mockReset().mockResolvedValue({
    mode: "route",
    attached: true,
    routeProviderId: "same",
    directProviderId: null,
  });
  vi.mocked(proxyApi.getProxyStatus)
    .mockReset()
    .mockResolvedValue({ running: false } as Awaited<
      ReturnType<typeof proxyApi.getProxyStatus>
    >);
});

describe("gateway navigation", () => {
  it("persists global views without changing legacy app navigation", () => {
    for (const view of ["providerCatalog", "routingOverview"] as const) {
      expect(parseView(view)).toBe(view);
      expect(isGlobalPage(view)).toBe(true);
      expect(isAppPage(view)).toBe(false);
      storeView(view);
      expect(readStoredView()).toBe(view);
    }
    expect(parseView("providers")).toBe("providers");
    // 旧 OpenClaw 环境页已并入工作区（见 navigation.ts LEGACY_VIEWS）
    expect(parseView("openclawEnv")).toBe("workspace");
    localStorage.removeItem(VIEW_STORAGE_KEY);
  });
});

describe("provider catalog", () => {
  it("opens directly on the unified pool with unified management actions", async () => {
    mount(<ProviderCatalogPage />);
    // 页面不再有按应用的只读目录：进来就是统一资源池。
    expect(
      await screen.findByRole("button", { name: "gateway.pool.create" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "gateway.pool.import" }),
    ).not.toBeInTheDocument();
    expect(providersApi.getAll).not.toHaveBeenCalled();
    // 旧目录的"管理供应商"入口已不存在。
    expect(
      screen.queryByRole("button", { name: "gateway.manage" }),
    ).not.toBeInTheDocument();
  });

  it("isolates a failed catalog read and supports retry", async () => {
    vi.mocked(gatewayApi.getCatalog)
      .mockReset()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({
        suppliers: [],
        policies: [],
        revision: 0,
      } as Awaited<ReturnType<typeof gatewayApi.getCatalog>>);
    mount(<ProviderCatalogPage />);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "gateway.retry" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "gateway.pool.create" }),
      ).toBeInTheDocument(),
    );
  });
  it("shows one shared supplier with references from multiple app policies", async () => {
    vi.mocked(gatewayApi.getCatalog).mockResolvedValue(sharedCatalog);
    mount(<ProviderCatalogPage />);
    const row = (await screen.findByText("Shared provider")).closest(
      "article",
    )!;
    expect(screen.getAllByText("Shared provider")).toHaveLength(1);
    // 引用默认折叠成摘要，展开后才能看到各策略链接
    fireEvent.click(
      within(row).getByRole("button", {
        name: "gateway.pool.showReferences",
      }),
    );
    expect(
      within(row).getByRole("button", { name: "Claude · claude" }),
    ).toBeInTheDocument();
    expect(
      within(row).getByRole("button", { name: "Codex · codex" }),
    ).toBeInTheDocument();
    expect(providersApi.getAll).not.toHaveBeenCalled();
    fireEvent.click(
      within(row).getByRole("button", { name: "gateway.pool.edit" }),
    );
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByLabelText("gateway.pool.apiKey")).toHaveValue(
      "",
    );
    fireEvent.change(within(dialog).getByLabelText("gateway.pool.name"), {
      target: { value: "Updated provider" },
    });
    vi.mocked(gatewayApi.updateSupplier).mockResolvedValue({
      ...sharedCatalog,
      suppliers: [{ ...sharedCatalog.suppliers[0], name: "Updated provider" }],
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "gateway.save" }),
    );
    await screen.findByText("Updated provider");
    expect(gatewayApi.updateSupplier).toHaveBeenCalledWith("shared", {
      revision: 1,
      name: "Updated provider",
      endpoint: sharedCatalog.suppliers[0].endpoint,
      models: ["model-a"],
    });
  });

  it("opens the existing template page from the resource pool", async () => {
    mount(<ProviderCatalogPage />);
    fireEvent.click(
      await screen.findByRole("button", { name: "gateway.pool.create" }),
    );
    expect(
      screen.getByText("existing-provider-template-page"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("routing overview", () => {
  const openAppRoute = async (app: string) => {
    const user = userEvent.setup();
    // 默认折叠靠后的应用：等应用列出来以后再展开。
    await screen.findByRole("list", { name: "gateway.flow.apps" });
    const expand = screen.queryByRole("button", {
      name: "gateway.flow.moreApps",
    });
    if (expand) await user.click(expand);
    const node = (await screen.findByText(app)).closest("li")!;
    await user.click(
      within(node).getByRole("button", {
        name: "gateway.flow.routeSettingsFor",
      }),
    );
    return { user, dialog: await screen.findByRole("dialog") };
  };

  it("opens a routing-only app's settings when the sidebar asks for it", async () => {
    vi.mocked(gatewayApi.getCatalog).mockResolvedValue(sharedCatalog);
    const handled = vi.fn();
    mount(
      <RoutingOverviewPage
        routeAppRequest={{ appId: "omo", nonce: 1 }}
        onRouteAppRequestHandled={handled}
      />,
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("OmO");
    await waitFor(() => expect(handled).toHaveBeenCalledTimes(1));
  });

  it("uses the flow as the only routing page with inline app and group actions", async () => {
    vi.mocked(gatewayApi.getCatalog).mockResolvedValue({
      ...sharedCatalog,
      groups: [routeGroup],
    });
    mount(<RoutingOverviewPage />);
    expect(
      await screen.findByRole("region", { name: "gateway.flow.title" }),
    ).toBeInTheDocument();
    // 路由 / 路由组页签已移除，页面只剩流转图。
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    fireEvent.click(
      await screen.findByRole("button", { name: "gateway.flow.moreApps" }),
    );
    for (const app of ROUTABLE_APP_IDS) {
      expect(screen.getByText(getAppLabel(app))).toBeInTheDocument();
    }
    // System One 是决策协议虚拟应用：应用行在，但路由目标由组推导，没有设置按钮。
    expect(
      screen.getAllByRole("button", { name: "gateway.flow.routeSettingsFor" }),
    ).toHaveLength(ROUTABLE_APP_IDS.length - 1);
    expect(
      screen.getByRole("button", { name: "gateway.groups.new" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "gateway.groups.editFor" }),
    ).toBeInTheDocument();
  });

  it("restores every app to direct from the routing page", async () => {
    vi.mocked(gatewayApi.getCatalog).mockResolvedValue(sharedCatalog);
    mount(<RoutingOverviewPage />);
    fireEvent.click(
      await screen.findByRole("button", { name: "routingSettings.exitAll" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "routingSettings.exitAllConfirm" }),
    );
    await waitFor(() =>
      expect(proxyApi.stopProxyWithRestore).toHaveBeenCalledTimes(1),
    );
  });

  it.each(["direct", "route"] as const)(
    "direct-connects a pool supplier from %s mode",
    async (mode) => {
      // 供应商段与供应商页同源：池内全部供应商都出现，协议不兼容的禁用。
      vi.mocked(gatewayApi.getCatalog).mockResolvedValue({
        ...sharedCatalog,
        suppliers: [
          sharedCatalog.suppliers[0],
          {
            id: "chat-relay",
            name: "Chat relay",
            endpoint: {
              protocol: "openai_chat",
              baseUrl: "https://chat.example.com",
            },
            models: ["model-a"],
          },
        ],
        groups: [routeGroup],
        policies: [
          ...sharedCatalog.policies,
          {
            ...sharedCatalog.policies[0],
            id: "connection/claude",
            groupId: "production",
            candidates: [],
          },
        ],
      });
      vi.mocked(providersApi.getAll).mockResolvedValue({
        old: { id: "old", name: "Old supplier", settingsConfig: {} },
      });
      vi.mocked(proxyApi.getAppMode).mockResolvedValue({
        mode,
        attached: mode !== "direct",
        directProviderId: "old",
        routeProviderId: "gateway-entry:claude",
      });
      let finish!: () => void;
      vi.mocked(providersApi.switch).mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = () => resolve({ warnings: [] });
          }),
      );
      mount(<RoutingOverviewPage />);
      const { user, dialog } = await openAppRoute("Claude");
      expect(
        within(dialog).getByRole("radio", { name: "Chat relay" }),
      ).toBeDisabled();
      if (mode === "direct") {
        expect(
          within(dialog).getByRole("radio", { name: "Old supplier" }),
        ).toHaveAttribute("aria-checked", "true");
      } else {
        expect(
          within(dialog).getByRole("radio", { name: "Production" }),
        ).toHaveAttribute("aria-checked", "true");
      }
      await user.click(
        within(dialog).getByRole("radio", { name: "Shared provider" }),
      );
      await waitFor(() =>
        expect(gatewayApi.materializeSupplierProvider).toHaveBeenCalledWith(
          "claude",
          "shared",
        ),
      );
      await waitFor(() =>
        expect(providersApi.switch).toHaveBeenCalledWith(
          "gateway-supplier:shared",
          "claude",
        ),
      );
      expect(within(dialog).getByRole("status")).toHaveTextContent(
        "gateway.saving",
      );
      if (mode === "route") {
        expect(proxyApi.setProxyTakeoverForApp).toHaveBeenCalledWith(
          "claude",
          false,
        );
        expect(
          vi.mocked(proxyApi.setProxyTakeoverForApp).mock
            .invocationCallOrder[0],
        ).toBeGreaterThan(
          vi.mocked(gatewayApi.materializeSupplierProvider).mock
            .invocationCallOrder[0],
        );
        expect(
          vi.mocked(proxyApi.setProxyTakeoverForApp).mock
            .invocationCallOrder[0],
        ).toBeLessThan(
          vi.mocked(providersApi.switch).mock.invocationCallOrder[0],
        );
      } else {
        expect(proxyApi.setProxyTakeoverForApp).not.toHaveBeenCalled();
      }
      await act(async () => finish());
      await waitFor(() =>
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
      );
      expect(gatewayApi.connectApp).not.toHaveBeenCalled();
    },
  );

  it("attaches an additive app through a gateway provider row", async () => {
    const additiveGroup = {
      ...routeGroup,
      appIds: [...routeGroup.appIds, "opencode"],
    };
    vi.mocked(gatewayApi.getCatalog).mockResolvedValue({
      ...sharedCatalog,
      groups: [additiveGroup],
    });
    vi.mocked(gatewayApi.getAppStatus).mockResolvedValue({
      appId: "opencode",
      attached: false,
      providerId: "phi-route-opencode",
      groupId: null,
      previousProviderId: null,
      ingress: "/opencode/v1",
    });
    mount(<RoutingOverviewPage />);
    const { user, dialog } = await openAppRoute("OpenCode");
    expect(
      within(dialog).getByRole("radio", {
        name: "gateway.connections.nativeTarget",
      }),
    ).toHaveAttribute("aria-checked", "true");
    await user.click(within(dialog).getByRole("radio", { name: "Production" }));
    await waitFor(() =>
      expect(gatewayApi.connectApp).toHaveBeenCalledWith(
        "opencode",
        "production",
        1,
      ),
    );
  });

  it("restores the previous configuration for an attached additive app", async () => {
    vi.mocked(gatewayApi.getCatalog).mockResolvedValue(sharedCatalog);
    vi.mocked(gatewayApi.getAppStatus).mockResolvedValue({
      appId: "mcode",
      attached: true,
      providerId: "phi-route-mcode",
      groupId: "production",
      previousProviderId: "my-own-provider",
      ingress: "/mcode/v1",
    });
    mount(<RoutingOverviewPage />);
    const { user, dialog } = await openAppRoute("MiniMax Code");
    await user.click(
      within(dialog).getByRole("radio", {
        name: "gateway.connections.nativeTarget",
      }),
    );
    await waitFor(() =>
      expect(gatewayApi.disconnectApp).toHaveBeenCalledWith("mcode"),
    );
    expect(gatewayApi.connectApp).not.toHaveBeenCalled();
  });

  it("maps a materialized supplier provider back to its pool option", async () => {
    vi.mocked(gatewayApi.getCatalog).mockResolvedValue(sharedCatalog);
    vi.mocked(proxyApi.getAppMode).mockResolvedValue({
      mode: "direct",
      attached: false,
      directProviderId: "gateway-supplier:shared",
      routeProviderId: null,
    });
    mount(<RoutingOverviewPage />);
    const { dialog } = await openAppRoute("Claude");
    const options = within(dialog).getAllByRole("radio", {
      name: "Shared provider",
    });
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveAttribute("aria-checked", "true");
    expect(options[0]).toBeEnabled();
  });

  it("does not switch providers when exiting proxy mode fails", async () => {
    vi.mocked(gatewayApi.getCatalog).mockResolvedValue(sharedCatalog);
    vi.mocked(proxyApi.setProxyTakeoverForApp).mockRejectedValue(
      new Error("exit failed"),
    );
    mount(<RoutingOverviewPage />);
    const { user, dialog } = await openAppRoute("Claude");
    await user.click(
      within(dialog).getByRole("radio", { name: "Shared provider" }),
    );
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "gateway.errors.generic",
    );
    expect(gatewayApi.materializeSupplierProvider).toHaveBeenCalledWith(
      "claude",
      "shared",
    );
    expect(providersApi.switch).not.toHaveBeenCalled();
  });

  it("connects an app to a route group from its node", async () => {
    const catalog: GatewayCatalog = {
      ...sharedCatalog,
      groups: [routeGroup, { ...routeGroup, id: "backup", name: "Backup" }],
      policies: [
        ...sharedCatalog.policies,
        {
          ...sharedCatalog.policies[0],
          id: "connection/claude",
          groupId: "production",
          candidates: [],
        },
      ],
    };
    vi.mocked(gatewayApi.getCatalog).mockResolvedValue(catalog);
    vi.mocked(proxyApi.getAppMode).mockResolvedValue({
      mode: "route",
      attached: true,
      directProviderId: null,
      routeProviderId: "gateway-entry:claude",
    });
    mount(<RoutingOverviewPage />);
    const { user, dialog } = await openAppRoute("Claude");
    expect(
      within(dialog).getByRole("radio", { name: "Production" }),
    ).toHaveAttribute("aria-checked", "true");
    await user.click(within(dialog).getByRole("radio", { name: "Backup" }));
    await waitFor(() =>
      expect(gatewayApi.connectApp).toHaveBeenCalledWith(
        "claude",
        "backup",
        catalog.revision,
      ),
    );
  });

  it("reconnects a detached application by selecting its saved group again", async () => {
    const catalog: GatewayCatalog = {
      ...sharedCatalog,
      groups: [routeGroup],
      policies: [
        ...sharedCatalog.policies,
        {
          ...sharedCatalog.policies[0],
          id: "connection/claude",
          groupId: "production",
          candidates: [],
        },
      ],
    };
    vi.mocked(gatewayApi.getCatalog).mockResolvedValue(catalog);
    vi.mocked(proxyApi.getAppMode).mockResolvedValue({
      mode: "route",
      attached: false,
      directProviderId: "direct",
      routeProviderId: "gateway-entry:claude",
    });
    mount(<RoutingOverviewPage />);
    const { user, dialog } = await openAppRoute("Claude");
    expect(
      within(dialog).getByRole("radio", { name: "Production" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(
      within(dialog).getAllByText("gateway.connections.reconnectGroup").length,
    ).toBeGreaterThan(0);
    await user.click(within(dialog).getByRole("radio", { name: "Production" }));
    await waitFor(() =>
      expect(gatewayApi.connectApp).toHaveBeenCalledWith(
        "claude",
        "production",
        catalog.revision,
      ),
    );
  });

  it.each(["disabled", "deleted"] as const)(
    "does not silently replace a %s group with a different route",
    async (kind) => {
      vi.mocked(gatewayApi.getCatalog).mockResolvedValue({
        ...sharedCatalog,
        groups: [
          ...(kind === "disabled" ? [{ ...routeGroup, enabled: false }] : []),
          { ...routeGroup, id: "backup", name: "Backup" },
        ],
        policies: [
          ...sharedCatalog.policies,
          {
            ...sharedCatalog.policies[0],
            id: "connection/claude",
            groupId: kind === "deleted" ? null : "production",
            enabled: kind !== "deleted",
            candidates: [],
          },
        ],
      });
      vi.mocked(proxyApi.getAppMode).mockResolvedValue({
        mode: "route",
        attached: true,
        directProviderId: "direct",
        routeProviderId: "gateway-entry:claude",
      });
      mount(<RoutingOverviewPage />);
      const { user, dialog } = await openAppRoute("Claude");
      expect(
        within(dialog).getByRole("radio", {
          name:
            kind === "deleted"
              ? "gateway.connections.unconfigured"
              : "gateway.connections.unavailableGroup",
        }),
      ).toBeDisabled();
      expect(gatewayApi.connectApp).not.toHaveBeenCalled();
      await user.click(within(dialog).getByRole("radio", { name: "Backup" }));
      await waitFor(() => expect(gatewayApi.connectApp).toHaveBeenCalled());
    },
  );

  it("offers compatible enabled groups without a generic proxy option", async () => {
    vi.mocked(gatewayApi.getCatalog).mockResolvedValue({
      ...sharedCatalog,
      groups: [
        routeGroup,
        {
          ...routeGroup,
          id: "gemini-only",
          name: "Gemini only",
          appIds: ["gemini"],
        },
        {
          ...routeGroup,
          id: "disabled",
          name: "Disabled group",
          enabled: false,
        },
      ],
    });
    mount(<RoutingOverviewPage />);
    const { dialog } = await openAppRoute("Codex");
    expect(
      within(dialog).getByRole("radio", { name: "Production" }),
    ).toBeEnabled();
    expect(
      within(dialog).queryByRole("radio", { name: "Gemini only" }),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).queryByRole("radio", { name: "Disabled group" }),
    ).not.toBeInTheDocument();
    expect(gatewayApi.connectApp).not.toHaveBeenCalled();
  });

  it("restores the native configuration from the app route dialog", async () => {
    vi.mocked(gatewayApi.getCatalog).mockResolvedValue({
      ...sharedCatalog,
      groups: [routeGroup],
      policies: [
        ...sharedCatalog.policies,
        {
          ...sharedCatalog.policies[0],
          id: "connection/claude",
          groupId: "production",
          candidates: [],
        },
      ],
    });
    vi.mocked(proxyApi.getAppMode).mockResolvedValue({
      mode: "direct",
      attached: false,
      directProviderId: null,
      routeProviderId: "gateway-entry:claude",
      directConfigured: true,
    });
    mount(<RoutingOverviewPage />);
    const { user, dialog } = await openAppRoute("Claude");
    const native = within(dialog).getByRole("radio", {
      name: "gateway.connections.nativeTarget",
    });
    expect(native).toHaveAttribute("aria-checked", "true");
    await user.click(native);
    await waitFor(() =>
      expect(proxyApi.setProxyTakeoverForApp).toHaveBeenCalledWith(
        "claude",
        false,
      ),
    );
    expect(gatewayApi.connectApp).not.toHaveBeenCalled();
  });

  it("isolates a failed app mode read and retries inside the dialog", async () => {
    vi.mocked(gatewayApi.getCatalog).mockResolvedValue({
      ...sharedCatalog,
      groups: [routeGroup],
    });
    vi.mocked(proxyApi.getAppMode)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({
        mode: "route",
        attached: true,
        directProviderId: null,
        routeProviderId: "gateway-entry:claude",
      });
    mount(<RoutingOverviewPage />);
    const { user, dialog } = await openAppRoute("Claude");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "gateway.loadError",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "gateway.retry" }),
    );
    expect(
      await within(dialog).findByRole("radio", { name: "Production" }),
    ).toBeInTheDocument();
  });

  it("creates, edits and deletes route groups from the flow column", async () => {
    vi.mocked(gatewayApi.getCatalog).mockResolvedValue({
      ...sharedCatalog,
      groups: [routeGroup],
    });
    mount(<RoutingOverviewPage />);
    const user = userEvent.setup();
    await screen.findByText("Production");
    await user.click(
      screen.getByRole("button", { name: "gateway.groups.editFor" }),
    );
    let dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText("gateway.pool.name")).toHaveValue(
      "Production",
    );
    await user.click(
      within(dialog).getByRole("button", {
        name: "gateway.groups.removeTitle",
      }),
    );
    dialog = await screen.findByRole("dialog");
    await user.click(
      within(dialog).getByRole("button", { name: "common.confirm" }),
    );
    await waitFor(() => expect(gatewayApi.saveCatalog).toHaveBeenCalled());
    expect(vi.mocked(gatewayApi.saveCatalog).mock.calls[0][0].groups).toEqual(
      [],
    );
    await user.click(
      await screen.findByRole("button", { name: "gateway.groups.new" }),
    );
    dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("gateway.groups.new")).toBeInTheDocument();
    await user.type(
      within(dialog).getByLabelText("gateway.pool.name"),
      "New group",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "gateway.groups.addMember" }),
    );
    await user.click(
      within(dialog).getByRole("button", { name: "gateway.save" }),
    );
    await waitFor(() =>
      expect(gatewayApi.saveCatalog).toHaveBeenCalledTimes(2),
    );
    expect(
      vi.mocked(gatewayApi.saveCatalog).mock.calls[1][0].groups,
    ).toMatchObject([
      {
        name: "New group",
        members: [{ supplierId: "shared", model: "model-a" }],
      },
    ]);
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("New group")).toBeInTheDocument();
  });
});

describe("gateway resource to request workflow", () => {
  it.each(["group"])(
    "blocks a stale %s draft after the catalog changes",
    async () => {
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const catalog = {
        ...sharedCatalog,
        policies: [sharedCatalog.policies[0]],
        groups: [routeGroup],
      };
      const editor = (next: GatewayCatalog) => (
        <QueryClientProvider client={client}>
          <GroupSection catalog={next} onOpenTraces={vi.fn()} />
        </QueryClientProvider>
      );
      const result = render(editor(catalog));
      const user = userEvent.setup();
      await user.click(
        screen.getByRole("button", { name: "gateway.policy.edit" }),
      );
      const dialog = screen.getByRole("dialog");
      const name = within(dialog).getByLabelText("gateway.pool.name", {
        selector: "input",
      });
      fireEvent.change(name, { target: { value: "Unsaved change" } });
      result.rerender(editor({ ...catalog, revision: catalog.revision + 1 }));
      expect(
        within(dialog).getByText("gateway.policy.staleEditor"),
      ).toBeInTheDocument();
      const save = within(dialog).getByRole("button", { name: "gateway.save" });
      expect(save).toBeDisabled();
      await user.click(save);
      expect(gatewayApi.saveCatalog).not.toHaveBeenCalled();
      expect(name).toHaveValue("Unsaved change");
    },
  );

  it.each(["supplier", "group"])(
    "keeps the %s editor locked until a pending save fails and then preserves edits",
    async (kind) => {
      let rejectSave!: (error: Error) => void;
      const pending = () =>
        new Promise<GatewayCatalog>((_, reject) => {
          rejectSave = reject;
        });
      vi.mocked(gatewayApi.updateSupplier).mockImplementation(pending);
      vi.mocked(gatewayApi.saveCatalog).mockImplementation(pending);
      const catalog = {
        ...sharedCatalog,
        policies: [sharedCatalog.policies[0]],
        groups: [routeGroup],
      };
      mount(
        kind === "supplier" ? (
          <ResourcePoolSection
            catalog={catalog}
            createOpen={false}
            onCreateOpenChange={vi.fn()}
          />
        ) : (
          <GroupSection catalog={catalog} onOpenTraces={vi.fn()} />
        ),
      );
      const user = userEvent.setup();
      await user.click(
        screen.getByRole("button", {
          name:
            kind === "supplier" ? "gateway.pool.edit" : "gateway.policy.edit",
        }),
      );
      const dialog = screen.getByRole("dialog");
      const name = within(dialog).getByLabelText("gateway.pool.name", {
        selector: "input",
      });
      fireEvent.change(name, { target: { value: "Keep this draft" } });
      await user.click(
        within(dialog).getByRole("button", { name: "gateway.save" }),
      );
      const cancel = within(dialog).getByRole("button", {
        name: "gateway.cancel",
      });
      await waitFor(() => expect(cancel).toBeDisabled());
      expect(name).toBeDisabled();
      const choice = within(dialog).getAllByRole("combobox")[0];
      // Select opens on pointerdown; native fieldset disabling alone is insufficient.
      fireEvent.pointerDown(choice, { button: 0, pointerType: "mouse" });
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
      await user.click(cancel);
      await user.keyboard("{Escape}");
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      const api =
        kind === "supplier"
          ? gatewayApi.updateSupplier
          : gatewayApi.saveCatalog;
      expect(api).toHaveBeenCalledOnce();
      await act(async () => rejectSave(new Error("save failed")));
      await waitFor(() => expect(cancel).toBeEnabled());
      expect(name).toHaveValue("Keep this draft");
      expect(name).toBeEnabled();
    },
  );

  it("discovers models using the stored supplier and merges selected models without removing existing ones", async () => {
    vi.mocked(gatewayApi.getCatalog).mockResolvedValue(sharedCatalog);
    vi.mocked(gatewayApi.fetchModels).mockResolvedValue([
      "model-a",
      "model-b",
      "model-c",
    ]);
    vi.mocked(gatewayApi.updateSupplier).mockResolvedValue(sharedCatalog);
    mount(<ProviderCatalogPage />);
    fireEvent.click(
      await screen.findByRole("button", { name: "gateway.pool.edit" }),
    );
    const dialog = screen.getByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "gateway.pool.discoverModels",
      }),
    );
    const model = await within(dialog).findByRole("checkbox", {
      name: "model-b",
    });
    expect(gatewayApi.fetchModels).toHaveBeenCalledWith("shared");
    expect(
      within(dialog).getByRole("checkbox", { name: "model-a" }),
    ).toBeDisabled();
    fireEvent.click(model);
    fireEvent.click(
      within(dialog).getByRole("button", { name: "gateway.pool.mergeModels" }),
    );
    expect(within(dialog).getByLabelText("gateway.pool.models")).toHaveValue(
      "model-a, model-b",
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "gateway.save" }),
    );
    await waitFor(() =>
      expect(gatewayApi.updateSupplier).toHaveBeenCalledWith(
        "shared",
        expect.objectContaining({
          revision: 1,
          models: ["model-a", "model-b"],
        }),
      ),
    );
    expect(
      vi.mocked(gatewayApi.updateSupplier).mock.calls[0][1],
    ).not.toHaveProperty("apiKey");
  });

  it("links a supplier to its policy and searches across supplier model names", async () => {
    const open = vi.fn();
    vi.mocked(gatewayApi.getCatalog).mockResolvedValue(sharedCatalog);
    mount(<ProviderCatalogPage onOpenPolicy={open} />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "gateway.pool.showReferences",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Claude · claude" }));
    expect(open).toHaveBeenCalledWith("claude");
    fireEvent.change(
      screen.getByRole("textbox", { name: "gateway.pool.search" }),
      { target: { value: "absent" } },
    );
    expect(screen.queryByText("Shared provider")).not.toBeInTheDocument();
    fireEvent.change(
      screen.getByRole("textbox", { name: "gateway.pool.search" }),
      { target: { value: "model-a" } },
    );
    expect(screen.getByText("Shared provider")).toBeInTheDocument();
  });

  it("shows historical names, individual failures, usage and a link to the current policy", async () => {
    const open = vi.fn();
    vi.mocked(gatewayApi.getCatalog).mockResolvedValue(sharedCatalog);
    vi.mocked(gatewayApi.getTraces).mockResolvedValue([
      {
        id: "request",
        createdAt: Date.now(),
        appId: "claude",
        requestModel: "client-model",
        catalogRevision: 1,
        policy: sharedCatalog.policies[0],
        events: [
          {
            supplierId: "shared",
            supplierName: "Name at request time",
            model: "model-a",
            outcome: "rate_limit",
          },
          {
            supplierId: "deleted",
            supplierName: "Deleted supplier",
            model: "model-b",
            outcome: "upstream_accepted",
          },
        ],
        outcome: "completed",
        latencyMs: 40,
        inputTokens: 15,
        outputTokens: 6,
        estimatedCost: "0.00003",
      },
    ]);
    mount(<RoutingStatus catalog={sharedCatalog} onOpenPolicy={open} />);
    const history = within(
      await screen.findByRole("region", { name: "gateway.trace.title" }),
    );
    expect(await history.findByText("Deleted supplier")).toBeInTheDocument();
    expect(screen.queryByText("Shared provider")).not.toBeInTheDocument();
    expect(
      history.getByText("gateway.trace.outcomes.completed"),
    ).toBeInTheDocument();
    expect(screen.getByText("15 / 6")).toBeInTheDocument();
    expect(screen.getByText("$0.00003")).toBeInTheDocument();
    // 详情入口移入展开区：先展开行
    fireEvent.click(
      screen.getByRole("button", { name: "gateway.trace.routingProcess" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "gateway.decisions.details" }),
    );
    const detail = screen.getByRole("dialog");
    expect(
      within(detail).getByText(/Name at request time/),
    ).toBeInTheDocument();
    expect(
      within(detail).getByText("gateway.trace.outcomes.rate_limit"),
    ).toBeInTheDocument();
    fireEvent.click(
      within(detail).getByRole("button", { name: "common.close" }),
    );
    const policy = screen.getByRole("button", { name: "claude" });
    await waitFor(() => expect(policy).toBeEnabled());
    fireEvent.click(policy);
    expect(open).toHaveBeenCalledWith("claude");
  });
});

const routeGroup: GatewayRouteGroup = {
  id: "production",
  name: "Production",
  enabled: true,
  appIds: ["claude", "codex"],
  strategy: "weighted",
  members: [
    {
      id: "primary",
      supplierId: "shared",
      model: "model-a",
      enabled: true,
      weight: 3,
    },
  ],
  sessionAffinity: true,
  affinityTtlSeconds: 1800,
  failover: true,
  maxAttempts: 3,
  streamingFirstByteTimeout: 60,
  streamingIdleTimeout: 120,
  nonStreamingTimeout: 600,
  classifier: { supplierId: "shared", model: "model-a" },
  rules: [
    {
      id: "code",
      name: "Code tasks",
      description: "Implement code",
      enabled: true,
      memberId: "primary",
    },
  ],
};

describe("route groups and routing data", () => {
  it("keeps group filtering without routing tabs", async () => {
    const user = userEvent.setup();
    const catalog = { ...sharedCatalog, groups: [routeGroup] };
    vi.mocked(gatewayApi.getCatalog).mockResolvedValue(catalog);
    vi.mocked(gatewayApi.getTraces).mockResolvedValue([
      {
        id: "linked-request",
        createdAt: Date.now(),
        appId: "claude",
        requestModel: "model-a",
        catalogRevision: 1,
        policy: catalog.policies[0],
        events: [],
        outcome: "completed",
        latencyMs: 100,
        inputTokens: null,
        outputTokens: null,
        estimatedCost: null,
      },
    ]);
    mount(<RoutingOverviewPage />);
    expect(
      await screen.findByRole("region", { name: "gateway.flow.title" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    // 筛选收进弹层：默认只露出入口，打开后才能选择路由组。
    await user.click(
      screen.getByRole("button", { name: /gateway.routingStatus.filter/ }),
    );
    expect(
      screen.getAllByRole("combobox", { name: "gateway.routingStatus.window" }),
    ).toHaveLength(1);
    expect(screen.getAllByText("gateway.routingStatus.requests")).toHaveLength(
      1,
    );
    expect(
      screen.getAllByRole("button", { name: "gateway.trace.refresh" }),
    ).toHaveLength(1);
    await user.click(
      screen.getByRole("combobox", { name: "gateway.groups.group" }),
    );
    await user.click(screen.getByRole("option", { name: "Production" }));
    await waitFor(() =>
      expect(gatewayApi.getTracePage).toHaveBeenLastCalledWith(
        expect.objectContaining({ groupId: "production", offset: 0 }),
      ),
    );
    await user.click(
      screen.getByRole("button", { name: "gateway.trace.clearFilter" }),
    );
    await waitFor(() =>
      expect(gatewayApi.getTracePage).toHaveBeenLastCalledWith({
        since: expect.any(Number),
        offset: 0,
      }),
    );
  });

  it("shares pagination and filters while keeping runtime details available", async () => {
    const user = userEvent.setup();
    const base = await gatewayApi.getTracePage({});
    vi.mocked(gatewayApi.getTracePage)
      .mockReset()
      .mockResolvedValue({
        ...base,
        total: 75,
        traces: [
          {
            id: "request",
            createdAt: Date.now(),
            appId: "claude",
            catalogRevision: 1,
            policy: sharedCatalog.policies[0],
            events: [
              {
                supplierId: "shared",
                supplierName: "Shared provider",
                model: "model-a",
                outcome: "rate_limit",
              },
              {
                supplierId: "deleted",
                supplierName: "Deleted supplier",
                model: "model-b",
                outcome: "upstream_accepted",
              },
            ],
            outcome: "completed",
            latencyMs: 40,
            inputTokens: null,
            outputTokens: null,
            estimatedCost: null,
          },
        ],
        members: [
          {
            supplierId: "shared",
            model: "model-a",
            active: 0,
            requests: 2,
            successes: 1,
            failures: 1,
            recentTokens: 0,
            unknownUsage: 0,
            cooldownUntil: null,
            lastError: null,
            lastLatencyMs: null,
            lastUsedAt: null,
          },
        ],
      });
    mount(
      <RoutingStatus
        catalog={{
          ...sharedCatalog,
          policies: [{ ...sharedCatalog.policies[0], groupId: "parent" }],
          groups: [
            routeGroup,
            {
              ...routeGroup,
              id: "parent",
              name: "Parent group",
              members: [
                {
                  id: "nested",
                  groupId: "production",
                  model: "",
                  enabled: true,
                  weight: 1,
                },
              ],
            },
          ],
        }}
        groupId="production"
        policyId="claude"
      />,
    );
    await user.click(
      await screen.findByRole("button", { name: "gateway.decisions.next" }),
    );
    await waitFor(() =>
      expect(gatewayApi.getTracePage).toHaveBeenLastCalledWith(
        expect.objectContaining({ groupId: "production", offset: 50 }),
      ),
    );
    await user.click(
      screen.getByRole("button", { name: /gateway.routingStatus.filter/ }),
    );
    await user.click(
      screen.getByRole("combobox", { name: "gateway.trace.outcome" }),
    );
    await user.click(
      screen.getByRole("option", { name: "gateway.trace.outcomes.rate_limit" }),
    );
    await waitFor(() =>
      expect(gatewayApi.getTracePage).toHaveBeenLastCalledWith(
        expect.objectContaining({
          groupId: "production",
          outcome: "rate_limit",
          offset: 0,
        }),
      ),
    );
    expect(screen.getAllByText("gateway.routingStatus.requests")).toHaveLength(
      1,
    );
    expect(
      screen.getByRole("button", { name: "gateway.decisions.previous" }),
    ).toBeDisabled();
    await user.click(
      await screen.findByRole("button", {
        name: "gateway.trace.routingProcess",
      }),
    );
    expect(
      screen.getByText("gateway.trace.routingProcess"),
    ).toBeInTheDocument();
    expect(screen.getByText("gateway.trace.outletStatus")).toBeInTheDocument();
    expect(screen.getAllByText("Shared provider").length).toBeGreaterThan(0);
    expect(screen.getAllByText("gateway.routingStatus.ready")).toHaveLength(2);
    expect(
      screen.getAllByText("gateway.trace.outcomes.rate_limit").length,
    ).toBeGreaterThan(0);
  });

  it("shows one logging notice and recovers a shared data error with refresh", async () => {
    const user = userEvent.setup();
    const page = await gatewayApi.getTracePage({});
    vi.mocked(gatewayApi.getTracePage)
      .mockReset()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(page);
    vi.mocked(proxyApi.getGlobalProxyConfig).mockResolvedValueOnce({
      listenAddress: "127.0.0.1",
      listenPort: 15821,
      enableLogging: false,
    } as Awaited<ReturnType<typeof proxyApi.getGlobalProxyConfig>>);
    mount(<RoutingStatus catalog={sharedCatalog} />);
    expect(
      await screen.findByText("gateway.errors.generic"),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText("gateway.routingStatus.loggingOff"),
    ).toHaveLength(1);
    await user.click(
      screen.getByRole("button", { name: "gateway.trace.refresh" }),
    );
    expect(
      await screen.findByRole("heading", { name: "gateway.trace.title" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("gateway.errors.generic"),
    ).not.toBeInTheDocument();
  });

  it("creates a group using pool members and preserves the catalog revision", async () => {
    const user = userEvent.setup();
    mount(<GroupSection catalog={sharedCatalog} onOpenTraces={vi.fn()} />);
    await user.click(
      screen.getByRole("button", { name: "gateway.groups.new" }),
    );
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).queryByText("gateway.groups.apps"),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).queryByRole("button", { name: "gateway.groups.addRule" }),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).queryByRole("button", {
        name: "gateway.groups.existingIntent",
      }),
    ).not.toBeInTheDocument();
    await user.click(
      within(dialog).getByRole("combobox", { name: "gateway.groups.strategy" }),
    );
    expect(
      screen.queryByRole("option", {
        name: "gateway.groups.strategies.manual",
      }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(4);
    await user.keyboard("{Escape}");
    await user.type(
      within(dialog).getByLabelText("gateway.pool.name"),
      "My group",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "gateway.groups.addMember" }),
    );
    await user.click(
      within(dialog).getByRole("button", { name: "gateway.save" }),
    );
    await waitFor(() => expect(gatewayApi.saveCatalog).toHaveBeenCalled());
    expect(vi.mocked(gatewayApi.saveCatalog).mock.calls[0][0]).toMatchObject({
      revision: 1,
      groups: [
        {
          name: "My group",
          appIds: [
            "claude",
            "claude-desktop",
            "codex",
            "grokbuild",
            "opencode",
            "openclaw",
            "hermes",
            "pi",
            "mcode",
            "commandcode",
            "crush",
            "droid",
            "kimi",
            "atomcode",
            "omo",
          ],
          strategy: "ordered",
          members: [{ supplierId: "shared", model: "model-a" }],
        },
      ],
    });
  });
  it("edits strategy, weight and ordered intent rules without losing their member references", async () => {
    const user = userEvent.setup();
    mount(
      <GroupSection
        catalog={{ ...sharedCatalog, groups: [routeGroup] }}
        onOpenTraces={vi.fn()}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "gateway.policy.edit" }),
    );
    const dialog = screen.getByRole("dialog");
    fireEvent.change(
      within(dialog).getByRole("spinbutton", { name: "gateway.groups.weight" }),
      { target: { value: "7" } },
    );
    await user.click(
      within(dialog).getByRole("button", {
        name: "gateway.groups.existingIntent",
      }),
    );
    await user.clear(
      within(dialog).getByLabelText("gateway.groups.ruleDescription"),
    );
    await user.type(
      within(dialog).getByLabelText("gateway.groups.ruleDescription"),
      "Fix failing tests",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "gateway.save" }),
    );
    await waitFor(() => expect(gatewayApi.saveCatalog).toHaveBeenCalled());
    const saved = vi.mocked(gatewayApi.saveCatalog).mock.calls[0][0].groups![0];
    expect(saved.members[0].weight).toBe(7);
    expect(saved.rules[0]).toMatchObject({
      memberId: "primary",
      description: "Fix failing tests",
    });
    expect(saved.classifier).toEqual(routeGroup.classifier);
  });
  it("infers compatible applications from endpoints and nested group scopes", () => {
    const catalog = {
      ...sharedCatalog,
      suppliers: [
        ...sharedCatalog.suppliers,
        {
          ...sharedCatalog.suppliers[0],
          id: "gemini",
          endpoint: {
            protocol: "gemini_native",
            baseUrl: "https://gemini.example",
          },
        },
      ],
      groups: [routeGroup],
    };
    // Chat 入口的应用也接得住 Chat 成员（非 Chat 成员由网关转换）。
    expect(inferGroupApps(routeGroup, catalog)).toEqual([
      "claude",
      "claude-desktop",
      "codex",
      "grokbuild",
      "opencode",
      "openclaw",
      "hermes",
      "pi",
      "mcode",
      "commandcode",
      "crush",
      "droid",
      "kimi",
      "atomcode",
      "omo",
    ]);
    const geminiGroup = {
      ...routeGroup,
      members: [{ ...routeGroup.members[0], supplierId: "gemini" }],
    };
    expect(inferGroupApps(geminiGroup, catalog)).toEqual([
      "claude",
      "claude-desktop",
      "gemini",
    ]);
    expect(
      inferGroupApps(
        {
          ...geminiGroup,
          members: [
            ...geminiGroup.members,
            {
              id: "nested",
              groupId: "production",
              model: "",
              enabled: true,
              weight: 1,
            },
          ],
        },
        catalog,
      ),
    ).toEqual(["claude"]);
    expect(
      inferGroupApps(
        {
          ...routeGroup,
          members: [{ ...routeGroup.members[0], supplierId: "missing" }],
        },
        catalog,
      ),
    ).toEqual([]);
  });

  it("preserves legacy manual selection and disabled members when editing a group", async () => {
    const user = userEvent.setup();
    const legacy: GatewayRouteGroup = {
      ...routeGroup,
      strategy: "manual",
      manualMemberId: "primary",
      members: [
        ...routeGroup.members,
        { ...routeGroup.members[0], id: "off", enabled: false },
      ],
    };
    mount(
      <GroupSection
        catalog={{ ...sharedCatalog, groups: [legacy] }}
        onOpenTraces={vi.fn()}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "gateway.policy.edit" }),
    );
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByRole("combobox", { name: "gateway.groups.strategy" }),
    ).toHaveTextContent("gateway.groups.legacyManualLabel");
    expect(
      within(dialog).queryByRole("switch", {
        name: /gateway.groups.memberEnabled/,
      }),
    ).not.toBeInTheDocument();
    expect(within(dialog).getByText("gateway.groups.off")).toBeInTheDocument();
    expect(
      within(dialog).queryByRole("button", { name: "gateway.policy.moveUp" }),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).queryByRole("button", { name: "gateway.policy.moveDown" }),
    ).not.toBeInTheDocument();
    await user.click(
      within(dialog).getByRole("button", { name: "gateway.save" }),
    );
    await waitFor(() => expect(gatewayApi.saveCatalog).toHaveBeenCalled());
    const saved = vi.mocked(gatewayApi.saveCatalog).mock.calls[0][0].groups![0];
    expect(saved.strategy).toBe("manual");
    expect(saved.manualMemberId).toBe("primary");
    expect(saved.members).toEqual(legacy.members);
    expect(saved.rules).toEqual(legacy.rules);
    expect(saved.classifier).toEqual(legacy.classifier);
  });

  it("removes member rule references with the icon button", async () => {
    const user = userEvent.setup();
    const group = {
      ...routeGroup,
      members: [
        ...routeGroup.members,
        { ...routeGroup.members[0], id: "second" },
      ],
    };
    mount(
      <GroupSection
        catalog={{ ...sharedCatalog, groups: [group] }}
        onOpenTraces={vi.fn()}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "gateway.policy.edit" }),
    );
    const dialog = screen.getByRole("dialog");
    const remove = within(dialog).getAllByRole("button", {
      name: "gateway.groups.removeMember",
    })[0];
    expect(remove).toHaveTextContent("");
    await user.click(remove);
    await user.click(
      within(dialog).getByRole("button", { name: "gateway.save" }),
    );
    await waitFor(() => expect(gatewayApi.saveCatalog).toHaveBeenCalled());
    const saved = vi.mocked(gatewayApi.saveCatalog).mock.calls[0][0].groups![0];
    expect(saved.members.map((m) => m.id)).toEqual(["second"]);
    expect(saved.rules).toEqual([]);
  });

  it("blocks a member change that would break an existing policy", async () => {
    const user = userEvent.setup();
    const catalog = {
      ...sharedCatalog,
      suppliers: [
        ...sharedCatalog.suppliers,
        {
          ...sharedCatalog.suppliers[0],
          id: "gemini",
          name: "Gemini supplier",
          endpoint: {
            protocol: "gemini_native",
            baseUrl: "https://gemini.example",
          },
        },
      ],
      groups: [routeGroup],
      policies: [
        { ...sharedCatalog.policies[1], groupId: "production", candidates: [] },
      ],
    };
    mount(<GroupSection catalog={catalog} onOpenTraces={vi.fn()} />);
    await user.click(
      screen.getByRole("button", { name: "gateway.policy.edit" }),
    );
    const dialog = screen.getByRole("dialog");
    await user.click(
      within(dialog).getByRole("combobox", { name: "gateway.groups.target" }),
    );
    await user.click(screen.getByRole("option", { name: "Gemini supplier" }));
    await user.click(
      within(dialog).getByRole("button", { name: "gateway.save" }),
    );
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "gateway.groups.incompatibleReference",
    );
    expect(gatewayApi.saveCatalog).not.toHaveBeenCalled();
  });

  it("reorders members with the keyboard and saves stable member references", async () => {
    const user = userEvent.setup();
    const group = {
      ...routeGroup,
      members: [
        ...routeGroup.members,
        { ...routeGroup.members[0], id: "second", model: "model-b" },
      ],
    };
    const catalog = {
      ...sharedCatalog,
      suppliers: [
        { ...sharedCatalog.suppliers[0], models: ["model-a", "model-b"] },
      ],
      groups: [group],
    };
    const rect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        const item = this.closest("li");
        const index = item
          ? Array.from(item.parentElement!.children).indexOf(item)
          : 0;
        const top = index * 80;
        return {
          x: 0,
          y: top,
          top,
          bottom: top + 60,
          left: 0,
          right: 600,
          width: 600,
          height: 60,
          toJSON: () => ({}),
        };
      });
    try {
      mount(<GroupSection catalog={catalog} onOpenTraces={vi.fn()} />);
      await user.click(
        screen.getByRole("button", { name: "gateway.policy.edit" }),
      );
      const dialog = screen.getByRole("dialog");
      const list = within(dialog).getByRole("list", {
        name: "gateway.groups.members",
      });
      const handle = within(list).getAllByRole("button", {
        name: "gateway.groups.dragItem",
      })[0];
      handle.focus();
      await user.keyboard(" ");
      await user.keyboard("{ArrowDown}");
      await user.keyboard(" ");
      await user.click(
        within(dialog).getByRole("button", { name: "gateway.save" }),
      );
      await waitFor(() => expect(gatewayApi.saveCatalog).toHaveBeenCalled());
      const saved = vi.mocked(gatewayApi.saveCatalog).mock.calls[0][0]
        .groups![0];
      expect(saved.members.map((m) => m.id)).toEqual(["second", "primary"]);
      expect(saved.rules[0].memberId).toBe("primary");
    } finally {
      rect.mockRestore();
    }
  });

  it("supplier and group removal clean classifier rules and empty ancestors", () => {
    const parent: GatewayRouteGroup = {
      ...routeGroup,
      id: "parent",
      classifier: null,
      rules: [],
      members: [
        {
          id: "nested",
          groupId: "production",
          model: "",
          enabled: true,
          weight: 1,
        },
      ],
    };
    const c = { ...sharedCatalog, groups: [routeGroup, parent] };
    const removed = catalogWithoutSupplier(c, "shared");
    expect(removed.groups!.every((g) => !g.enabled)).toBe(true);
    expect(removed.groups![0].classifier).toBeNull();
    expect(removed.groups![0].rules).toEqual([]);
    expect(c.groups[0].enabled).toBe(true);
    const noGroup = catalogWithoutGroup(c, "production");
    expect(noGroup.groups![0]).toMatchObject({
      id: "parent",
      enabled: false,
      members: [],
    });
  });
  it("sends group filters to the backend and opens the historical decision snapshot", async () => {
    const user = userEvent.setup();
    vi.mocked(gatewayApi.getCatalog).mockResolvedValue({
      ...sharedCatalog,
      groups: [routeGroup],
    });
    vi.mocked(gatewayApi.getTraces).mockResolvedValue([
      {
        id: "group-request",
        createdAt: Date.now(),
        appId: "claude",
        requestModel: "alias",
        catalogRevision: 3,
        policy: sharedCatalog.policies[0],
        events: [],
        outcome: "completed",
        latencyMs: 100,
        inputTokens: null,
        outputTokens: null,
        estimatedCost: null,
        decision: {
          reason: "group",
          groupId: "production",
          affinity: "hit",
          groups: [{ ...routeGroup, name: "Name in snapshot" }],
          candidates: [
            {
              supplierId: "shared",
              supplierName: "Old supplier name",
              model: "model-a",
              groupPath: ["production"],
              memberPath: ["primary"],
              reason: "intent",
              available: true,
              recentTokens: 30,
              active: 1,
              cooldownUntil: null,
            },
          ],
          intents: [
            {
              groupId: "production",
              outcome: "matched",
              ruleId: "code",
              ruleName: "Old rule",
              supplierId: "shared",
              model: "model-a",
              latencyMs: 12,
              inputTokens: 2,
              outputTokens: 3,
              estimatedCost: "0.001",
              cached: false,
            },
          ],
        },
      },
    ]);
    mount(
      <RoutingStatus
        catalog={{ ...sharedCatalog, groups: [routeGroup] }}
        groupId="production"
      />,
    );
    await waitFor(() =>
      expect(gatewayApi.getTracePage).toHaveBeenCalledWith(
        expect.objectContaining({ groupId: "production", offset: 0 }),
      ),
    );
    await user.click(
      await screen.findByRole("button", {
        name: "gateway.trace.routingProcess",
      }),
    );
    await user.click(
      screen.getByRole("button", { name: "gateway.decisions.details" }),
    );
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Old rule")).toBeInTheDocument();
    expect(
      within(dialog).getByText("Old supplier name → model-a"),
    ).toBeInTheDocument();
    expect(
      within(dialog).getAllByText(/Name in snapshot/).length,
    ).toBeGreaterThan(0);
    expect(within(dialog).queryByText("Production")).not.toBeInTheDocument();
  });
});
