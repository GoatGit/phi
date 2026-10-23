import providers from "../../../subscriptions/bridge/providers.json";
import type { PresetEntry } from "@/components/providers/forms/ProviderPresetSelector";

export interface SubscriptionType {
  id: string;
  name: string;
  website: string;
  /** 图标名（src/icons/extracted），每个订阅供应商都有自己的品牌标。 */
  icon?: string;
}
export const subscriptionTypes: SubscriptionType[] = providers;
export const subscriptionTemplates = subscriptionTypes.map((provider) => ({
  id: "subscription:" + provider.id,
  appId: "claude" as const,
  preset: {
    name: provider.name,
    websiteUrl: provider.website,
    icon: provider.icon,
    settingsConfig: {},
    category: "third_party" as const,
    group: "subscription" as const,
  },
})) satisfies (PresetEntry & { appId: "claude" })[];

export const SUBSCRIPTION_BASE = "https://subscriptions.phi.invalid/";
export function subscriptionIdFromBase(base?: string) {
  if (!base?.startsWith(SUBSCRIPTION_BASE)) return undefined;
  const id = base.slice(SUBSCRIPTION_BASE.length);
  return /^[A-Za-z0-9_-]{1,100}$/.test(id) ? id : undefined;
}

export function subscriptionFromTemplate(id?: string) {
  return subscriptionTypes.find(
    (provider) => id === "subscription:" + provider.id,
  );
}

/** 订阅供应商的品牌图标；资源池卡片用它，不靠名称猜。 */
export function subscriptionIconFromBase(base?: string) {
  const id = subscriptionIdFromBase(base);
  return id
    ? subscriptionTypes.find((provider) => provider.id === id)?.icon
    : undefined;
}
