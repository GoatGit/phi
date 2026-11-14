import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, ShieldCheck, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { HoverTip } from "@/components/ui/hover-tip";
import { Input } from "@/components/ui/input";
import { Notice } from "@/components/ui/notice";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  SettingsBlock,
  SettingsCard,
  SettingsSwitchRow,
} from "@/components/settings/SettingsLayout";
import {
  commandErrorMessage,
  privacyApi,
  type DetectorKind,
  type PrivacyConfig,
  type PrivacyConfigResponse,
  type PrivacyPreviewResponse,
  type RedactionAction,
  type RedactionRuleConfig,
} from "@/lib/api/plugins";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { pluginPageClass } from "./pluginPage";
import {
  PluginEmpty,
  PluginField,
  PluginGuide,
  PluginLede,
  PluginSaveBar,
} from "./pluginSection";

/** 检测器 → 文案键，顺序与后端 `DetectorKind` 一致。 */
const DETECTOR_LABEL: Record<DetectorKind, string> = {
  "api-key": "apiKey",
  "bearer-token": "bearerToken",
  "aws-access-key": "awsAccessKey",
  "private-key-block": "privateKeyBlock",
  email: "email",
  phone: "phone",
  "id-card": "idCard",
  "credit-card": "creditCard",
  "ip-address": "ipAddress",
  custom: "custom",
};

const ACTIONS: RedactionAction[] = ["mask", "remove"];

function blankRule(detector: DetectorKind): RedactionRuleConfig {
  return {
    detector,
    action: "mask",
    replacement: null,
    customPattern: detector === "custom" ? "" : null,
  };
}

/**
 * 隐私脱敏页签。
 *
 * 两条默认值刻意不同，界面上要让人一眼分清：错误摘要默认脱敏（只是本地诊断材料），
 * 请求体默认不动（改 prompt 是行为变化）。试跑读的是**已保存**的配置，所以改完
 * 规则要先保存——这条提示直接写在试跑框上面，避免「试跑没效果」的误判。
 */
export function PrivacyPanel() {
  const { t } = useTranslation();
  const [data, setData] = useState<PrivacyConfigResponse | null>(null);
  const [draft, setDraft] = useState<PrivacyConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [sample, setSample] = useState(
    "联系我：someone@example.com / 13800138000，token 是 sk-abcdefghijklmnopqrstuvwxyz012345",
  );
  const [preview, setPreview] = useState<PrivacyPreviewResponse | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const apply = useCallback((response: PrivacyConfigResponse) => {
    setData(response);
    setDraft(response.config);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      apply(await privacyApi.get());
      setError(null);
    } catch (err) {
      setError(commandErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [apply]);

  useEffect(() => {
    void load();
  }, [load]);

  const detectors = useMemo(() => data?.detectors ?? [], [data]);

  const patch = useCallback((changes: Partial<PrivacyConfig>) => {
    setDraft((current) => (current ? { ...current, ...changes } : current));
  }, []);

  const patchRule = useCallback(
    (index: number, changes: Partial<RedactionRuleConfig>) => {
      setDraft((current) => {
        if (!current) return current;
        const rules = current.rules.map((rule, position) =>
          position === index ? { ...rule, ...changes } : rule,
        );
        return { ...current, rules };
      });
    },
    [],
  );

  const addRule = useCallback(() => {
    setDraft((current) => {
      if (!current) return current;
      // 先挑一个还没用过的内置检测器，用完了再退到自定义。
      const used = new Set(current.rules.map((rule) => rule.detector));
      const next =
        detectors.find((detector) => detector.builtin && !used.has(detector.id))
          ?.id ?? "custom";
      return { ...current, rules: [...current.rules, blankRule(next)] };
    });
  }, [detectors]);

  const removeRule = useCallback((index: number) => {
    setDraft((current) =>
      current
        ? {
            ...current,
            rules: current.rules.filter((_, position) => position !== index),
          }
        : current,
    );
  }, []);

  const save = useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    try {
      apply(await privacyApi.save(draft));
      toast.success(t("pluginCenter.privacy.saved"));
    } catch (err) {
      toast.error(
        t("pluginCenter.privacy.saveFailed", {
          message: commandErrorMessage(err),
        }),
      );
    } finally {
      setSaving(false);
    }
  }, [apply, draft, t]);

  const runPreview = useCallback(async () => {
    setPreviewing(true);
    try {
      setPreview(await privacyApi.preview(sample));
    } catch (err) {
      toast.error(commandErrorMessage(err));
    } finally {
      setPreviewing(false);
    }
  }, [sample]);

  if (loading) {
    return (
      <div className={cn(pluginPageClass, "text-body text-fg-3")}>
        {t("pluginCenter.loading")}
      </div>
    );
  }

  if (error || !draft) {
    return (
      <div className={cn(pluginPageClass, "space-y-4")}>
        <Notice
          tone="danger"
          title={t("pluginCenter.privacy.loadFailed")}
          actions={
            <Button size="compact" onClick={() => void load()}>
              {t("pluginCenter.refresh")}
            </Button>
          }
        >
          {error}
        </Notice>
      </div>
    );
  }

  // 改过但没保存时，页尾点一句，别让人以为配置已经生效。
  const dirty = data
    ? JSON.stringify(draft) !== JSON.stringify(data.config)
    : false;

  return (
    <div className={cn(pluginPageClass, "space-y-5")}>
      <PluginLede>{t("pluginCenter.privacy.intro")}</PluginLede>

      <SettingsCard>
        <SettingsSwitchRow
          label={t("pluginCenter.privacy.enabled")}
          description={t("pluginCenter.privacy.enabledHint")}
          checked={draft.enabled}
          onCheckedChange={(enabled) => patch({ enabled })}
        />
        <SettingsSwitchRow
          label={t("pluginCenter.privacy.body")}
          description={t("pluginCenter.privacy.bodyHint")}
          checked={draft.applyToRequestBody}
          disabled={!draft.enabled}
          onCheckedChange={(applyToRequestBody) =>
            patch({ applyToRequestBody })
          }
        />
        <SettingsSwitchRow
          label={t("pluginCenter.privacy.logs")}
          description={t("pluginCenter.privacy.logsHint")}
          checked={draft.redactErrorLogs}
          disabled={!draft.enabled}
          onCheckedChange={(redactErrorLogs) => patch({ redactErrorLogs })}
        />
      </SettingsCard>

      <SettingsBlock
        title={t("pluginCenter.privacy.rules")}
        actions={
          <Button variant="ghost" size="compact" onClick={addRule}>
            <Plus className="me-1.5 h-3.5 w-3.5" />
            {t("pluginCenter.privacy.addRule")}
          </Button>
        }
      >
        {draft.rules.length === 0 ? (
          <PluginEmpty>{t("pluginCenter.privacy.noRules")}</PluginEmpty>
        ) : (
          <SettingsCard>
            {draft.rules.map((rule, index) => (
              <div key={`${rule.detector}-${index}`} className="px-4 py-3">
                <div className="grid items-end gap-x-3 gap-y-2 sm:grid-cols-[minmax(0,1fr)_112px_minmax(0,1fr)_28px]">
                  <PluginField label={t("pluginCenter.privacy.ruleDetector")}>
                    <Select
                      value={rule.detector}
                      onValueChange={(value) => {
                        const detector = value as DetectorKind;
                        patchRule(index, {
                          detector,
                          // 切到自定义时要给一个可编辑的正则框；切回内置时清掉，
                          // 否则后端会因为「非 custom 带了 customPattern」拒绝保存。
                          customPattern: detector === "custom" ? "" : null,
                        });
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue
                          placeholder={t("pluginCenter.privacy.ruleDetector")}
                        />
                      </SelectTrigger>
                      <SelectContent>
                        {detectors.map((detector) => (
                          <SelectItem key={detector.id} value={detector.id}>
                            {t(
                              `pluginCenter.privacy.detectors.${DETECTOR_LABEL[detector.id]}`,
                            )}
                            {detector.builtin ? "" : " (regex)"}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </PluginField>

                  <PluginField label={t("pluginCenter.privacy.ruleAction")}>
                    <Select
                      value={rule.action}
                      onValueChange={(value) =>
                        patchRule(index, { action: value as RedactionAction })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue
                          placeholder={t("pluginCenter.privacy.ruleAction")}
                        />
                      </SelectTrigger>
                      <SelectContent>
                        {ACTIONS.map((action) => (
                          <SelectItem key={action} value={action}>
                            {action === "mask"
                              ? t("pluginCenter.privacy.actionMask")
                              : t("pluginCenter.privacy.actionRemove")}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </PluginField>

                  <PluginField label={t("pluginCenter.privacy.replacement")}>
                    <Input
                      value={rule.replacement ?? ""}
                      placeholder="***"
                      onChange={(event) =>
                        patchRule(index, {
                          replacement: event.target.value || null,
                        })
                      }
                    />
                  </PluginField>

                  <HoverTip content={t("pluginCenter.privacy.removeRule")}>
                    <Button
                      variant="ghost"
                      size="icon-compact"
                      aria-label={t("pluginCenter.privacy.removeRule")}
                      onClick={() => removeRule(index)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </HoverTip>
                </div>

                {rule.detector === "custom" && (
                  <div className="mt-2 sm:max-w-[calc(50%-0.375rem)]">
                    <PluginField
                      label={t("pluginCenter.privacy.customPatternHint")}
                    >
                      <Input
                        className="font-mono text-caption"
                        value={rule.customPattern ?? ""}
                        onChange={(event) =>
                          patchRule(index, {
                            customPattern: event.target.value,
                          })
                        }
                      />
                    </PluginField>
                  </div>
                )}
              </div>
            ))}
          </SettingsCard>
        )}
      </SettingsBlock>

      <SettingsBlock
        title={t("pluginCenter.privacy.preview")}
        actions={
          <Button
            variant="secondary"
            size="compact"
            onClick={() => void runPreview()}
            disabled={previewing}
          >
            <ShieldCheck className="me-1.5 h-3.5 w-3.5" />
            {previewing
              ? t("pluginCenter.running")
              : t("pluginCenter.privacy.previewRun")}
          </Button>
        }
      >
        <p className="text-caption text-fg-3">
          {t("pluginCenter.privacy.previewHint")}
        </p>
        <SettingsCard>
          <label className="block space-y-1.5 px-4 py-3">
            <span className="block text-caption text-fg-3">
              {t("pluginCenter.privacy.previewInput")}
            </span>
            <Textarea
              value={sample}
              onChange={(event) => setSample(event.target.value)}
              className="min-h-[96px] font-mono text-caption"
              spellCheck={false}
            />
          </label>
        </SettingsCard>
        {preview && (
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="text-caption text-fg-2">
                {t("pluginCenter.privacy.previewOutput")}
              </span>
              <Badge variant="outline" className="text-fg-2">
                {t("pluginCenter.privacy.previewHits", {
                  count: preview.hits,
                })}
              </Badge>
            </div>
            <pre className="overflow-auto rounded-panel border border-border bg-subtle p-3 text-caption text-fg-1">
              {preview.text}
            </pre>
          </div>
        )}
      </SettingsBlock>

      <PluginGuide
        title={t("pluginCenter.guide.title")}
        summary={t("pluginCenter.privacy.about.what")}
        steps={[1, 2, 3, 4].map((step) =>
          t(`pluginCenter.privacy.about.step${step}`),
        )}
        note={t("pluginCenter.privacy.about.note")}
      />

      <PluginSaveBar
        onSave={() => void save()}
        label={t("pluginCenter.save")}
        savingLabel={t("pluginCenter.saving")}
        saving={saving}
        dirty={dirty}
        dirtyLabel={t("pluginCenter.unsaved")}
      />
    </div>
  );
}
