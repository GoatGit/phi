import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom";
import type { ComponentProps } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SettingsPage } from "@/components/settings/SettingsPage";

const toastSuccessMock = vi.fn();
const toastErrorMock = vi.fn();

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccessMock(...args),
    error: (...args: unknown[]) => toastErrorMock(...args),
  },
}));

const tMock = vi.fn((key: string) => key);
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: tMock }),
}));

vi.mock("@/components/theme-provider", () => ({
  useTheme: () => ({ theme: "system", setTheme: vi.fn() }),
}));

interface SettingsMock {
  settings: any;
  isLoading: boolean;
  isSaving: boolean;
  isPortable: boolean;
  appConfigDir?: string;
  initialAppConfigDir?: string;
  resolvedDirs: Record<string, string>;
  requiresRestart: boolean;
  updateSettings: ReturnType<typeof vi.fn>;
  updateDirectory: ReturnType<typeof vi.fn>;
  updateAppConfigDir: ReturnType<typeof vi.fn>;
  browseDirectory: ReturnType<typeof vi.fn>;
  browseAppConfigDir: ReturnType<typeof vi.fn>;
  resetDirectory: ReturnType<typeof vi.fn>;
  resetAppConfigDir: ReturnType<typeof vi.fn>;
  saveSettings: ReturnType<typeof vi.fn>;
  autoSaveSettings: ReturnType<typeof vi.fn>;
  resetSettings: ReturnType<typeof vi.fn>;
  acknowledgeRestart: ReturnType<typeof vi.fn>;
}

const savedSettings = {
  showInTray: true,
  minimizeToTrayOnClose: true,
  enableClaudePluginIntegration: false,
  language: "zh",
  claudeConfigDir: "/claude",
  codexConfigDir: "/codex",
};

const createSettingsMock = (overrides: Partial<SettingsMock> = {}) => {
  const base: SettingsMock = {
    settings: { ...savedSettings },
    isLoading: false,
    isSaving: false,
    isPortable: false,
    appConfigDir: "/app-config",
    initialAppConfigDir: "/app-config",
    resolvedDirs: {
      appConfig: "/app-config",
      claude: "/claude",
      codex: "/codex",
    },
    requiresRestart: false,
    updateSettings: vi.fn(),
    updateDirectory: vi.fn(),
    updateAppConfigDir: vi.fn(),
    browseDirectory: vi.fn(),
    browseAppConfigDir: vi.fn(),
    resetDirectory: vi.fn(),
    resetAppConfigDir: vi.fn(),
    saveSettings: vi.fn().mockResolvedValue({ requiresRestart: false }),
    autoSaveSettings: vi.fn().mockResolvedValue({ requiresRestart: false }),
    resetSettings: vi.fn(),
    acknowledgeRestart: vi.fn(),
  };

  return { ...base, ...overrides };
};

const createImportExportMock = () => ({
  selectedFile: "/tmp/config.sql",
  status: "idle",
  errorMessage: null,
  backupId: null,
  isImporting: false,
  selectImportFile: vi.fn(),
  importConfig: vi.fn(),
  exportConfig: vi.fn(),
  clearSelection: vi.fn(),
  resetStatus: vi.fn(),
});

let settingsMock = createSettingsMock();
let importExportMock = createImportExportMock();
const useImportExportSpy = vi.fn();

vi.mock("@/hooks/useSettings", () => ({
  useSettings: () => settingsMock,
}));

vi.mock("@/hooks/useImportExport", () => ({
  useImportExport: (options?: Record<string, unknown>) =>
    useImportExportSpy(options),
}));

vi.mock("@/lib/query", () => ({
  useSettingsQuery: () => ({ data: savedSettings }),
}));

const restartMock = vi.fn().mockResolvedValue(true);
vi.mock("@/lib/api", () => ({
  settingsApi: {
    restart: (...args: unknown[]) => restartMock(...args),
  },
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: any) =>
    open ? <div data-testid="dialog-root">{children}</div> : null,
  DialogContent: ({ children }: any) => <div>{children}</div>,
  DialogHeader: ({ children }: any) => <div>{children}</div>,
  DialogFooter: ({ children }: any) => <div>{children}</div>,
  DialogTitle: ({ children }: any) => <h2>{children}</h2>,
  DialogDescription: ({ children }: any) => <div>{children}</div>,
  DialogClose: ({ children }: any) => <>{children}</>,
}));

vi.mock("@/components/settings/AboutSection", () => ({
  AboutSection: ({ isPortable }: any) => <div>about:{String(isPortable)}</div>,
}));
vi.mock("@/components/settings/BackupListSection", () => ({
  BackupListSection: () => <div>backup-list-section</div>,
}));
vi.mock("@/components/settings/LogConfigPanel", () => ({
  LogConfigPanel: () => <div>log-config-panel</div>,
}));
vi.mock("@/components/settings/ProxyTabContent", () => ({
  ProxyTabContent: () => <div>proxy-tab-content</div>,
}));
vi.mock("@/components/settings/GlobalProxySettings", () => ({
  GlobalProxySettings: () => <div>global-proxy-settings</div>,
}));
vi.mock("@/components/settings/CodexAuthSettings", () => ({
  CodexAuthSettings: () => <div>codex-auth-settings</div>,
}));

const renderSettingsPage = (
  props?: Partial<ComponentProps<typeof SettingsPage>>,
) => {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  const allProps = {
    section: "general" as const,
    onSelectSection: vi.fn(),
    onOpenApps: vi.fn(),
    ...props,
  };
  const view = render(
    <QueryClientProvider client={client}>
      <SettingsPage {...allProps} />
    </QueryClientProvider>,
  );
  return {
    ...view,
    props: allProps,
    rerenderWith: (next: Partial<ComponentProps<typeof SettingsPage>>) =>
      view.rerender(
        <QueryClientProvider client={client}>
          <SettingsPage {...allProps} {...next} />
        </QueryClientProvider>,
      ),
  };
};

describe("SettingsPage", () => {
  beforeEach(() => {
    tMock.mockImplementation((key: string) => key);
    settingsMock = createSettingsMock();
    importExportMock = createImportExportMock();
    useImportExportSpy.mockReset();
    useImportExportSpy.mockImplementation(() => importExportMock);
    toastSuccessMock.mockReset();
    toastErrorMock.mockReset();
    restartMock.mockClear();
  });

  it("shows a spinner instead of the form while loading", () => {
    settingsMock = createSettingsMock({ settings: null, isLoading: true });

    renderSettingsPage();

    expect(
      screen.queryByText("settings.general.appearance"),
    ).not.toBeInTheDocument();
    expect(document.querySelector(".animate-spin")).toBeInTheDocument();
  });

  // 页头与用量页一致：左侧直接是页签行，不放图标与页面标题
  it("keeps the header title-less like the usage page", () => {
    renderSettingsPage({ section: "network" });

    expect(
      screen.getByRole("tablist", { name: "nav.settings" }),
    ).toBeInTheDocument();
    // 标题槽位仍由 AppPageHeader 渲染（空 h1 是为保持布局），但不带任何文字
    expect(
      screen.queryByRole("heading", { level: 1, name: "nav.settings" }),
    ).toBeNull();
    // 分区只在页内标签上露面（且有该分区的测试不传 expertMode，
    // network 属高级分区，内容仍按传入的 section 渲染）
    expect(screen.getByText("global-proxy-settings")).toBeInTheDocument();
  });

  it("switches sections with in-page tabs instead of leaving the page", () => {
    const { props } = renderSettingsPage({ section: "general" });

    const tabs = screen.getAllByRole("tab").map((tab) => tab.textContent);
    // 授权中心已取消：不再有 auth 页签
    expect(tabs).toEqual([
      "settings.sections.general",
      "nav.apps",
      "settings.sections.routing",
      "settings.sections.data",
      "settings.sections.about",
    ]);
    // 专家模式关掉时高级分区（网络）不出标签
    expect(
      screen.queryByRole("tab", { name: "settings.sections.network" }),
    ).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "nav.apps" }));
    expect(props.onSelectSection).toHaveBeenCalledWith("apps");
  });

  it("shows the expert-only section as a tab in expert mode", () => {
    renderSettingsPage({ section: "network", expertMode: true });

    expect(
      screen.getByRole("tab", { name: "settings.sections.network" }),
    ).toHaveAttribute("aria-selected", "true");
  });

  it("saves general switches immediately and links to the Apps page", async () => {
    const { props } = renderSettingsPage();

    fireEvent.click(
      screen.getByRole("switch", { name: "settings.minimizeToTray" }),
    );
    expect(settingsMock.updateSettings).toHaveBeenCalledWith({
      minimizeToTrayOnClose: false,
    });
    await waitFor(() =>
      expect(settingsMock.autoSaveSettings).toHaveBeenCalledWith({
        minimizeToTrayOnClose: false,
      }),
    );

    fireEvent.click(
      screen.getByRole("switch", { name: "settings.general.checkToolUpdates" }),
    );
    await waitFor(() =>
      expect(settingsMock.autoSaveSettings).toHaveBeenCalledWith({
        checkToolUpdatesOnStartup: true,
      }),
    );

    fireEvent.click(
      screen.getByRole("button", { name: /settings\.general\.goToApps/ }),
    );
    expect(props.onOpenApps).toHaveBeenCalledTimes(1);
  });

  it("rolls a failed autosave back and reports it", async () => {
    settingsMock = createSettingsMock({
      autoSaveSettings: vi.fn().mockRejectedValue(new Error("disk full")),
    });

    renderSettingsPage();
    fireEvent.click(
      screen.getByRole("switch", { name: "settings.minimizeToTray" }),
    );

    await waitFor(() =>
      expect(settingsMock.updateSettings).toHaveBeenLastCalledWith({
        minimizeToTrayOnClose: true,
      }),
    );
    expect(toastErrorMock).toHaveBeenCalledWith("settings.saveFailedGeneric");
  });

  it("keeps local data tools and excludes cloud sync from the data section", () => {
    renderSettingsPage({ section: "data" });

    fireEvent.click(screen.getByRole("button", { name: /settings\.import/ }));
    expect(importExportMock.importConfig).toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "settings.exportConfig" }),
    );
    expect(importExportMock.exportConfig).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "common.clear" }));
    expect(importExportMock.clearSelection).toHaveBeenCalled();

    expect(screen.getByText("backup-list-section")).toBeInTheDocument();
    expect(screen.getByText("log-config-panel")).toBeInTheDocument();
  });

  it("passes onImportSuccess through to the import hook", () => {
    const onImportSuccess = vi.fn();

    renderSettingsPage({ onImportSuccess });

    expect(useImportExportSpy).toHaveBeenCalledWith(
      expect.objectContaining({ onImportSuccess }),
    );
  });

  it("drives the per-app config dialog: browse/reset/save only when dirty", async () => {
    const { ConfigDirectoryDialog } = await import(
      "@/components/app/ConfigDirectoryDialog"
    );
    const view = render(
      <QueryClientProvider client={new QueryClient()}>
        <ConfigDirectoryDialog app="codex" open onOpenChange={vi.fn()} />
      </QueryClientProvider>,
    );
    const rerenderDialog = () =>
      view.rerender(
        <QueryClientProvider client={new QueryClient()}>
          <ConfigDirectoryDialog app="codex" open onOpenChange={vi.fn()} />
        </QueryClientProvider>,
      );

    // 应用专属开关（Codex 会话压缩）在弹窗里
    expect(screen.getByText("codex-auth-settings")).toBeInTheDocument();
    // 没改过目录：没有保存按钮
    expect(
      screen.queryByRole("button", { name: "common.save" }),
    ).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "settings.browseDirectory" }),
    );
    expect(settingsMock.browseDirectory).toHaveBeenCalledWith("codex");
    fireEvent.click(
      screen.getByRole("button", { name: "settings.resetDefault" }),
    );
    expect(settingsMock.resetDirectory).toHaveBeenCalledWith("codex");

    // 目录改动后出现保存按钮，保存走 saveSettings
    settingsMock = createSettingsMock({
      settings: { ...savedSettings, codexConfigDir: "/new/codex" },
    });
    rerenderDialog();
    fireEvent.click(screen.getByRole("button", { name: "common.save" }));
    await waitFor(() =>
      expect(settingsMock.saveSettings).toHaveBeenCalledTimes(1),
    );
  });

  it("asks to restart after moving the data directory", async () => {
    settingsMock = createSettingsMock({
      appConfigDir: "/moved",
      saveSettings: vi.fn().mockResolvedValue({ requiresRestart: true }),
    });

    renderSettingsPage({ section: "data" });
    fireEvent.click(screen.getByRole("button", { name: "common.save" }));

    expect(
      await screen.findByText("settings.restartRequired"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByText("settings.restartNow"));

    await waitFor(() => {
      expect(toastSuccessMock).toHaveBeenCalledWith(
        "settings.devModeRestartHint",
        expect.objectContaining({ closeButton: true }),
      );
    });
  });

  it("lets the restart wait", async () => {
    settingsMock = createSettingsMock({ requiresRestart: true });

    renderSettingsPage();

    expect(
      await screen.findByText("settings.restartRequired"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByText("settings.restartLater"));

    await waitFor(() =>
      expect(settingsMock.acknowledgeRestart).toHaveBeenCalledTimes(1),
    );
    expect(restartMock).not.toHaveBeenCalled();
    expect(screen.queryByText("settings.restartRequired")).toBeNull();
  });

  it("scrolls back to the top when the section changes", () => {
    const { container, rerenderWith } = renderSettingsPage();
    const scrollContainer = container.querySelector(
      "#main-content",
    ) as HTMLDivElement;

    scrollContainer.scrollTop = 640;
    rerenderWith({ section: "about" });

    expect(scrollContainer.scrollTop).toBe(0);
    expect(screen.getByText("about:false")).toBeInTheDocument();
  });
});
