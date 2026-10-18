import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  RefreshCw,
  Settings,
  Signal,
} from "lucide-react";
import { APP_ICON_MAP, getAppLabel } from "@/config/appConfig";
import {
  trayPanelApi,
  type TrayAgent,
  type TrayOption,
} from "@/lib/api/trayPanel";
import { usageApi } from "@/lib/api/usage";
import { gatewayApi } from "@/lib/api/gateway";
import { proxyApi } from "@/lib/api/proxy";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Card, CardHeader, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Notice } from "@/components/ui/notice";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import phiLogo from "@/assets/icons/phi/256x256.png";

function Options({
  options,
  label,
  busy,
  onSelect,
  groupLabel,
}: {
  options: TrayOption[];
  label: string;
  groupLabel?: string;
  busy: boolean;
  onSelect: (id: string) => void;
}) {
  const groups = groupLabel
    ? [
        {
          label: undefined,
          options: options.filter((o) => !o.id.startsWith("group:")),
        },
        {
          label: groupLabel,
          options: options.filter((o) => o.id.startsWith("group:")),
        },
      ]
    : [{ label: undefined, options }];
  return (
    <Select
      value={options.find((o) => o.selected)?.id ?? ""}
      onValueChange={onSelect}
      disabled={busy || !options.some((o) => o.enabled)}
    >
      <SelectTrigger aria-label={label} className="min-w-0 flex-1">
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>
        {groups
          .filter((group) => group.options.length > 0)
          .map((group, index) => (
            <SelectGroup key={index}>
              {group.label && <SelectLabel>{group.label}</SelectLabel>}
              {group.options.map((o) => (
                <SelectItem key={o.id} value={o.id} disabled={!o.enabled}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
      </SelectContent>
    </Select>
  );
}
function AgentCard({
  agent,
  expanded,
  busy,
  onExpand,
  onAction,
  onToggle,
}: {
  agent: TrayAgent;
  expanded: boolean;
  busy: boolean;
  onExpand: () => void;
  onAction: (id: string) => void;
  onToggle: (enabled: boolean) => void;
}) {
  const { t } = useTranslation();
  const selectionLabel = t(
    agent.gateway ? "trayPanel.selectGroup" : "trayPanel.selectModel",
    { name: agent.name },
  );
  // 卡片摘要展示当前出口（PHI 或直连供应商）；未配置时明确写「未配置」。
  const outletText = agent.providerName ?? t("trayPanel.unconfigured");
  return (
    <Card className="overflow-hidden rounded-xl">
      <CardHeader className="p-0">
        <button
          type="button"
          className="tray-agent-heading"
          onClick={onExpand}
          aria-expanded={expanded}
          aria-controls={`agent-${agent.id}`}
        >
          <span className="tray-agent-icon" aria-hidden>
            {APP_ICON_MAP[agent.id]?.icon}
          </span>
          <strong>{agent.name}</strong>
          <span className="tray-model-summary" title={outletText}>
            {outletText}
          </span>
          <Signal
            className={cn(
              "size-3.5 shrink-0",
              agent.attention ? "text-danger" : "text-fg-3",
            )}
            aria-label={t(
              agent.attention ? "trayPanel.attention" : "trayPanel.status",
            )}
          />
          {expanded ? (
            <ChevronDown className="size-3" />
          ) : (
            <ChevronRight className="size-3" />
          )}
        </button>
      </CardHeader>
      {expanded && (
        <CardContent
          id={`agent-${agent.id}`}
          className="flex flex-col gap-3 pb-4 pl-[42px] pr-3 pt-1"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-baseline gap-2">
              <span>{outletText}</span>
              <span className="truncate text-xs text-fg-3">
                {t(
                  agent.connected ? "trayPanel.connected" : "trayPanel.direct",
                )}
              </span>
            </div>
            {agent.canConnect && (
              <Switch
                checked={agent.connected}
                onCheckedChange={onToggle}
                disabled={busy}
                aria-label={t("trayPanel.connectAgent", { name: agent.name })}
              />
            )}
          </div>
          <div className="tray-selector">
            <span>{t("trayPanel.provider")}</span>
            <Options
              options={agent.providers}
              label={t("trayPanel.selectProvider", { name: agent.name })}
              busy={busy}
              onSelect={onAction}
            />
          </div>
          <div className="tray-selector">
            <span>
              {t(agent.gateway ? "trayPanel.groups" : "trayPanel.models")}
            </span>
            <Options
              options={agent.modelOptions}
              label={selectionLabel}
              groupLabel={!agent.gateway ? t("trayPanel.groups") : undefined}
              busy={busy}
              onSelect={onAction}
            />
          </div>
          {agent.id === "claude-desktop" && (
            <p className="text-xs text-fg-3">
              {t("trayPanel.appManagedModel")}
            </p>
          )}
        </CardContent>
      )}
    </Card>
  );
}
function Stats({ items }: { items: [string, string][] }) {
  return (
    <dl className="tray-stats">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
export function TrayPanel() {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const [tab, setTab] = useState("agents");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [visible, setVisible] = useState(true);
  const [warnings, setWarnings] = useState<string[]>([]);
  const snapshot = useQuery({
    queryKey: ["tray-panel"],
    queryFn: trayPanelApi.snapshot,
    refetchInterval: visible ? 3000 : false,
  });
  const refreshQueries = () => client.invalidateQueries();
  const action = useMutation({
    mutationFn: (id: string) => trayPanelApi.action(id),
    onSuccess: async (warnings) => {
      setWarnings(warnings);
    },
    onSettled: refreshQueries,
  });
  const toggle = useMutation({
    mutationFn: async ({
      agent,
      enabled,
    }: {
      agent: TrayAgent;
      enabled: boolean;
    }) => {
      if (
        enabled &&
        agent.providers.some((p) => p.id === `gateway:${agent.id}` && p.enabled)
      )
        await gatewayApi.connectApp(agent.id);
      else await proxyApi.setProxyTakeoverForApp(agent.id, enabled);
      await refreshQueries();
    },
  });
  const refresh = useMutation({
    mutationFn: async () => {
      await trayPanelApi.refresh();
      await refreshQueries();
    },
  });
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const usage = useQuery({
    queryKey: ["tray-usage", start.getTime()],
    queryFn: () => usageApi.getUsageSummary(start.getTime() / 1000),
    enabled: visible && tab === "usage",
    refetchInterval: visible && tab === "usage" ? 15000 : false,
  });
  const routes = useQuery({
    queryKey: ["tray-routes"],
    queryFn: () => gatewayApi.tracePage(),
    enabled: visible && tab === "routes",
    refetchInterval: visible && tab === "routes" ? 3000 : false,
  });
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented)
        void trayPanelApi.hide();
    };
    const focus = () => {
      setVisible(true);
      void client.invalidateQueries();
    };
    const blur = () => setVisible(false);
    window.addEventListener("keydown", key);
    window.addEventListener("focus", focus);
    window.addEventListener("blur", blur);
    const off = isTauri()
      ? listen("tray-panel-shown", focus)
      : Promise.resolve(() => {});
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("focus", focus);
      window.removeEventListener("blur", blur);
      void off.then((f) => f());
    };
  }, [client]);
  const data = snapshot.data;
  const busy = action.isPending || toggle.isPending;
  // 默认展开第一个已接入的应用（没有已接入时展开第一个），其余卡片收起。
  const first =
    data?.agents.find((a) => a.connected)?.id ?? data?.agents[0]?.id;
  const selected = expanded ?? first;
  const error = snapshot.error ?? action.error ?? toggle.error ?? refresh.error;
  const message = (error: unknown) => {
    const text = String(error);
    return t(text, { defaultValue: text });
  };
  const num = (value: number) =>
    value.toLocaleString(i18n.language, { maximumFractionDigits: 1 });
  const act = (id: string) => {
    setWarnings([]);
    toggle.reset();
    refresh.reset();
    action.mutate(id);
  };
  return (
    <main className="tray-panel" aria-label={t("trayPanel.title")}>
      <header className="tray-header">
        <div className="tray-brand">
          <img src={phiLogo} alt="" className="dark:invert" />
          <span>PHI</span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-compact"
            aria-label={t("trayPanel.refresh")}
            title={t("trayPanel.refresh")}
            disabled={refresh.isPending}
            onClick={() => refresh.mutate()}
          >
            <RefreshCw
              data-icon="inline-start"
              className={cn(refresh.isPending && "animate-spin")}
            />
          </Button>
          <Button
            variant="ghost"
            size="icon-compact"
            aria-label={t("trayPanel.open")}
            title={t("trayPanel.open")}
            onClick={() => act("show_main")}
          >
            <ExternalLink data-icon="inline-start" />
          </Button>
          <Button
            variant="ghost"
            size="icon-compact"
            aria-label={t("trayPanel.settings")}
            title={t("trayPanel.settings")}
            onClick={() => act("nav:settings:general")}
          >
            <Settings data-icon="inline-start" />
          </Button>
        </div>
      </header>
      <Tabs
        value={tab}
        onValueChange={setTab}
        className="flex min-h-0 flex-1 flex-col"
      >
        <TabsList className="mx-3 grid grid-cols-3 gap-1 bg-transparent p-0">
          {(["agents", "usage", "routes"] as const).map((id) => (
            <TabsTrigger
              key={id}
              appearance="surface"
              value={id}
              className="min-w-0"
            >
              {t(`trayPanel.${id}`)}
              {id === "agents" && data && (
                <span className="ml-1 text-fg-3">{data.agents.length}</span>
              )}
            </TabsTrigger>
          ))}
        </TabsList>
        <div className="tray-scroll">
          {error && (
            <Notice tone="danger" title={message(error)}>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  action.reset();
                  toggle.reset();
                  refresh.mutate();
                }}
              >
                {t("gateway.retry")}
              </Button>
            </Notice>
          )}
          {data?.problems.map((problem, index) => (
            <Notice key={index} tone="warning" title={problem} />
          ))}
          {warnings.map((warning, index) => (
            <Notice key={index} tone="warning" title={warning} />
          ))}
          {data?.feedback && (
            <p role="status" className="text-xs text-fg-2">
              {data.feedback}
            </p>
          )}
          {snapshot.isPending && (
            <Skeleton className="h-40 w-full rounded-xl" />
          )}
          <TabsContent value="agents" className="mt-0 flex flex-col gap-2">
            {data?.agents.map((agent) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                expanded={selected === agent.id}
                busy={busy}
                onExpand={() =>
                  setExpanded(selected === agent.id ? "" : agent.id)
                }
                onAction={act}
                onToggle={(enabled) => {
                  setWarnings([]);
                  action.reset();
                  refresh.reset();
                  toggle.mutate({ agent, enabled });
                }}
              />
            ))}
            {data && data.agents.length === 0 && (
              <Notice title={t("trayPanel.noAgents")}>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => act("nav:settings:apps")}
                >
                  {t("trayPanel.manageAgents")}
                </Button>
              </Notice>
            )}
          </TabsContent>
          <TabsContent value="usage" className="mt-0 flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <strong>{t("trayPanel.today")}</strong>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => act("nav:page:usage")}
              >
                {t("trayPanel.details")}
                <ExternalLink data-icon="inline-end" />
              </Button>
            </div>
            {usage.isPending ? (
              <Skeleton className="h-32 w-full" />
            ) : usage.error ? (
              <Notice tone="danger" title={message(usage.error)} />
            ) : (
              usage.data && (
                <Stats
                  items={[
                    [t("trayPanel.requests"), num(usage.data.totalRequests)],
                    ["Tokens", num(usage.data.realTotalTokens)],
                    [
                      t("trayPanel.cost"),
                      `$${Number(usage.data.totalCost).toFixed(4)}`,
                    ],
                    [
                      t("trayPanel.success"),
                      usage.data.totalRequests
                        ? `${num(usage.data.successRate)}%`
                        : "—",
                    ],
                  ]}
                />
              )
            )}
            <p className="text-xs text-fg-3">{t("trayPanel.usageHint")}</p>
          </TabsContent>
          <TabsContent value="routes" className="mt-0 flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <strong>{t("trayPanel.last24h")}</strong>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => act("nav:page:routingOverview")}
              >
                {t("trayPanel.manageRoutes")}
                <ExternalLink data-icon="inline-end" />
              </Button>
            </div>
            {routes.isPending ? (
              <Skeleton className="h-28 w-full" />
            ) : routes.error ? (
              <Notice tone="danger" title={message(routes.error)} />
            ) : (
              routes.data && (
                <>
                  <Stats
                    items={[
                      [t("trayPanel.active"), num(routes.data.active.length)],
                      [
                        t("trayPanel.requests"),
                        num(routes.data.summary.requests),
                      ],
                      [
                        t("trayPanel.failovers"),
                        num(routes.data.summary.failovers),
                      ],
                      [
                        "P95",
                        routes.data.summary.requests
                          ? `${num(routes.data.summary.p95LatencyMs)} ms`
                          : "—",
                      ],
                    ]}
                  />
                  {!routes.data.traces.length && (
                    <p className="text-xs text-fg-3">
                      {t("trayPanel.noTraces")}
                    </p>
                  )}
                  {routes.data.traces.slice(0, 5).map((trace) => (
                    <Card key={trace.id}>
                      <CardHeader className="px-3 py-2">
                        <div className="flex items-center justify-between gap-2">
                          <strong className="truncate">
                            {trace.policy.name}
                          </strong>
                          <span className="text-xs text-fg-3">
                            {t(`gateway.trace.outcomes.${trace.outcome}`, {
                              defaultValue: trace.outcome,
                            })}
                          </span>
                        </div>
                      </CardHeader>
                      <CardContent className="px-3 pb-3">
                        <p className="break-words text-xs text-fg-2">
                          {getAppLabel(trace.appId)} →{" "}
                          {trace.events
                            .map(
                              (e) =>
                                `${e.supplierName || e.supplierId} / ${e.model}`,
                            )
                            .join(" → ") || trace.requestModel}
                        </p>
                      </CardContent>
                    </Card>
                  ))}
                </>
              )
            )}
          </TabsContent>
        </div>
      </Tabs>
      <Separator />
      <footer className="tray-footer justify-end">
        <Button
          variant="ghost"
          size="sm"
          title={
            data?.routingInUse
              ? t("trayPanel.quitRouting")
              : t("trayPanel.quit")
          }
          onClick={() => act("quit")}
        >
          {t("trayPanel.quit")}
        </Button>
      </footer>
    </main>
  );
}
