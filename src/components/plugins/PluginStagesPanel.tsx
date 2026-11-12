import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Play, RefreshCw } from "lucide-react";
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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  commandErrorMessage,
  pluginsApi,
  type PluginHook,
  type PluginSummary,
  type PluginSummaryResponse,
  type SessionExitDecision,
} from "@/lib/api/plugins";
import type { GlobalPage } from "@/lib/navigation";
import { panelViewFor, pluginKeys } from "@/hooks/usePluginPanels";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

/** 试跑默认样本：普通对话请求体，插件改了哪里一眼能看出来。 */
const SAMPLE_PAYLOAD = JSON.stringify(
  {
    model: "claude-sonnet-4",
    messages: [
      { role: "user", content: "我的邮箱是 someone@example.com，帮我写封邮件" },
    ],
  },
  null,
  2,
);

/** 接棒试跑默认样本：一次额度耗尽导致的异常退出。 */
const SAMPLE_EXIT_EVENT = JSON.stringify(
  {
    app: "claude",
    cwd: "/tmp/demo",
    exitCode: 1,
    failureKind: "quota",
    reason: "命中 quota 标记：usage limit",
    hasTarget: true,
    attempts: 0,
    lastKind: null,
    maxAttempts: 2,
    autoResume: true,
    evidence: ["上游 429：usage limit reached"],
    successes: 12,
  },
  null,
  2,
);

/** 钩子标签。未知钩子原样展示，方便插件作者自己扩展时先看到它。 */
function hookLabel(hook: PluginHook, t: (key: string) => string): string {
  if (hook === "request") return t("sessionBaton.hooks.request");
  if (hook === "session-exit") return t("sessionBaton.hooks.sessionExit");
  return hook;
}

/**
 * 这个插件该用哪种试跑：
 * - 声明了请求钩子 → 请求体改写试跑；
 * - 只声明会话退出钩子 → 接棒决策试跑；
 * - 功能插件两种都不跑（它只在界面挂面板）。
 */
function previewKind(
  plugin: PluginSummary,
): "request" | "session-exit" | "none" {
  if (plugin.kind === "feature") return "none";
  if (plugin.hooks.includes("request")) return "request";
  return "session-exit";
}

/**
 * 插件页签：磁盘插件与宿主自带功能插件的清单、启停、试跑。
 *
 * 请求插件可以干跑一次看它把请求体改成什么；功能插件不跑代码，只有「打开」
 * 一个动作。两类插件共用一份启用状态（`plugins-state.json`），停用后侧栏入口
 * 一起消失。
 */
export function PluginStagesPanel({
  onOpenPanel,
}: {
  onOpenPanel?: (page: GlobalPage) => void;
} = {}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [data, setData] = useState<PluginSummaryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [previewTarget, setPreviewTarget] = useState<PluginSummary | null>(
    null,
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await pluginsApi.list());
      setError(null);
    } catch (err) {
      setError(commandErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = useCallback(
    async (plugin: PluginSummary, enabled: boolean) => {
      setBusyId(plugin.id);
      try {
        // 命令回的是重扫后的完整摘要，直接替换本地状态，省一次往返。
        setData(await pluginsApi.setEnabled(plugin.id, enabled));
        setError(null);
        // 侧栏的功能面板入口读的是同一份摘要，启停后要重新拉一次。
        void queryClient.invalidateQueries({ queryKey: pluginKeys.list });
      } catch (err) {
        toast.error(
          t("pluginCenter.stages.toggleFailed", {
            message: commandErrorMessage(err),
          }),
        );
      } finally {
        setBusyId(null);
      }
    },
    [t, queryClient],
  );

  const plugins = data?.plugins ?? [];

  return (
    <div className="space-y-4 px-6 pb-10">
      <section className="space-y-1">
        <p className="text-body text-fg-2">{t("pluginCenter.stages.intro")}</p>
        {data && (
          <p className="text-caption text-fg-3">
            {t("pluginCenter.stages.dir")}：{data.root}
          </p>
        )}
      </section>

      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="compact"
          onClick={() => void load()}
          disabled={loading}
        >
          <RefreshCw
            className={cn("me-1.5 h-3.5 w-3.5", loading && "animate-spin")}
          />
          {t("pluginCenter.refresh")}
        </Button>
      </div>

      {error && (
        <Notice
          tone="danger"
          title={t("pluginCenter.stages.loadFailed")}
          actions={
            <Button size="compact" onClick={() => void load()}>
              {t("pluginCenter.refresh")}
            </Button>
          }
        >
          {error}
        </Notice>
      )}

      {data && data.errors.length > 0 && (
        <Notice tone="warning" title={t("pluginCenter.stages.loadFailures")}>
          <ul className="space-y-0.5">
            {data.errors.map((failure) => (
              <li key={`${failure.pluginDir}:${failure.message}`}>
                <span className="font-medium">{failure.pluginDir}</span>：
                {failure.message}
              </li>
            ))}
          </ul>
        </Notice>
      )}

      {!loading && plugins.length === 0 && !error && (
        <div className="rounded-panel border border-dashed border-border px-4 py-8 text-center text-body text-fg-3">
          {t("pluginCenter.stages.empty")}
        </div>
      )}

      {plugins.length > 0 && (
        <ul className="divide-y divide-border overflow-hidden rounded-panel border border-border">
          {plugins.map((plugin) => {
            const panelView =
              plugin.kind === "feature" && plugin.panel
                ? panelViewFor(plugin.panel.entry)
                : null;
            return (
              <li
                key={plugin.id}
                className="flex items-start gap-3 bg-surface px-4 py-3"
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-strong font-medium text-fg-1">
                      {plugin.name}
                    </span>
                    <Badge variant="outline" className="text-fg-2">
                      {plugin.kind === "feature"
                        ? t("pluginCenter.stages.kindFeature")
                        : plugin.kind === "script"
                          ? t("pluginCenter.stages.kindScript")
                          : t("pluginCenter.stages.kindRules")}
                    </Badge>
                    {plugin.hooks.map((hook) => (
                      <Badge key={hook} variant="outline" className="text-fg-3">
                        {hookLabel(hook, (key) => t(key) as string)}
                      </Badge>
                    ))}
                    <span className="text-caption text-fg-3">
                      v{plugin.version}
                    </span>
                  </div>
                  {plugin.description && (
                    <p className="text-body text-fg-2">{plugin.description}</p>
                  )}
                  <p className="text-caption text-fg-3">
                    {[
                      plugin.builtin
                        ? t("pluginCenter.stages.builtin")
                        : plugin.sourceDir,
                      plugin.kind === "feature"
                        ? t("pluginCenter.stages.panelEntry", {
                            entry: plugin.panel?.entry ?? "",
                          })
                        : t("pluginCenter.stages.priority", {
                            value: plugin.priority,
                          }),
                      plugin.kind === "rules"
                        ? t("pluginCenter.stages.ruleCount", {
                            count: plugin.ruleCount,
                          })
                        : null,
                      plugin.author,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                  {previewKind(plugin) === "session-exit" && (
                    <p className="text-caption text-fg-3">
                      {t("sessionBaton.pluginCenter.hint")}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2 pt-0.5">
                  {plugin.kind === "feature" ? (
                    <Button
                      variant="ghost"
                      size="compact"
                      disabled={!plugin.enabled || !panelView}
                      onClick={() => {
                        if (panelView) onOpenPanel?.(panelView);
                      }}
                    >
                      <ExternalLink className="me-1.5 h-3.5 w-3.5" />
                      {t("pluginCenter.stages.openPanel")}
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      size="compact"
                      onClick={() => setPreviewTarget(plugin)}
                    >
                      <Play className="me-1.5 h-3.5 w-3.5" />
                      {t("pluginCenter.stages.preview")}
                    </Button>
                  )}
                  <Switch
                    size="sm"
                    checked={plugin.enabled}
                    disabled={busyId === plugin.id}
                    aria-label={t("pluginCenter.stages.enable")}
                    onCheckedChange={(next) => void toggle(plugin, next)}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {previewTarget && previewKind(previewTarget) === "request" && (
        <PluginPreviewDialog
          plugin={previewTarget}
          onClose={() => setPreviewTarget(null)}
        />
      )}

      {previewTarget && previewKind(previewTarget) === "session-exit" && (
        <SessionExitPreviewDialog
          plugin={previewTarget}
          onClose={() => setPreviewTarget(null)}
        />
      )}
    </div>
  );
}

interface PluginPreviewDialogProps {
  plugin: PluginSummary;
  onClose: () => void;
}

/** 干跑对话框：输入一段请求体，看这个插件把它改成什么。 */
function PluginPreviewDialog({ plugin, onClose }: PluginPreviewDialogProps) {
  const { t } = useTranslation();
  const [input, setInput] = useState(SAMPLE_PAYLOAD);
  const [output, setOutput] = useState<string | null>(null);
  const [hits, setHits] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const run = useCallback(async () => {
    let payload: unknown;
    try {
      payload = JSON.parse(input);
    } catch {
      setError(t("pluginCenter.stages.invalidJson"));
      setOutput(null);
      setHits(null);
      return;
    }
    setRunning(true);
    try {
      const result = await pluginsApi.preview(plugin.id, payload);
      setError(result.error);
      setHits(result.error ? null : result.hits);
      setOutput(JSON.stringify(result.payload, null, 2));
    } catch (err) {
      setError(commandErrorMessage(err));
      setOutput(null);
      setHits(null);
    } finally {
      setRunning(false);
    }
  }, [input, plugin.id, t]);

  const summary =
    hits === null
      ? null
      : hits === 0
        ? t("pluginCenter.stages.previewNoHits")
        : t("pluginCenter.stages.previewHits", { count: hits });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {t("pluginCenter.stages.previewTitle", { name: plugin.name })}
          </DialogTitle>
          <DialogDescription>
            {t("pluginCenter.stages.previewHint")}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <label className="block space-y-1.5">
            <span className="text-caption text-fg-2">
              {t("pluginCenter.stages.previewInput")}
            </span>
            <Textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              className="min-h-[140px] font-mono text-caption"
              spellCheck={false}
            />
          </label>

          {error && <Notice tone="warning" title={error} />}

          {output !== null && (
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="text-caption text-fg-2">
                  {t("pluginCenter.stages.previewOutput")}
                </span>
                {summary && (
                  <Badge variant="outline" className="text-fg-2">
                    {summary}
                  </Badge>
                )}
              </div>
              <pre className="max-h-[240px] overflow-auto rounded-panel border border-border bg-subtle p-3 text-caption text-fg-1">
                {output}
              </pre>
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" size="compact" onClick={onClose}>
            {t("pluginCenter.close")}
          </Button>
          <Button size="compact" onClick={() => void run()} disabled={running}>
            {running
              ? t("pluginCenter.running")
              : t("pluginCenter.stages.previewRun")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface SessionExitPreviewDialogProps {
  plugin: PluginSummary;
  onClose: () => void;
}

/**
 * 接棒钩子的试跑：给它一段「会话刚挂了」的事件，看它到底怎么判。
 *
 * 这里只跑决策，不会启动或重启任何终端——真正的接棒在后台的退出记账监听里。
 */
function SessionExitPreviewDialog({
  plugin,
  onClose,
}: SessionExitPreviewDialogProps) {
  const { t } = useTranslation();
  const [input, setInput] = useState(SAMPLE_EXIT_EVENT);
  const [decision, setDecision] = useState<SessionExitDecision | null>(null);
  const [ran, setRan] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const run = useCallback(async () => {
    let event: unknown;
    try {
      event = JSON.parse(input);
    } catch {
      setError(t("sessionBaton.preview.invalidJson"));
      setDecision(null);
      setRan(false);
      return;
    }
    setRunning(true);
    try {
      const result = await pluginsApi.previewSessionExit(plugin.id, event);
      setDecision(result.decision);
      setRan(true);
      setError(null);
    } catch (err) {
      setError(commandErrorMessage(err));
      setDecision(null);
      setRan(false);
    } finally {
      setRunning(false);
    }
  }, [input, plugin.id, t]);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {t("sessionBaton.preview.title", { name: plugin.name })}
          </DialogTitle>
          <DialogDescription>
            {t("sessionBaton.preview.hint")}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <label className="block space-y-1.5">
            <span className="text-caption text-fg-2">
              {t("sessionBaton.preview.input")}
            </span>
            <Textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              className="min-h-[180px] font-mono text-caption"
              spellCheck={false}
            />
          </label>

          {error && <Notice tone="warning" title={error} />}

          {ran && (
            <div className="space-y-1.5">
              <span className="text-caption text-fg-2">
                {t("sessionBaton.preview.output")}
              </span>
              {decision ? (
                <div className="space-y-1 rounded-panel border border-border bg-subtle p-3">
                  <p className="text-body text-fg-1">
                    {decision.action === "resume"
                      ? t("sessionBaton.preview.actionResume")
                      : t("sessionBaton.preview.actionRecord")}
                    {decision.mode
                      ? ` · ${
                          decision.mode === "fresh-session"
                            ? t("sessionBaton.preview.modeFresh")
                            : t("sessionBaton.preview.modeSame")
                        }`
                      : null}
                  </p>
                  <p className="text-caption text-fg-2">{decision.reason}</p>
                </div>
              ) : (
                <p className="text-body text-fg-2">
                  {t("sessionBaton.preview.abstained")}
                </p>
              )}
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" size="compact" onClick={onClose}>
            {t("pluginCenter.close")}
          </Button>
          <Button size="compact" onClick={() => void run()} disabled={running}>
            {running
              ? t("pluginCenter.running")
              : t("pluginCenter.stages.previewRun")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
