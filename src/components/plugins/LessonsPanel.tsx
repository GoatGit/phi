import { useCallback, useEffect, useState } from "react";
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
import { HoverTip } from "@/components/ui/hover-tip";
import { Notice } from "@/components/ui/notice";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  lessonErrorMessage,
  lessonsApi,
  type InjectionPreview,
  type Lesson,
  type LessonOverview,
  type LessonProject,
  type LessonState,
} from "@/lib/api/lessons";
import { toast } from "@/lib/toast";
import { SettingsCard } from "@/components/settings/SettingsLayout";
import { cn } from "@/lib/utils";
import { pluginPageClass } from "./pluginPage";
import { PluginGuide } from "./PluginGlyph";
import { PluginEmpty, PluginLede } from "./pluginSection";

function formatTime(ts: number | undefined) {
  if (!ts) return null;
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return null;
  }
}

/**
 * 教训库页签：本机所有会话沉淀出来的「禁区清单」。
 *
 * 三件事分开讲：教训从哪来（本机会话里的工具失败）、怎么回喂（`AGENTS.md` 里的
 * 一个小块、默认关闭）、删了怎么复原（删掉只是不再注入，理由留着）。界面上不放
 * 「一键全量注入」这类开关——注入的克制就是这个功能能不能活下去的前提。
 *
 * 仓库不需要先选：扫一遍会话，会话 cwd 所在的仓库就自动成为清单的归属地，
 * 所以这一页没有仓库选择器，只有「扫描会话」和一个按仓库分组的结果。
 */
export function LessonsPanel() {
  const { t } = useTranslation();
  const [overview, setOverview] = useState<LessonOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [savingRoot, setSavingRoot] = useState<string | null>(null);
  const [preview, setPreview] = useState<InjectionPreview | null>(null);
  const [dismissTarget, setDismissTarget] = useState<{
    root: string;
    lesson: Lesson;
  } | null>(null);

  /** 单仓库操作（删除、恢复、开关注入）只回一个仓库的状态，就地替换。 */
  const replaceState = useCallback((root: string, next: LessonState) => {
    setOverview((current) =>
      current
        ? {
            ...current,
            projects: current.projects.map((project) =>
              project.root === root ? { ...project, state: next } : project,
            ),
          }
        : current,
    );
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const next = await lessonsApi.overview();
        if (cancelled) return;
        setOverview(next);
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
  }, [t]);

  const scan = useCallback(async () => {
    setScanning(true);
    try {
      setOverview(await lessonsApi.scan());
      setError(null);
    } catch (err) {
      toast.error(lessonErrorMessage(err, t));
    } finally {
      setScanning(false);
    }
  }, [t]);

  const toggleInjection = useCallback(
    async (project: LessonProject, enabled: boolean) => {
      setSavingRoot(project.root);
      try {
        setPreview(await lessonsApi.setInjection(project.root, enabled));
        replaceState(project.root, await lessonsApi.state(project.root));
        setError(null);
      } catch (err) {
        toast.error(lessonErrorMessage(err, t));
      } finally {
        setSavingRoot(null);
      }
    },
    [replaceState, t],
  );

  const openPreview = useCallback(
    async (root: string) => {
      try {
        setPreview(await lessonsApi.preview(root));
      } catch (err) {
        toast.error(lessonErrorMessage(err, t));
      }
    },
    [t],
  );

  const restore = useCallback(
    async (root: string, lesson: Lesson) => {
      try {
        replaceState(root, await lessonsApi.restore(root, lesson.id));
      } catch (err) {
        toast.error(lessonErrorMessage(err, t));
      }
    },
    [replaceState, t],
  );

  if (loading) {
    return (
      <div className={cn(pluginPageClass, "text-body text-fg-3")}>
        {t("pluginCenter.loading")}
      </div>
    );
  }

  const projects = overview?.projects ?? [];
  // 没有失败记录的仓库不占版面：扫是全扫的，看只看真出过事的那几个。
  const reported = projects.filter(
    (project) => project.state.lessons.length > 0,
  );
  const scannedAt = formatTime(overview?.lastScanAt);
  const summary = [
    scannedAt
      ? t("pluginCenter.lessons.scannedAt", { time: scannedAt })
      : t("pluginCenter.lessons.neverScanned"),
    projects.length > 0
      ? t("pluginCenter.lessons.discovered", { count: projects.length })
      : null,
    overview && (overview.scannedSessions > 0 || overview.failures > 0)
      ? t("pluginCenter.lessons.scanSummary", {
          sessions: overview.scannedSessions,
          failures: overview.failures,
        })
      : null,
    overview && overview.pendingSessions > 0
      ? t("pluginCenter.lessons.pending", {
          count: overview.pendingSessions,
        })
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className={cn(pluginPageClass, "space-y-5")}>
      <PluginLede hint={t("pluginCenter.lessons.sourceHint")}>
        {t("pluginCenter.lessons.intro")}
      </PluginLede>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button
          variant="ghost"
          size="compact"
          onClick={() => void scan()}
          disabled={scanning}
        >
          <RefreshCw
            className={cn("me-1.5 h-3.5 w-3.5", scanning && "animate-spin")}
          />
          {scanning
            ? t("pluginCenter.lessons.scanning")
            : t("pluginCenter.lessons.scan")}
        </Button>
        <p className="text-caption text-fg-3">{summary}</p>
      </div>

      {error && (
        <Notice
          tone="danger"
          title={t("pluginCenter.lessons.loadFailed")}
          actions={
            <Button size="compact" onClick={() => void scan()}>
              {t("pluginCenter.refresh")}
            </Button>
          }
        >
          {error}
        </Notice>
      )}

      {reported.length === 0 ? (
        <PluginEmpty>
          {projects.length === 0
            ? t("pluginCenter.lessons.emptyHint")
            : t("pluginCenter.lessons.emptyScanned")}
        </PluginEmpty>
      ) : (
        reported.map((project) => (
          <ProjectSection
            key={project.root}
            project={project}
            saving={savingRoot === project.root}
            onToggleInjection={(enabled) =>
              void toggleInjection(project, enabled)
            }
            onPreview={() => void openPreview(project.root)}
            onRestore={(lesson) => void restore(project.root, lesson)}
            onDismiss={(lesson) =>
              setDismissTarget({ root: project.root, lesson })
            }
          />
        ))
      )}

      <PluginGuide
        pluginId="lessons"
        what={t("pluginCenter.lessons.about.what")}
        steps={[1, 2, 3, 4].map((step) =>
          t(`pluginCenter.lessons.about.step${step}`),
        )}
        notes={t("pluginCenter.lessons.about.note")}
      />

      {preview && (
        <InjectionPreviewDialog
          preview={preview}
          onClose={() => setPreview(null)}
        />
      )}

      {dismissTarget && (
        <DismissDialog
          lesson={dismissTarget.lesson}
          onCancel={() => setDismissTarget(null)}
          onConfirm={async (reason) => {
            const { root, lesson } = dismissTarget;
            try {
              replaceState(
                root,
                await lessonsApi.dismiss(root, lesson.id, reason),
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

interface ProjectSectionProps {
  project: LessonProject;
  saving: boolean;
  onToggleInjection: (enabled: boolean) => void;
  onPreview: () => void;
  onRestore: (lesson: Lesson) => void;
  onDismiss: (lesson: Lesson) => void;
}

/** 一个仓库：名字与路径只出现一次，注入开关跟着自己的仓库，不混成全局开关。 */
function ProjectSection({
  project,
  saving,
  onToggleInjection,
  onPreview,
  onRestore,
  onDismiss,
}: ProjectSectionProps) {
  const { t } = useTranslation();
  const active = project.state.lessons.filter((lesson) => !lesson.dismissed);
  const dismissed = project.state.lessons.filter((lesson) => lesson.dismissed);
  const injection = project.state.injection;

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <div className="flex min-w-0 items-center gap-2 text-body font-medium text-fg-1">
            <ShieldAlert className="h-4 w-4 shrink-0 text-fg-2" />
            <span className="truncate">{project.name}</span>
            <Badge variant="outline" className="shrink-0 text-fg-2">
              {t("pluginCenter.lessons.lessonCount", { count: active.length })}
            </Badge>
          </div>
          <p className="truncate text-caption text-fg-3">{project.root}</p>
          {injection.enabled && (
            <p className="text-caption text-fg-3">
              {t("pluginCenter.lessons.injectionMeta", {
                used: injection.usedChars,
                budget: injection.budgetChars,
                version: injection.version,
              })}
              {injection.applied
                ? null
                : ` · ${t("pluginCenter.lessons.injectionStale")}`}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="ghost" size="compact" onClick={onPreview}>
            {t("pluginCenter.lessons.preview")}
          </Button>
          <HoverTip content={t("pluginCenter.lessons.injectionTitle")}>
            <Switch
              size="sm"
              checked={injection.enabled}
              disabled={saving}
              aria-label={t("pluginCenter.lessons.injectionTitle")}
              onCheckedChange={onToggleInjection}
            />
          </HoverTip>
        </div>
      </div>

      <SettingsCard>
        {active.length === 0 ? (
          <p className="px-4 py-3 text-caption text-fg-3">
            {t("pluginCenter.lessons.allDismissed")}
          </p>
        ) : (
          active.map((lesson) => (
            <div key={lesson.id} className="space-y-1 px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <p className="min-w-0 flex-1 text-strong text-fg-1">
                  {lesson.trigger}
                </p>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge variant="outline" className="text-fg-2">
                    {t("pluginCenter.lessons.hits", { count: lesson.hits })}
                  </Badge>
                  <HoverTip content={t("pluginCenter.lessons.dismiss")}>
                    <Button
                      variant="ghost"
                      size="icon-compact"
                      aria-label={t("pluginCenter.lessons.dismiss")}
                      onClick={() => onDismiss(lesson)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </HoverTip>
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
            </div>
          ))
        )}
      </SettingsCard>

      {dismissed.length > 0 && (
        <div className="space-y-1">
          <p className="text-caption text-fg-3">
            {t("pluginCenter.lessons.dismissedTitle")}
          </p>
          <SettingsCard>
            {dismissed.map((lesson) => (
              <div
                key={lesson.id}
                className="flex items-start justify-between gap-3 px-4 py-3"
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
                  onClick={() => onRestore(lesson)}
                >
                  {t("pluginCenter.lessons.restore")}
                </Button>
              </div>
            ))}
          </SettingsCard>
        </div>
      )}
    </section>
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
