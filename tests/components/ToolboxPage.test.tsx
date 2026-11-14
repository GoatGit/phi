import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ToolboxPage } from "@/components/toolbox/ToolboxPage";
import type { AppId } from "@/lib/api";
import type { ToolboxTab } from "@/lib/navigation";

// 四个面板各自的页头与数据请求都在自己的单测里；这里只看页签怎么接起来。
vi.mock("@/components/mcp/UnifiedMcpPanel", () => ({
  default: ({ tabs }: any) => <div data-testid="mcp-panel">{tabs}</div>,
}));

vi.mock("@/components/skills/UnifiedSkillsPanel", () => ({
  default: ({ tabs }: any) => <div data-testid="skills-panel">{tabs}</div>,
}));

vi.mock("@/components/prompts/PromptPanel", () => ({
  default: ({ tabs, appId }: any) => (
    <div data-testid="prompts-panel">
      {tabs}
      <span>{appId}</span>
    </div>
  ),
}));

vi.mock("@/components/sessions/SessionManagerPage", () => ({
  SessionManagerPage: ({ tabs, appId }: any) => (
    <div data-testid="sessions-panel">
      {tabs}
      <span>{appId}</span>
    </div>
  ),
}));

function renderToolbox(tab: ToolboxTab, sessionApp: AppId = "claude") {
  const onSelectTab = vi.fn();
  render(
    <ToolboxPage
      tab={tab}
      onSelectTab={onSelectTab}
      sessionApp={sessionApp}
      fromApp="claude"
      onOpenTerminalSettings={() => {}}
      promptsApp="claude"
      promptApps={["claude"]}
      onPromptAppChange={() => {}}
      onMcpBusyChange={() => {}}
      onSkillsBusyChange={() => {}}
      onPromptsBusyChange={() => {}}
    />,
  );
  return { onSelectTab };
}

describe("ToolboxPage", () => {
  it("把四个子菜单画成页头页签，并且只挂载当前页签的面板", () => {
    renderToolbox("mcp");

    const tablist = screen.getByRole("tablist", { name: "nav.toolbox" });
    const tabs = within(tablist).getAllByRole("tab");
    // MCP / Skills 是产品名，提示词与会话走 nav.* 文案
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "MCP",
      "Skills",
      "nav.prompts",
      "nav.sessions",
    ]);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("mcp-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("skills-panel")).toBeNull();
    expect(screen.queryByTestId("prompts-panel")).toBeNull();
    expect(screen.queryByTestId("sessions-panel")).toBeNull();
  });

  it("点别的页签只把页签值报给宿主，自己不在页内换面板", () => {
    const { onSelectTab } = renderToolbox("mcp");
    const tablist = screen.getByRole("tablist", { name: "nav.toolbox" });

    fireEvent.click(within(tablist).getByRole("tab", { name: "Skills" }));

    expect(onSelectTab).toHaveBeenCalledWith("skills");
    // 面板仍由宿主按视图决定，本地不维护第二份「当前页签」
    expect(screen.getByTestId("mcp-panel")).toBeInTheDocument();
  });

  it("点当前页签不重复导航", () => {
    const { onSelectTab } = renderToolbox("sessions");
    const tablist = screen.getByRole("tablist", { name: "nav.toolbox" });

    fireEvent.click(within(tablist).getByRole("tab", { name: "nav.sessions" }));

    expect(onSelectTab).not.toHaveBeenCalled();
  });

  it("会话页签看的是传入的那个应用的会话", () => {
    renderToolbox("sessions", "codex");

    expect(screen.getByTestId("sessions-panel")).toHaveTextContent("codex");
  });
});
