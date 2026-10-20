import { providerPresets } from "@/config/claudeProviderPresets";
import { codexProviderPresets } from "@/config/codexProviderPresets";
import { geminiProviderPresets } from "@/config/geminiProviderPresets";
import {
  grokBuildOfficialPreset,
  grokBuildProviderPresets,
} from "@/config/grokBuildProviderPresets";
import type { ProxyAppId } from "@/config/appConfig";
import type { PresetEntry } from "@/components/providers/forms/ProviderPresetSelector";
import { GROKBUILD_OFFICIAL_PROVIDER_ID } from "@/utils/providerCapabilities";

import { subscriptionTemplates } from "./subscriptionTemplates";

type SupplierTemplate = PresetEntry & { appId: ProxyAppId };

/**
 * 没有应用模板的协议出口：TypeSafe 的 System One（决策协议）。
 * 它不进应用表单，AddPoolSupplier 选中后直接打开资源池供应商编辑器。
 */
export const SYSTEM_ONE_TEMPLATE_ID = "systemone";

const systemOnePreset: PresetEntry["preset"] & { group: "vendor" } = {
  name: "TypeSafe System One",
  websiteUrl: "https://typesafe.ai",
  settingsConfig: {},
  category: "third_party",
  theme: { icon: "generic" },
  // TypeSafe 自己提供模型与决策接口，不是聚合器或中转站。用 group 覆盖
  // 分类，避免为了归到「模型厂商」而改掉 category 影响其它行为。
  group: "vendor",
};

const systemOneTemplate: SupplierTemplate = {
  id: SYSTEM_ONE_TEMPLATE_ID,
  // 仅占位：System One 不属于任何聊天应用，保存时不会读取这个 appId。
  appId: "claude",
  preset: systemOnePreset,
};

// Keep the original IDs so each existing form can load its complete template.
// Shared suppliers appear once; app-specific client defaults do not create
// separate suppliers. Prefer the existing pool default (Claude's template).
const templates: SupplierTemplate[] = [
  systemOneTemplate,
  ...subscriptionTemplates,
  ...providerPresets
    .filter((preset) => !preset.hidden)
    .map((preset, index) => ({
      id: `claude-${index}`,
      appId: "claude" as const,
      preset,
    })),
  ...codexProviderPresets.map((preset, index) => ({
    id: `codex-${index}`,
    appId: "codex" as const,
    preset,
  })),
  ...geminiProviderPresets.map((preset, index) => ({
    id: `gemini-${index}`,
    appId: "gemini" as const,
    preset,
  })),
  {
    id: GROKBUILD_OFFICIAL_PROVIDER_ID,
    appId: "grokbuild",
    preset: grokBuildOfficialPreset,
  },
  ...grokBuildProviderPresets.map((preset, index) => ({
    id: `grokbuild-${index}`,
    appId: "grokbuild" as const,
    preset,
  })),
];

const seen = new Set<string>();
export const supplierTemplates = templates.filter(({ preset }) => {
  const key = JSON.stringify([
    preset.name,
    preset.family,
    preset.planKey,
    preset.regionKey,
    "group" in preset ? preset.group : undefined,
  ]);
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});
