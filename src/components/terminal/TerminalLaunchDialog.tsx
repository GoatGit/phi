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
import type { TerminalWorkspace } from "./useTerminalWorkspace";

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
  useEffect(() => {
    setCwd(draft?.cwd ?? "");
    setArgumentsText(draft?.arguments ?? "");
    setPickerError(false);
  }, [draft]);
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
              if (!busy && cwd.trim())
                void workspace.startTerminal(cwd, argumentsText);
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
                />
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
