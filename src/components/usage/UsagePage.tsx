import { useState } from "react";
import type { AppTypeFilter } from "@/types/usage";
import { UsageDashboard } from "./UsageDashboard";
import { SessionStatsPanel } from "./SessionStatsPanel";
import { ContextStatsPanel } from "./ContextStatsPanel";
import { PageHeaderBackButton } from "@/components/shell/PageHeaderBackButton";
import { AppPageHeader } from "@/components/shell/AppPageHeader";
import { PageTabs } from "@/components/ui/page-tabs";
import { useTranslation } from "react-i18next";

interface UsagePageProps {
  /** 从应用页「查看此应用的用量」进入时带上的应用筛选 */
  initialAppType?: AppTypeFilter;
  /** 打开设置 → 本地路由（「记录请求用量」开关在那里） */
  /** 从应用页下钻进入时的返回入口 */
  onBack?: () => void;
}

type UsageTab = "activity" | "sessionStats" | "contextStats";

/** 侧栏「用量统计」全局页（v7 S6）：不开路由也有数据（读会话日志）。 */
export function UsagePage({ initialAppType, onBack }: UsagePageProps = {}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<UsageTab>("activity");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AppPageHeader
        leading={onBack && <PageHeaderBackButton onClick={onBack} />}
        title={null}
        tabs={
          <PageTabs
            size="lg"
            aria-label={t("nav.usage")}
            value={tab}
            onValueChange={(value) => setTab(value as UsageTab)}
            items={[
              { value: "activity", label: t("usage.tabs.activity") },
              { value: "sessionStats", label: t("usage.tabs.sessions") },
              { value: "contextStats", label: t("usage.tabs.context") },
            ]}
          />
        }
      />
      <div
        id="main-content"
        className="min-h-0 flex-1 overflow-y-auto scroll-stable px-6 py-5"
      >
        {/* 保持挂载：切签时保留会话与用量面板的状态与查询 */}
        <div className={tab === "activity" ? "space-y-4" : "hidden"}>
          <UsageDashboard initialAppType={initialAppType} />
        </div>
        {tab === "sessionStats" && <SessionStatsPanel />}
        {tab === "contextStats" && <ContextStatsPanel />}
      </div>
    </div>
  );
}
