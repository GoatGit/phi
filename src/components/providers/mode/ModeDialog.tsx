import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import type { AppId } from "@/lib/api";
import type { AppMode } from "@/types/proxy";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { APP_DISPLAY_NAME } from "@/components/shell/AppGlyph";
import { extractErrorMessage } from "@/utils/errorUtils";
import { logFrontendInfo } from "@/lib/frontendLogger";

/** 路由模式改写的客户端文件（确认框里写明，用默认位置）。 */
const CLIENT_FILE: Partial<Record<AppId, string>> = {
  claude: "~/.claude/settings.json",
  codex: "~/.codex/config.toml",
  gemini: "~/.gemini/.env",
  grokbuild: "~/.grok/config.toml",
};

export type ModeDialogState =
  | { kind: "enter"; preselect?: string | null }
  | { kind: "needsRoute"; providerId: string; name: string; reason: string };

/** 框里的选择写进日志：取消、仍然直连切换、进入模式在日志里分得清。 */
function logDialog(app: AppId, state: ModeDialogState, choice: string) {
  const subject =
    state.kind === "enter"
      ? "进入路由模式确认框"
      : `「${state.providerId} 需要路由」确认框`;
  logFrontendInfo(`[MODE] ${app} ${subject}：${choice}`);
}

interface ModeDialogProps {
  app: AppId;
  state: ModeDialogState | null;
  active: AppMode;
  /** 可选路由组（已启用、允许该应用），带成员摘要 */
  groups: { id: string; name: string; summary: string }[];
  /** 默认选中的组：当前绑定的组，没有就选第一个 */
  defaultPick: string | null;
  /** 确认请求进行中 */
  activating?: boolean;
  onClose: () => void;
  /** 确认启用代理并绑定选中的组 */
  onEnter: (groupId: string) => Promise<void>;
  /** 「需要路由」框：不经选择，直接用默认路由组启用代理 */
  onRouteDefault: () => Promise<void>;
  /** 对话框 F：仍然直连切换 */
  onSwitchDirect: (providerId: string) => void;
}

/**
 * 模式切换确认框。代理一律走路由组：确认键 = 入口按钮去掉「…」。
 * 出错时就地显示，不关框。
 */
export function ModeDialog(props: ModeDialogProps) {
  const { app, state, onClose } = props;

  useEffect(() => {
    if (state) logDialog(app, state, "弹出");
  }, [app, state]);

  const cancel = () => {
    if (state) logDialog(app, state, "取消");
    onClose();
  };

  return (
    <Dialog open={state !== null} onOpenChange={(open) => !open && cancel()}>
      {state && (
        <DialogContent
          zIndex="alert"
          className="max-w-[480px] gap-0 rounded-dialog border-border bg-surface p-6 shadow-v7-lg sm:rounded-dialog"
        >
          {state.kind === "enter" ? (
            <EnterBody {...props} state={state} onCancel={cancel} />
          ) : (
            <NeedsRouteBody {...props} state={state} onCancel={cancel} />
          )}
        </DialogContent>
      )}
    </Dialog>
  );
}

function EnterBody({
  app,
  state,
  groups,
  defaultPick,
  activating = false,
  onCancel,
  onEnter,
}: ModeDialogProps & {
  state: Extract<ModeDialogState, { kind: "enter" }>;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const appName = APP_DISPLAY_NAME[app];
  const initialPick =
    state.preselect && groups.some((g) => g.id === state.preselect)
      ? state.preselect
      : defaultPick && groups.some((g) => g.id === defaultPick)
        ? defaultPick
        : (groups[0]?.id ?? "");
  const [pick, setPick] = useState(initialPick);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPick(initialPick);
    // 每次打开按传进来的预选重置
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const notes = [
    t("mode.dialog.routeNoteFile", {
      file: CLIENT_FILE[app] ?? "",
    }),
    t("mode.dialog.routeNoteSwitch"),
    t("mode.dialog.routeNoteKeepRunning"),
    ...(app === "codex"
      ? [t("mode.dialog.stackNoteRestartCodex", { app: appName })]
      : []),
  ];

  const confirm = async () => {
    if (!pick || busy) return;
    logDialog(app, state, `确认，选 ${pick}`);
    setBusy(true);
    setError(null);
    try {
      await onEnter(pick);
    } catch (err) {
      setError(extractErrorMessage(err) || t("common.unknown"));
    } finally {
      setBusy(false);
    }
  };

  const title = t("mode.dialog.routeTitle", { app: appName });
  const lead = t("mode.dialog.routeLead");
  const pickLabel = t("mode.dialog.routeTo");

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <DialogTitle className="text-title">{title}</DialogTitle>
        <DialogDescription className="text-body text-fg-2">
          {lead}
        </DialogDescription>
      </div>

      <div className="space-y-1.5">
        <label className="text-caption font-semibold text-fg-2">
          {pickLabel}
        </label>
        <Select
          value={pick}
          onValueChange={setPick}
          disabled={busy || activating}
        >
          <SelectTrigger className="h-9" aria-label={pickLabel}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="z-[70]">
            {groups.map((group) => (
              <SelectItem key={group.id} value={group.id}>
                {group.summary
                  ? `${group.name}（${group.summary}）`
                  : group.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <ul className="space-y-1.5 rounded-panel bg-subtle px-4 py-3 text-caption text-fg-2">
        {notes.map((note) => (
          <li key={note} className="flex gap-2">
            <span aria-hidden="true">·</span>
            <span>{note}</span>
          </li>
        ))}
      </ul>

      {error && (
        <p
          role="alert"
          className="rounded-control bg-danger-soft px-3 py-2 text-caption text-danger-text"
        >
          {error}
        </p>
      )}

      <div className="flex flex-wrap justify-end gap-2 pt-1">
        <Button
          variant="neutral"
          size="regular"
          autoFocus
          disabled={busy || activating}
          onClick={onCancel}
        >
          {t("common.cancel")}
        </Button>
        <Button
          variant="route"
          size="regular"
          disabled={busy || activating || !pick}
          onClick={() => void confirm()}
        >
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {t("mode.dialog.confirmRoute")}
        </Button>
      </div>
    </div>
  );
}

function NeedsRouteBody({
  app,
  state,
  onClose,
  onCancel,
  onRouteDefault,
  onSwitchDirect,
}: ModeDialogProps & {
  state: Extract<ModeDialogState, { kind: "needsRoute" }>;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = state.name;

  const route = async () => {
    logDialog(app, state, "用默认路由组启用代理");
    setBusy(true);
    setError(null);
    try {
      await onRouteDefault();
      onClose();
    } catch (err) {
      setError(extractErrorMessage(err) || t("common.unknown"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <DialogTitle className="text-title">
          {t("mode.dialog.needsRouteTitle", { provider: name })}
        </DialogTitle>
        <DialogDescription className="text-body text-fg-2">
          {t("mode.dialog.needsRouteLead", {
            provider: name,
            reason: state.reason,
            app: APP_DISPLAY_NAME[app],
          })}
        </DialogDescription>
      </div>
      {error && (
        <p
          role="alert"
          className="rounded-control bg-danger-soft px-3 py-2 text-caption text-danger-text"
        >
          {error}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2 pt-1">
        <Button
          variant="neutral"
          size="regular"
          autoFocus
          disabled={busy}
          onClick={onCancel}
        >
          {t("common.cancel")}
        </Button>
        <Button
          variant="neutral"
          size="regular"
          disabled={busy}
          onClick={() => {
            logDialog(app, state, "仍然直连切换");
            onClose();
            onSwitchDirect(state.providerId);
          }}
        >
          {t("mode.dialog.switchAnyway")}
        </Button>
        <Button
          variant="route"
          size="regular"
          disabled={busy}
          onClick={() => void route()}
        >
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {t("mode.activate.route")}
        </Button>
      </div>
    </div>
  );
}
