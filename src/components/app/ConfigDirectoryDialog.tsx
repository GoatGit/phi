import { useTranslation } from "react-i18next";
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { useSettings } from "@/hooks/useSettings";
import type { SettingsFormState } from "@/hooks/useSettings";
import { useSettingsQuery } from "@/lib/query";
import type { Settings } from "@/types";
import { APP_DISPLAY_NAME, AppGlyph } from "@/components/shell/AppGlyph";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  DirectoryInput,
  type DirectoryAppId,
} from "@/components/settings/DirectorySettings";
import { CodexAuthSettings } from "@/components/settings/CodexAuthSettings";
import {
  SettingsCard,
  SettingsRow,
  SettingsSwitchRow,
} from "@/components/settings/SettingsLayout";

/** 各应用的配置目录在 Settings 表单里对应的字段。 */
const DIRECTORY_FIELD: Record<DirectoryAppId, keyof Settings> = {
  claude: "claudeConfigDir",
  codex: "codexConfigDir",
  gemini: "geminiConfigDir",
  grokbuild: "grokConfigDir",
  opencode: "opencodeConfigDir",
  openclaw: "openclawConfigDir",
  hermes: "hermesConfigDir",
  pi: "piConfigDir",
};

const DIRECTORY_PLACEHOLDER: Record<DirectoryAppId, string> = {
  claude: "settings.browsePlaceholderClaude",
  codex: "settings.browsePlaceholderCodex",
  gemini: "settings.browsePlaceholderGemini",
  grokbuild: "settings.browsePlaceholderGrok",
  opencode: "settings.browsePlaceholderOpencode",
  openclaw: "settings.browsePlaceholderOpenclaw",
  hermes: "settings.browsePlaceholderHermes",
  pi: "settings.browsePlaceholderPi",
};

const normalizeDir = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

interface ConfigDirectoryDialogProps {
  app: DirectoryAppId;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * 单个应用的配置弹窗：只属于它的开关和配置目录。
 * 替代原「设置 → 配置目录」分区——目录改动点「保存」才写入。
 */
export function ConfigDirectoryDialog({
  app,
  open,
  onOpenChange,
}: ConfigDirectoryDialogProps) {
  const { t } = useTranslation();
  const {
    settings,
    resolvedDirs,
    isSaving,
    updateSettings,
    updateDirectory,
    browseDirectory,
    resetDirectory,
    saveSettings,
  } = useSettings();
  const { data: savedSettings } = useSettingsQuery();
  const [needsRestart, setNeedsRestart] = useState(false);

  /** 开关类：先乐观更新表单，再整表静默保存 */
  const autoSave = (updates: Partial<SettingsFormState>) => {
    setNeedsRestart(false);
    updateSettings(updates);
    void saveSettings(updates, { silent: true });
  };

  const field = DIRECTORY_FIELD[app];
  const isDirty =
    normalizeDir(settings?.[field as keyof SettingsFormState]) !==
    normalizeDir(savedSettings?.[field]);

  const handleSave = async () => {
    const result = await saveSettings(undefined, { silent: false });
    if (!result) return;
    if (result.requiresRestart) {
      setNeedsRestart(true);
      return;
    }
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AppGlyph app={app} size={18} badgeClassName="bg-app" />
            {t("appPage.configDirectory")}
            <span className="text-fg-2">· {APP_DISPLAY_NAME[app]}</span>
          </DialogTitle>
        </DialogHeader>
        <div className="px-6 pb-2">
          <SettingsCard>
            {app === "claude" && (
              <>
                <SettingsSwitchRow
                  label={t("settings.enableClaudePluginIntegration")}
                  help={{
                    title: t("settings.enableClaudePluginIntegration"),
                    body: t(
                      "settings.enableClaudePluginIntegrationDescription",
                    ),
                  }}
                  checked={!!settings?.enableClaudePluginIntegration}
                  onCheckedChange={(value) =>
                    autoSave({ enableClaudePluginIntegration: value })
                  }
                />
                <SettingsSwitchRow
                  label={t("settings.skipClaudeOnboarding")}
                  help={{
                    title: t("settings.skipClaudeOnboarding"),
                    body: t("settings.skipClaudeOnboardingDescription"),
                  }}
                  checked={!!settings?.skipClaudeOnboarding}
                  onCheckedChange={(value) =>
                    autoSave({ skipClaudeOnboarding: value })
                  }
                />
              </>
            )}
            {app === "codex" && settings && (
              <CodexAuthSettings
                settings={settings}
                onChange={autoSave}
                codexConfigDir={savedSettings?.codexConfigDir}
              />
            )}
            <SettingsRow
              label={t("settings.appConfig.configDir")}
              help={{
                title: t("settings.appConfig.configDir"),
                body: t("settings.configDirectoryDescription"),
              }}
            >
              <DirectoryInput
                label=""
                value={
                  settings?.[field as keyof SettingsFormState] as
                    | string
                    | undefined
                }
                resolvedValue={resolvedDirs[app]}
                placeholder={t(DIRECTORY_PLACEHOLDER[app])}
                onChange={(value) => {
                  setNeedsRestart(false);
                  updateDirectory(app, value);
                }}
                onBrowse={() => browseDirectory(app)}
                onReset={() => resetDirectory(app)}
              />
            </SettingsRow>
          </SettingsCard>
          <div className="mt-3 flex items-center justify-end gap-3">
            {needsRestart && (
              <p role="status" className="me-auto text-sm text-fg-2">
                {t("settings.restartRequiredMessage")}
              </p>
            )}
            {/* 遮罩点击与 ESC 之外必须有一个可见的关闭入口；目录未改动时它是唯一按钮 */}
            <DialogClose asChild>
              <Button type="button" variant="outline" size="compact">
                {t("common.close")}
              </Button>
            </DialogClose>
            {isDirty && (
              <Button
                variant="solid"
                size="compact"
                disabled={isSaving}
                onClick={() => void handleSave()}
              >
                {isSaving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {t("common.save")}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
