import { useEffect, useState, type ReactNode } from "react";
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
import { APP_ICON_MAP } from "@/config/appConfig";
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
import {
  Card,
  CardHeader,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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
}: {
  options: TrayOption[];
  label: string;
  busy: boolean;
  onSelect: (id: string) => void;
}) {
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
        <SelectGroup>
          {options.map((o) => (
            <SelectItem key={o.id} value={o.id} disabled={!o.enabled}>
              {o.label}
            </SelectItem>
          ))}
        </SelectGroup>
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
  footer,
}: {
  agent: TrayAgent;
  expanded: boolean;
  busy: boolean;
  onExpand: () => void;
  onAction: (id: string) => void;
  onToggle: (enabled: boolean) => void;
  footer?: ReactNode;
}) {
  const { t } = useTranslation();
  const modelText = agent.models.length
    ? agent.models.slice(0, 2).join(", ") +
      (agent.models.length > 2 ? ` +${agent.models.length - 2}` : "")
    : t("trayPanel.noModels");
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
          <span className="tray-model-summary" title={modelText}>
            {modelText}
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
              <span>{agent.providerName ?? "PHI"}</span>
              <span className="truncate text-xs text-fg-3">
                {t(
                  agent.connected ? "trayPanel.connected" : "trayPanel.direct",
                )}
                {agent.connected && agent.models.length
                  ? ` · ${t("trayPanel.modelCount", { count: agent.models.length })}`
                  : ""}
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
          <button
            type="button"
            className="tray-model-button"
            onClick={() => onAction(`nav:app:${agent.id}`)}
            title={t("trayPanel.manageModels")}
          >
            <span>{t("trayPanel.models")}</span>
            <span className="truncate">{modelText}</span>
            <ChevronRight className="size-3.5" />
          </button>
        </CardContent>
      )}
      {footer && (
        <CardFooter className="border-t px-2 py-1">{footer}</CardFooter>
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
  const [showAll, setShowAll] = useState(false);
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
      await refreshQueries();
    },
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
        agent.providers.some((p) => p.id === `gateway:${agent.id}`)
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
  const first =
    data?.agents.find((a) => a.connected)?.id ?? data?.agents[0]?.id;
  const selected = expanded ?? first;
  const agents = showAll
    ? data?.agents
    : data?.agents.filter((a) => a.id === first);
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
  const showOthers = data && data.agents.length > 1 && (
    <Button
      variant="ghost"
      className="w-full justify-start"
      onClick={() => setShowAll(!showAll)}
    >
      {showAll
        ? t("trayPanel.collapse")
        : t("trayPanel.showOthers", { count: data.agents.length - 1 })}
      <ChevronDown
        data-icon="inline-end"
        className={cn(showAll && "rotate-180")}
      />
    </Button>
  );
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
        <TabsList className="mx-3 grid grid-cols-4 gap-1 bg-transparent p-0">
          {(["agents", "quota", "usage", "routes"] as const).map((id) => (
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
            {agents?.map((agent) => (
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
                footer={!showAll ? showOthers : undefined}
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
            {showAll && showOthers}
          </TabsContent>
          <TabsContent value="quota" className="mt-0 flex flex-col gap-2">
            <p className="text-xs text-fg-3">{t("trayPanel.quotaHint")}</p>
            {data?.agents.map((agent) => (
              <Card key={agent.id}>
                <CardHeader className="px-3 py-3">
                  <strong>{agent.name}</strong>
                  <span className="text-xs text-fg-3">
                    {agent.providerName ?? t("trayPanel.unconfigured")}
                  </span>
                </CardHeader>
                <CardContent className="flex flex-col gap-2 px-3 pb-3">
                  {agent.quota.length ? (
                    agent.quota.map((quota, index) => (
                      <div key={index} className="flex flex-col gap-1">
                        <span className="text-sm">{quota.text}</span>
                        {quota.remaining !== null && (
                          <progress
                            className="tray-quota-progress"
                            value={quota.remaining}
                            max={100}
                            aria-label={quota.text}
                          />
                        )}{" "}
                        {quota.resetsAt && (
                          <span className="text-xs text-fg-3">
                            {t("trayPanel.resets", {
                              time: new Date(quota.resetsAt).toLocaleString(
                                i18n.language,
                              ),
                            })}
                          </span>
                        )}
                      </div>
                    ))
                  ) : (
                    <p className="text-xs text-fg-3">
                      {agent.quotaError ?? t("trayPanel.noQuota")}
                    </p>
                  )}
                </CardContent>
              </Card>
            ))}
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
                          {trace.appId} →{" "}
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
      <footer className="tray-footer">
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="sm">
              {t("trayPanel.profiles")}
            </Button>
          </PopoverTrigger>
          <PopoverContent side="top" align="start" className="w-72">
            <div className="flex flex-col gap-3">
              <strong>{t("trayPanel.profiles")}</strong>
              {data?.profiles.length ? (
                data.profiles.map((p) => (
                  <div key={p.scope} className="flex flex-col gap-1">
                    <span className="text-xs text-fg-3">{p.name}</span>
                    <Options
                      options={p.items}
                      label={p.name}
                      busy={busy}
                      onSelect={act}
                    />
                  </div>
                ))
              ) : (
                <p className="text-sm text-fg-3">{t("trayPanel.noProfiles")}</p>
              )}
            </div>
          </PopoverContent>
        </Popover>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={() => act("show_main")}>
            {t("trayPanel.open")}
          </Button>
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
        </div>
      </footer>
    </main>
  );
}
