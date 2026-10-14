import {
  act,
  render,
  renderHook,
  screen,
  waitFor,
  fireEvent,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import i18n from "i18next";
import zh from "@/i18n/locales/zh.json";
import type { AppId } from "@/lib/api";
import { terminalApi, type TerminalSession } from "@/lib/api/terminal";
import {
  AppTerminalTabs,
  TerminalCloseDialog,
} from "@/components/terminal/AppTerminalTabs";
import { TerminalLaunchDialog } from "@/components/terminal/TerminalLaunchDialog";
import { TerminalPane } from "@/components/terminal/TerminalPane";
import {
  terminalOverlays,
  focusNativeTerminal,
} from "@/components/terminal/presentation";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
} from "@/components/ui/dropdown-menu";
import {
  TERMINAL_THEME_KEY,
  TerminalThemeMenu,
} from "@/components/terminal/TerminalThemeMenu";
import {
  mergeTerminalSession,
  useTerminalWorkspace,
} from "@/components/terminal/useTerminalWorkspace";

const native = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  pick: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name, callback) => {
    native.listeners.set(name, callback);
    return () => native.listeners.delete(name);
  }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: native.pick }));
vi.mock("@/lib/api/terminal", () => ({
  terminalApi: {
    capabilities: vi.fn(),
    list: vi.fn(),
    create: vi.fn(),
    close: vi.fn(),
    restart: vi.fn(),
    present: vi.fn(),
  },
}));

function snapshot(
  id = "s1",
  appId: AppId = "claude",
  phase: TerminalSession["phase"] = "running",
): TerminalSession {
  return {
    id,
    appId,
    title: "phi",
    launchCwd: "/tmp/phi",
    launchArgs: "",
    phase,
    generation: 1,
    sequence: 2,
    errorCode: null,
  };
}
function emit(session: TerminalSession) {
  native.listeners.get("terminal://changed")?.({ payload: session });
}
const canLeave = () => false;
function ThemeMenu() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label="应用更多操作">…</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuGroup>
          <TerminalThemeMenu />
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
function LaunchWorkspace() {
  const workspace = useTerminalWorkspace("claude", true, canLeave);
  return (
    <>
      <AppTerminalTabs app="claude" workspace={workspace} />
      <TerminalLaunchDialog workspace={workspace} />
    </>
  );
}
beforeEach(() => {
  native.listeners.clear();
  localStorage.clear();
  i18n.addResourceBundle("zh", "translation", zh, true, true);
  vi.mocked(terminalApi.capabilities).mockResolvedValue({
    supported: true,
    apps: ["claude", "codex"],
    defaultCwd: "/tmp/phi",
  });
  vi.mocked(terminalApi.list).mockResolvedValue([]);
  vi.mocked(terminalApi.present).mockResolvedValue();
  vi.mocked(terminalApi.close).mockResolvedValue();
  vi.mocked(terminalApi.create).mockResolvedValue(snapshot());
  Element.prototype.scrollIntoView = vi.fn();
});

describe("terminal workspaces", () => {
  it("excludes real popper bounds but ignores empty, closed, and hidden overlays", () => {
    const terminalBounds = {
      x: 100,
      y: 50,
      width: 800,
      height: 500,
    } as DOMRect;
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
      terminalBounds,
    ] as unknown as DOMRectList);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 750,
      y: 40,
      width: 220,
      height: 100,
    } as DOMRect);
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-radix-popper-content-wrapper", "");
    document.body.append(wrapper);
    expect(terminalOverlays(terminalBounds)).toEqual({
      overlays: [],
      blocked: false,
      dimmed: false,
    });
    const content = document.createElement("div");
    content.dataset.state = "delayed-open";
    content.innerHTML = '<span role="tooltip">Theme</span>';
    wrapper.append(content);
    expect(terminalOverlays(terminalBounds)).toEqual({
      overlays: [{ x: 644, y: 0, width: 156, height: 96 }],
      blocked: false,
      dimmed: false,
    });
    content.dataset.state = "closed";
    expect(terminalOverlays(terminalBounds).overlays).toEqual([]);
    content.dataset.state = "open";
    wrapper.hidden = true;
    expect(terminalOverlays(terminalBounds).blocked).toBe(false);
    wrapper.remove();
    vi.restoreAllMocks();
  });

  it("restores focus after menu dismissal and window activation without hiding or restarting", async () => {
    const rect = { x: 100, y: 50, width: 800, height: 500 } as DOMRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      rect,
    );
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
      rect,
    ] as unknown as DOMRectList);
    const { unmount } = render(
      <TerminalPane
        session={snapshot()}
        onDirectory={vi.fn()}
        onRestart={vi.fn()}
        onInstall={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(terminalApi.present).toHaveBeenCalledWith(
        expect.objectContaining({ focus: true, visible: true }),
      ),
    );
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    document.body.append(menu);
    await waitFor(() =>
      expect(terminalApi.present).toHaveBeenLastCalledWith(
        expect.objectContaining({ visible: true, focus: false, blocked: true }),
      ),
    );
    fireEvent(window, new Event("focus"));
    await waitFor(() =>
      expect(terminalApi.present).toHaveBeenLastCalledWith(
        expect.objectContaining({ focus: false, blocked: true }),
      ),
    );
    menu.remove();
    await waitFor(() =>
      expect(terminalApi.present).toHaveBeenLastCalledWith(
        expect.objectContaining({ focus: true, blocked: false, overlays: [] }),
      ),
    );
    vi.mocked(terminalApi.present).mockClear();
    fireEvent(window, new Event("focus"));
    await waitFor(() =>
      expect(terminalApi.present).toHaveBeenCalledWith(
        expect.objectContaining({ focus: true }),
      ),
    );
    vi.mocked(terminalApi.present).mockClear();
    act(() => focusNativeTerminal());
    await waitFor(() =>
      expect(terminalApi.present).toHaveBeenCalledWith(
        expect.objectContaining({ focus: true }),
      ),
    );
    expect(terminalApi.present).not.toHaveBeenCalledWith(
      expect.objectContaining({ visible: false }),
    );
    expect(terminalApi.restart).not.toHaveBeenCalled();
    unmount();
    vi.restoreAllMocks();
  });
  it("opens setup before launch and cancellation never starts a process", async () => {
    render(<LaunchWorkspace />);
    await waitFor(() => expect(terminalApi.list).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "新建终端" }));
    expect(screen.getByLabelText("工作区目录")).toHaveValue("/tmp/phi");
    expect(screen.getByLabelText("命令参数（可选）")).toHaveValue("");
    expect(terminalApi.create).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(terminalApi.create).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "t", metaKey: true });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(terminalApi.create).not.toHaveBeenCalled();
  });

  it("uses the system directory picker and sends parameters only after confirmation", async () => {
    render(<LaunchWorkspace />);
    await waitFor(() => expect(terminalApi.list).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "新建终端" }));
    native.pick
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("/tmp/中文 项目");
    fireEvent.click(screen.getByRole("button", { name: "选择目录" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "选择目录" })).toBeEnabled(),
    );
    expect(screen.getByLabelText("工作区目录")).toHaveValue("/tmp/phi");
    fireEvent.click(screen.getByRole("button", { name: "选择目录" }));
    await waitFor(() =>
      expect(screen.getByLabelText("工作区目录")).toHaveValue("/tmp/中文 项目"),
    );
    fireEvent.change(screen.getByLabelText("命令参数（可选）"), {
      target: { value: '--model "test model" --resume' },
    });
    expect(terminalApi.create).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "启动 CLI" }));
    await waitFor(() =>
      expect(terminalApi.create).toHaveBeenCalledWith(
        "claude",
        "/tmp/中文 项目",
        '--model "test model" --resume',
      ),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it("keeps invalid inputs editable and locks submission until creation completes", async () => {
    render(<LaunchWorkspace />);
    await waitFor(() => expect(terminalApi.list).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "新建终端" }));
    fireEvent.change(screen.getByLabelText("工作区目录"), {
      target: { value: "" },
    });
    expect(screen.getByRole("button", { name: "启动 CLI" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("工作区目录"), {
      target: { value: "/tmp/项目" },
    });
    fireEvent.change(screen.getByLabelText("命令参数（可选）"), {
      target: { value: '"unclosed' },
    });
    vi.mocked(terminalApi.create).mockRejectedValueOnce("invalid-arguments");
    fireEvent.click(screen.getByRole("button", { name: "启动 CLI" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("参数格式无效");
    expect(screen.getByLabelText("命令参数（可选）")).toHaveValue('"unclosed');
    fireEvent.change(screen.getByLabelText("命令参数（可选）"), {
      target: { value: "--resume" },
    });
    let resolve!: (value: TerminalSession) => void;
    vi.mocked(terminalApi.create).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "启动 CLI" }));
    expect(screen.getByLabelText("工作区目录")).toBeDisabled();
    expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("dialog"), {
      key: "Escape",
      code: "Escape",
    });
    fireEvent.submit(document.querySelector("#terminal-launch-form")!);
    expect(terminalApi.create).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await act(async () => resolve(snapshot()));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("native new-tab actions also require setup and retain the current arguments", async () => {
    vi.mocked(terminalApi.list).mockResolvedValueOnce([
      { ...snapshot(), launchArgs: "--resume" },
    ]);
    const { result } = renderHook(() =>
      useTerminalWorkspace("claude", true, canLeave),
    );
    await waitFor(() => expect(result.current.sessions).toHaveLength(1));
    act(() => result.current.select("s1"));
    act(() =>
      native.listeners.get("terminal://action")?.({
        payload: { id: "s1", action: "new" },
      }),
    );
    expect(result.current.launchDraft).toEqual({
      appId: "claude",
      cwd: "/tmp/phi",
      arguments: "--resume",
    });
    expect(terminalApi.create).not.toHaveBeenCalled();
  });
  it("retains each application's sessions and pinned configuration without closing processes", async () => {
    const { result, rerender } = renderHook(
      ({ app, visible }) => useTerminalWorkspace(app, visible, canLeave),
      { initialProps: { app: "claude" as AppId, visible: true } },
    );
    await waitFor(() => expect(result.current.supported).toBe(true));
    act(() => result.current.newTerminal());
    await act(() => result.current.startTerminal("/tmp/phi", ""));
    await waitFor(() => expect(result.current.current?.id).toBe("s1"));
    act(() => result.current.select(undefined));
    expect(result.current.current).toBeUndefined();
    act(() => result.current.select("s1"));
    rerender({ app: "codex", visible: true });
    vi.mocked(terminalApi.create).mockResolvedValueOnce(
      snapshot("s2", "codex"),
    );
    act(() => result.current.newTerminal());
    await act(() => result.current.startTerminal("/tmp/phi", ""));
    await waitFor(() => expect(result.current.current?.id).toBe("s2"));
    rerender({ app: "claude", visible: false });
    expect(result.current.current?.id).toBe("s1");
    expect(terminalApi.close).not.toHaveBeenCalled();
    act(() => result.current.showConfig("claude"));
    expect(result.current.current).toBeUndefined();
    expect(result.current.sessions).toHaveLength(2);
  });

  it("rejects delayed events from old generations and never revives a closed tab", async () => {
    const { result } = renderHook(() =>
      useTerminalWorkspace("claude", true, canLeave),
    );
    await waitFor(() => expect(result.current.supported).toBe(true));
    act(() => result.current.newTerminal());
    await act(() => result.current.startTerminal("/tmp/phi", ""));
    await waitFor(() => expect(result.current.current?.id).toBe("s1"));
    act(() =>
      emit({ ...snapshot(), generation: 2, sequence: 1, phase: "running" }),
    );
    act(() => emit({ ...snapshot(), phase: "exited", sequence: 999 }));
    expect(result.current.current?.phase).toBe("running");
    await act(() => result.current.close(result.current.current!, true));
    act(() =>
      emit({ ...snapshot(), generation: 2, sequence: 99, phase: "exited" }),
    );
    expect(result.current.sessions).toEqual([]);
    expect(
      mergeTerminalSession([snapshot()], {
        ...snapshot(),
        sequence: 1,
        phase: "checking",
      })[0].phase,
    ).toBe("running");
  });

  it("confirms a running close and handles the check-to-running race on the backend", async () => {
    const { result } = renderHook(() =>
      useTerminalWorkspace("claude", true, canLeave),
    );
    await waitFor(() => expect(result.current.supported).toBe(true));
    act(() => result.current.newTerminal());
    await act(() => result.current.startTerminal("/tmp/phi", ""));
    await waitFor(() => expect(result.current.current).toBeTruthy());
    act(() => result.current.requestClose(result.current.current!));
    expect(terminalApi.close).not.toHaveBeenCalled();
    expect(result.current.closeTarget?.id).toBe("s1");
    act(() => result.current.setCloseTarget(null));
    vi.mocked(terminalApi.close).mockRejectedValueOnce(
      "terminal-confirm-required",
    );
    await act(async () =>
      result.current.requestClose({ ...snapshot(), phase: "checking" }),
    );
    expect(result.current.closeTarget?.id).toBe("s1");
    expect(result.current.sessions).toHaveLength(1);
  });

  it("creates a separate terminal in the chosen directory and remembers successful cwd", async () => {
    vi.mocked(terminalApi.create).mockResolvedValueOnce({
      ...snapshot(),
      launchCwd: "/tmp/其他项目",
    });
    const { result } = renderHook(() =>
      useTerminalWorkspace("claude", true, canLeave),
    );
    await waitFor(() => expect(result.current.supported).toBe(true));
    act(() => result.current.newTerminal("/tmp/其他项目"));
    expect(terminalApi.create).not.toHaveBeenCalled();
    await act(() =>
      result.current.startTerminal(
        result.current.launchDraft!.cwd,
        "--model test",
      ),
    );
    expect(terminalApi.create).toHaveBeenCalledWith(
      "claude",
      "/tmp/其他项目",
      "--model test",
    );
    expect(localStorage.getItem("phi.terminal.cwd.claude")).toBe(
      "/tmp/其他项目",
    );
  });

  it("does not advertise terminal support for desktop apps or unavailable platforms", async () => {
    const { result } = renderHook(() =>
      useTerminalWorkspace("claude-desktop", true, canLeave),
    );
    await waitFor(() => expect(terminalApi.capabilities).toHaveBeenCalled());
    expect(result.current.supported).toBe(false);
    act(() => result.current.newTerminal());
    expect(terminalApi.create).not.toHaveBeenCalled();
  });

  it("renders creation, fixed configuration, and cancel-safe close actions", async () => {
    function Workspace() {
      const workspace = useTerminalWorkspace("claude", true, canLeave);
      return (
        <>
          <AppTerminalTabs app="claude" workspace={workspace} />
          <TerminalCloseDialog workspace={workspace} />
          <TerminalLaunchDialog workspace={workspace} />
        </>
      );
    }
    render(<Workspace />);
    await waitFor(() => expect(terminalApi.list).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "新建终端" }));
    expect(terminalApi.create).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "启动 CLI" }));
    await screen.findByRole("button", { name: "关闭终端 phi" });
    fireEvent.click(screen.getByRole("button", { name: "关闭终端 phi" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(terminalApi.close).not.toHaveBeenCalled();
    expect(screen.getByRole("tab", { name: "配置" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭终端 phi" }));
    fireEvent.click(screen.getByRole("button", { name: "结束并关闭" }));
    await waitFor(() =>
      expect(terminalApi.close).toHaveBeenCalledWith(snapshot(), true),
    );
  });

  it("keeps terminal output visible beneath overlays and unmounts without closing its process", async () => {
    const rect = {
      x: 200,
      y: 94,
      width: 640,
      height: 430,
      top: 94,
      left: 200,
      right: 840,
      bottom: 524,
      toJSON: () => ({}),
    };
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      rect,
    );
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
      rect,
    ] as unknown as DOMRectList);
    const { unmount } = render(
      <TerminalPane
        session={snapshot()}
        onDirectory={vi.fn()}
        onRestart={vi.fn()}
        onInstall={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(terminalApi.present).toHaveBeenCalledWith(
        expect.objectContaining({ id: "s1", visible: true }),
      ),
    );
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.append(dialog);
    await waitFor(() =>
      expect(terminalApi.present).toHaveBeenLastCalledWith(
        expect.objectContaining({
          id: "s1",
          visible: true,
          blocked: true,
          dimmed: true,
        }),
      ),
    );
    dialog.remove();
    await waitFor(() =>
      expect(terminalApi.present).toHaveBeenLastCalledWith(
        expect.objectContaining({ visible: true }),
      ),
    );
    unmount();
    expect(terminalApi.present).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: null, visible: false }),
    );
    expect(terminalApi.close).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("selects and remembers a theme across applications without restarting the CLI", async () => {
    const rect = { x: 200, y: 94, width: 640, height: 430 } as DOMRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      rect,
    );
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
      rect,
    ] as unknown as DOMRectList);
    const user = userEvent.setup();
    const pane = (id = "s1", app: AppId = "claude") => (
      <>
        <ThemeMenu />
        <TerminalPane
          session={snapshot(id, app)}
          onDirectory={vi.fn()}
          onRestart={vi.fn()}
          onInstall={vi.fn()}
        />
      </>
    );
    const first = render(pane());
    vi.mocked(terminalApi.present).mockClear();
    expect(screen.queryByText("/tmp/phi")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "在其他目录新建" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "选择终端主题" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "应用更多操作" }));
    await user.click(screen.getByRole("menuitem", { name: "主题" }));
    expect(
      screen.getByRole("menuitemradio", { name: "跟随 PHI" }),
    ).toBeChecked();
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(7);
    await waitFor(() =>
      expect(terminalApi.present).toHaveBeenLastCalledWith(
        expect.objectContaining({ visible: true, blocked: true }),
      ),
    );
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Nord" }));
    await waitFor(() =>
      expect(terminalApi.present).toHaveBeenLastCalledWith(
        expect.objectContaining({ theme: "nord", visible: true }),
      ),
    );
    expect(localStorage.getItem(TERMINAL_THEME_KEY)).toBe("nord");
    expect(terminalApi.present).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: null }),
    );
    expect(terminalApi.restart).not.toHaveBeenCalled();
    expect(terminalApi.close).not.toHaveBeenCalled();
    first.unmount();
    const second = render(pane("s2", "codex"));
    await waitFor(() =>
      expect(terminalApi.present).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: "s2", theme: "nord", visible: true }),
      ),
    );
    await user.click(screen.getByRole("button", { name: "应用更多操作" }));
    await user.click(screen.getByRole("menuitem", { name: "主题" }));
    expect(screen.getByRole("menuitemradio", { name: "Nord" })).toBeChecked();
    await user.keyboard("{Escape}");
    expect(localStorage.getItem(TERMINAL_THEME_KEY)).toBe("nord");
    second.unmount();
    vi.restoreAllMocks();
  });

  it("falls back to following PHI for obsolete preferences and tracks appearance", async () => {
    localStorage.setItem(TERMINAL_THEME_KEY, "removed-theme");
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 90,
      width: 600,
      height: 400,
    } as DOMRect);
    document.documentElement.classList.remove("dark");
    const { unmount } = render(
      <TerminalPane
        session={snapshot()}
        onDirectory={vi.fn()}
        onRestart={vi.fn()}
        onInstall={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(terminalApi.present).toHaveBeenLastCalledWith(
        expect.objectContaining({ theme: "auto", dark: false }),
      ),
    );
    document.documentElement.classList.add("dark");
    await waitFor(() =>
      expect(terminalApi.present).toHaveBeenLastCalledWith(
        expect.objectContaining({ theme: "auto", dark: true }),
      ),
    );
    unmount();
    document.documentElement.classList.remove("dark");
    vi.restoreAllMocks();
  });

  it("offers presentation retry without restarting a running process", async () => {
    const rect = { x: 200, y: 94, width: 640, height: 430 } as DOMRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      rect,
    );
    vi.mocked(terminalApi.present).mockRejectedValueOnce(
      "native-window-unavailable",
    );
    const { unmount } = render(
      <TerminalPane
        session={snapshot()}
        onDirectory={vi.fn()}
        onRestart={vi.fn()}
        onInstall={vi.fn()}
      />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "嵌入终端服务暂不可用",
    );
    fireEvent.click(screen.getByRole("button", { name: "重新检测 / 重试" }));
    await waitFor(() =>
      expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
    );
    expect(terminalApi.present).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "s1", visible: true }),
    );
    expect(terminalApi.restart).not.toHaveBeenCalled();
    expect(terminalApi.close).not.toHaveBeenCalled();
    unmount();
    vi.restoreAllMocks();
  });
});
