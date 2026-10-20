import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SubscriptionSupplierDialog } from "@/components/gateway/SubscriptionSupplierDialog";
import { gatewayApi, settingsApi } from "@/lib/api";
import { gatewayCatalogKey } from "@/components/gateway/useGatewayCatalog";
import { createTestQueryClient } from "../utils/testQueryClient";

const subscription = {
  id: "copilot",
  name: "GitHub Copilot",
  website: "https://github.com",
};
const saved = { revision: 8, suppliers: [], policies: [] };
function mount() {
  const client = createTestQueryClient();
  const onClose = vi.fn();
  const view = render(
    <QueryClientProvider client={client}>
      <SubscriptionSupplierDialog
        subscription={subscription}
        revision={7}
        onClose={onClose}
      />
    </QueryClientProvider>,
  );
  return { ...view, client, onClose };
}
let ready: boolean;
let callbackDone: boolean;
let requests: { action: string; input: Record<string, unknown> }[];
beforeEach(() => {
  ready = false;
  callbackDone = false;
  requests = [];
  vi.spyOn(settingsApi, "openExternal").mockResolvedValue(undefined);
  vi.spyOn(gatewayApi, "connectSubscription").mockResolvedValue(saved);
  vi.spyOn(gatewayApi, "subscriptionAction").mockImplementation((async (
    action: string,
    input: Record<string, unknown>,
  ) => {
    requests.push({ action, input });
    switch (action) {
      case "prepare":
        return [{ type: "oauth", label: "Device login" }];
      case "prompt":
        return null;
      case "models":
        if (!ready) throw new Error("not signed in");
        return {
          models: ["gpt-5", "claude-sonnet-4-5"],
          source: "vendor",
          fetchedAt: "2026-10-19T18:00:00Z",
        };
      case "login":
        return {
          id: "session-1",
          agent: "copilot",
          state: "waiting",
          url: "https://github.com/login/device",
          code: "ABCD-EFGH",
          pasteCode: true,
        };
      case "callback":
        callbackDone = true;
        return true;
      case "status":
        if (callbackDone) {
          ready = true;
          return { id: "session-1", agent: "copilot", state: "done" };
        }
        return { id: "session-1", agent: "copilot", state: "waiting" };
      case "cancel":
        return true;
      default:
        throw new Error("unexpected action " + action);
    }
  }) as typeof gatewayApi.subscriptionAction);
});

describe("subscription supplier authorization", () => {
  it("reuses an existing subscription and saves only its ID and catalog revision", async () => {
    ready = true;
    const { client, onClose } = mount();
    const add = await screen.findByRole("button", {
      name: "gateway.subscription.add",
    });
    await waitFor(() => expect(add).toBeEnabled());
    fireEvent.click(add);
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(gatewayApi.connectSubscription).toHaveBeenCalledWith("copilot", 7);
    expect(client.getQueryData(gatewayCatalogKey)).toEqual(saved);
    expect(requests.some((request) => request.action === "login")).toBe(false);
  });
  it("shows device codes and submits pasted authorization results before saving", async () => {
    const { onClose } = mount();
    fireEvent.click(
      await screen.findByRole("button", { name: "gateway.subscription.login" }),
    );
    expect(await screen.findByText("ABCD-EFGH")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "gateway.subscription.add" }),
    ).toBeDisabled();
    fireEvent.click(
      screen.getByRole("button", { name: "gateway.subscription.openLogin" }),
    );
    await waitFor(() =>
      expect(settingsApi.openExternal).toHaveBeenCalledWith(
        "https://github.com/login/device",
      ),
    );
    fireEvent.change(screen.getByLabelText("gateway.subscription.callback"), {
      target: { value: "authorization-result" },
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "gateway.subscription.submitCallback",
      }),
    );
    await waitFor(() =>
      expect(requests).toContainEqual({
        action: "callback",
        input: {
          id: "copilot",
          session: "session-1",
          value: "authorization-result",
        },
      }),
    );
    await waitFor(
      () =>
        expect(
          screen.getByRole("button", { name: "gateway.subscription.add" }),
        ).toBeEnabled(),
      { timeout: 2500 },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "gateway.subscription.add" }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });
  it("cancels pending login listeners when the dialog closes", async () => {
    const { unmount } = mount();
    fireEvent.click(
      await screen.findByRole("button", { name: "gateway.subscription.login" }),
    );
    await screen.findByText("ABCD-EFGH");
    unmount();
    await waitFor(() =>
      expect(requests).toContainEqual({
        action: "cancel",
        input: { session: "session-1" },
      }),
    );
    expect(gatewayApi.connectSubscription).not.toHaveBeenCalled();
  });
  it("keeps the subscription open after a catalog revision conflict", async () => {
    ready = true;
    vi.mocked(gatewayApi.connectSubscription).mockRejectedValue(
      "gateway.staleRevision",
    );
    const { onClose } = mount();
    const add = await screen.findByRole("button", {
      name: "gateway.subscription.add",
    });
    await waitFor(() => expect(add).toBeEnabled());
    fireEvent.click(add);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    await waitFor(() => expect(add).toBeEnabled());
  });
  it("collects the API key alongside method prompts before signing in", async () => {
    vi.mocked(gatewayApi.subscriptionAction).mockImplementation((async (
      action: string,
      input: Record<string, unknown>,
    ) => {
      requests.push({ action, input });
      switch (action) {
        case "prepare":
          return [{ type: "api", label: "API key" }];
        case "prompt":
          return (input.inputs as Record<string, string> | undefined)?.region
            ? null
            : {
                type: "text",
                key: "region",
                message: "Region",
                placeholder: "",
              };
        case "models":
          if (!ready) throw new Error("not signed in");
          return { models: ["m-1"], source: "vendor" };
        case "login":
          ready = true;
          return { id: "session-1", agent: "copilot", state: "done" };
        default:
          throw new Error("unexpected action " + action);
      }
    }) as typeof gatewayApi.subscriptionAction);
    mount();
    fireEvent.change(await screen.findByLabelText("Region"), {
      target: { value: "us" },
    });
    // 提问存在时仍要能看到 API Key，否则带提问的 api 方式永远集不到密钥；
    // 而且在填 key 之前不能点「下一步」（否则最后一次提问会带空 key 登录）。
    const next = screen.getByRole("button", {
      name: "gateway.subscription.next",
    });
    expect(
      screen.getByLabelText("gateway.subscription.apiKey"),
    ).toBeInTheDocument();
    expect(next).toBeDisabled();
    fireEvent.change(screen.getByLabelText("gateway.subscription.apiKey"), {
      target: { value: "sk-test" },
    });
    expect(next).toBeEnabled();
    fireEvent.click(next);
    await waitFor(() =>
      expect(requests).toContainEqual({
        action: "login",
        input: {
          id: "copilot",
          method: 0,
          inputs: { region: "us" },
          value: "sk-test",
        },
      }),
    );
  });

  it("says when the account's models couldn't be refreshed, and still adds what it has", async () => {
    ready = true;
    vi.mocked(gatewayApi.subscriptionAction).mockImplementation((async (
      action: string,
    ) => {
      switch (action) {
        case "prepare":
          return [{ type: "oauth", label: "Browser login" }];
        case "prompt":
          return null;
        case "models":
          // The vendor wasn't asked, so the dialog shows the list saved before
          // and says why it isn't newer: an older list must not look current.
          return {
            models: ["gpt-5.1"],
            source: "cached",
            warning: "ChatGPT models: 401 Unauthorized",
          };
        default:
          return true;
      }
    }) as typeof gatewayApi.subscriptionAction);
    mount();
    expect(
      await screen.findByText("gateway.subscription.modelsStale"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("ChatGPT models: 401 Unauthorized"),
    ).toBeInTheDocument();
    const add = screen.getByRole("button", {
      name: "gateway.subscription.add",
    });
    await waitFor(() => expect(add).toBeEnabled());
    fireEvent.click(add);
    await waitFor(() =>
      expect(gatewayApi.connectSubscription).toHaveBeenCalledOnce(),
    );
  });

  it("offers setup retry when the engine cannot be prepared", async () => {
    vi.mocked(gatewayApi.subscriptionAction).mockRejectedValue(
      new Error("engine missing"),
    );
    mount();
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "gateway.subscription.retry" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "gateway.subscription.add" }),
    ).toBeDisabled();
  });
});
