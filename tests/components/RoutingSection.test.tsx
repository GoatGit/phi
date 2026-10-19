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
    isPending: false,
  }),
}));
vi.mock("@/components/settings/GatewayDiagnostics", () => ({
  GatewayDiagnostics: () => null,
}));
vi.mock("@/components/settings/RectifierConfigPanel", () => ({
  RectifierConfigPanel: () => null,
}));

beforeEach(() => {
  mocks.status = { running: true, port: 15821, address: "127.0.0.1" };
  mocks.save.mockReset().mockResolvedValue(undefined);
  mocks.retry.mockReset().mockResolvedValue(undefined);
});

describe("gateway settings", () => {
  it("saves a valid port and does not offer manual start/stop controls", async () => {
    renderWithQueryClient(<RoutingSection />);
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
    renderWithQueryClient(<RoutingSection />);
    expect(screen.getByText("routingSettings.unavailable")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "routingSettings.retryStart" }),
    );
    await waitFor(() => expect(mocks.retry).toHaveBeenCalledOnce());
    expect(
      screen.getByRole("button", { name: "routingSettings.saveAndRestart" }),
    ).toBeEnabled();
  });

  it("leaves app routing out of the gateway settings page", () => {
    renderWithQueryClient(<RoutingSection />);
    expect(
      screen.queryByText(/routingSettings\.usingApps/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "routingSettings.exitAll" }),
    ).not.toBeInTheDocument();
  });
});
