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
  catalogWithoutGroup,
  inferGroupApps,
} from "@/components/gateway/GroupSection";
import { catalogWithoutSupplier } from "@/components/gateway/useGatewayCatalog";
import type { GatewayRouteGroup } from "@/lib/api/gateway";
import { ResourcePoolSection } from "@/components/gateway/ResourcePoolSection";
import { RoutingStatus } from "@/components/gateway/RoutingStatus";
import type { GatewayCatalog } from "@/lib/api";
import { gatewayApi, providersApi } from "@/lib/api";
import { proxyApi } from "@/lib/api/proxy";
import { piApi } from "@/lib/api/pi";
import { APP_IDS, PROXY_APP_IDS, getAppLabel } from "@/config/appConfig";
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
  vi.mocked(proxyApi.setProxyTakeoverForApp)
    .mockReset()
    .mockResolvedValue(undefined);
  vi.mocked(gatewayApi.previewRoute).mockReset();
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
    expect(parseView("openclawEnv")).toBe("openclawConfig");
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
    const row = (await screen.findByText("Shared provider")).closest("tr")!;
    expect(screen.getAllByText("Shared provider")).toHaveLength(1);
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
  it.each(["opencode", "openclaw", "hermes", "pi", "mcode"] as const)(
    "shows live %s targets and opens its adapter without invoking proxy takeover",
    async (app) => {
      const open = vi.fn();
      vi.mocked(providersApi.getAll).mockImplementation(async (id) =>
        id === app
          ? {
              live: {
                id: "live",
                name: "Configured supplier",
                settingsConfig: {},
                meta: { liveConfigManaged: true },
              },
              saved: {
                id: "saved",
                name: "Saved only",
                settingsConfig: {},
                meta: { liveConfigManaged: false },
              },
              ...(app === "mcode"
                ? {
                    external: {
                      id: "external",
                      name: "external",
                      settingsConfig: {},
                      meta: { liveConfigManaged: true },
                    },
                  }
                : {}),
            }
          : {},
      );
      vi.mocked(providersApi.getOpenCodeLiveProviderIds).mockResolvedValue([
        "live",
        "external",
      ]);
      vi.mocked(providersApi.getOpenClawLiveProviderIds).mockResolvedValue([
        "live",
        "external",
      ]);
      vi.mocked(providersApi.getHermesLiveProviderIds).mockResolvedValue([
        "live",
        "external",
      ]);
      vi.mocked(piApi.getCurrentState).mockResolvedValue({
        enabledProviderIds: ["live", "external"],
        defaultProviderId: "live",
      });
      mount(<RoutingOverviewPage onOpenApp={open} />);
      const row = (await screen.findByText(getAppLabel(app))).closest("tr")!;
      expect(
        await within(row).findByText("Configured supplier、external"),
      ).toBeInTheDocument();
      expect(within(row).queryByText("Saved only")).not.toBeInTheDocument();
      expect(
        within(row).getByText("gateway.connections.appManaged"),
      ).toBeInTheDocument();
      expect(within(row).queryByRole("combobox")).not.toBeInTheDocument();
      fireEvent.click(
        within(row).getByRole("button", { name: "gateway.configure" }),
      );
      expect(open).toHaveBeenCalledWith(app);
      expect(proxyApi.getAppMode).not.toHaveBeenCalledWith(app);
      expect(proxyApi.setProxyTakeoverForApp).not.toHaveBeenCalled();
      expect(gatewayApi.connectApp).not.toHaveBeenCalled();
    },
  );

  it("shows Claude Desktop's independent proxy status and flags an incomplete connection", async () => {
    vi.mocked(providersApi.getCurrent).mockResolvedValue("desktop");
    vi.mocked(providersApi.getAll).mockResolvedValue({
      desktop: { id: "desktop", name: "Desktop route", settingsConfig: {} },
    });
    vi.mocked(providersApi.getClaudeDesktopStatus).mockResolvedValue({
      supported: true,
      configured: true,
      appliedId: "00000000-0000-4000-8000-000000157210",
      mode: "proxy",
      proxyRunning: true,
      expectedBaseUrl: "http://127.0.0.1:15821/claude-desktop",
      actualBaseUrl: "https://external.example",
      staleRawModels: false,
      missingRouteMappings: false,
      gatewayTokenConfigured: true,
    });
    const open = vi.fn();
    mount(<RoutingOverviewPage onOpenApp={open} />);
    const row = (await screen.findByText("Claude Desktop")).closest("tr")!;
    expect(await within(row).findByText("Desktop route")).toBeInTheDocument();
    expect(
      within(row).getByText("gateway.connections.proxy"),
    ).toBeInTheDocument();
    expect(
      within(row).getByText("gateway.connections.needsReconnect"),
    ).toBeInTheDocument();
    expect(within(row).queryByRole("combobox")).not.toBeInTheDocument();
    fireEvent.click(
      within(row).getByRole("button", { name: "gateway.configure" }),
    );
    expect(open).toHaveBeenCalledWith("claude-desktop");
    expect(proxyApi.getAppMode).not.toHaveBeenCalledWith("claude-desktop");
  });

  it("isolates an unreadable native config and retries without claiming a configured target", async () => {
    vi.mocked(providersApi.getOpenCodeLiveProviderIds)
      .mockRejectedValueOnce(new Error("invalid config"))
      .mockResolvedValue(["recovered"]);
    mount(<RoutingOverviewPage onOpenApp={vi.fn()} />);
    const row = (await screen.findByText("OpenCode")).closest("tr")!;
    expect(await within(row).findByRole("alert")).toHaveTextContent(
      "gateway.loadError",
    );
    expect(
      within(row).queryByText("gateway.connections.appManaged"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Pi")).toBeInTheDocument();
    fireEvent.click(within(row).getByRole("button", { name: "gateway.retry" }));
    expect(await within(row).findByText("recovered")).toBeInTheDocument();
    expect(within(row).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows all managed apps without the removed gateway details or manual token panel", async () => {
    vi.mocked(proxyApi.getProxyStatus).mockResolvedValue({
      running: true,
      address: "127.0.0.1",
      port: 15821,
    } as Awaited<ReturnType<typeof proxyApi.getProxyStatus>>);
    mount(<RoutingOverviewPage onOpenApp={vi.fn()} />);
    await screen.findByText("OpenClaw");
    const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(
      rows.map((row) => within(row).getAllByRole("cell")[0].textContent),
    ).toEqual(APP_IDS.map(getAppLabel));
    expect(screen.queryByText("127.0.0.1:15821")).not.toBeInTheDocument();
    expect(
      screen.queryByText("gateway.routingDescription"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("gateway.connections.alwaysOn"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("gateway.connections.settings"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("access.advanced")).not.toBeInTheDocument();
    expect(screen.queryByText("access.create")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "gateway.connections.start" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "gateway.connections.stop" }),
    ).not.toBeInTheDocument();
    expect(proxyApi.startProxyServer).not.toHaveBeenCalled();
    expect(proxyApi.stopProxyWithRestore).not.toHaveBeenCalled();
  });

  it("uses one connection column and shows gateway availability once", async () => {
    const open = vi.fn();
    mount(<RoutingOverviewPage onOpenApp={open} />);
    await waitFor(() =>
      expect(screen.getAllByRole("combobox")).toHaveLength(4),
    );
    expect(
      screen.getAllByRole("columnheader").map((cell) => cell.textContent),
    ).toEqual([
      "gateway.agent",
      "gateway.target",
      "gateway.connections.method",
    ]);
    expect(screen.getAllByText("gateway.stopped")).toHaveLength(1);
    expect(
      screen.queryByText("gateway.connection.stopped"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("OpenClaw")).toBeInTheDocument();
    const row = screen.getByText("Codex").closest("tr")!;
    expect(within(row).getByRole("combobox")).toHaveTextContent(
      "gateway.connections.legacy",
    );
    fireEvent.click(
      within(row).getByRole("button", { name: "gateway.configure" }),
    );
    expect(open).toHaveBeenCalledWith("codex");
    expect(
      screen.queryByRole("button", { name: "gateway.connections.connect" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "gateway.connections.disconnect" }),
    ).not.toBeInTheDocument();
  });

  it("preserves the configured connection and reports a failed gateway read globally", async () => {
    vi.mocked(proxyApi.getProxyStatus).mockRejectedValue(new Error("offline"));
    vi.mocked(proxyApi.getAppMode).mockImplementation(async (app) => ({
      mode: app === "codex" ? "direct" : "route",
      attached: true,
      directProviderId: "direct-id",
      routeProviderId: "route-id",
    }));
    mount(<RoutingOverviewPage onOpenApp={vi.fn()} />);
    expect(await screen.findByText("direct-id")).toBeInTheDocument();
    const row = screen.getByText("Codex").closest("tr")!;
    expect(within(row).getByRole("combobox")).toHaveTextContent(
      "gateway.connections.direct",
    );
    expect(screen.getByRole("alert")).toHaveTextContent("gateway.statusError");
    expect(screen.queryByText("gateway.stopped")).not.toBeInTheDocument();
  });

  it("distinguishes native configurations from unconfigured apps and opens their configuration", async () => {
    const open = vi.fn();
    vi.mocked(proxyApi.getAppMode).mockImplementation(async (app) => ({
      mode: "direct",
      attached: false,
      directProviderId: null,
      routeProviderId: null,
      directConfigured: app === "claude",
    }));
    mount(<RoutingOverviewPage onOpenApp={open} />);
    expect(
      await screen.findByText("gateway.connections.nativeTarget"),
    ).toBeInTheDocument();
    const claude = screen.getByText("Claude").closest("tr")!;
    expect(within(claude).getByRole("combobox")).toHaveTextContent(
      "gateway.connections.direct",
    );
    const codex = screen.getByText("Codex").closest("tr")!;
    expect(within(codex).getByRole("combobox")).toHaveTextContent(
      "gateway.connections.unconfigured",
    );
    const user = userEvent.setup();
    await user.click(within(codex).getByRole("combobox"));
    expect(
      screen.getByRole("option", { name: "gateway.connections.direct" }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.queryByRole("option", { name: "gateway.connections.proxy" }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(2);
    await user.keyboard("{Escape}");
    await user.click(
      within(codex).getByRole("button", { name: "gateway.configure" }),
    );
    expect(open).toHaveBeenCalledWith("codex");
    expect(gatewayApi.connectApp).not.toHaveBeenCalled();
  });

  it("does not mistake failed mode reads for an unconfigured app and supports retry", async () => {
    vi.mocked(proxyApi.getAppMode).mockRejectedValue(new Error("offline"));
    mount(<RoutingOverviewPage onOpenApp={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getAllByText("gateway.loadError")).toHaveLength(4),
    );
    expect(
      screen.queryByText("gateway.connections.unconfigured"),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    vi.mocked(proxyApi.getAppMode).mockResolvedValue({
      mode: "direct",
      attached: false,
      directProviderId: null,
      routeProviderId: null,
    });
    const row = screen.getByText("Claude").closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "gateway.retry" }));
    expect(await within(row).findByRole("combobox")).toHaveTextContent(
      "gateway.connections.unconfigured",
    );
  });

  it("keeps the previous connection when selecting a group fails", async () => {
    const user = userEvent.setup();
    vi.mocked(gatewayApi.getCatalog).mockResolvedValue({
      ...sharedCatalog,
      groups: [routeGroup],
    });
    vi.mocked(proxyApi.getAppMode).mockResolvedValue({
      mode: "direct",
      attached: false,
      directProviderId: "direct",
      routeProviderId: "saved-route",
    });
    vi.mocked(gatewayApi.connectApp).mockRejectedValue(
      new Error("switch failed"),
    );
    mount(<RoutingOverviewPage onOpenApp={vi.fn()} />);
    const row = (await screen.findByText("Claude")).closest("tr")!;
    const select = await within(row).findByRole("combobox");
    await user.click(select);
    await user.click(screen.getByRole("option", { name: "Production" }));
    await waitFor(() =>
      expect(gatewayApi.connectApp).toHaveBeenCalledWith(
        "claude",
        "production",
        sharedCatalog.revision,
      ),
    );
    expect(await within(row).findByRole("alert")).toHaveTextContent(
      "gateway.errors.generic",
    );
    expect(select).toHaveTextContent("gateway.connections.direct");
    expect(proxyApi.setProxyTakeoverForApp).not.toHaveBeenCalled();
  });

  it("offers compatible enabled groups without a generic proxy option", async () => {
    const user = userEvent.setup();
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
    mount(<RoutingOverviewPage onOpenApp={vi.fn()} />);
    const row = (await screen.findByText("Codex")).closest("tr")!;
    await user.click(await within(row).findByRole("combobox"));
    expect(screen.getByRole("option", { name: "Production" })).toBeEnabled();
    expect(
      screen.queryByRole("option", { name: "Gemini only" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "Disabled group" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "gateway.connections.proxy" }),
    ).not.toBeInTheDocument();
    expect(gatewayApi.connectApp).not.toHaveBeenCalled();
  });

  it("switches an attached application from one group to another", async () => {
    const user = userEvent.setup();
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
      directProviderId: "direct",
      routeProviderId: "gateway-entry:claude",
    });
    vi.mocked(gatewayApi.connectApp).mockImplementation(async () => {
      vi.mocked(gatewayApi.getCatalog).mockResolvedValue({
        ...catalog,
        revision: catalog.revision + 1,
        policies: catalog.policies.map((p) =>
          p.id === "connection/claude" ? { ...p, groupId: "backup" } : p,
        ),
      });
    });
    mount(<RoutingOverviewPage onOpenApp={vi.fn()} />);
    const row = (await screen.findByText("Claude")).closest("tr")!;
    const select = await within(row).findByRole("combobox");
    expect(select).toHaveTextContent("Production");
    await user.click(select);
    await user.click(screen.getByRole("option", { name: "Backup" }));
    await waitFor(() =>
      expect(gatewayApi.connectApp).toHaveBeenCalledWith(
        "claude",
        "backup",
        catalog.revision,
      ),
    );
    await waitFor(() => expect(select).toHaveTextContent("Backup"));
    expect(proxyApi.setProxyTakeoverForApp).not.toHaveBeenCalled();
  });

  it("reconnects a detached application by selecting its saved group again", async () => {
    const user = userEvent.setup();
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
    vi.mocked(gatewayApi.connectApp).mockImplementation(async () => {
      vi.mocked(proxyApi.getAppMode).mockResolvedValue({
        mode: "route",
        attached: true,
        directProviderId: "direct",
        routeProviderId: "gateway-entry:claude",
      });
    });
    mount(<RoutingOverviewPage onOpenApp={vi.fn()} />);
    const row = (await screen.findByText("Claude")).closest("tr")!;
    const select = await within(row).findByRole("combobox");
    expect(select).toHaveTextContent("gateway.connections.detachedGroup");
    await user.click(select);
    await user.click(screen.getByRole("option", { name: "Production" }));
    await waitFor(() =>
      expect(gatewayApi.connectApp).toHaveBeenCalledWith(
        "claude",
        "production",
        catalog.revision,
      ),
    );
    await waitFor(() => expect(select).toHaveTextContent("Production"));
    expect(proxyApi.setProxyTakeoverForApp).not.toHaveBeenCalled();
  });

  it.each(["disabled", "deleted"])(
    "does not silently replace a %s group with a different route",
    async (kind) => {
      const user = userEvent.setup();
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
      mount(<RoutingOverviewPage onOpenApp={vi.fn()} />);
      const row = (await screen.findByText("Claude")).closest("tr")!;
      const select = await within(row).findByRole("combobox");
      expect(select).toHaveTextContent(
        kind === "deleted"
          ? "gateway.connections.unconfigured"
          : "gateway.connections.unavailableGroup",
      );
      await user.click(select);
      expect(screen.getByRole("option", { name: "Backup" })).toBeEnabled();
      expect(gatewayApi.connectApp).not.toHaveBeenCalled();
    },
  );

  it.each(PROXY_APP_IDS)(
    "opens %s provider settings when configuring a connected resource pool",
    async (app) => {
      const open = vi.fn();
      vi.mocked(gatewayApi.getCatalog).mockResolvedValue(sharedCatalog);
      vi.mocked(proxyApi.getAppMode).mockImplementation(async (appId) => ({
        mode: "route",
        attached: true,
        directProviderId: null,
        routeProviderId: `gateway-entry:${appId}`,
        directConfigured: true,
      }));
      mount(<RoutingOverviewPage onOpenApp={open} />);
      const row = (await screen.findByText(getAppLabel(app))).closest("tr")!;
      await within(row).findByRole("combobox");
      fireEvent.click(
        within(row).getByRole("button", { name: "gateway.configure" }),
      );
      expect(open).toHaveBeenCalledTimes(1);
      expect(open).toHaveBeenCalledWith(app);
      expect(
        screen.getByRole("tab", { name: "gateway.tabs.connections" }),
      ).toHaveAttribute("aria-selected", "true");
    },
  );

  it("directs a detached proxy to configuration instead of claiming it is attached", async () => {
    vi.mocked(proxyApi.getProxyStatus).mockResolvedValue({
      running: true,
    } as Awaited<ReturnType<typeof proxyApi.getProxyStatus>>);
    vi.mocked(proxyApi.getAppMode).mockResolvedValue({
      mode: "route",
      attached: false,
      directProviderId: "direct",
      routeProviderId: "route",
    });
    mount(<RoutingOverviewPage onOpenApp={vi.fn()} />);
    await waitFor(() =>
      expect(
        screen.getAllByText("gateway.connections.needsReconnect"),
      ).toHaveLength(4),
    );
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
      await screen.findByRole("button", { name: "Claude · claude" }),
    );
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

  it("previews a selected group without a matching-rule editor", async () => {
    const user = userEvent.setup();
    const catalog = { ...sharedCatalog, groups: [routeGroup] };
    vi.mocked(gatewayApi.previewRoute).mockResolvedValue({
      revision: catalog.revision,
      policy: {
        ...catalog.policies[0],
        name: "Production",
        groupId: "production",
        candidates: [],
      },
      reason: "group",
    });
    vi.mocked(gatewayApi.getCatalog).mockResolvedValue(catalog);
    mount(<RoutingOverviewPage onOpenApp={vi.fn()} />);
    await user.click(
      screen.getByRole("tab", { name: "gateway.tabs.policies" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "gateway.preview.title" }),
    );
    await user.type(
      screen.getByRole("textbox", { name: "gateway.preview.model" }),
      "client-model",
    );
    await user.click(
      screen.getByRole("button", { name: "gateway.preview.run" }),
    );
    await waitFor(() =>
      expect(gatewayApi.previewRoute).toHaveBeenCalledWith(
        "claude",
        "client-model",
      ),
    );
    expect(await screen.findByText(/gateway.preview.group/)).toHaveTextContent(
      "Production",
    );
    expect(
      screen.queryByRole("region", { name: "gateway.policy.title" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "gateway.policy.new" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/gateway.policy.priority/),
    ).not.toBeInTheDocument();
  });

  it.each([false, true])(
    "selects a group and restores the native configuration (configured: %s)",
    async (configured) => {
      const user = userEvent.setup();
      vi.mocked(gatewayApi.getCatalog).mockResolvedValue({
        ...sharedCatalog,
        groups: [routeGroup],
      });
      vi.mocked(proxyApi.getAppMode).mockResolvedValue({
        mode: "direct",
        attached: false,
        directProviderId: null,
        routeProviderId: null,
        directConfigured: configured,
      });
      vi.mocked(gatewayApi.connectApp).mockImplementation(async () => {
        vi.mocked(gatewayApi.getCatalog).mockResolvedValue({
          ...sharedCatalog,
          revision: sharedCatalog.revision + 1,
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
          mode: "route",
          attached: true,
          directProviderId: null,
          routeProviderId: "gateway-entry:claude",
          directConfigured: true,
        });
      });
      vi.mocked(proxyApi.setProxyTakeoverForApp).mockImplementation(
        async () => {
          vi.mocked(proxyApi.getAppMode).mockResolvedValue({
            mode: "direct",
            attached: false,
            directProviderId: null,
            routeProviderId: "gateway-entry:claude",
            directConfigured: true,
          });
        },
      );
      mount(<RoutingOverviewPage onOpenApp={vi.fn()} />);
      const row = (await screen.findByText("Claude")).closest("tr")!;
      const select = await within(row).findByRole("combobox");
      expect(select).toHaveTextContent(
        configured
          ? "gateway.connections.direct"
          : "gateway.connections.unconfigured",
      );
      await user.click(select);
      await user.click(screen.getByRole("option", { name: "Production" }));
      await waitFor(() =>
        expect(gatewayApi.connectApp).toHaveBeenCalledWith(
          "claude",
          "production",
          sharedCatalog.revision,
        ),
      );
      await waitFor(() => expect(select).toHaveTextContent("Production"));
      expect(within(row).getByText("Shared provider")).toBeInTheDocument();
      await user.click(select);
      await user.click(
        screen.getByRole("option", { name: "gateway.connections.direct" }),
      );
      await waitFor(() =>
        expect(proxyApi.setProxyTakeoverForApp).toHaveBeenCalledWith(
          "claude",
          false,
        ),
      );
      await waitFor(() =>
        expect(select).toHaveTextContent("gateway.connections.direct"),
      );
      expect(
        within(row).getByText("gateway.connections.nativeTarget"),
      ).toBeInTheDocument();
      expect(proxyApi.stopProxyWithRestore).not.toHaveBeenCalled();
    },
  );

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
  it("uses three tabs and connects groups to request history without matching rules", async () => {
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
    mount(<RoutingOverviewPage onOpenApp={vi.fn()} />);
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "gateway.tabs.connections",
      "gateway.tabs.policies",
      "gateway.routingStatus.title",
    ]);
    await user.click(
      screen.getByRole("tab", { name: "gateway.tabs.policies" }),
    );
    const groups = await screen.findByRole("region", {
      name: "gateway.groups.title",
    });
    expect(
      screen.queryByRole("region", { name: "gateway.policy.title" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "gateway.preview.title" }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("textbox", { name: "gateway.preview.model" }),
    ).not.toBeInTheDocument();
    await user.click(
      within(groups).getByRole("button", {
        name: "gateway.policy.viewRequests",
      }),
    );
    expect(
      screen.getByRole("tab", { name: "gateway.routingStatus.title" }),
    ).toHaveAttribute("aria-selected", "true");
    await waitFor(() =>
      expect(gatewayApi.getTracePage).toHaveBeenCalledWith(
        expect.objectContaining({ groupId: "production", offset: 0 }),
      ),
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
    expect(gatewayApi.getTracePage).toHaveBeenCalledTimes(1);
    await user.click(
      screen.getByRole("button", { name: "gateway.trace.clearFilter" }),
    );
    await waitFor(() =>
      expect(gatewayApi.getTracePage).toHaveBeenLastCalledWith({
        since: expect.any(Number),
        offset: 0,
      }),
    );
    expect(
      screen.queryByRole("combobox", { name: "gateway.trace.policy" }),
    ).not.toBeInTheDocument();
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
          appIds: ["claude", "codex", "grokbuild"],
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
    expect(inferGroupApps(routeGroup, catalog)).toEqual([
      "claude",
      "codex",
      "grokbuild",
    ]);
    const geminiGroup = {
      ...routeGroup,
      members: [{ ...routeGroup.members[0], supplierId: "gemini" }],
    };
    expect(inferGroupApps(geminiGroup, catalog)).toEqual(["claude", "gemini"]);
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
      await screen.findByRole("button", { name: "gateway.decisions.details" }),
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
