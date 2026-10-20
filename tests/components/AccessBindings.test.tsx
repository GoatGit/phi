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
import { accessApi, type AccessBinding } from "@/lib/api/access";
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

/** 一个没有任何外部协议入口的组：三方应用不能选它。 */
const asideGroup: GatewayRouteGroup = {
  ...group,
  id: "aside-group",
  name: "Aside",
  appIds: ["unrelated-app"],
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

/** 打开新建弹窗并填好名称。三方应用就是一枚接入令牌，只有一个名称字段。 */
function openForm() {
  renderWithQueryClient(<AccessBindings />);
  fireEvent.click(screen.getByRole("button", { name: zh.access.create }));
  const dialog = screen.getByRole("dialog");
  fireEvent.change(within(dialog).getByLabelText(zh.access.keyName), {
    target: { value: " Cline " },
  });
  return dialog;
}

/** 等目录查询落地：可选路由组来自它，提交按钮要等它成功才可用。 */
async function waitForGroups(dialog: HTMLElement) {
  return within(dialog).findByRole("checkbox", { name: "Coding" });
}

describe("third-party app access", () => {
  it("lists third-party apps as apps rather than a hidden advanced flow", () => {
    renderWithQueryClient(<AccessBindings />);
    expect(
      screen.getByRole("heading", { name: zh.access.title }),
    ).toBeInTheDocument();
    expect(screen.getByText(zh.access.description)).toBeInTheDocument();
    expect(screen.getByText(zh.access.boundary)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: zh.access.create }),
    ).toBeInTheDocument();
  });

  it("guards keyboard submission while nothing is named", () => {
    renderWithQueryClient(<AccessBindings />);
    fireEvent.click(screen.getByRole("button", { name: zh.access.create }));
    const dialog = screen.getByRole("dialog");
    // 没有任何可选路由组时提交按钮保持禁用：请求在流转图上会没有路线可画。
    expect(
      within(dialog).getByRole("button", { name: zh.access.issue }),
    ).toBeDisabled();
    fireEvent.submit(dialog.querySelector("form")!);
    expect(accessApi.issue).not.toHaveBeenCalled();
  });

  it("recovers from a failed catalog read and copies the issued token", async () => {
    vi.mocked(gatewayApi.getCatalog)
      .mockRejectedValueOnce(new Error("storage unavailable"))
      .mockResolvedValue({
        revision: 1,
        suppliers: [],
        policies: [],
        groups: [group],
      });
    const dialog = openForm();
    const retry = await within(dialog).findByRole("button", {
      name: zh.access.retry,
    });
    expect(
      within(dialog).getByRole("button", { name: zh.access.issue }),
    ).toBeDisabled();
    fireEvent.click(retry);
    await waitFor(() => expect(accessApi.issue).not.toHaveBeenCalled());
    await userEvent.click(await waitForGroups(dialog));
    const submit = within(dialog).getByRole("button", {
      name: zh.access.issue,
    });
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);
    await screen.findByDisplayValue("test-only-token");
    expect(accessApi.issue).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Cline",
        // 没填渠道标识时用应用名，用量记录才分得清是哪一方。
        agent: "Cline",
        tool: "external",
        allowedGroups: ["codex-group"],
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

  it("only offers route groups that an external entry can use", async () => {
    vi.mocked(gatewayApi.getCatalog).mockResolvedValue({
      revision: 1,
      suppliers: [],
      policies: [],
      groups: [group, asideGroup],
    });
    const dialog = openForm();
    expect(await waitForGroups(dialog)).toBeInTheDocument();
    expect(
      within(dialog).queryByRole("checkbox", { name: "Aside" }),
    ).not.toBeInTheDocument();
  });

  it("keeps the form and input after issuing fails", async () => {
    vi.mocked(accessApi.issue).mockRejectedValue(new Error("write failed"));
    const dialog = openForm();
    await userEvent.click(await waitForGroups(dialog));
    const submit = within(dialog).getByRole("button", {
      name: zh.access.issue,
    });
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);
    await within(dialog).findByText("Error: write failed");
    expect(within(dialog).getByLabelText(zh.access.keyName)).toHaveValue(
      " Cline ",
    );
    expect(
      screen.queryByDisplayValue("test-only-token"),
    ).not.toBeInTheDocument();
    expect(submit).toBeEnabled();
  });

  it("deletes a third-party app through the shared confirmation", async () => {
    const binding: AccessBinding = {
      id: "binding-1",
      name: "Cursor",
      agent: "Cursor",
      tool: "external",
      projectId: null,
      allowedGroups: ["codex-group"],
      enabled: true,
    };
    vi.mocked(accessApi.bindings).mockResolvedValue([binding]);
    const remove = vi.spyOn(accessApi, "remove").mockResolvedValue(undefined);
    renderWithQueryClient(<AccessBindings />);
    fireEvent.click(
      await screen.findByRole("button", { name: zh.access.delete }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(zh.access.deleteTitle)).toBeInTheDocument();
    // 确认框里的按钮也叫「删除」，取最后一个（弹窗内）。
    const confirm = within(dialog)
      .getAllByRole("button", { name: zh.access.delete })
      .pop();
    fireEvent.click(confirm!);
    await waitFor(() => expect(remove).toHaveBeenCalledWith("binding-1"));
  });
});
