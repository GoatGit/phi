import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import i18n from "i18next";
import zh from "@/i18n/locales/zh.json";
import { GatewayDiagnostics } from "@/components/settings/GatewayDiagnostics";
import { renderWithQueryClient } from "../utils/testQueryClient";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(invoke).mockReset();
  i18n.addResourceBundle(
    i18n.language,
    "translation",
    { diagnostics: zh.diagnostics, ledger: zh.ledger },
    true,
    true,
  );
});
it("only probes endpoints after explicit selection and run, and renders diagnostic codes", async () => {
  vi.mocked(invoke).mockResolvedValue({
    checkedAt: 1,
    checks: [
      {
        id: "listener",
        subject: "PHI",
        state: "error",
        code: "listenerFailed",
        latencyMs: null,
      },
    ],
  });
  renderWithQueryClient(<GatewayDiagnostics />);
  expect(invoke).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: zh.diagnostics.run }));
  expect(
    await screen.findAllByText(zh.diagnostics.codes.listenerFailed),
  ).toHaveLength(2);
  expect(invoke).toHaveBeenCalledWith("diagnose_gateway", {
    includeUpstreams: false,
  });
  fireEvent.click(
    screen.getByRole("checkbox", { name: zh.diagnostics.upstreams }),
  );
  fireEvent.click(screen.getByRole("button", { name: zh.diagnostics.run }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("diagnose_gateway", {
      includeUpstreams: true,
    }),
  );
});
it("shows a failed diagnostic read instead of a successful empty report", async () => {
  vi.mocked(invoke).mockRejectedValue("read failed");
  renderWithQueryClient(<GatewayDiagnostics />);
  fireEvent.click(screen.getByRole("button", { name: zh.diagnostics.run }));
  expect(await screen.findByText("read failed")).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: zh.diagnostics.copy }),
  ).not.toBeInTheDocument();
});
