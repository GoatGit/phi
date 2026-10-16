import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ConfigDirectoryDialog } from "@/components/app/ConfigDirectoryDialog";
import type { ResolvedDirectories } from "@/hooks/useSettings";
import type { Settings } from "@/types";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/lib/api", () => ({
  settingsApi: {
    getCodexSessionCompression: vi.fn().mockResolvedValue(false),
    getCodexSessionsDiskUsage: vi.fn().mockResolvedValue(0),
    hasCodexUnifyHistoryBackup: vi.fn().mockResolvedValue(false),
    restoreCodexUnifiedHistory: vi.fn(),
    codexForcesMultiAgentV2: vi.fn().mockResolvedValue(false),
  },
}));

vi.mock("@/hooks/useSettings", () => ({
  useSettings: () => ({
    settings: draftSettings,
    resolvedDirs: resolvedDirs,
    isSaving: false,
    updateSettings: vi.fn(),
    updateDirectory: vi.fn(),
    browseDirectory: vi.fn(),
    resetDirectory: vi.fn(),
    saveSettings: vi.fn().mockResolvedValue(true),
  }),
}));

vi.mock("@/lib/query", () => ({
  useSettingsQuery: () => ({ data: savedSettings }),
}));

/** 已保存状态：目录为空（走默认路径） */
const savedSettings: Partial<Settings> = {};

/** 表单草稿；用例里按需覆盖 codexConfigDir 制造 dirty */
let draftSettings: Partial<Settings>;

const resolvedDirs: ResolvedDirectories = {
  claude: "/Users/default/.claude",
  codex: "/Users/default/.codex",
  gemini: "/Users/default/.gemini",
  grokbuild: "/Users/default/.grok",
  opencode: "/Users/default/.opencode",
  openclaw: "/Users/default/.openclaw",
  hermes: "/Users/default/.hermes",
  pi: "/Users/default/.pi",
} as ResolvedDirectories;

async function renderDialog() {
  const onOpenChange = vi.fn();
  await act(async () => {
    render(
      <ConfigDirectoryDialog app="codex" open onOpenChange={onOpenChange} />,
    );
  });
  return onOpenChange;
}

describe("ConfigDirectoryDialog", () => {
  it("目录未改动时没有保存按钮，但保留可见的关闭按钮", async () => {
    draftSettings = {};
    await renderDialog();

    expect(screen.queryByText("common.save")).not.toBeInTheDocument();
    const closeButton = screen.getByRole("button", { name: "common.close" });
    expect(closeButton).toBeEnabled();
  });

  it("点击关闭按钮会请求关闭弹窗（遮罩点击已被全局禁用）", async () => {
    draftSettings = {};
    const onOpenChange = await renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "common.close" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("目录草稿与已保存值不同时出现保存按钮，关闭按钮仍可用", async () => {
    draftSettings = { codexConfigDir: "/tmp/other-codex" };
    await renderDialog();

    expect(screen.getByText("common.save")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "common.close" }),
    ).toBeEnabled();
  });
});
