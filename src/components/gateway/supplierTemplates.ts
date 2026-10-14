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

type SupplierTemplate = PresetEntry & { appId: ProxyAppId };

// Keep the original IDs so each existing form can load its complete template.
// Shared suppliers appear once; app-specific client defaults do not create
// separate suppliers. Prefer the existing pool default (Claude's template).
const templates: SupplierTemplate[] = [
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
  ]);
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});
