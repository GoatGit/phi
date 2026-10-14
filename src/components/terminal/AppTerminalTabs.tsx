import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AppId } from "@/lib/api";
import type { TerminalWorkspace } from "./useTerminalWorkspace";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

export function AppTerminalTabs({
  app,
  workspace,
}: {
  app: AppId;
  workspace: TerminalWorkspace;
}) {
  const { t } = useTranslation();
  const rail = useRef<HTMLDivElement>(null);
  const sessions = workspace.sessions.filter(
    (session) => session.appId === app,
  );
  useEffect(() => {
    rail.current
      ?.querySelector('[aria-selected="true"]')
      ?.parentElement?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [workspace.current?.id, sessions.length]);
  return (
    <div
      className="flex min-w-0 flex-1 items-center gap-1"
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
    >
      <div
        className="flex min-w-0 items-center gap-1"
        role="tablist"
        aria-label={t("terminal.tabs")}
      >
        <button
          type="button"
          role="tab"
          aria-selected={!workspace.current}
          className={cn(
            "h-8 shrink-0 rounded-control px-3 text-body text-fg-3 hover:bg-subtle",
            !workspace.current && "bg-subtle text-fg-1",
          )}
          onClick={() => workspace.select(undefined)}
        >
          {t("terminal.config")}
        </button>
        <div
          ref={rail}
          className="flex min-w-0 items-center gap-1 overflow-x-auto"
        >
          {sessions.map((session) => (
            <div
              key={session.id}
              className={cn(
                "flex h-8 max-w-[170px] shrink-0 items-center rounded-control text-fg-3 hover:bg-subtle",
                workspace.current?.id === session.id && "bg-subtle text-fg-1",
              )}
            >
              <button
                type="button"
                role="tab"
                aria-selected={workspace.current?.id === session.id}
                className="flex h-full min-w-0 items-center gap-2 ps-3 pe-1 text-body"
                title={`${session.launchCwd} · ${t(`terminal.phase.${session.phase}`)}`}
                onClick={() => workspace.select(session.id)}
              >
                <span
                  aria-label={t(`terminal.phase.${session.phase}`)}
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    session.phase === "running"
                      ? "bg-success"
                      : session.phase === "exited"
                        ? "bg-fg-3"
                        : "bg-warning",
                  )}
                />
                <span className="truncate">{session.title}</span>
              </button>
              <Button
                variant="quiet"
                size="icon-compact"
                aria-label={t("terminal.closeLabel", { title: session.title })}
                onClick={() => workspace.requestClose(session)}
              >
                ×
              </Button>
            </div>
          ))}
        </div>
      </div>
      <Button
        variant="quiet"
        size="icon-compact"
        className="shrink-0"
        aria-label={t("terminal.new")}
        title={`${t("terminal.new")} (⌘T)`}
        onClick={() => workspace.newTerminal()}
      >
        ＋
      </Button>
    </div>
  );
}

export function TerminalCloseDialog({
  workspace,
}: {
  workspace: TerminalWorkspace;
}) {
  const { t } = useTranslation();
  return (
    <Dialog
      open={!!workspace.closeTarget}
      onOpenChange={(open) => {
        if (!open && !workspace.closing) workspace.setCloseTarget(null);
      }}
    >
      <DialogContent
        onEscapeKeyDown={(event) => {
          if (workspace.closing) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t("terminal.closeTitle")}</DialogTitle>
          <DialogDescription>
            {t("terminal.closeDescription", {
              title: workspace.closeTarget?.title,
            })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="neutral"
            disabled={workspace.closing}
            onClick={() => workspace.setCloseTarget(null)}
          >
            {t("common.cancel")}
          </Button>
          <Button
            variant="destructive"
            disabled={workspace.closing}
            onClick={() => {
              if (workspace.closeTarget)
                void workspace.close(workspace.closeTarget, true);
            }}
          >
            {t("terminal.closeConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
