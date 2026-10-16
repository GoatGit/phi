import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { toast } from "sonner";
import type { Provider } from "@/types";
import type { ProxyAppId } from "@/config/appConfig";
import type { AppMode } from "@/types/proxy";
import { SwitchModePanel } from "@/components/providers/mode/SwitchModePanel";
import { server } from "../msw/server";
import { createTestQueryClient } from "../utils/testQueryClient";

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
}));

// 只关心模式层：卡片画成按钮，按 presentation 的 key 找；「更多」菜单里的项加 menu- 前缀
vi.mock("@/components/providers/ProviderCard", () => ({
  ProviderCard: ({ provider, presentation }: any) => (
    <div data-testid={`card-${provider.id}`}>
      {presentation.buttons.map((button: any) => (
        <button
          key={button.key}
          data-testid={`${button.key}-${provider.id}`}
          disabled={Boolean(button.disabledReason)}
          onClick={button.onClick}
        >
          {button.label}
        </button>
      ))}
      {(presentation.menuItems ?? []).map((item: any) => (
        <button
          key={item.key}
          data-testid={`menu-${item.key}-${provider.id}`}
          disabled={Boolean(item.disabledReason)}
          onClick={item.onSelect}
        >
          {item.label}
        </button>
      ))}
    </div>
  ),
}));

vi.mock("@/hooks/useStreamCheck", () => ({
  useStreamCheck: () => ({ checkProvider: vi.fn(), isChecking: () => false }),
}));

const TAURI_ENDPOINT = "http://tauri.local";

const provider = (id: string): Provider => ({
  id,
  name: id,
  settingsConfig: {},
});

function mockMode(
  mode: AppMode,
  routeProviderId: string | null,
  directProviderId: string | null = routeProviderId,
) {
  server.use(
    http.post(`${TAURI_ENDPOINT}/get_app_mode`, () =>
      HttpResponse.json({
        mode,
        attached: mode !== "direct",
        routeProviderId,
        directProviderId,
      }),
    ),
    http.post(`${TAURI_ENDPOINT}/get_proxy_status`, () =>
      HttpResponse.json({ running: true }),
    ),
  );
}

const groupMember = (supplierId: string) => ({
  id: supplierId,
  supplierId,
  model: "",
  enabled: true,
  weight: 1,
});

const group = (id: string, name: string, members: unknown[] = []) => ({
  id,
  name,
  enabled: true,
  appIds: ["claude"],
  strategy: "ordered",
  members,
  sessionAffinity: false,
  affinityTtlSeconds: 0,
  failover: true,
  maxAttempts: 3,
  rules: [],
});

function mockCatalog(
  groups: unknown[],
  suppliers: { id: string; name: string }[] = [],
) {
  server.use(
    http.post(`${TAURI_ENDPOINT}/get_gateway_catalog`, () =>
      HttpResponse.json({
        revision: 7,
        suppliers: suppliers.map((s) => ({
          id: s.id,
          name: s.name,
          endpoint: { protocol: "anthropic", baseUrl: "https://upstream.test" },
          models: [],
        })),
        policies: [],
        groups,
      }),
    ),
  );
}

function renderPanel(
  app: ProxyAppId,
  providers: Record<string, Provider>,
  onSwitch = vi.fn(),
) {
  const onOpenRoutingPage = vi.fn();
  const queryClient = createTestQueryClient();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <SwitchModePanel
        app={app}
        providers={providers}
        currentProviderId={Object.keys(providers)[0] ?? ""}
        isLoading={false}
        onSwitch={onSwitch}
        onOpenRoutingPage={onOpenRoutingPage}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onDuplicate={vi.fn()}
        onOpenWebsite={vi.fn()}
      />
    </QueryClientProvider>,
  );
  return { ...view, queryClient, onOpenRoutingPage };
}

beforeEach(() => {
  vi.mocked(toast.info).mockClear();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
  // jsdom 没有 scrollIntoView，确认框里的下拉打开时会调
  Element.prototype.scrollIntoView = vi.fn();
  // 默认空目录：不关心路由组的用例不至于报未处理请求
  mockCatalog([]);
});

describe("SwitchModePanel — direct view keeps the provider list", () => {
  it("lists provider cards with switch buttons and no proxy-section tabs", async () => {
    mockMode("direct", null, "a");
    renderPanel("claude", { a: provider("a"), kimi: provider("kimi") });

    expect(await screen.findByTestId("card-a")).toBeInTheDocument();
    expect(
      screen.queryByRole("tab", { name: "mode.proxySections.stack" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("route-group-list")).not.toBeInTheDocument();
  });
});

describe("SwitchModePanel — proxy view lists route groups", () => {
  it("marks the bound group as current and offers the others for activation", async () => {
    mockMode("route", "gateway-entry:claude");
    mockCatalog(
      [
        group("g1", "组一", [groupMember("sup-1")]),
        group("g2", "组二", [groupMember("sup-2")]),
      ],
      [
        { id: "sup-1", name: "供应商一" },
        { id: "sup-2", name: "供应商二" },
      ],
    );
    renderPanel("claude", { a: provider("a") });

    await screen.findByTestId("route-group-list");
    // 目录里没有 connection 策略时按组顺序兜底：g1 成为当前绑定
    expect(
      await screen.findByText("gateway.groups.current"),
    ).toBeInTheDocument();
    const g2 = screen.getByTestId("group-g2");
    expect(g2).toHaveTextContent("组二");
    expect(g2).toHaveTextContent("供应商二");
    expect(
      within(g2).getByRole("button", { name: "mode.activate.route" }),
    ).toBeEnabled();
  });

  it("shows the legacy route target and asks to finish migrating", async () => {
    mockMode("route", "prov-a");
    mockCatalog([group("g1", "组一")]);
    renderPanel("claude", { "prov-a": provider("prov-a") });

    expect(
      await screen.findByText(/mode\.legacyRouteTarget/),
    ).toBeInTheDocument();
    expect(screen.getByText("gateway.connections.legacy")).toBeInTheDocument();
  });

  it("activates a group through the confirm dialog", async () => {
    const user = userEvent.setup();
    mockMode("direct", null, "a");
    mockCatalog([
      group("g1", "组一", [groupMember("sup-1")]),
      group("g2", "组二", [groupMember("sup-2")]),
    ]);
    const connectCalls: unknown[] = [];
    server.use(
      http.post(
        `${TAURI_ENDPOINT}/connect_gateway_app`,
        async ({ request }) => {
          connectCalls.push(await request.json());
          return HttpResponse.json(null);
        },
      ),
    );
    renderPanel("claude", { a: provider("a") });

    await user.click(
      await screen.findByRole("button", { name: /mode\.names\.route/ }),
    );
    await user.click(
      within(await screen.findByTestId("group-g2")).getByRole("button", {
        name: "mode.activate.route",
      }),
    );
    expect(await screen.findByText("mode.dialog.routeTitle")).toBeVisible();
    // 预选点的那家组
    const select = await screen.findByRole("combobox", {
      name: "mode.dialog.routeTo",
    });
    expect(select).toHaveTextContent("组二");
    await user.click(screen.getByText("mode.dialog.confirmRoute"));

    await waitFor(() =>
      expect(connectCalls).toEqual([
        { appId: "claude", groupId: "g2", revision: 7 },
      ]),
    );
  });

  it("exits to direct from the bound group card", async () => {
    mockMode("route", "gateway-entry:claude");
    mockCatalog([group("g1", "组一", [groupMember("sup-1")])]);
    const takeoverCalls: unknown[] = [];
    server.use(
      http.post(
        `${TAURI_ENDPOINT}/set_proxy_takeover_for_app`,
        async ({ request }) => {
          takeoverCalls.push(await request.json());
          return HttpResponse.json(null);
        },
      ),
    );
    renderPanel("claude", { a: provider("a") });

    await userEvent
      .setup()
      .click(
        await screen.findByRole("button", { name: "mode.notice.backToDirect" }),
      );
    await waitFor(() =>
      expect(takeoverCalls).toEqual([
        { appType: "claude", enabled: false, stack: false, route: null },
      ]),
    );
  });

  it("shows an empty state that opens the routing settings when no group exists", async () => {
    const user = userEvent.setup();
    mockMode("direct", null, "a");
    mockCatalog([]);
    const { onOpenRoutingPage } = renderPanel("claude", {
      a: provider("a"),
    });

    await user.click(
      await screen.findByRole("button", { name: /mode\.names\.route/ }),
    );
    expect(await screen.findByText("gateway.groups.empty")).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "gateway.groups.goCreate" }),
    );
    expect(onOpenRoutingPage).toHaveBeenCalledTimes(1);
  });

  it("shows only the group name in the status line, not the local address", async () => {
    mockMode("route", "gateway-entry:claude");
    mockCatalog([group("g1", "组一")]);
    server.use(
      http.post(`${TAURI_ENDPOINT}/get_proxy_status`, () =>
        HttpResponse.json({ running: true, address: "127.0.0.1", port: 15721 }),
      ),
    );
    renderPanel("claude", { a: provider("a") });

    expect(await screen.findByText("→ 组一")).toBeInTheDocument();
    expect(screen.queryByText(/15721/)).not.toBeInTheDocument();
  });
});

describe("SwitchModePanel — tray needs-route request", () => {
  it("opens the same needs-routing dialog once the provider is there", async () => {
    mockMode("direct", null);
    const onHandled = vi.fn();
    const copilot: Provider = {
      ...provider("copilot"),
      meta: { providerType: "github_copilot" },
    };
    const queryClient = createTestQueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <SwitchModePanel
          app="claude"
          providers={{ kimi: provider("kimi"), copilot }}
          currentProviderId="kimi"
          isLoading={false}
          onSwitch={vi.fn()}
          onOpenRoutingPage={vi.fn()}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
          onDuplicate={vi.fn()}
          onOpenWebsite={vi.fn()}
          needsRouteRequest={{ providerId: "copilot", nonce: 1 }}
          onNeedsRouteHandled={onHandled}
        />
      </QueryClientProvider>,
    );

    expect(
      await screen.findByText("mode.dialog.needsRouteTitle"),
    ).toBeInTheDocument();
    expect(onHandled).toHaveBeenCalledTimes(1);
  });

  it("activates the default route group from the needs-routing dialog", async () => {
    const user = userEvent.setup();
    mockMode("direct", null);
    mockCatalog([group("g1", "组一")]);
    const connectCalls: unknown[] = [];
    server.use(
      http.post(
        `${TAURI_ENDPOINT}/connect_gateway_app`,
        async ({ request }) => {
          connectCalls.push(await request.json());
          return HttpResponse.json(null);
        },
      ),
    );
    const copilot: Provider = {
      ...provider("copilot"),
      meta: { providerType: "github_copilot" },
    };
    render(
      <QueryClientProvider client={createTestQueryClient()}>
        <SwitchModePanel
          app="claude"
          providers={{ kimi: provider("kimi"), copilot }}
          currentProviderId="kimi"
          isLoading={false}
          onSwitch={vi.fn()}
          onOpenRoutingPage={vi.fn()}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
          onDuplicate={vi.fn()}
          onOpenWebsite={vi.fn()}
          needsRouteRequest={{ providerId: "copilot", nonce: 1 }}
          onNeedsRouteHandled={vi.fn()}
        />
      </QueryClientProvider>,
    );

    await screen.findByText("mode.dialog.needsRouteTitle");
    await user.click(
      screen.getByRole("button", { name: "mode.activate.route" }),
    );
    // 不带 groupId：由后端按策略解析默认组（revision 随请求带上但仅在选组时使用）
    await waitFor(() =>
      expect(connectCalls).toEqual([{ appId: "claude", revision: 7 }]),
    );
  });
});
