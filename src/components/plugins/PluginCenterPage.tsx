import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AppPageHeader } from "@/components/shell/AppPageHeader";
import { PageHeaderBackButton } from "@/components/shell/PageHeaderBackButton";
import { PageTabs } from "@/components/ui/page-tabs";
import { McpRouterPanel } from "./McpRouterPanel";
import { PluginStagesPanel } from "./PluginStagesPanel";
import { PrivacyPanel } from "./PrivacyPanel";

type PluginCenterTab = "stages" | "privacy" | "router";

interface PluginCenterPageProps {
  /** 从别处下钻进来时的返回入口 */
  onBack?: () => void;
}

/**
 * 插件中心：侧栏一级页。
 *
 * 三个页签是三块独立能力，共享的只有「插件」这个词：
 * - 请求插件：代理出站请求体的改写阶段（脚本 / 规则）；
 * - 隐私脱敏：内置阶段 + 一份独立配置（`privacy.json`）；
 * - MCP 路由：MCP 服务器在哪个客户端、以什么名字出现（`mcp-router.json`）。
 *
 * 所以这里只做页签与页头，各页签自己的读取、保存、试跑都在面板里，
 * 切页签不共享状态，也不会互相触发请求。
 */
export function PluginCenterPage({ onBack }: PluginCenterPageProps = {}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<PluginCenterTab>("stages");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AppPageHeader
        leading={onBack && <PageHeaderBackButton onClick={onBack} />}
        title={null}
        tabs={
          <PageTabs
            size="lg"
            // 与用量页一致：页签底线压在页头分割线上
            className="self-end -mb-px"
            aria-label={t("pluginCenter.title")}
            idPrefix="plugin-center-tab"
            controls="plugin-center-tabpanel"
            value={tab}
            onValueChange={(value) => setTab(value as PluginCenterTab)}
            items={[
              { value: "stages", label: t("pluginCenter.tabs.stages") },
              { value: "privacy", label: t("pluginCenter.tabs.privacy") },
              { value: "router", label: t("pluginCenter.tabs.router") },
            ]}
          />
        }
      />
      <div
        id="main-content"
        className="min-h-0 flex-1 overflow-y-auto scroll-stable pt-3"
      >
        <div
          id="plugin-center-tabpanel"
          role="tabpanel"
          aria-labelledby={`plugin-center-tab-${tab}`}
        >
          {tab === "stages" && <PluginStagesPanel />}
          {tab === "privacy" && <PrivacyPanel />}
          {tab === "router" && <McpRouterPanel />}
        </div>
      </div>
    </div>
  );
}
