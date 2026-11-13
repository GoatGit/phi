import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Play } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { Switch } from "@/components/ui/switch";
import {
  commandErrorMessage,
  pluginsApi,
  type PluginHook,
} from "@/lib/api/plugins";
import { pluginKeys, type PluginCenterEntry } from "@/hooks/usePluginCatalog";
import { toast } from "@/lib/toast";
import {
  PluginPreviewDialog,
  SessionExitPreviewDialog,
} from "./PluginPreviewDialogs";

/** 钩子标签。未知钩子原样展示，方便插件作者自己扩展时先看到它。 */
function hookLabel(hook: PluginHook, t: (key: string) => string): string {
  if (hook === "request") return t("sessionBaton.hooks.request");
  if (hook === "session-exit") return t("sessionBaton.hooks.sessionExit");
  return hook;
}

/**
 * 单个插件的详情页（插件中心里的一个页签）。
 *
 * 固定卡片里的「成绩单 / 隐私脱敏 / MCP 路由 / 教训库」都有自己的面板；这里
 * 只处理清单插件：展示它挂在哪、按什么顺序跑、来源在哪，并提供启停与试跑。
 */
export function PluginDetailPage({ entry }: { entry: PluginCenterEntry }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<"request" | "session-exit" | null>(
    null,
  );

  const plugin = entry.summary;
  if (!plugin) {
    return (
      <div className="px-6 pb-10">
        <Notice tone="warning" title={t("pluginCenter.detail.missing")} />
      </div>
    );
  }

  const toggle = async (enabled: boolean) => {
    setBusy(true);
    try {
      await pluginsApi.setEnabled(plugin.id, enabled);
      void queryClient.invalidateQueries({ queryKey: pluginKeys.list });
    } catch (err) {
      toast.error(
        t("pluginCenter.stages.toggleFailed", {
          message: commandErrorMessage(err),
        }),
      );
    } finally {
      setBusy(false);
    }
  };

  const canPreviewRequest = plugin.hooks.includes("request");
  const canPreviewSessionExit = plugin.hooks.includes("session-exit");

  return (
    <div className="space-y-5 px-6 pb-10">
      <section className="space-y-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-strong font-medium text-fg-1">
            {plugin.name}
          </span>
          <Badge variant="outline" className="text-fg-2">
            {plugin.kind === "script"
              ? t("pluginCenter.stages.kindScript")
              : plugin.kind === "feature"
                ? t("pluginCenter.stages.kindFeature")
                : t("pluginCenter.stages.kindRules")}
          </Badge>
          {plugin.hooks.map((hook) => (
            <Badge key={hook} variant="outline" className="text-fg-3">
              {hookLabel(hook, (key) => t(key) as string)}
            </Badge>
          ))}
          <span className="text-caption text-fg-3">v{plugin.version}</span>
        </div>
        {plugin.description && (
          <p className="text-body text-fg-2">{plugin.description}</p>
        )}
        <p className="text-caption text-fg-3">
          {[
            plugin.builtin
              ? t("pluginCenter.stages.builtin")
              : t("pluginCenter.detail.sourceDir", { dir: plugin.sourceDir }),
            plugin.author,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </section>

      <section className="rounded-panel border border-border bg-surface">
        <div className="flex items-center justify-between gap-4 px-4 py-3">
          <div className="min-w-0 space-y-0.5">
            <p className="text-strong text-fg-1">
              {t("pluginCenter.detail.enable")}
            </p>
            <p className="text-caption text-fg-3">
              {t("pluginCenter.detail.enableHint")}
            </p>
          </div>
          <Switch
            checked={plugin.enabled}
            disabled={busy}
            aria-label={t("pluginCenter.detail.enable")}
            onCheckedChange={(next) => void toggle(next)}
          />
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 border-t border-border px-4 py-3 text-caption">
          <div className="flex items-center justify-between gap-2">
            <dt className="text-fg-3">{t("pluginCenter.detail.priority")}</dt>
            <dd className="tabular-nums text-fg-1">{plugin.priority}</dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="text-fg-3">{t("pluginCenter.detail.rules")}</dt>
            <dd className="tabular-nums text-fg-1">{plugin.ruleCount}</dd>
          </div>
        </dl>
      </section>

      {(canPreviewRequest || canPreviewSessionExit) && (
        <section className="space-y-2">
          {canPreviewSessionExit && (
            <p className="text-caption text-fg-3">
              {t("sessionBaton.pluginCenter.hint")}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {canPreviewRequest && (
              <Button
                variant="quiet"
                size="compact"
                onClick={() => setPreview("request")}
              >
                <Play className="me-1.5 h-3.5 w-3.5" />
                {t("pluginCenter.detail.previewRequest")}
              </Button>
            )}
            {canPreviewSessionExit && (
              <Button
                variant="quiet"
                size="compact"
                onClick={() => setPreview("session-exit")}
              >
                <Play className="me-1.5 h-3.5 w-3.5" />
                {t("pluginCenter.detail.previewSessionExit")}
              </Button>
            )}
          </div>
        </section>
      )}

      {preview === "request" && (
        <PluginPreviewDialog plugin={plugin} onClose={() => setPreview(null)} />
      )}
      {preview === "session-exit" && (
        <SessionExitPreviewDialog
          plugin={plugin}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
}
