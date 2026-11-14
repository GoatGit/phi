import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";
import type { PluginSummary } from "@/lib/api/plugins";
import { pluginCenterEntries, pluginEntryFor } from "@/hooks/usePluginCatalog";

const t = ((key: string) => key) as unknown as TFunction;

function plugin(overrides: Partial<PluginSummary> = {}): PluginSummary {
  return {
    id: "report-card",
    name: "Report card",
    version: "1.0.4",
    kind: "feature",
    hooks: ["panel"],
    priority: 100,
    enabled: true,
    description: null,
    author: null,
    ruleCount: 0,
    sourceDir: "builtin",
    builtin: true,
    panel: { entry: "report-card", title: null, order: 10 },
    ...overrides,
  };
}

describe("pluginCenterEntries", () => {
  it("keeps the six fixed cards in order and marks host panels always-on", () => {
    const entries = pluginCenterEntries([plugin()], t);

    expect(entries.slice(0, 6).map((entry) => entry.id)).toEqual([
      "report-card",
      "task-board",
      "session-baton",
      "privacy",
      "mcp-router",
      "lessons",
    ]);
    // 成绩单与任务看板都是宿主面板：能打开、能钉在侧栏，但没有单独的启停开关
    expect(entries[0].status).toBe("always-on");
    expect(entries[0].toggleable).toBe(false);
    expect(entries[1].status).toBe("always-on");
    expect(entries[1].toggleable).toBe(false);
    expect(entries[2].status).toBe("unknown");
    expect(entries[2].toggleable).toBe(false);
    expect(entries[3].status).toBe("always-on");
    expect(entries[3].toggleable).toBe(false);
  });

  it("reflects the plugin registry state for the cards backed by manifests", () => {
    const entries = pluginCenterEntries(
      [
        plugin({ enabled: false }),
        plugin({
          id: "session-baton",
          name: "接棒",
          kind: "script",
          hooks: ["session-exit"],
          enabled: false,
          panel: null,
          builtin: false,
          sourceDir: "session-baton",
        }),
      ],
      t,
    );

    const reportCard = entries.find((entry) => entry.id === "report-card");
    const baton = entries.find((entry) => entry.id === "session-baton");
    // 成绩单是宿主面板：清单里的启停状态不影响它能不能打开
    expect(reportCard?.status).toBe("always-on");
    expect(baton?.status).toBe("disabled");
    expect(baton?.title).toBe("pluginCenter.cards.sessionBaton.title");
  });

  it("appends other disk plugins after the fixed cards", () => {
    const entries = pluginCenterEntries(
      [
        plugin(),
        plugin({
          id: "custom.rules",
          name: "Custom rules",
          kind: "rules",
          hooks: ["request"],
          panel: null,
          builtin: false,
          sourceDir: "custom-rules",
          description: "mask secrets",
        }),
      ],
      t,
    );

    const discovered = entries.filter(
      (entry) =>
        ![
          "report-card",
          "task-board",
          "session-baton",
          "privacy",
          "mcp-router",
          "lessons",
        ].includes(entry.id),
    );
    expect(discovered).toHaveLength(1);
    expect(discovered[0]).toMatchObject({
      id: "custom.rules",
      title: "Custom rules",
      description: "mask secrets",
      status: "enabled",
    });
  });

  it("looks a card up by id and returns null when the plugin is gone", () => {
    const plugins = [plugin()];
    expect(pluginEntryFor("privacy", plugins, t)?.status).toBe("always-on");
    expect(pluginEntryFor("gone", plugins, t)).toBeNull();
  });
});
