import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { AddPoolSupplier } from "@/components/gateway/AddPoolSupplier";
import { gatewayApi, providersApi, universalProvidersApi } from "@/lib/api";
import { gatewayCatalogKey } from "@/components/gateway/useGatewayCatalog";
import { createTestQueryClient } from "../utils/testQueryClient";

vi.mock("@/components/JsonEditor", () => ({
  default: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (value: string) => void;
  }) => (
    <textarea
      aria-label="configuration"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

const saved = { revision: 2, suppliers: [], policies: [] };

function mount() {
  const client = createTestQueryClient();
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <AddPoolSupplier revision={1} onClose={onClose} />
    </QueryClientProvider>,
  );
  return { client, onClose };
}

function chooseTemplate(name: string) {
  const button = screen
    .getAllByRole("button")
    .find((item) => item.querySelector("span.truncate")?.textContent === name);
  expect(button).toBeDefined();
  fireEvent.click(button!);
}

beforeEach(() => {
  vi.spyOn(providersApi, "getEditorView");
  vi.spyOn(providersApi, "add");
  vi.spyOn(universalProvidersApi, "upsert");
  vi.spyOn(universalProvidersApi, "sync");
  vi.spyOn(gatewayApi, "createFromTemplate").mockResolvedValue(saved);
  vi.spyOn(gatewayApi, "createFromUniversal").mockResolvedValue(saved);
});

describe("resource pool template creation", () => {
  it("opens a template from another family directly without an application selector", async () => {
    const { onClose } = mount();
    await screen.findByRole("textbox", {
      name: "providerPreset.searchAriaLabel",
    });
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    fireEvent.change(
      screen.getByRole("textbox", { name: "providerPreset.searchAriaLabel" }),
      { target: { value: "StepFun API" } },
    );
    chooseTemplate("StepFun");
    fireEvent.change(document.getElementById("codexApiKey")!, {
      target: { value: "codex-template-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "common.add" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(gatewayApi.createFromTemplate).toHaveBeenCalledWith(
      "codex",
      expect.objectContaining({
        name: "StepFun API",
        settingsConfig: expect.objectContaining({
          auth: { OPENAI_API_KEY: "codex-template-key" },
        }),
      }),
      1,
    );
    expect(providersApi.getEditorView).not.toHaveBeenCalled();
    expect(providersApi.add).not.toHaveBeenCalled();
  });

  it("returns to the shared catalog and changes form families without retaining the previous credentials", async () => {
    const user = userEvent.setup();
    mount();
    const search = await screen.findByRole("textbox", {
      name: "providerPreset.searchAriaLabel",
    });
    fireEvent.change(search, { target: { value: "StepFun API" } });
    chooseTemplate("StepFun");
    fireEvent.change(document.getElementById("codexApiKey")!, {
      target: { value: "previous-template-key" },
    });
    await user.click(
      screen.getByRole("button", { name: "providerPreset.backToPick" }),
    );
    fireEvent.change(
      await screen.findByRole("textbox", {
        name: "providerPreset.searchAriaLabel",
      }),
      { target: { value: "Nvidia" } },
    );
    const matches = screen
      .getAllByRole("button")
      .filter(
        (item) => item.querySelector("span.truncate")?.textContent === "Nvidia",
      );
    expect(matches).toHaveLength(1);
    fireEvent.click(matches[0]);
    expect(document.getElementById("apiKey")).toHaveValue("");
    expect(document.getElementById("codexApiKey")).not.toBeInTheDocument();
    expect(providersApi.getEditorView).not.toHaveBeenCalled();
  });

  it("uses the real template picker and full form, saving only to the resource pool", async () => {
    const { client, onClose } = mount();
    expect(
      await screen.findByRole("textbox", {
        name: "providerPreset.searchAriaLabel",
      }),
    ).toBeInTheDocument();
    fireEvent.change(
      screen.getByRole("textbox", { name: "providerPreset.searchAriaLabel" }),
      { target: { value: "Nvidia" } },
    );
    chooseTemplate("Nvidia");
    const key = document.getElementById("apiKey")!;
    expect(key).toBeInTheDocument();
    fireEvent.change(key, { target: { value: "template-test-key" } });
    fireEvent.click(screen.getByRole("button", { name: "common.add" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(gatewayApi.createFromTemplate).toHaveBeenCalledWith(
      "claude",
      expect.objectContaining({
        name: "Nvidia",
        settingsConfig: expect.objectContaining({
          env: expect.objectContaining({
            ANTHROPIC_AUTH_TOKEN: "template-test-key",
          }),
        }),
        meta: expect.objectContaining({ apiFormat: "openai_chat" }),
      }),
      1,
    );
    expect(
      vi.mocked(gatewayApi.createFromTemplate).mock.calls[0][1],
    ).not.toHaveProperty("editorSave");
    expect(client.getQueryData(gatewayCatalogKey)).toEqual(saved);
    expect(providersApi.getEditorView).not.toHaveBeenCalled();
    expect(providersApi.add).not.toHaveBeenCalled();
  });

  it("keeps the filled template open when the backend rejects it", async () => {
    vi.mocked(gatewayApi.createFromTemplate).mockRejectedValue(
      "gateway.managedCredential",
    );
    const { onClose } = mount();
    await screen.findByRole("textbox", {
      name: "providerPreset.searchAriaLabel",
    });
    chooseTemplate("Nvidia");
    fireEvent.change(document.getElementById("apiKey")!, {
      target: { value: "template-test-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "common.add" }));
    expect(
      await screen.findByText("gateway.errors.generic"),
    ).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(document.getElementById("apiKey")).toHaveValue("template-test-key");
  });

  it("saves a universal template to the pool and keeps it open for retry on failure", async () => {
    vi.mocked(gatewayApi.createFromUniversal)
      .mockRejectedValueOnce("gateway.staleRevision")
      .mockResolvedValue(saved);
    const { onClose, client } = mount();
    await screen.findByRole("textbox", {
      name: "providerPreset.searchAriaLabel",
    });
    fireEvent.click(
      screen.getByRole("button", { name: /providerPreset.group.universal/ }),
    );
    chooseTemplate("NewAPI");
    fireEvent.change(screen.getByLabelText("API 地址"), {
      target: { value: "https://example.com" },
    });
    fireEvent.change(
      screen.getByLabelText(/API Key/, {
        selector: "#universal-provider-apiKey",
      }),
      {
        target: { value: "template-test-key" },
      },
    );
    expect(
      screen.getByText("gateway.pool.templateProtocolsHelp"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    expect(
      await screen.findByText("gateway.errors.generic"),
    ).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(
      screen.getByLabelText(/API Key/, {
        selector: "#universal-provider-apiKey",
      }),
    ).toHaveValue("template-test-key");
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(gatewayApi.createFromUniversal).toHaveBeenLastCalledWith(
      expect.objectContaining({
        baseUrl: "https://example.com",
        apiKey: "template-test-key",
      }),
      1,
    );
    expect(client.getQueryData(gatewayCatalogKey)).toEqual(saved);
    expect(universalProvidersApi.upsert).not.toHaveBeenCalled();
    expect(universalProvidersApi.sync).not.toHaveBeenCalled();
  });
});
