import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Play } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import {
  commandErrorMessage,
  pluginsApi,
  type PluginHook,
} from "@/lib/api/plugins";
import { pluginKeys, type PluginCenterEntry } from "@/hooks/usePluginCatalog";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import {
  PluginPreviewDialog,
  SessionExitPreviewDialog,
} from "./PluginPreviewDialogs";
import {
  SettingsBlock,
  SettingsCard,
  SettingsRow,
  SettingsSwitchRow,
} from "@/components/settings/SettingsLayout";
import { pluginPageClass } from "./pluginPage";
import { PluginGuide } from "./pluginSection";

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
 * 只处理清单插件：一句话说清它是干什么的，然后才是启停、优先级与试跑。
 * 插件名已经在页签上，这里不再重复一遍。
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
      <div className={pluginPageClass}>
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

  const kindLabel =
    plugin.kind === "script"
      ? t("pluginCenter.stages.kindScript")
      : plugin.kind === "feature"
        ? t("pluginCenter.stages.kindFeature")
        : t("pluginCenter.stages.kindRules");

  // 来源、作者、版本是同一类「查得到就行」的信息，压成一行，不占正文版面。
  const metaLine = [
    plugin.builtin
      ? t("pluginCenter.stages.builtin")
      : t("pluginCenter.detail.sourceDir", { dir: plugin.sourceDir }),
    plugin.author,
    `v${plugin.version}`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className={cn(pluginPageClass, "space-y-5")}>
      <section className="space-y-2">
        {plugin.description && (
          <p className="text-body text-fg-2">{plugin.description}</p>
        )}
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline" className="text-fg-2">
            {kindLabel}
          </Badge>
          {plugin.hooks.map((hook) => (
            <Badge key={hook} variant="outline" className="text-fg-3">
              {hookLabel(hook, (key) => t(key) as string)}
            </Badge>
          ))}
        </div>
      </section>

      <SettingsCard>
        <SettingsSwitchRow
          label={t("pluginCenter.detail.enable")}
          description={t("pluginCenter.detail.enableHint")}
          checked={plugin.enabled}
          disabled={busy}
          onCheckedChange={(next) => void toggle(next)}
        />
        <SettingsRow
          label={t("pluginCenter.detail.priority")}
          control={
            <span className="text-body tabular-nums text-fg-1">
              {plugin.priority}
            </span>
          }
        />
        {plugin.kind === "rules" && (
          <SettingsRow
            label={t("pluginCenter.detail.rules")}
            control={
              <span className="text-body tabular-nums text-fg-1">
                {plugin.ruleCount}
              </span>
            }
          />
        )}
        <p
          className="truncate px-4 py-2 text-caption text-fg-3"
          title={metaLine}
        >
          {metaLine}
        </p>
      </SettingsCard>

      {(canPreviewRequest || canPreviewSessionExit) && (
        <SettingsBlock title={t("pluginCenter.detail.tryRun")}>
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
        </SettingsBlock>
      )}

      <PluginGuide
        title={t("pluginCenter.guide.title")}
        summary={
          plugin.description?.trim() ||
          t("pluginCenter.detail.about.whatFallback")
        }
        steps={[1, 2, 3].map((step) =>
          t(`pluginCenter.detail.about.step${step}`),
        )}
        note={t("pluginCenter.detail.about.note")}
      />

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
