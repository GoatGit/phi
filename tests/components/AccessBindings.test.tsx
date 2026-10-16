import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
import { AccessBindings } from "@/components/gateway/AccessBindings";
import { accessApi } from "@/lib/api/access";
import { gatewayApi, type GatewayRouteGroup } from "@/lib/api/gateway";
import * as clipboard from "@/lib/clipboard";
import { renderWithQueryClient } from "../utils/testQueryClient";

// Keep real Radix selection behavior; jsdom has no native scrolling API.
const scrollDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollIntoView",
);
beforeAll(() =>
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  }),
);
afterAll(() => {
  if (scrollDescriptor)
    Object.defineProperty(
      HTMLElement.prototype,
      "scrollIntoView",
      scrollDescriptor,
    );
  else delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
});

const group: GatewayRouteGroup = {
  id: "codex-group",
  name: "Coding",
  enabled: true,
  appIds: ["codex"],
  strategy: "ordered",
  members: [],
  sessionAffinity: false,
  affinityTtlSeconds: 600,
  failover: true,
  maxAttempts: 2,
  streamingFirstByteTimeout: 60,
  streamingIdleTimeout: 180,
  nonStreamingTimeout: 600,
  rules: [],
};
beforeEach(() => {
  vi.restoreAllMocks();
  i18n.addResourceBundle(
    i18n.language,
    "translation",
    { access: zh.access, ledger: zh.ledger },
    true,
    true,
  );
  vi.spyOn(accessApi, "bindings").mockResolvedValue([]);
  vi.spyOn(accessApi, "projects").mockResolvedValue([]);
  vi.spyOn(gatewayApi, "getCatalog").mockResolvedValue({
    revision: 1,
    suppliers: [],
    policies: [],
    groups: [group],
  });
  vi.spyOn(accessApi, "issue").mockImplementation(async (binding) => ({
    binding: { ...binding, id: "test-binding" },
    token: "test-only-token",
  }));
  vi.spyOn(clipboard, "copyText").mockResolvedValue();
});
function openForm() {
  renderWithQueryClient(<AccessBindings />);
  fireEvent.click(screen.getByRole("button", { name: zh.access.advanced }));
  fireEvent.click(screen.getByRole("button", { name: zh.access.create }));
  const dialog = screen.getByRole("dialog");
  fireEvent.change(within(dialog).getByLabelText(zh.ledger.name), {
    target: { value: " Cline " },
  });
  fireEvent.change(within(dialog).getByLabelText(zh.access.agent), {
    target: { value: " cline " },
  });
  return dialog;
}

describe("optional local client access", () => {
  it("keeps manual tokens out of the normal flow and explains the boundary", () => {
    renderWithQueryClient(<AccessBindings />);
    expect(screen.getByText(zh.access.automaticHint)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: zh.access.create }),
    ).not.toBeInTheDocument();
    expect(accessApi.bindings).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: zh.access.advanced }));
    expect(screen.getByText(zh.access.boundary)).toBeInTheDocument();
  });

  it("guards keyboard submission while prerequisite data is loading", () => {
    vi.mocked(accessApi.projects).mockReturnValue(new Promise(() => {}));
    const dialog = openForm();
    expect(
      within(dialog).getByRole("button", { name: zh.access.issue }),
    ).toBeDisabled();
    fireEvent.submit(dialog.querySelector("form")!);
    expect(accessApi.issue).not.toHaveBeenCalled();
  });

  it("recovers from a failed prerequisite read and copies the issued token", async () => {
    vi.mocked(accessApi.projects)
      .mockRejectedValueOnce(new Error("storage unavailable"))
      .mockResolvedValue([]);
    const dialog = openForm();
    const retry = await within(dialog).findByRole("button", {
      name: zh.access.retry,
    });
    expect(
      within(dialog).getByRole("button", { name: zh.access.issue }),
    ).toBeDisabled();
    fireEvent.submit(dialog.querySelector("form")!);
    expect(accessApi.issue).not.toHaveBeenCalled();
    fireEvent.click(retry);
    const submit = within(dialog).getByRole("button", {
      name: zh.access.issue,
    });
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);
    await screen.findByDisplayValue("test-only-token");
    expect(accessApi.issue).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Cline",
        agent: "cline",
        allowedGroups: [],
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: zh.access.copy }));
    await screen.findByRole("button", { name: zh.access.copied });
    expect(clipboard.copyText).toHaveBeenCalledWith("test-only-token");
    fireEvent.click(screen.getByRole("button", { name: zh.access.done }));
    await waitFor(() =>
      expect(
        screen.queryByDisplayValue("test-only-token"),
      ).not.toBeInTheDocument(),
    );
  });

  it("does not broaden selected scope when the protocol changes", async () => {
    const user = userEvent.setup();
    const dialog = openForm();
    const submit = within(dialog).getByRole("button", {
      name: zh.access.issue,
    });
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(within(dialog).getByLabelText(zh.access.scope));
    await user.click(
      screen.getByRole("option", { name: zh.access.selectedGroups }),
    );
    expect(submit).toBeDisabled();
    fireEvent.submit(dialog.querySelector("form")!);
    expect(accessApi.issue).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("checkbox", { name: "Coding" }));
    expect(submit).toBeEnabled();
    await user.click(within(dialog).getByLabelText(zh.access.protocol));
    await user.click(
      screen.getByRole("option", { name: "Anthropic Messages" }),
    );
    expect(within(dialog).getByLabelText(zh.access.scope)).toHaveTextContent(
      zh.access.selectedGroups,
    );
    expect(submit).toBeDisabled();
    expect(within(dialog).getByText(zh.access.noGroups)).toBeInTheDocument();
    fireEvent.submit(dialog.querySelector("form")!);
    expect(accessApi.issue).not.toHaveBeenCalled();
    await user.click(within(dialog).getByLabelText(zh.access.protocol));
    await user.click(
      screen.getByRole("option", { name: "OpenAI Chat / Responses" }),
    );
    await user.click(within(dialog).getByRole("checkbox", { name: "Coding" }));
    await user.click(submit);
    await waitFor(() =>
      expect(accessApi.issue).toHaveBeenCalledWith(
        expect.objectContaining({
          tool: "codex",
          allowedGroups: ["codex-group"],
        }),
      ),
    );
  });

  it("keeps the form and input after issuing fails", async () => {
    vi.mocked(accessApi.issue).mockRejectedValue(new Error("write failed"));
    const dialog = openForm();
    const submit = within(dialog).getByRole("button", {
      name: zh.access.issue,
    });
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);
    await within(dialog).findByText("Error: write failed");
    expect(within(dialog).getByLabelText(zh.ledger.name)).toHaveValue(
      " Cline ",
    );
    expect(
      screen.queryByDisplayValue("test-only-token"),
    ).not.toBeInTheDocument();
    expect(submit).toBeEnabled();
  });
});
