import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
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
import { Textarea } from "@/components/ui/textarea";
import {
  commandErrorMessage,
  pluginsApi,
  type PluginSummary,
  type SessionExitDecision,
} from "@/lib/api/plugins";

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

interface PreviewDialogProps {
  plugin: PluginSummary;
  onClose: () => void;
}

/** 干跑对话框：输入一段请求体，看这个插件把它改成什么。 */
export function PluginPreviewDialog({ plugin, onClose }: PreviewDialogProps) {
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

/**
 * 接棒钩子的试跑：给它一段「会话刚挂了」的事件，看它到底怎么判。
 *
 * 这里只跑决策，不会启动或重启任何终端——真正的接棒在后台的退出记账监听里。
 */
export function SessionExitPreviewDialog({
  plugin,
  onClose,
}: PreviewDialogProps) {
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
