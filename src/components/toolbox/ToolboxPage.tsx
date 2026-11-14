import { useTranslation } from "react-i18next";
import type { AppId } from "@/lib/api";
import {
  TOOLBOX_TABS,
  toolboxTabFromView,
  type ToolboxTab,
} from "@/lib/navigation";
import UnifiedMcpPanel from "@/components/mcp/UnifiedMcpPanel";
import UnifiedSkillsPanel from "@/components/skills/UnifiedSkillsPanel";
import PromptPanel from "@/components/prompts/PromptPanel";
import { SessionManagerPage } from "@/components/sessions/SessionManagerPage";
import { PageTabs } from "@/components/ui/page-tabs";

export interface ToolboxPageProps {
  /** 当前页签（由视图 `toolbox:<tab>` 决定，切页签就是换视图） */
  tab: ToolboxTab;
  /** 切页签：走宿主的导航，操作进行中会先拦住并确认未保存内容 */
  onSelectTab: (tab: ToolboxTab) => void;
  /** 从应用页下钻进来时的返回入口 */
  onBack?: () => void;
  /** 会话页看的是哪个应用的会话（Claude Desktop 与 Claude 共用） */
  sessionApp: AppId;
  /** 会话页：从哪个应用进来 */
  fromApp: AppId;
  onOpenTerminalSettings: () => void;
  /** 提示词页：当前应用与可切换的应用列表 */
  promptsApp: AppId;
  promptApps: AppId[];
  onPromptAppChange: (app: AppId) => void;
  /** 三个面板都有进行中的写入，期间不许离开这一页 */
  onMcpBusyChange: (busy: boolean) => void;
  onSkillsBusyChange: (busy: boolean) => void;
  onPromptsBusyChange: (busy: boolean) => void;
}

/**
 * 工具箱：MCP / Skills / 提示词 / 会话 收在同一个页面里，页签画在页头上。
 *
 * 四项原本是侧栏「工具箱」下的二级菜单，各自是独立整页；合并后侧栏只留一个入口，
 * 页签行占用页头的标题位（与用量统计、插件中心同一套版式），各面板自己的操作
 * 按钮仍在页头右侧，所以换页签时不用离开这一屏。
 */
export function ToolboxPage({
  tab,
  onSelectTab,
  onBack,
  sessionApp,
  fromApp,
  onOpenTerminalSettings,
  promptsApp,
  promptApps,
  onPromptAppChange,
  onMcpBusyChange,
  onSkillsBusyChange,
  onPromptsBusyChange,
}: ToolboxPageProps) {
  const { t } = useTranslation();

  const tabs = (
    <PageTabs<ToolboxTab>
      size="lg"
      // 与用量页一致：页签底线压在页头分割线上
      className="self-end -mb-px"
      aria-label={t("nav.toolbox")}
      value={tab}
      onValueChange={(next) => {
        if (next !== tab) onSelectTab(next);
      }}
      items={TOOLBOX_TABS.map((value) => ({
        value,
        label: TOOLBOX_TAB_LABELS(t)[value],
      }))}
    />
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {tab === "mcp" && (
        <UnifiedMcpPanel
          tabs={tabs}
          onBack={onBack}
          onInteractionBlockedChange={onMcpBusyChange}
        />
      )}
      {tab === "skills" && (
        <UnifiedSkillsPanel
          tabs={tabs}
          onBack={onBack}
          onNavigationBlockedChange={onSkillsBusyChange}
        />
      )}
      {tab === "prompts" && (
        <PromptPanel
          tabs={tabs}
          onBack={onBack}
          appId={promptsApp}
          apps={promptApps}
          onAppChange={onPromptAppChange}
          onNavigationBlockedChange={onPromptsBusyChange}
        />
      )}
      {tab === "sessions" && (
        <SessionManagerPage
          key={sessionApp}
          tabs={tabs}
          appId={sessionApp}
          fromApp={fromApp}
          onOpenTerminalSettings={onOpenTerminalSettings}
          onBack={onBack}
        />
      )}
    </div>
  );
}

/** 页签文案：MCP / Skills 是产品名，不翻译。 */
function TOOLBOX_TAB_LABELS(
  t: (key: string) => string,
): Record<ToolboxTab, string> {
  return {
    mcp: "MCP",
    skills: "Skills",
    prompts: t("nav.prompts"),
    sessions: t("nav.sessions"),
  };
}

/** 视图里存的就是页签，这里只用来兜底一个合法的初始值。 */
export function normalizeToolboxTab(
  view: string | null | undefined,
): ToolboxTab {
  return toolboxTabFromView(view) ?? TOOLBOX_TABS[0];
}
