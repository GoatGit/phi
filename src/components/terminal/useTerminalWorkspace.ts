import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { exit } from "@tauri-apps/plugin-process";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { terminalApi, type TerminalSession } from "@/lib/api/terminal";
import type { AppId } from "@/lib/api";
import { hideNativeTerminal } from "./TerminalPane";

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
  const [supportedApps, setSupportedApps] = useState<AppId[]>([]);
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [selected, setSelected] = useState<Partial<Record<AppId, string>>>({});
  const [closeTarget, setCloseTarget] = useState<TerminalSession | null>(null);
  const [closing, setClosing] = useState(false);
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
  const select = (id: string | undefined) => {
    const proceed = () =>
      setSelected((previous) => ({ ...previous, [app]: id }));
    if (!canLeave(proceed)) proceed();
  };
  const showConfig = (appId: AppId) =>
    setSelected((previous) => ({ ...previous, [appId]: undefined }));
  const close = async (session: TerminalSession, confirmed = false) => {
    setClosing(true);
    try {
      await terminalApi.close(session, confirmed);
      tombstones.current.add(session.id);
      const group = sessions.filter((item) => item.appId === session.appId);
      const left = group[group.findIndex((item) => item.id === session.id) - 1];
      setSessions((previous) =>
        previous.filter((item) => item.id !== session.id),
      );
      setSelected((previous) =>
        previous[session.appId] === session.id
          ? { ...previous, [session.appId]: left?.id }
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
  const requestClose = (session: TerminalSession) => {
    if (["starting", "running"].includes(session.phase))
      setCloseTarget(session);
    else void close(session);
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
    current,
    sessions,
    select,
    visible,
    app,
  });
  handlers.current = {
    newTerminal,
    requestClose,
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
      if (
        event.shiftKey &&
        ["BracketLeft", "BracketRight"].includes(event.code)
      ) {
        event.preventDefault();
        act(event.code === "BracketLeft" ? "previous" : "next");
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
    setCloseTarget,
    closing,
  };
}
export type TerminalWorkspace = ReturnType<typeof useTerminalWorkspace>;
