import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { exit } from "@tauri-apps/plugin-process";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { terminalApi, type TerminalSession } from "@/lib/api/terminal";
import type { AppId } from "@/lib/api";
import { hideNativeTerminal } from "./TerminalPane";
import { useTerminalTheme } from "./TerminalThemeMenu";
import {
  childPaneIds,
  contains,
  navigatePane,
  paneIds,
  removePane,
  setRatioAtPath,
  splitAt,
  type DividerPath,
  type SplitDirection,
  type SplitNode,
} from "./splitTree";

/** 每个标签页一棵窗格树，键 `${appId}:${rootSessionId}`；没有键 = 单窗格标签页 */
type TreeMap = Record<string, SplitNode>;
const treeKey = (appId: AppId, rootId: string) => `${appId}:${rootId}`;

export function mergeTerminalSession(
  sessions: TerminalSession[],
  next: TerminalSession,
) {
  const prior = sessions.find((session) => session.id === next.id);
  if (
    prior &&
    (prior.generation > next.generation ||
      (prior.generation === next.generation && prior.sequence >= next.sequence))
  )
    return sessions;
  return prior
    ? sessions.map((session) => (session.id === next.id ? next : session))
    : [...sessions, next];
}
export const terminalAlive = (session: TerminalSession) =>
  ["checking", "starting", "running"].includes(session.phase);
const cwdKey = (app: AppId) => `phi.terminal.cwd.${app}`;
export interface TerminalLaunchDraft {
  appId: AppId;
  cwd: string;
  arguments: string;
}

export function useTerminalWorkspace(
  app: AppId,
  visible: boolean,
  canLeave: (proceed: () => void) => boolean,
) {
  const { t } = useTranslation();
  const [terminalTheme] = useTerminalTheme();
  const [supportedApps, setSupportedApps] = useState<AppId[]>([]);
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [selected, setSelected] = useState<Partial<Record<AppId, string>>>({});
  const [closeTarget, setCloseTarget] = useState<TerminalSession | null>(null);
  /** 确认框确认的是关一个窗格还是整棵树（页签 ×） */
  const closeTargetWholeTree = useRef(false);
  const [closing, setClosing] = useState(false);
  const [trees, setTrees] = useState<TreeMap>({});
  const [activePanes, setActivePanes] = useState<
    Partial<Record<AppId, string>>
  >({});
  const treesRef = useRef<TreeMap>({});
  treesRef.current = trees;
  const [defaultDirectory, setDefaultDirectory] = useState("");
  const [launchDraft, setLaunchDraft] = useState<TerminalLaunchDraft | null>(
    null,
  );
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [launchPending, setLaunchPending] = useState(false);
  const launching = useRef(false);
  const tombstones = useRef(new Set<string>());
  const current = sessions.find(
    (session) => session.appId === app && session.id === selected[app],
  );
  const upsert = useCallback((next: TerminalSession) => {
    if (tombstones.current.has(next.id)) return;
    setSessions((previous) => mergeTerminalSession(previous, next));
    if (next.phase === "running")
      localStorage.setItem(cwdKey(next.appId), next.launchCwd);
  }, []);
  useEffect(() => {
    if (!isTauri()) return;
    const hide = () => {
      void hideNativeTerminal().catch(() => {});
    };
    hide();
    window.addEventListener("pagehide", hide);
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        const capabilities = await terminalApi.capabilities();
        if (disposed) return;
        setSupportedApps(capabilities.supported ? capabilities.apps : []);
        setDefaultDirectory(capabilities.defaultCwd);
        if (!capabilities.supported) return;
        unlisten = await listen<TerminalSession>(
          "terminal://changed",
          (event) => {
            if (!disposed) upsert(event.payload);
          },
        );
        if (disposed) {
          unlisten();
          return;
        }
        const existing = await terminalApi.list();
        if (!disposed) existing.forEach(upsert);
      } catch {
        if (!disposed) toast.error(t("terminal.unavailable"));
      }
    })();
    return () => {
      disposed = true;
      unlisten?.();
      window.removeEventListener("pagehide", hide);
      hide();
    };
  }, [upsert, t]);

  const newTerminal = (directory?: string) => {
    if (!supportedApps.includes(app)) return;
    const proceed = () => {
      if (launching.current) return;
      setLaunchError(null);
      setLaunchDraft({
        appId: app,
        cwd:
          directory ??
          current?.launchCwd ??
          localStorage.getItem(cwdKey(app)) ??
          defaultDirectory,
        arguments: current?.launchArgs ?? "",
      });
    };
    if (!canLeave(proceed)) proceed();
  };
  const cancelLaunch = () => {
    if (!launching.current) setLaunchDraft(null);
  };
  const startTerminal = async (cwd: string, argumentsText: string) => {
    if (!launchDraft || launching.current) return;
    launching.current = true;
    setLaunchPending(true);
    setLaunchError(null);
    try {
      const session = await terminalApi.create(
        launchDraft.appId,
        cwd,
        argumentsText,
        {
          theme: terminalTheme,
          dark: document.documentElement.classList.contains("dark"),
        },
      );
      upsert(session);
      setSelected((previous) => ({ ...previous, [session.appId]: session.id }));
      setLaunchDraft(null);
    } catch (error) {
      const code = String(error);
      setLaunchError(
        ["invalid-directory", "invalid-arguments"].includes(code)
          ? code
          : "createFailed",
      );
    } finally {
      launching.current = false;
      setLaunchPending(false);
    }
  };
  /** 会话所属标签页的根会话：在树里则取树根，否则它自己 */
  const rootIdOf = (sessionId: string): string => {
    for (const [key, tree] of Object.entries(treesRef.current)) {
      if (contains(tree, sessionId)) return key.split(":")[1];
    }
    return sessionId;
  };
  const treeContaining = (sessionId: string): SplitNode | null => {
    for (const tree of Object.values(treesRef.current)) {
      if (contains(tree, sessionId)) return tree;
    }
    return null;
  };
  const noteFocus = (sessionId: string) => {
    const session = sessions.find((item) => item.id === sessionId);
    if (session)
      setActivePanes((previous) => ({
        ...previous,
        [session.appId]: sessionId,
      }));
  };
  const focusPane = (sessionId: string) => {
    const proceed = () => noteFocus(sessionId);
    if (!canLeave(proceed)) proceed();
  };
  const focusRelative = (sessionId: string, delta: 1 | -1) => {
    const tree = treeContaining(sessionId);
    const next = tree ? navigatePane(tree, sessionId, delta) : null;
    if (next) focusPane(next);
  };
  const splitPane = (sessionId: string, direction: SplitDirection) => {
    const source = sessions.find((session) => session.id === sessionId);
    if (!source || !supportedApps.includes(source.appId) || launching.current)
      return;
    launching.current = true;
    // 分屏新窗格沿用源窗格的目录与参数（Ghostty 的 new_split 语义：不弹对话框）
    terminalApi
      .create(source.appId, source.launchCwd, source.launchArgs, {
        theme: terminalTheme,
        dark: document.documentElement.classList.contains("dark"),
      })
      .then((session) => {
        upsert(session);
        const rootId = rootIdOf(sessionId);
        setTrees((previous) => {
          const key = treeKey(source.appId, rootId);
          const tree = previous[key] ?? { kind: "pane", id: rootId };
          return {
            ...previous,
            [key]: splitAt(tree, sessionId, direction, session.id),
          };
        });
        setActivePanes((previous) => ({
          ...previous,
          [source.appId]: session.id,
        }));
      })
      .catch(() => toast.error(t("terminal.createFailed")))
      .finally(() => {
        launching.current = false;
      });
  };
  const resizeDivider = (
    sessionId: string,
    path: DividerPath,
    ratio: number,
  ) => {
    setTrees((previous) => {
      for (const [key, tree] of Object.entries(previous)) {
        if (!contains(tree, sessionId)) continue;
        return { ...previous, [key]: setRatioAtPath(tree, path, ratio) };
      }
      return previous;
    });
  };
  const tabSessionsOf = (appId: AppId): TerminalSession[] => {
    const children = new Set<string>();
    for (const [key, tree] of Object.entries(treesRef.current)) {
      if (!key.startsWith(`${appId}:`)) continue;
      childPaneIds(key.split(":")[1], tree).forEach((id) => children.add(id));
    }
    return sessions.filter(
      (session) => session.appId === appId && !children.has(session.id),
    );
  };

  const select = (id: string | undefined) => {
    const proceed = () =>
      setSelected((previous) => ({ ...previous, [app]: id }));
    if (!canLeave(proceed)) proceed();
  };
  const showConfig = (appId: AppId) =>
    setSelected((previous) => ({ ...previous, [appId]: undefined }));
  const close = async (
    session: TerminalSession,
    confirmed = false,
    wholeTree = false,
  ) => {
    setClosing(true);
    try {
      // 页签 ×：关掉这棵树上的全部窗格；⌘W：只关焦点窗格（根窗格被关时树重新生根）
      const asRoot = treesRef.current[treeKey(session.appId, session.id)];
      const victims =
        wholeTree && asRoot
          ? paneIds(asRoot)
              .map((id) => sessions.find((item) => item.id === id))
              .filter((item): item is TerminalSession => !!item)
          : [session];
      for (const victim of victims) {
        await terminalApi.close(victim, confirmed);
        tombstones.current.add(victim.id);
      }
      const victimIds = new Set(victims.map((victim) => victim.id));
      const nextTrees: TreeMap = {};
      let collapsedRootId: string | undefined;
      let rerootTo: string | undefined;
      for (const [key, tree] of Object.entries(treesRef.current)) {
        if (!contains(tree, session.id)) {
          nextTrees[key] = tree;
          continue;
        }
        const appId = key.split(":")[0] as AppId;
        const updated = removePane(tree, session.id);
        if (!updated) continue;
        if (updated.kind === "pane") {
          // 只剩一个窗格：回到普通标签页，选中它
          collapsedRootId = updated.id;
          continue;
        }
        rerootTo = paneIds(updated)[0];
        nextTrees[treeKey(appId, rerootTo)] = updated;
      }
      setTrees(nextTrees);
      const group = sessions.filter((item) => item.appId === session.appId);
      const left = group[group.findIndex((item) => item.id === session.id) - 1];
      setSessions((previous) =>
        previous.filter((item) => !victimIds.has(item.id)),
      );
      setSelected((previous) => {
        if (previous[session.appId] !== session.id) return previous;
        if (collapsedRootId && !victimIds.has(collapsedRootId))
          return { ...previous, [session.appId]: collapsedRootId };
        if (rerootTo && !victimIds.has(rerootTo))
          return { ...previous, [session.appId]: rerootTo };
        const fallback = left && !victimIds.has(left.id) ? left.id : undefined;
        return { ...previous, [session.appId]: fallback };
      });
      setActivePanes((previous) =>
        previous[session.appId] && victimIds.has(previous[session.appId]!)
          ? { ...previous, [session.appId]: undefined }
          : previous,
      );
      setCloseTarget(null);
    } catch (error) {
      if (String(error).includes("terminal-confirm-required"))
        setCloseTarget(session);
      else toast.error(t("terminal.closeFailed"));
    } finally {
      setClosing(false);
    }
  };
  const requestClose = (session: TerminalSession, wholeTree = false) => {
    if (["starting", "running"].includes(session.phase)) {
      closeTargetWholeTree.current = wholeTree;
      setCloseTarget(session);
    } else void close(session, false, wholeTree);
  };
  const restart = (session: TerminalSession) => {
    void terminalApi
      .restart(session)
      .then(upsert)
      .catch(() => toast.error(t("terminal.createFailed")));
  };
  const handlers = useRef({
    newTerminal,
    requestClose,
    splitPane,
    focusRelative,
    noteFocus,
    current,
    sessions,
    select,
    visible,
    app,
  });
  handlers.current = {
    newTerminal,
    requestClose,
    splitPane,
    focusRelative,
    noteFocus,
    current,
    sessions,
    select,
    visible,
    app,
  };
  useEffect(() => {
    if (!isTauri() || !supportedApps.length) return;
    let disposed = false;
    const act = (action: string, id?: string) => {
      const value = handlers.current;
      if (
        !value.visible ||
        document.querySelector(
          '[role="dialog"], [role="alertdialog"], [role="menu"]',
        )
      )
        return;
      const target = id
        ? value.sessions.find((session) => session.id === id)
        : value.current;
      if (action === "new") value.newTerminal();
      if (action.startsWith("split:") && target)
        value.splitPane(target.id, action.slice(6) as SplitDirection);
      if ((action === "pane-previous" || action === "pane-next") && target)
        value.focusRelative(target.id, action === "pane-next" ? 1 : -1);
      if (action === "focus" && target) value.noteFocus(target.id);
      if (action === "close" && target) value.requestClose(target);
      if (action === "quit") void exit(0);
      if (action === "previous" || action === "next") {
        const ids: (string | undefined)[] = [
          undefined,
          ...value.sessions
            .filter((session) => session.appId === value.app)
            .map((session) => session.id),
        ];
        value.select(
          ids[
            (ids.indexOf(value.current?.id) +
              (action === "next" ? 1 : -1) +
              ids.length) %
              ids.length
          ],
        );
      }
    };
    const listening = listen<{ id: string; action: string }>(
      "terminal://action",
      ({ payload }) => {
        if (!disposed) act(payload.action, payload.id);
      },
    );
    const keydown = (event: KeyboardEvent) => {
      if (
        !event.metaKey ||
        !handlers.current.visible ||
        !supportedApps.includes(handlers.current.app)
      )
        return;
      if (
        document.querySelector(
          '[role="dialog"], [role="alertdialog"], [role="menu"]',
        )
      )
        return;
      if (event.key.toLowerCase() === "t") {
        event.preventDefault();
        act("new");
      }
      if (event.key.toLowerCase() === "w" && handlers.current.current) {
        event.preventDefault();
        act("close");
      }
      // 分屏：⌘D 右 / ⇧⌘D 下 / ⌥⌘D 左 / ⌥⇧⌘D 上（与原生侧一致）
      if (event.key.toLowerCase() === "d") {
        event.preventDefault();
        act(
          event.altKey
            ? event.shiftKey
              ? "split:up"
              : "split:left"
            : event.shiftKey
              ? "split:down"
              : "split:right",
        );
      }
      if (
        event.shiftKey &&
        ["BracketLeft", "BracketRight"].includes(event.code)
      ) {
        event.preventDefault();
        act(event.code === "BracketLeft" ? "previous" : "next");
      }
      if (
        !event.shiftKey &&
        !event.altKey &&
        ["BracketLeft", "BracketRight"].includes(event.code)
      ) {
        event.preventDefault();
        act(event.code === "BracketLeft" ? "pane-previous" : "pane-next");
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      disposed = true;
      void listening.then((unlisten) => unlisten()).catch(() => {});
      document.removeEventListener("keydown", keydown);
    };
  }, [supportedApps]);

  // A destroyed/recreated WebView can reconnect to backend sessions. Never
  // stop them on React unmount; only hide the native presentation.
  // 当前标签页的窗格树与会话（没有分屏时为 null，渲染普通 TerminalPane）
  const currentTree = current
    ? (trees[treeKey(current.appId, current.id)] ?? null)
    : null;
  const currentTreeSessions = currentTree
    ? paneIds(currentTree)
        .map((id) => sessions.find((session) => session.id === id))
        .filter((session): session is TerminalSession => !!session)
    : [];
  const activePaneId =
    currentTree && activePanes[app] && contains(currentTree, activePanes[app]!)
      ? activePanes[app]!
      : (currentTreeSessions[0]?.id ?? null);
  return {
    supported: supportedApps.includes(app),
    sessions,
    current,
    select,
    showConfig,
    newTerminal,
    requestClose,
    close,
    restart,
    launchDraft,
    launchError,
    launchPending,
    cancelLaunch,
    startTerminal,
    closeTarget,
    closeTargetWholeTree,
    setCloseTarget,
    closing,
    trees,
    splitPane,
    focusPane,
    resizeDivider,
    tabSessions: tabSessionsOf,
    currentTree,
    currentTreeSessions,
    activePaneId,
  };
}
export type TerminalWorkspace = ReturnType<typeof useTerminalWorkspace>;
