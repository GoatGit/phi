import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { terminalApi, type TerminalSession } from "@/lib/api/terminal";
import { useTerminalTheme } from "./TerminalThemeMenu";
import {
  terminalOverlays,
  nextTerminalRevision,
  TERMINAL_FOCUS_EVENT,
  focusNativeTerminal,
} from "./presentation";

export function hideNativeTerminal() {
  return terminalApi.present({
    id: null,
    revision: nextTerminalRevision(),
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    visible: false,
    focus: false,
    dark: false,
    theme: "auto",
  });
}
export function TerminalPane({
  session,
  onDirectory,
  onRestart,
  onInstall,
}: {
  session: TerminalSession;
  onDirectory: () => void;
  onRestart: () => void;
  onInstall: () => void;
}) {
  const { t } = useTranslation();
  const container = useRef<HTMLDivElement>(null);
  const [theme] = useTerminalTheme();
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const scheduleRef = useRef<() => void>(() => {});
  useLayoutEffect(() => {
    scheduleRef.current();
  }, [theme]);
  const [presentationError, setPresentationError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const native = session.phase === "running" || session.phase === "exited";
  useLayoutEffect(() => {
    if (!native || !container.current) return;
    const element = container.current;
    setPresentationError(false);
    let frame = 0;
    let stopped = false;
    let failed = false;
    let wasInteractive = false;
    let focusRequested = false;
    let focusTimer: ReturnType<typeof setTimeout> | undefined;
    let previous = "";
    let lastVisibleIds = "";
    const sync = () => {
      frame = 0;
      if (stopped || failed) return;
      const bounds = element.getBoundingClientRect();
      const overlay = terminalOverlays(bounds);
      const visible =
        document.visibilityState !== "hidden" &&
        bounds.width > 0 &&
        bounds.height > 0;
      // 分屏后 present 不再互斥隐藏其他 surface：显式声明本页可见的会话集合
      const visibleIds = visible ? session.id : "";
      if (visibleIds !== lastVisibleIds) {
        lastVisibleIds = visibleIds;
        void terminalApi
          .setVisible(visible ? [session.id] : [])
          .catch(() => {});
      }
      const presentation = {
        id: session.id,
        x: Math.max(0, bounds.x),
        y: Math.max(0, bounds.y),
        width: bounds.width,
        height: bounds.height,
        visible,
        focus:
          visible && !overlay.blocked && (!wasInteractive || focusRequested),
        dark: document.documentElement.classList.contains("dark"),
        theme: themeRef.current,
        ...overlay,
      };
      const signature = JSON.stringify(presentation);
      if (signature !== previous || focusRequested) {
        previous = signature;
        void terminalApi
          .present({ ...presentation, revision: nextTerminalRevision() })
          .catch(() => {
            if (stopped) return;
            failed = true;
            setPresentationError(true);
            void hideNativeTerminal().catch(() => {});
          });
      }
      // Radix restores focus to the trigger as it finishes dismissing. Reapply
      // once after that handoff; never poll or steal focus from an open form.
      const interactive = visible && !overlay.blocked;
      if (interactive && !wasInteractive) {
        clearTimeout(focusTimer);
        focusTimer = setTimeout(() => {
          if (
            !stopped &&
            !document.activeElement?.matches(
              'input, textarea, select, [contenteditable="true"]',
            )
          ) {
            focusRequested = true;
            schedule();
          }
        }, 60);
      }
      wasInteractive = interactive;
      focusRequested = false;
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(sync);
    };
    scheduleRef.current = schedule;
    const requestFocus = () => {
      focusRequested = true;
      schedule();
    };
    const resize = new ResizeObserver(schedule);
    resize.observe(element);
    const mutations = new MutationObserver(schedule);
    mutations.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "data-state",
        "style",
        "class",
        "hidden",
        "aria-hidden",
      ],
    });
    mutations.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    window.addEventListener("resize", schedule);
    window.addEventListener("focus", requestFocus);
    window.addEventListener(TERMINAL_FOCUS_EVENT, requestFocus);
    document.addEventListener("transitionend", schedule, true);
    document.addEventListener("animationend", schedule, true);
    document.addEventListener("scroll", schedule, true);
    document.addEventListener("visibilitychange", schedule);
    sync();
    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      clearTimeout(focusTimer);
      scheduleRef.current = () => {};
      resize.disconnect();
      mutations.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("focus", requestFocus);
      window.removeEventListener(TERMINAL_FOCUS_EVENT, requestFocus);
      document.removeEventListener("transitionend", schedule, true);
      document.removeEventListener("animationend", schedule, true);
      document.removeEventListener("scroll", schedule, true);
      document.removeEventListener("visibilitychange", schedule);
      void hideNativeTerminal().catch(() => {});
    };
  }, [session.id, session.generation, native, attempt]);
  return (
    <section
      className="flex min-h-0 flex-1 flex-col"
      aria-label={t("terminal.pane")}
    >
      {native ? (
        <div
          ref={container}
          className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4"
          aria-label={t("terminal.nativeContent")}
          onPointerDown={focusNativeTerminal}
        >
          {presentationError && (
            <>
              <p role="alert" className="text-body text-fg-3">
                {t("terminal.unavailable")}
              </p>
              <Button
                variant="neutral"
                onClick={() => setAttempt((value) => value + 1)}
              >
                {t("terminal.retry")}
              </Button>
            </>
          )}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 overflow-auto px-6 py-8">
          <h2 className="text-title">{t(`terminal.phase.${session.phase}`)}</h2>
          {session.errorCode && (
            <p className="max-w-md text-center text-body text-fg-3">
              {t(`terminal.errors.${session.errorCode}`, {
                defaultValue: t("terminal.errors.startup-failed"),
              })}
            </p>
          )}
          {["failed", "missing-cli"].includes(session.phase) && (
            <div className="flex gap-2">
              <Button variant="neutral" onClick={onRestart}>
                {t("terminal.retry")}
              </Button>
              <Button
                onClick={
                  session.phase === "missing-cli" ? onInstall : onDirectory
                }
              >
                {t(
                  session.phase === "missing-cli"
                    ? "terminal.install"
                    : "terminal.chooseDirectory",
                )}
              </Button>
            </div>
          )}
        </div>
      )}
      {session.phase === "exited" && (
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border px-6 py-2 text-caption text-fg-3">
          <span>{t("terminal.exitedHint")}</span>
          <Button variant="neutral" size="compact" onClick={onRestart}>
            {t("terminal.restart")}
          </Button>
        </div>
      )}
      <div
        className="flex h-7 shrink-0 items-center border-t border-border px-6 text-caption text-fg-3"
        role="status"
      >
        {t(`terminal.phase.${session.phase}`)}
      </div>
    </section>
  );
}
