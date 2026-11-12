import type { ReactNode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { panelViewFor, usePluginPanels } from "@/hooks/usePluginPanels";
import type { PluginSummary } from "@/lib/api/plugins";

const apiMocks = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock("@/lib/api/plugins", () => ({
  pluginsApi: { list: (...args: unknown[]) => apiMocks.list(...args) },
}));

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

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("usePluginPanels", () => {
  beforeEach(() => {
    apiMocks.list.mockResolvedValue({ plugins: [], errors: [] });
  });

  it("maps a builtin panel entry to the host page", () => {
    expect(panelViewFor("report-card")).toBe("reportCard");
    // 后端清单已经用白名单拦住了未知面板，这里只做兜底
    expect(panelViewFor("made-up")).toBeNull();
  });

  it("keeps only enabled feature panels, ordered by declaration", async () => {
    apiMocks.list.mockResolvedValue({
      plugins: [
        plugin({ id: "later", panel: { entry: "report-card", order: 30 } }),
        plugin({ id: "first", panel: { entry: "report-card", order: 5 } }),
        plugin({ id: "disabled", enabled: false }),
        plugin({ id: "unknown", panel: { entry: "made-up", order: 1 } }),
        plugin({ id: "rules", kind: "rules", panel: null }),
      ],
      errors: [],
    });

    const { result } = renderHook(() => usePluginPanels(), { wrapper });

    await waitFor(() => expect(result.current).toHaveLength(2));
    expect(result.current.map((panel) => panel.pluginId)).toEqual([
      "first",
      "later",
    ]);
    expect(result.current[0].view).toBe("reportCard");
  });
});
