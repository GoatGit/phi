import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { terminalApi, type TerminalSession } from "@/lib/api/terminal";
import { logFrontendInfo } from "@/lib/frontendLogger";
import { useTerminalTheme } from "./TerminalThemeMenu";
import {
  terminalOverlays,
  nextTerminalRevision,
  TERMINAL_FOCUS_EVENT,
} from "./presentation";
import {
  paneIds as collectPaneIds,
  type DividerPath,
  type SplitNode,
} from "./splitTree";

const PANE_INSET = 1;
const DIVIDER_SIZE = 6;

interface BranchProps {
  node: SplitNode;
  path: DividerPath;
  paneRefs: Map<string, HTMLElement>;
  setPaneElement: (id: string, element: HTMLElement | null) => void;
  activePaneId: string | null;
  sessionOf: (id: string) => TerminalSession | undefined;
  onFocusPane: (id: string) => void;
  onRatioChange: (path: DividerPath, ratio: number) => void;
  onRestart: (session: TerminalSession) => void;
  onInstall: () => void;
  onDirectory: () => void;
  dragging: DividerPath | null;
  setDragging: (path: DividerPath | null) => void;
}

/**
 * 分屏区：一棵窗格树占满终端内容区，每个窗格一个原生 Ghostty surface。
 * 单个 rAF 循环统一同步所有窗格的几何/主题/焦点；分隔条可拖拽、双击复位。
 */
export function SplitTerminalArea({
  tree,
  sessions,
  activePaneId,
  onFocusPane,
  onRatioChange,
  onRestart,
  onInstall,
  onDirectory,
}: {
  tree: SplitNode;
  sessions: TerminalSession[];
  activePaneId: string | null;
  onFocusPane: (id: string) => void;
  onRatioChange: (path: DividerPath, ratio: number) => void;
  onRestart: (session: TerminalSession) => void;
  onInstall: () => void;
  onDirectory: () => void;
}) {
  const { t } = useTranslation();
  const [theme] = useTerminalTheme();
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const areaRef = useRef<HTMLDivElement>(null);
  const paneRefs = useRef(new Map<string, HTMLElement>());
  const focusRequestRef = useRef(false);
  const scheduleRef = useRef<() => void>(() => {});
  const [presentationError, setPresentationError] = useState(false);
  const [dragging, setDragging] = useState<DividerPath | null>(null);

  const setPaneElement = useCallback(
    (id: string, element: HTMLElement | null) => {
      if (element) paneRefs.current.set(id, element);
      else paneRefs.current.delete(id);
    },
    [],
  );

  const sessionOf = useCallback(
    (id: string) => sessions.find((session) => session.id === id),
    [sessions],
  );

  // 同步循环读最新数据，观察者不必随渲染重建
  const latest = useRef({ tree, activePaneId });
  latest.current = { tree, activePaneId };
  // 会话 phase 也要进签名：terminal_create 先注册会话、原生 surface 异步
  // 后建，surface 建好（running）时必须重新 present，否则新窗格永远拿不到几何
  const phasesRef = useRef(sessions);
  phasesRef.current = sessions;

  const paneSignature = useMemo(() => collectPaneIds(tree).join(","), [tree]);

  useLayoutEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    setPresentationError(false);
    let frame = 0;
    let stopped = false;
    let failed = false;
    let wasInteractive = false;
    let focusTimer: ReturnType<typeof setTimeout> | undefined;
    let previous = "";
    let lastSignature = "";

    const sync = () => {
      frame = 0;
      if (stopped || failed) return;
      const active = latest.current.activePaneId;
      const areaBounds = area.getBoundingClientRect();
      const areaOverlay = terminalOverlays(areaBounds);
      const visible =
        document.visibilityState !== "hidden" &&
        areaBounds.width > 0 &&
        areaBounds.height > 0;
      const interactive = visible && !areaOverlay.blocked;
      const requestFocus = focusRequestRef.current;
      const dark = document.documentElement.classList.contains("dark");
      const focusPane =
        interactive && (!wasInteractive || requestFocus) ? active : null;
      // 模态弹窗（role=dialog）不再靠挖洞透出：多个窗格的洞/暗化层拼接在
      // 弹窗边缘会留下可见接缝，也会盖住弹窗部分内容。弹窗打开时原生终端
      // 整体退场，关闭后随签名变化一并恢复。菜单 / tooltip 仍走挖洞。
      const modalCover = areaOverlay.dimmed;
      const signature = JSON.stringify({
        ids: paneSignature,
        active,
        visible,
        overlay: areaOverlay,
        theme: themeRef.current,
        dark,
        phases: phasesRef.current.map((s) => `${s.id}:${s.phase}`).join(","),
      });
      if (signature !== lastSignature) {
        lastSignature = signature;
        void terminalApi
          .setVisible(
            visible && paneSignature && !modalCover
              ? paneSignature.split(",")
              : [],
          )
          .catch(() => {});
      }
      if (signature !== previous || requestFocus) {
        previous = signature;
        if (import.meta.env.DEV) {
          const sizes = Array.from(paneRefs.current.entries())
            .map(([id, el]) => {
              const r = el.getBoundingClientRect();
              const style = getComputedStyle(el);
              return `${id.slice(0, 8)}:${Math.round(r.width)}x${Math.round(r.height)}/h${style.height}`;
            })
            .join(" ");
          logFrontendInfo(
            `[SPLIT] sig=${paneSignature} area=${Math.round(areaBounds.width)}x${Math.round(areaBounds.height)} panes=[${sizes}]`,
          );
        }
        for (const [id, element] of paneRefs.current) {
          const bounds = element.getBoundingClientRect();
          const paneVisible = visible && bounds.width > 0 && bounds.height > 0;
          // 浮层挖洞：与该窗格相交的部分转成窗格本地坐标
          const overlays = areaOverlay.overlays
            .map((rect) => {
              const x = Math.max(areaBounds.x + rect.x, bounds.x + PANE_INSET);
              const y = Math.max(areaBounds.y + rect.y, bounds.y + PANE_INSET);
              const right = Math.min(
                areaBounds.x + rect.x + rect.width,
                bounds.x + bounds.width - PANE_INSET,
              );
              const bottom = Math.min(
                areaBounds.y + rect.y + rect.height,
                bounds.y + bounds.height - PANE_INSET,
              );
              return right > x && bottom > y
                ? {
                    x: x - bounds.x,
                    y: y - bounds.y,
                    width: right - x,
                    height: bottom - y,
                  }
                : null;
            })
            .filter(
              (
                rect,
              ): rect is {
                x: number;
                y: number;
                width: number;
                height: number;
              } => rect !== null,
            );
          void terminalApi
            .present({
              id,
              revision: nextTerminalRevision(),
              x: bounds.x + PANE_INSET,
              y: bounds.y + PANE_INSET,
              width: Math.max(0, bounds.width - PANE_INSET * 2),
              height: Math.max(0, bounds.height - PANE_INSET * 2),
              visible: paneVisible && !modalCover,
              focus: focusPane === id,
              dark,
              theme: themeRef.current,
              overlays,
              blocked: areaOverlay.blocked,
              dimmed: areaOverlay.dimmed,
            })
            .catch(() => {
              if (stopped) return;
              failed = true;
              setPresentationError(true);
              void terminalApi.setVisible([]).catch(() => {});
            });
        }
      }
      // 与单窗格版相同：进入交互后延迟一次抢焦点，避开 Radix 的焦点归还
      if (interactive && !wasInteractive) {
        clearTimeout(focusTimer);
        focusTimer = setTimeout(() => {
          if (
            !stopped &&
            !document.activeElement?.matches(
              'input, textarea, select, [contenteditable="true"]',
            )
          ) {
            focusRequestRef.current = true;
            schedule();
          }
        }, 60);
      }
      wasInteractive = interactive;
      focusRequestRef.current = false;
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(sync);
    };
    scheduleRef.current = schedule;
    const requestPaneFocus = () => {
      focusRequestRef.current = true;
      schedule();
    };
    const resize = new ResizeObserver(schedule);
    for (const element of paneRefs.current.values()) resize.observe(element);
    resize.observe(area);
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
    window.addEventListener("focus", requestPaneFocus);
    window.addEventListener(TERMINAL_FOCUS_EVENT, requestPaneFocus);
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
      window.removeEventListener("focus", requestPaneFocus);
      window.removeEventListener(TERMINAL_FOCUS_EVENT, requestPaneFocus);
      document.removeEventListener("transitionend", schedule, true);
      document.removeEventListener("animationend", schedule, true);
      document.removeEventListener("scroll", schedule, true);
      document.removeEventListener("visibilitychange", schedule);
      void terminalApi.setVisible([]).catch(() => {});
    };
  }, [paneSignature]);

  // 活动窗格变化（键盘循环、菜单分屏、原生 focus 事件）后把焦点交给它
  useEffect(() => {
    if (!activePaneId) return;
    focusRequestRef.current = true;
    scheduleRef.current();
  }, [activePaneId]);

  useEffect(() => {
    scheduleRef.current();
  }, [theme]);

  // 会话 phase 变化（如新窗格的 surface 建好）没有对应的 DOM 变化，主动排一帧
  useEffect(() => {
    scheduleRef.current();
  }, [sessions]);

  return (
    <section
      ref={areaRef}
      className="flex min-h-0 flex-1 flex-col"
      aria-label={t("terminal.pane")}
    >
      {presentationError ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4">
          <p role="alert" className="text-body text-fg-3">
            {t("terminal.unavailable")}
          </p>
        </div>
      ) : (
        <Branch
          node={tree}
          path=""
          paneRefs={paneRefs.current}
          setPaneElement={setPaneElement}
          activePaneId={activePaneId}
          sessionOf={sessionOf}
          onFocusPane={onFocusPane}
          onRatioChange={onRatioChange}
          onRestart={onRestart}
          onInstall={onInstall}
          onDirectory={onDirectory}
          dragging={dragging}
          setDragging={setDragging}
        />
      )}
    </section>
  );
}

function Branch({
  node,
  path,
  paneRefs,
  setPaneElement,
  activePaneId,
  sessionOf,
  onFocusPane,
  onRatioChange,
  onRestart,
  onInstall,
  onDirectory,
  dragging,
  setDragging,
}: BranchProps) {
  const { t } = useTranslation();

  if (node.kind === "pane") {
    const session = sessionOf(node.id);
    const active = activePaneId === node.id;
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div
          ref={(element) => setPaneElement(node.id, element)}
          data-pane-id={node.id}
          onPointerDown={() => onFocusPane(node.id)}
          className={cn(
            "relative min-h-0 min-w-0 flex-1 rounded-[4px] border transition-colors",
            active ? "border-ring" : "border-border",
          )}
        >
          {session && !["running", "exited"].includes(session.phase) && (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-app px-4 text-center">
              <h2 className="text-title">
                {t(`terminal.phase.${session.phase}`)}
              </h2>
              {session.errorCode && (
                <p className="max-w-md text-body text-fg-3">
                  {t(`terminal.errors.${session.errorCode}`, {
                    defaultValue: t("terminal.errors.startup-failed"),
                  })}
                </p>
              )}
              {["failed", "missing-cli"].includes(session.phase) && (
                <div className="flex gap-2">
                  <Button variant="neutral" onClick={() => onRestart(session)}>
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
        </div>
        {session?.phase === "exited" && (
          <div className="flex h-7 shrink-0 items-center justify-between gap-2 border-t border-border px-3 text-caption text-fg-3">
            <span>{t("terminal.exitedHint")}</span>
            <Button
              variant="neutral"
              size="compact"
              onClick={() => onRestart(session)}
            >
              {t("terminal.restart")}
            </Button>
          </div>
        )}
      </div>
    );
  }

  const horizontal = node.axis === "x";
  const beginDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const divider = event.currentTarget;
    const parent = divider.parentElement;
    if (!parent) return;
    divider.setPointerCapture(event.pointerId);
    setDragging(path);
    const move = (moveEvent: PointerEvent) => {
      const rect = parent.getBoundingClientRect();
      const raw = horizontal
        ? (moveEvent.clientX - rect.left) / rect.width
        : (moveEvent.clientY - rect.top) / rect.height;
      onRatioChange(path, raw);
    };
    const finish = () => {
      divider.removeEventListener("pointermove", move);
      divider.removeEventListener("pointerup", finish);
      divider.removeEventListener("pointercancel", finish);
      setDragging(null);
    };
    divider.addEventListener("pointermove", move);
    divider.addEventListener("pointerup", finish);
    divider.addEventListener("pointercancel", finish);
  };

  return (
    <div
      className={cn(
        "flex min-h-0 min-w-0 flex-1",
        horizontal ? "flex-row" : "flex-col",
      )}
    >
      <div
        className={cn(
          "flex min-h-0 min-w-0",
          horizontal ? "flex-row" : "flex-col",
        )}
        style={{
          flex: `0 0 calc(${node.ratio * 100}% - ${DIVIDER_SIZE / 2}px)`,
        }}
      >
        <Branch
          node={node.first}
          path={`${path}0`}
          paneRefs={paneRefs}
          setPaneElement={setPaneElement}
          activePaneId={activePaneId}
          sessionOf={sessionOf}
          onFocusPane={onFocusPane}
          onRatioChange={onRatioChange}
          onRestart={onRestart}
          onInstall={onInstall}
          onDirectory={onDirectory}
          dragging={dragging}
          setDragging={setDragging}
        />
      </div>
      <div
        role="separator"
        aria-orientation={horizontal ? "vertical" : "horizontal"}
        aria-label={t("terminal.split.resize")}
        onPointerDown={beginDrag}
        onDoubleClick={() => onRatioChange(path, 0.5)}
        className={cn(
          "group relative shrink-0 touch-none select-none",
          horizontal ? "w-1.5 cursor-col-resize" : "h-1.5 cursor-row-resize",
          dragging === path ? "bg-ring/40" : "bg-transparent hover:bg-subtle",
        )}
      >
        <div
          className={cn(
            "absolute rounded-full bg-border opacity-0 transition-opacity group-hover:opacity-100",
            dragging === path && "opacity-100",
            horizontal
              ? "inset-y-1 left-1/2 w-0.5 -translate-x-1/2"
              : "inset-x-1 top-1/2 h-0.5 -translate-y-1/2",
          )}
        />
      </div>
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-1",
          horizontal ? "flex-row" : "flex-col",
        )}
      >
        <Branch
          node={node.second}
          path={`${path}1`}
          paneRefs={paneRefs}
          setPaneElement={setPaneElement}
          activePaneId={activePaneId}
          sessionOf={sessionOf}
          onFocusPane={onFocusPane}
          onRatioChange={onRatioChange}
          onRestart={onRestart}
          onInstall={onInstall}
          onDirectory={onDirectory}
          dragging={dragging}
          setDragging={setDragging}
        />
      </div>
    </div>
  );
}
