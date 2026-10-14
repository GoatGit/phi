import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
      models: ["sonnet"],
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
  it("shows the first agent, expands others and keeps model management discoverable", async () => {
    mount();
    await screen.findByText("Claude Code");
    expect(screen.queryByText("Codex")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "显示其余 1 个" }));
    expect(screen.getByText("Codex")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("打开应用页管理模型"));
    await waitFor(() =>
      expect(trayPanelApi.action).toHaveBeenCalledWith("nav:app:claude"),
    );
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
  it("shows unavailable data and switch failures without inventing a successful state", async () => {
    vi.mocked(gatewayApi.connectApp).mockRejectedValue(
      new Error("connection failed"),
    );
    mount();
    fireEvent.click(
      await screen.findByRole("switch", { name: "接入 Claude Code" }),
    );
    await screen.findByText("Error: connection failed");
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
    fireEvent.mouseDown(screen.getByRole("tab", { name: "额度" }), {
      button: 0,
      ctrlKey: false,
    });
    await screen.findAllByText("暂无额度数据");
  });
  it("uses native lifecycle actions for opening, settings, Escape and quit", async () => {
    const { unmount } = mount();
    await screen.findByText("Claude Code");
    fireEvent.click(screen.getAllByRole("button", { name: "打开 PHI" })[0]);
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
