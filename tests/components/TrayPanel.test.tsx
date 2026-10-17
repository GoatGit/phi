import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import i18n from "i18next";
import zh from "@/i18n/locales/zh.json";
import { TrayPanel } from "@/components/tray/TrayPanel";
import { trayPanelApi, type TraySnapshot } from "@/lib/api/trayPanel";
import { gatewayApi } from "@/lib/api/gateway";
import { proxyApi } from "@/lib/api/proxy";
import { createTestQueryClient } from "../utils/testQueryClient";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => false,
}));
const snapshot: TraySnapshot = {
  agents: [
    {
      id: "claude",
      name: "Claude Code",
      mode: "direct",
      connected: false,
      gateway: false,
      canConnect: true,
      providerName: "Acme",
      providers: [
        { id: "prov:claude:a", label: "Acme", enabled: true, selected: true },
        { id: "gateway:claude", label: "PHI", enabled: true, selected: false },
      ],
      models: ["sonnet", "opus"],
      modelOptions: [
        {
          id: 'model:claude:["a","sonnet"]',
          label: "sonnet",
          enabled: true,
          selected: true,
        },
        {
          id: 'model:claude:["a","opus"]',
          label: "opus",
          enabled: true,
          selected: false,
        },
      ],
      quota: [],
      quotaError: null,
      attention: false,
    },
    {
      id: "codex",
      name: "Codex",
      mode: "direct",
      connected: false,
      gateway: false,
      canConnect: true,
      providerName: null,
      providers: [],
      models: [],
      modelOptions: [],
      quota: [],
      quotaError: null,
      attention: false,
    },
  ],
  problems: [],
  feedback: null,
  routingInUse: false,
  profiles: [],
  updatedAt: 1,
};
function mount() {
  const client = createTestQueryClient();
  const view = render(
    <QueryClientProvider client={client}>
      <TrayPanel />
    </QueryClientProvider>,
  );
  return { ...view, client };
}
const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
beforeAll(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterAll(() => {
  HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
});
beforeEach(() => {
  i18n.addResourceBundle(
    i18n.language,
    "translation",
    { trayPanel: zh.trayPanel },
    true,
    true,
  );
  vi.spyOn(trayPanelApi, "snapshot").mockResolvedValue(
    structuredClone(snapshot),
  );
  vi.spyOn(trayPanelApi, "action").mockResolvedValue([]);
  vi.spyOn(trayPanelApi, "hide").mockResolvedValue();
  vi.spyOn(trayPanelApi, "refresh").mockResolvedValue();
  vi.spyOn(gatewayApi, "connectApp").mockResolvedValue();
  vi.spyOn(proxyApi, "setProxyTakeoverForApp").mockResolvedValue();
});
describe("menu-bar panel", () => {
  it("shows two selectors and switches the direct model without navigating away", async () => {
    mount();
    await screen.findByText("Claude Code");
    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /应用/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "路由状态" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "额度" })).not.toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Claude Code 的供应商或 PHI" }),
    ).toHaveTextContent("Acme");
    fireEvent.keyDown(
      screen.getByRole("combobox", { name: "选择 Claude Code 的模型" }),
      { key: "Enter" },
    );
    fireEvent.click(await screen.findByRole("option", { name: "opus" }));
    await waitFor(() =>
      expect(trayPanelApi.action).toHaveBeenCalledWith(
        'model:claude:["a","opus"]',
      ),
    );
  });
  it("selects PHI in the first box and uses route groups in the second box", async () => {
    const agent = snapshot.agents[0];
    const connected = {
      ...agent,
      connected: true,
      gateway: true,
      providerName: "PHI",
      providers: agent.providers.map((p) => ({
        ...p,
        selected: p.id === "gateway:claude",
      })),
      modelOptions: [
        {
          id: "group:claude:one",
          label: "路由一",
          enabled: true,
          selected: true,
        },
        {
          id: "group:claude:two",
          label: "路由二",
          enabled: true,
          selected: false,
        },
      ],
    };
    vi.mocked(trayPanelApi.action).mockImplementation(async (id) => {
      if (id === "gateway:claude") {
        vi.mocked(trayPanelApi.snapshot).mockResolvedValue({
          ...snapshot,
          agents: [connected],
        });
      }
      return [];
    });
    mount();
    fireEvent.keyDown(
      await screen.findByRole("combobox", {
        name: "Claude Code 的供应商或 PHI",
      }),
      { key: "Enter" },
    );
    fireEvent.click(await screen.findByRole("option", { name: "PHI" }));
    const groups = await screen.findByRole("combobox", {
      name: "选择 Claude Code 的路由组",
    });
    expect(groups).toHaveTextContent("路由一");
    expect(
      screen.queryByRole("combobox", { name: "选择 Claude Code 的模型" }),
    ).not.toBeInTheDocument();
    fireEvent.keyDown(groups, { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: "路由二" }));
    await waitFor(() =>
      expect(trayPanelApi.action).toHaveBeenCalledWith("group:claude:two"),
    );
  });
  it("disables an empty model list", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /Codex/ }));
    expect(
      screen.getByRole("combobox", { name: "选择 Codex 的模型" }),
    ).toBeDisabled();
  });
  it("connects through the shared gateway when offered, and does not optimistically change the switch", async () => {
    mount();
    const toggle = await screen.findByRole("switch", {
      name: "接入 Claude Code",
    });
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(gatewayApi.connectApp).toHaveBeenCalledWith("claude"),
    );
    expect(proxyApi.setProxyTakeoverForApp).not.toHaveBeenCalled();
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });
  it("restores direct mode when disconnecting an agent", async () => {
    vi.mocked(trayPanelApi.snapshot).mockResolvedValue({
      ...snapshot,
      agents: [{ ...snapshot.agents[0], connected: true, gateway: true }],
    });
    mount();
    fireEvent.click(
      await screen.findByRole("switch", { name: "接入 Claude Code" }),
    );
    await waitFor(() =>
      expect(proxyApi.setProxyTakeoverForApp).toHaveBeenCalledWith(
        "claude",
        false,
      ),
    );
  });
  it("shows switch failures without inventing a successful state", async () => {
    vi.mocked(gatewayApi.connectApp).mockRejectedValue(
      new Error("connection failed"),
    );
    mount();
    fireEvent.click(
      await screen.findByRole("switch", { name: "接入 Claude Code" }),
    );
    await screen.findByText("Error: connection failed");
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
  });
  it("uses native lifecycle actions for opening, settings, Escape and quit", async () => {
    const { unmount } = mount();
    await screen.findByText("Claude Code");
    fireEvent.click(screen.getByRole("button", { name: "打开 PHI" }));
    await waitFor(() =>
      expect(trayPanelApi.action).toHaveBeenCalledWith("show_main"),
    );
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    await waitFor(() =>
      expect(trayPanelApi.action).toHaveBeenCalledWith("nav:settings:general"),
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(trayPanelApi.hide).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "退出" }));
    await waitFor(() =>
      expect(trayPanelApi.action).toHaveBeenCalledWith("quit"),
    );
    unmount();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(trayPanelApi.hide).toHaveBeenCalledTimes(1);
  });
});
