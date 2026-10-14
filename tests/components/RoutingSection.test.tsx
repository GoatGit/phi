import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RoutingSection } from "@/components/settings/sections/RoutingSection";
import { renderWithQueryClient } from "../utils/testQueryClient";

const mocks = vi.hoisted(() => ({
  status: { running: true, port: 15821, address: "127.0.0.1" },
  config: {
    proxyEnabled: true,
    listenAddress: "127.0.0.1",
    listenPort: 15821,
    enableLogging: true,
  },
  save: vi.fn(),
  retry: vi.fn(),
  restore: vi.fn(),
}));
vi.mock("@/lib/query", () => ({
  useProvidersQuery: () => ({ data: { providers: {}, currentProviderId: "" } }),
}));
vi.mock("@/lib/query/proxy", () => ({
  useProxyStatusQuery: () => ({ data: mocks.status, isError: false }),
  useGlobalProxyConfig: () => ({ data: mocks.config }),
  useUpdateGlobalProxyConfig: () => ({
    mutateAsync: mocks.save,
    isPending: false,
  }),
  useProxyClientHost: () => ({ data: "" }),
  useSetProxyClientHost: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/useProxyStatus", () => ({
  useProxyStatus: () => ({
    startProxyServer: mocks.retry,
    stopWithRestore: mocks.restore,
    isPending: false,
  }),
}));
vi.mock("@/lib/api/proxy", () => ({
  proxyApi: {
    getAppMode: async (app: string) => ({
      mode: app === "claude" ? "route" : "direct",
      attached: app === "claude",
    }),
  },
}));
vi.mock("@/components/settings/GatewayDiagnostics", () => ({
  GatewayDiagnostics: () => null,
}));
vi.mock("@/components/proxy/AutoFailoverConfigPanel", () => ({
  AutoFailoverConfigPanel: () => null,
}));
vi.mock("@/components/settings/RectifierConfigPanel", () => ({
  RectifierConfigPanel: () => null,
}));

beforeEach(() => {
  mocks.status = { running: true, port: 15821, address: "127.0.0.1" };
  mocks.save.mockReset().mockResolvedValue(undefined);
  mocks.retry.mockReset().mockResolvedValue(undefined);
  mocks.restore.mockReset().mockResolvedValue(undefined);
});

describe("resident gateway settings", () => {
  it("saves a valid port and does not offer manual start/stop controls", async () => {
    renderWithQueryClient(<RoutingSection onOpenApp={vi.fn()} />);
    expect(
      screen.queryByRole("button", { name: "routingSettings.start" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "routingSettings.stop" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "routingSettings.retryStart" }),
    ).not.toBeInTheDocument();
    const port = screen.getByRole("textbox", { name: "routingSettings.port" });
    fireEvent.change(port, { target: { value: "99999" } });
    fireEvent.click(
      screen.getByRole("button", { name: "routingSettings.saveAndRestart" }),
    );
    expect(mocks.save).not.toHaveBeenCalled();
    expect(port).toHaveAttribute("aria-invalid", "true");
    fireEvent.change(port, { target: { value: "15822" } });
    fireEvent.click(
      screen.getByRole("button", { name: "routingSettings.saveAndRestart" }),
    );
    await waitFor(() =>
      expect(mocks.save).toHaveBeenCalledWith({
        proxyEnabled: true,
        listenAddress: "127.0.0.1",
        listenPort: 15822,
        enableLogging: true,
      }),
    );
  });

  it("allows retrying a failed startup and saving settings while unavailable", async () => {
    mocks.status.running = false;
    renderWithQueryClient(<RoutingSection onOpenApp={vi.fn()} />);
    expect(screen.getByText("routingSettings.unavailable")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "routingSettings.retryStart" }),
    );
    await waitFor(() => expect(mocks.retry).toHaveBeenCalledOnce());
    expect(
      screen.getByRole("button", { name: "routingSettings.saveAndRestart" }),
    ).toBeEnabled();
  });

  it("restores app connections through the existing restore action", async () => {
    renderWithQueryClient(<RoutingSection onOpenApp={vi.fn()} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "routingSettings.exitAll" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "routingSettings.exitAllConfirm" }),
    );
    await waitFor(() => expect(mocks.restore).toHaveBeenCalledOnce());
    expect(mocks.retry).not.toHaveBeenCalled();
  });
});
