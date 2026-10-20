import { describe, expect, it } from "vitest";
import {
  subscriptionTemplates,
  subscriptionFromTemplate,
} from "@/components/gateway/subscriptionTemplates";
import { hasIcon, isTileIcon } from "@/icons/extracted";
import { supplierDirectCompatible } from "@/components/gateway/useGatewayCatalog";
import {
  presetGroup,
  PRESET_GROUP_ORDER,
} from "@/components/providers/forms/presetGroups";

describe("Magpie subscription catalog", () => {
  it("offers all 19 built-in subscription types in their own category", () => {
    expect(
      subscriptionTemplates
        .map((e) => subscriptionFromTemplate(e.id)?.id)
        .sort(),
    ).toEqual(
      [
        "antigravity",
        "claude",
        "codex",
        "commandcode-plan",
        "copilot",
        "cursor",
        "devin",
        "factory",
        "gemini",
        "grok",
        "kiro",
        "mimo-app",
        "chatgpt-api",
        "qoder",
        "qoder-cn",
        "workbuddy",
        "workbuddy-ai",
        "zcode",
        "zed",
      ].sort(),
    );
    expect(PRESET_GROUP_ORDER).toContain("subscription");
    expect(
      subscriptionTemplates.every(
        (e) => presetGroup(e.preset) === "subscription",
      ),
    ).toBe(true);
    expect(new Set(subscriptionTemplates.map((e) => e.id)).size).toBe(19);
  });
  it("gives every subscription its own brand logo", () => {
    for (const entry of subscriptionTemplates) {
      const icon = entry.preset.icon;
      expect(icon, `${entry.preset.name} has no icon`).toBeTruthy();
      expect(hasIcon(icon!), `${icon} is not a bundled icon`).toBe(true);
    }
    // 品牌标不能都是同一个占位图：每种订阅要么独占图标，要么两家共用同一品牌。
    const icons = subscriptionTemplates.map((e) => e.preset.icon);
    expect(new Set(icons).size).toBeGreaterThanOrEqual(15);
    // 自带底色的标铺满图标框，透明底的标缩小居中。
    expect(isTileIcon("codex")).toBe(true);
    expect(isTileIcon("kiro")).toBe(true);
    expect(isTileIcon("workbuddy")).toBe(true);
    expect(isTileIcon("cursor")).toBe(false);
  });
  it("keeps managed subscriptions behind local routing even for native Chat clients", () => {
    expect(
      supplierDirectCompatible(
        "opencode",
        "openai_chat",
        "https://subscriptions.phi.invalid/copilot",
      ),
    ).toBe(false);
    expect(
      supplierDirectCompatible(
        "opencode",
        "openai_chat",
        "https://api.example.com/v1",
      ),
    ).toBe(true);
  });
  it("does not mistake ordinary templates for subscriptions", () => {
    expect(subscriptionFromTemplate("claude-0")).toBeUndefined();
    expect(subscriptionFromTemplate("subscription:unknown")).toBeUndefined();
  });
});
