import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Field,
  FieldLabel,
  FieldDescription,
  FieldError,
  FieldGroup,
} from "@/components/ui/field";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ChevronDown } from "lucide-react";
import type { TerminalWorkspace } from "./useTerminalWorkspace";

/** 参数历史按应用记（MRU，去重，最多 8 条）；与 cwdKey 的记忆模式一致 */
const argsHistoryKey = (app: string) => `phi.terminal.args.${app}`;
const ARGS_HISTORY_LIMIT = 8;

function loadArgsHistory(app: string): string[] {
  try {
    const raw = localStorage.getItem(argsHistoryKey(app));
    const list: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(list)
      ? list
          .filter((item): item is string => typeof item === "string")
          .slice(0, ARGS_HISTORY_LIMIT)
      : [];
  } catch {
    return [];
  }
}

function saveArgsHistory(app: string, value: string) {
  const trimmed = value.trim();
  if (!trimmed) return;
  const next = [
    trimmed,
    ...loadArgsHistory(app).filter((item) => item !== trimmed),
  ].slice(0, ARGS_HISTORY_LIMIT);
  try {
    localStorage.setItem(argsHistoryKey(app), JSON.stringify(next));
  } catch {
    // 存不进（隐私模式等）就算了，本次会话内仍可用
  }
}

export function TerminalLaunchDialog({
  workspace,
}: {
  workspace: TerminalWorkspace;
}) {
  const { t } = useTranslation();
  const draft = workspace.launchDraft;
  const [cwd, setCwd] = useState("");
  const [argumentsText, setArgumentsText] = useState("");
  const [picking, setPicking] = useState(false);
  const [pickerError, setPickerError] = useState(false);
  const activeDraft = useRef(draft);
  activeDraft.current = draft;
  // 「记住选择」：全新草稿（没带参数）预填该应用最近一次用过的参数
  const historyApp = draft?.appId ?? "";
  const [history, setHistory] = useState<string[]>([]);
  useEffect(() => {
    setCwd(draft?.cwd ?? "");
    setArgumentsText(
      draft?.arguments ||
        (draft ? (loadArgsHistory(draft.appId)[0] ?? "") : ""),
    );
    setPickerError(false);
  }, [draft]);
  useEffect(() => {
    if (historyApp) setHistory(loadArgsHistory(historyApp));
  }, [historyApp]);
  const busy = workspace.launchPending || picking;
  const pickDirectory = async () => {
    setPicking(true);
    setPickerError(false);
    try {
      const path = await open({
        directory: true,
        multiple: false,
        defaultPath: cwd || undefined,
      });
      if (activeDraft.current === draft && typeof path === "string")
        setCwd(path);
    } catch {
      if (activeDraft.current === draft) setPickerError(true);
    } finally {
      setPicking(false);
    }
  };
  const error = workspace.launchError;
  return (
    <Dialog
      open={!!draft}
      onOpenChange={(opened) => {
        if (!opened && !busy) workspace.cancelLaunch();
      }}
    >
      <DialogContent
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t("terminal.launchTitle")}</DialogTitle>
          <DialogDescription>
            {t("terminal.launchDescription")}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <form
            id="terminal-launch-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (!busy && cwd.trim()) {
                if (draft) saveArgsHistory(draft.appId, argumentsText);
                void workspace.startTerminal(cwd, argumentsText);
              }
            }}
          >
            <FieldGroup>
              <Field
                data-invalid={error === "invalid-directory"}
                data-disabled={busy}
              >
                <FieldLabel htmlFor="terminal-launch-cwd">
                  {t("terminal.workspace")}
                </FieldLabel>
                <div className="flex items-center gap-2">
                  <Input
                    id="terminal-launch-cwd"
                    value={cwd}
                    onChange={(event) => setCwd(event.target.value)}
                    disabled={busy}
                    required
                    maxLength={4096}
                    aria-invalid={error === "invalid-directory"}
                    aria-describedby="terminal-cwd-help"
                    className="min-w-0 flex-1"
                  />
                  <Button
                    type="button"
                    variant="neutral"
                    disabled={busy}
                    onClick={() => void pickDirectory()}
                  >
                    {t("terminal.chooseDirectory")}
                  </Button>
                </div>
                <FieldDescription id="terminal-cwd-help">
                  {t("terminal.workspaceHint")}
                </FieldDescription>
                {error === "invalid-directory" && (
                  <FieldError>
                    {t("terminal.errors.invalid-directory")}
                  </FieldError>
                )}
                {pickerError && (
                  <FieldError>{t("terminal.directoryFailed")}</FieldError>
                )}
              </Field>
              <Field
                data-invalid={error === "invalid-arguments"}
                data-disabled={busy}
              >
                <FieldLabel htmlFor="terminal-launch-args">
                  {t("terminal.arguments")}
                </FieldLabel>
                <div className="flex items-center gap-2">
                  <Input
                    id="terminal-launch-args"
                    value={argumentsText}
                    onChange={(event) => setArgumentsText(event.target.value)}
                    disabled={busy}
                    maxLength={16384}
                    autoComplete="off"
                    spellCheck={false}
                    aria-invalid={error === "invalid-arguments"}
                    aria-describedby="terminal-args-help"
                    placeholder={t("terminal.argumentsPlaceholder")}
                    className="min-w-0 flex-1"
                  />
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        type="button"
                        variant="neutral"
                        disabled={busy}
                        aria-label={t("terminal.argumentsHistory")}
                        title={t("terminal.argumentsHistory")}
                      >
                        <ChevronDown className="h-4 w-4" aria-hidden />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent align="end" className="w-80 p-1">
                      {history.length > 0 ? (
                        <ul className="max-h-64 overflow-y-auto">
                          {history.map((item) => (
                            <li key={item}>
                              <button
                                type="button"
                                title={item}
                                onClick={() => setArgumentsText(item)}
                                className="w-full truncate rounded-control px-2.5 py-1.5 text-start text-body text-fg-1 hover:bg-subtle"
                              >
                                {item}
                              </button>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="px-2.5 py-2 text-caption text-fg-3">
                          {t("terminal.argumentsHistoryEmpty")}
                        </p>
                      )}
                    </PopoverContent>
                  </Popover>
                </div>
                <FieldDescription id="terminal-args-help">
                  {t("terminal.argumentsHint")}
                </FieldDescription>
                {error === "invalid-arguments" && (
                  <FieldError>
                    {t("terminal.errors.invalid-arguments")}
                  </FieldError>
                )}
              </Field>
              {error === "createFailed" && (
                <FieldError>{t("terminal.createFailed")}</FieldError>
              )}
            </FieldGroup>
          </form>
        </DialogBody>
        <DialogFooter>
          <Button
            type="button"
            variant="neutral"
            disabled={busy}
            onClick={workspace.cancelLaunch}
          >
            {t("common.cancel")}
          </Button>
          <Button
            type="submit"
            form="terminal-launch-form"
            disabled={busy || !cwd.trim()}
          >
            {t(
              workspace.launchPending
                ? "terminal.phase.starting"
                : "terminal.launchConfirm",
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
