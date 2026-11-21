import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  settings: undefined as { firstRunNoticeConfirmed?: boolean } | undefined,
}));

vi.mock("@/lib/api", () => ({
  settingsApi: { save: mocks.save },
}));
vi.mock("@/lib/query", () => ({
  useSettingsQuery: () => ({ data: mocks.settings }),
}));
vi.mock("@tauri-apps/api/app", () => ({
  getVersion: async () => "1.2.3",
}));

import { FirstRunNoticeDialog } from "@/components/FirstRunNoticeDialog";

function Harness({ client }: { client: QueryClient }) {
  return (
    <QueryClientProvider client={client}>
      <FirstRunNoticeDialog />
    </QueryClientProvider>
  );
}

function renderDialog() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return { client, ...render(<Harness client={client} />) };
}

describe("FirstRunNoticeDialog", () => {
  beforeEach(() => {
    mocks.settings = { firstRunNoticeConfirmed: undefined };
    mocks.save.mockReset().mockResolvedValue(true);
  });

  it("shows the two things PHI did on a fresh install", async () => {
    renderDialog();
    expect(await screen.findByText("firstRunNotice.title")).toBeInTheDocument();
    // 说明拆成「保留原配置」和「随时切回官方」两条，标题与解释分开渲染
    expect(screen.getByText("firstRunNotice.keepTitle")).toBeInTheDocument();
    expect(
      screen.getByText("firstRunNotice.officialTitle"),
    ).toBeInTheDocument();
    expect(screen.getByText("firstRunNotice.keepBody")).toBeInTheDocument();
    expect(screen.getByText("firstRunNotice.officialBody")).toBeInTheDocument();
  });

  it("records the confirmation and closes", async () => {
    const view = renderDialog();
    fireEvent.click(
      await screen.findByRole("button", { name: "firstRunNotice.confirm" }),
    );
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({
        firstRunNoticeConfirmed: true,
        newLayoutNoticeConfirmed: true,
        whatsNewSeenVersion: "1.2.3",
      }),
    );
    // 保存后重新读到 confirmed，弹窗不再出现
    mocks.settings = { firstRunNoticeConfirmed: true };
    view.rerender(<Harness client={view.client} />);
    expect(screen.queryByText("firstRunNotice.title")).not.toBeInTheDocument();
  });

  it("stays closed once the user has confirmed", () => {
    mocks.settings = { firstRunNoticeConfirmed: true };
    renderDialog();
    expect(screen.queryByText("firstRunNotice.title")).not.toBeInTheDocument();
    expect(mocks.save).not.toHaveBeenCalled();
  });
});
