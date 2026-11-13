import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw, ShieldAlert, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Notice } from "@/components/ui/notice";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  lessonErrorMessage,
  lessonsApi,
  type InjectionPreview,
  type Lesson,
  type LessonState,
} from "@/lib/api/lessons";
import { tasksApi, type TaskWorkspace } from "@/lib/api/tasks";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { pluginPageClass } from "./pluginPage";

const ROOT_STORAGE_KEY = "phi.lesson.workspace";

function readStoredRoot() {
  try {
    return localStorage.getItem(ROOT_STORAGE_KEY);
  } catch {
    return null;
  }
}

function formatTime(ts: number | undefined) {
  if (!ts) return null;
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return null;
  }
}

/**
 * 教训库页签：仓库级的「禁区清单」。
 *
 * 三件事分开讲：教训从哪来（本机会话里的工具失败）、怎么回喂（`AGENTS.md` 里的
 * 一个小块、默认关闭）、删了怎么复原（删掉只是不再注入，理由留着）。界面上不放
 * 「一键全量注入」这类开关——注入的克制就是这个功能能不能活下去的前提。
 */
export function LessonsPanel() {
  const { t } = useTranslation();
  const [workspaces, setWorkspaces] = useState<TaskWorkspace[]>([]);
  const [root, setRoot] = useState<string>(() => readStoredRoot() ?? "");
  const [state, setState] = useState<LessonState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<InjectionPreview | null>(null);
  const [dismissTarget, setDismissTarget] = useState<Lesson | null>(null);

  const loadWorkspaces = useCallback(async () => {
    const list = await tasksApi.workspaces();
    setWorkspaces(list);
    return list;
  }, []);

  const loadState = useCallback(async (target: string) => {
    if (!target) {
      setState(null);
      return;
    }
    const next = await lessonsApi.state(target);
    setState(next);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const list = await loadWorkspaces();
        const stored = readStoredRoot();
        const next =
          list.find((entry) => entry.root === stored)?.root ??
          list[0]?.root ??
          "";
        if (cancelled) return;
        setRoot(next);
        await loadState(next);
        setError(null);
      } catch (err) {
        if (!cancelled) setError(lessonErrorMessage(err, t));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadState, loadWorkspaces, t]);

  const selectRoot = useCallback(
    async (next: string) => {
      setRoot(next);
      try {
        localStorage.setItem(ROOT_STORAGE_KEY, next);
      } catch {
        // 存不了就算了，下次回到第一个仓库
      }
      setLoading(true);
      try {
        await loadState(next);
        setError(null);
      } catch (err) {
        setError(lessonErrorMessage(err, t));
      } finally {
        setLoading(false);
      }
    },
    [loadState, t],
  );

  const scan = useCallback(async () => {
    if (!root) return;
    setScanning(true);
    try {
      setState(await lessonsApi.refresh(root));
      setError(null);
    } catch (err) {
      toast.error(lessonErrorMessage(err, t));
    } finally {
      setScanning(false);
    }
  }, [root, t]);

  const toggleInjection = useCallback(
    async (enabled: boolean) => {
      if (!root) return;
      setSaving(true);
      try {
        setPreview(await lessonsApi.setInjection(root, enabled));
        await loadState(root);
        setError(null);
      } catch (err) {
        toast.error(lessonErrorMessage(err, t));
      } finally {
        setSaving(false);
      }
    },
    [loadState, root, t],
  );

  const openPreview = useCallback(async () => {
    if (!root) return;
    try {
      setPreview(await lessonsApi.preview(root));
    } catch (err) {
      toast.error(lessonErrorMessage(err, t));
    }
  }, [root, t]);

  const restore = useCallback(
    async (lesson: Lesson) => {
      try {
        setState(await lessonsApi.restore(root, lesson.id));
      } catch (err) {
        toast.error(lessonErrorMessage(err, t));
      }
    },
    [root, t],
  );

  const active = useMemo(
    () => (state?.lessons ?? []).filter((lesson) => !lesson.dismissed),
    [state],
  );
  const dismissed = useMemo(
    () => (state?.lessons ?? []).filter((lesson) => lesson.dismissed),
    [state],
  );
  const scannedAt = formatTime(state?.lastScanAt);

  if (loading) {
    return (
      <div className={cn(pluginPageClass, "text-body text-fg-3")}>
        {t("pluginCenter.loading")}
      </div>
    );
  }

  if (workspaces.length === 0) {
    return (
      <div className={cn(pluginPageClass, "space-y-4")}>
        <p className="text-body text-fg-2">{t("pluginCenter.lessons.intro")}</p>
        <Notice
          tone="neutral"
          title={t("pluginCenter.lessons.noWorkspaceTitle")}
        >
          {t("pluginCenter.lessons.noWorkspaceBody")}
        </Notice>
      </div>
    );
  }

  return (
    <div className={cn(pluginPageClass, "space-y-4")}>
      <section className="space-y-1">
        <p className="text-body text-fg-2">{t("pluginCenter.lessons.intro")}</p>
        <p className="text-caption text-fg-3">
          {t("pluginCenter.lessons.sourceHint")}
        </p>
      </section>

      <div className="flex flex-wrap items-center gap-2">
        <Select value={root} onValueChange={(value) => void selectRoot(value)}>
          <SelectTrigger
            className="w-[260px]"
            aria-label={t("pluginCenter.lessons.repo")}
          >
            <SelectValue
              placeholder={t("pluginCenter.lessons.repoPlaceholder")}
            />
          </SelectTrigger>
          <SelectContent>
            {workspaces.map((workspace) => (
              <SelectItem key={workspace.root} value={workspace.root}>
                {workspace.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="ghost"
          size="compact"
          onClick={() => void scan()}
          disabled={scanning || !root}
        >
          <RefreshCw
            className={cn("me-1.5 h-3.5 w-3.5", scanning && "animate-spin")}
          />
          {scanning
            ? t("pluginCenter.lessons.scanning")
            : t("pluginCenter.lessons.scan")}
        </Button>
      </div>

      {error && (
        <Notice
          tone="danger"
          title={t("pluginCenter.lessons.loadFailed")}
          actions={
            <Button size="compact" onClick={() => void selectRoot(root)}>
              {t("pluginCenter.refresh")}
            </Button>
          }
        >
          {error}
        </Notice>
      )}

      {state && (
        <p className="text-caption text-fg-3">
          {[
            root,
            scannedAt
              ? t("pluginCenter.lessons.scannedAt", { time: scannedAt })
              : t("pluginCenter.lessons.neverScanned"),
            t("pluginCenter.lessons.scanSummary", {
              sessions: state.scannedSessions,
              failures: state.failures,
            }),
            state.pendingSessions > 0
              ? t("pluginCenter.lessons.pending", {
                  count: state.pendingSessions,
                })
              : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      )}

      {state && (
        <section className="rounded-panel border border-border bg-surface">
          <div className="flex items-start justify-between gap-4 p-4">
            <div className="space-y-1">
              <p className="flex items-center gap-2 text-strong font-medium text-fg-1">
                <ShieldAlert className="h-4 w-4 text-fg-2" />
                {t("pluginCenter.lessons.injectionTitle")}
              </p>
              <p className="text-body text-fg-2">
                {t("pluginCenter.lessons.injectionHint", {
                  file: state.injection.file,
                })}
              </p>
              <p className="text-caption text-fg-3">
                {t("pluginCenter.lessons.injectionMeta", {
                  used: state.injection.usedChars,
                  budget: state.injection.budgetChars,
                  version: state.injection.version,
                })}
                {state.injection.enabled && !state.injection.applied
                  ? ` · ${t("pluginCenter.lessons.injectionStale")}`
                  : null}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2 pt-0.5">
              <Button
                variant="ghost"
                size="compact"
                onClick={() => void openPreview()}
              >
                {t("pluginCenter.lessons.preview")}
              </Button>
              <Switch
                size="sm"
                checked={state.injection.enabled}
                disabled={saving}
                aria-label={t("pluginCenter.lessons.injectionTitle")}
                onCheckedChange={(next) => void toggleInjection(next)}
              />
            </div>
          </div>
        </section>
      )}

      {active.length === 0 && dismissed.length === 0 && (
        <div className="rounded-panel border border-dashed border-border px-4 py-8 text-center text-body text-fg-3">
          {t("pluginCenter.lessons.empty")}
        </div>
      )}

      {active.length > 0 && (
        <ul className="divide-y divide-border overflow-hidden rounded-panel border border-border">
          {active.map((lesson) => (
            <li key={lesson.id} className="space-y-1 bg-surface px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <p className="min-w-0 flex-1 text-strong font-medium text-fg-1">
                  {lesson.trigger}
                </p>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge variant="outline" className="text-fg-2">
                    {t("pluginCenter.lessons.hits", { count: lesson.hits })}
                  </Badge>
                  <Button
                    variant="ghost"
                    size="compact"
                    aria-label={t("pluginCenter.lessons.dismiss")}
                    onClick={() => setDismissTarget(lesson)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
              <p className="text-body text-fg-2">{lesson.nextStep}</p>
              <p className="text-caption text-fg-3">
                {[
                  lesson.paths.length > 0 ? lesson.paths.join("、") : null,
                  lesson.evidence,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </li>
          ))}
        </ul>
      )}

      {dismissed.length > 0 && (
        <section className="space-y-2">
          <p className="text-caption text-fg-3">
            {t("pluginCenter.lessons.dismissedTitle")}
          </p>
          <ul className="divide-y divide-border overflow-hidden rounded-panel border border-border">
            {dismissed.map((lesson) => (
              <li
                key={lesson.id}
                className="flex items-start justify-between gap-3 bg-surface px-4 py-3"
              >
                <div className="min-w-0 space-y-1">
                  <p className="text-body text-fg-2 line-through">
                    {lesson.trigger}
                  </p>
                  <p className="text-caption text-fg-3">
                    {lesson.dismissReason
                      ? t("pluginCenter.lessons.dismissReason", {
                          reason: lesson.dismissReason,
                        })
                      : t("pluginCenter.lessons.dismissedTitle")}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="compact"
                  onClick={() => void restore(lesson)}
                >
                  {t("pluginCenter.lessons.restore")}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {preview && (
        <InjectionPreviewDialog
          preview={preview}
          onClose={() => setPreview(null)}
        />
      )}

      {dismissTarget && (
        <DismissDialog
          lesson={dismissTarget}
          onCancel={() => setDismissTarget(null)}
          onConfirm={async (reason) => {
            try {
              setState(
                await lessonsApi.dismiss(root, dismissTarget.id, reason),
              );
              setDismissTarget(null);
            } catch (err) {
              toast.error(lessonErrorMessage(err, t));
            }
          }}
        />
      )}
    </div>
  );
}

interface InjectionPreviewDialogProps {
  preview: InjectionPreview;
  onClose: () => void;
}

/** 注入预览：写进仓库之前先把这一块摊开给人看。 */
function InjectionPreviewDialog({
  preview,
  onClose,
}: InjectionPreviewDialogProps) {
  const { t } = useTranslation();
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {t("pluginCenter.lessons.previewTitle", { file: preview.file })}
          </DialogTitle>
          <DialogDescription>
            {t("pluginCenter.lessons.previewHint", {
              used: preview.usedChars,
              budget: preview.budgetChars,
              count: preview.lessonCount,
            })}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {preview.block ? (
            <pre className="max-h-[320px] overflow-auto rounded-panel border border-border bg-subtle p-3 text-caption text-fg-1">
              {preview.block}
            </pre>
          ) : (
            <Notice
              tone="neutral"
              title={t("pluginCenter.lessons.previewEmpty")}
            />
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" size="compact" onClick={onClose}>
            {t("pluginCenter.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface DismissDialogProps {
  lesson: Lesson;
  onCancel: () => void;
  onConfirm: (reason: string) => Promise<void>;
}

/** 删除一条教训。理由必填——下次重算才知道为什么它不该出现。 */
function DismissDialog({ lesson, onCancel, onConfirm }: DismissDialogProps) {
  const { t } = useTranslation();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = useCallback(async () => {
    if (!reason.trim()) return;
    setBusy(true);
    try {
      await onConfirm(reason.trim());
    } finally {
      setBusy(false);
    }
  }, [onConfirm, reason]);

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("pluginCenter.lessons.dismissTitle")}</DialogTitle>
          <DialogDescription>
            {t("pluginCenter.lessons.dismissHint")}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <p className="rounded-panel border border-border bg-subtle px-3 py-2 text-body text-fg-2">
            {lesson.trigger}
          </p>
          <Textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder={t("pluginCenter.lessons.dismissPlaceholder")}
            className="min-h-[90px]"
          />
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" size="compact" onClick={onCancel}>
            {t("pluginCenter.lessons.cancel")}
          </Button>
          <Button
            variant="destructive"
            size="compact"
            disabled={busy || !reason.trim()}
            onClick={() => void submit()}
          >
            {t("pluginCenter.lessons.dismiss")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
