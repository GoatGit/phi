import { GatewayDiagnostics } from "../GatewayDiagnostics";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { toast } from "@/lib/toast";
import { Loader2 } from "lucide-react";
import {
  useGlobalProxyConfig,
  useProxyClientHost,
  useProxyStatusQuery,
  useSetProxyClientHost,
  useUpdateGlobalProxyConfig,
} from "@/lib/query/proxy";
import { useProxyStatus } from "@/hooks/useProxyStatus";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { HelpTip } from "@/components/ui/help-tip";
import { RectifierConfigPanel } from "@/components/settings/RectifierConfigPanel";
import { AccessBindings } from "@/components/gateway/AccessBindings";
import {
  SettingsBlock,
  SettingsCard,
  SettingsRow,
  SettingsSwitchRow,
} from "@/components/settings/SettingsLayout";
import { cn } from "@/lib/utils";

const isValidListenAddress = (address: string): boolean => {
  if (address === "localhost" || address === "::1") return true;
  return (
    /^127(\.\d{1,3}){3}$/.test(address) &&
    address.split(".").every((part) => Number(part) <= 255)
  );
};

/** 客户端地址：空（按监听地址）、IP 或主机名；`0.0.0.0` / `::` 客户端连不上 */
const isValidClientHost = (host: string): boolean => {
  if (host === "") return true;
  if (host === "0.0.0.0" || host === "::") return false;
  if (/^[\d.]+$/.test(host) || host.includes(":")) {
    return isValidListenAddress(host);
  }
  return /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(
    host,
  );
};

/** 没设客户端地址时写给客户端的主机，和后端 `proxy_origin` 一致 */
const defaultClientHost = (listenAddress: string): string =>
  listenAddress === "0.0.0.0"
    ? "127.0.0.1"
    : listenAddress === "::"
      ? "::1"
      : listenAddress;

function formatUptime(seconds: number, t: TFunction) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0
    ? t("routingSettings.uptimeHours", { hours, minutes })
    : t("routingSettings.uptimeMinutes", { minutes: Math.max(minutes, 0) });
}

/**
 * 设置 → 网关：服务（状态、统计、监听地址、连接地址、请求用量）→ 外部接入密钥
 * → 整流与优化。应用和路由组的进出只在「路由」页（流转图）里设置。
 */
export function RoutingSection() {
  const { t } = useTranslation();
  const { data: status, isError: statusError } = useProxyStatusQuery();
  const running = status?.running ?? false;
  const { startProxyServer, isPending } = useProxyStatus();
  const { data: config } = useGlobalProxyConfig();
  const updateConfig = useUpdateGlobalProxyConfig();
  const { data: savedClientHost } = useProxyClientHost();
  const saveClientHostMutation = useSetProxyClientHost();
  const [address, setAddress] = useState("127.0.0.1");
  const [port, setPort] = useState("15821");
  const [addressError, setAddressError] = useState<string | null>(null);
  const [portError, setPortError] = useState<string | null>(null);
  const [clientHost, setClientHost] = useState("");
  const [clientHostError, setClientHostError] = useState<string | null>(null);

  useEffect(() => {
    if (config) {
      setAddress(config.listenAddress);
      setPort(String(config.listenPort));
    }
  }, [config]);

  useEffect(() => {
    if (savedClientHost !== undefined) setClientHost(savedClientHost);
  }, [savedClientHost]);

  const saveListen = async () => {
    if (!config) return;
    const trimmed = address.trim();
    const portValue = Number(port.trim());
    const addressOk = isValidListenAddress(trimmed);
    const portOk =
      /^\d+$/.test(port.trim()) && portValue >= 1024 && portValue <= 65535;
    setAddressError(addressOk ? null : t("proxy.settings.invalidAddress"));
    setPortError(portOk ? null : t("proxy.settings.invalidPort"));
    if (!addressOk || !portOk) return;
    try {
      await updateConfig.mutateAsync({
        ...config,
        listenAddress: trimmed === "localhost" ? "127.0.0.1" : trimmed,
        listenPort: portValue,
      });
    } catch {
      // useUpdateGlobalProxyConfig 的 onSuccess / onError 已经弹过 toast
    }
  };

  const listenDirty =
    !!config &&
    (address.trim() !== config.listenAddress ||
      port.trim() !== String(config.listenPort));

  const saveClientHost = async () => {
    const trimmed = clientHost.trim();
    const ok = isValidClientHost(trimmed);
    setClientHostError(ok ? null : t("routingSettings.clientHostInvalid"));
    if (!ok) return;
    try {
      await saveClientHostMutation.mutateAsync(trimmed);
    } catch {
      // useSetProxyClientHost 的 onSuccess / onError 已经弹过 toast
    }
  };

  const toggleLogging = async (enabled: boolean) => {
    if (!config) return;
    try {
      await updateConfig.mutateAsync({ ...config, enableLogging: enabled });
    } catch {
      toast.error(t("proxy.logging.failed"));
    }
  };

  return (
    <>
      <GatewayDiagnostics />
      <SettingsBlock title={t("routingSettings.service")}>
        <SettingsCard>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3.5">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1 text-body font-medium text-fg-1">
                {t("routingSettings.serviceName")}
                <HelpTip title={t("routingSettings.serviceName")}>
                  {t("routingSettings.serviceHelp")}
                </HelpTip>
              </div>
              <div className="mt-0.5 flex items-center gap-1.5 text-caption text-fg-2">
                <span
                  aria-hidden="true"
                  className={cn(
                    "h-1.5 w-1.5 rounded-full",
                    running ? "bg-route" : "bg-fg-3",
                  )}
                />
                {running
                  ? t("routingSettings.runningFor", {
                      uptime: formatUptime(status?.uptime_seconds ?? 0, t),
                    })
                  : !status || statusError
                    ? t("gateway.unknown")
                    : t("routingSettings.unavailable")}
              </div>
            </div>
            {running && (
              <dl className="flex gap-6 text-end">
                {[
                  [
                    t("routingSettings.totalRequests"),
                    status?.total_requests ?? 0,
                  ],
                  [
                    t("routingSettings.successRate"),
                    `${(status?.success_rate ?? 0).toFixed(1)}%`,
                  ],
                  [
                    t("routingSettings.activeConnections"),
                    status?.active_connections ?? 0,
                  ],
                ].map(([label, value]) => (
                  <div key={String(label)}>
                    <dt className="text-caption text-fg-2">{label}</dt>
                    <dd className="m-0 text-strong font-semibold tabular-nums text-fg-1">
                      {typeof value === "number"
                        ? value.toLocaleString()
                        : value}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
            {status && !running && !statusError && (
              <Button
                variant="neutral"
                size="regular"
                disabled={isPending}
                onClick={() => void startProxyServer().catch(() => undefined)}
              >
                {t("routingSettings.retryStart")}
              </Button>
            )}
          </div>

          <SettingsRow
            label={t("routingSettings.listen")}
            control={
              <div className="flex items-start gap-3">
                <label className="space-y-1">
                  <span className="block text-caption font-medium text-fg-2">
                    {t("routingSettings.address")}
                  </span>
                  <Input
                    aria-label={t("routingSettings.address")}
                    value={address}
                    onChange={(event) => setAddress(event.target.value)}
                    aria-invalid={addressError ? true : undefined}
                    className="w-[150px]"
                  />
                  <span
                    className={cn(
                      "block text-caption",
                      addressError ? "text-danger-text" : "text-fg-3",
                    )}
                  >
                    {addressError ?? t("routingSettings.addressHint")}
                  </span>
                </label>
                <label className="space-y-1">
                  <span className="block text-caption font-medium text-fg-2">
                    {t("routingSettings.port")}
                  </span>
                  <Input
                    aria-label={t("routingSettings.port")}
                    value={port}
                    inputMode="numeric"
                    onChange={(event) => setPort(event.target.value)}
                    aria-invalid={portError ? true : undefined}
                    className="w-[96px]"
                  />
                  <span
                    className={cn(
                      "block text-caption",
                      portError ? "text-danger-text" : "text-fg-3",
                    )}
                  >
                    {portError ?? "1024–65535"}
                  </span>
                </label>
                <Button
                  variant="neutral"
                  size="regular"
                  // 和输入框顶边对齐：上面的小标题 18 + 间距 4
                  className="mt-[22px]"
                  disabled={
                    !config ||
                    (running && !listenDirty) ||
                    updateConfig.isPending
                  }
                  onClick={() => void saveListen()}
                >
                  {updateConfig.isPending && (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  )}
                  {t("routingSettings.saveAndRestart")}
                </Button>
              </div>
            }
          />
          <SettingsRow
            label={t("routingSettings.clientHost")}
            help={{
              title: t("routingSettings.clientHost"),
              body: t("routingSettings.clientHostHelp"),
            }}
            control={
              <div className="flex items-start gap-3">
                <label className="space-y-1">
                  <Input
                    value={clientHost}
                    placeholder={defaultClientHost(
                      config?.listenAddress ?? "127.0.0.1",
                    )}
                    onChange={(event) => setClientHost(event.target.value)}
                    aria-label={t("routingSettings.clientHost")}
                    aria-invalid={clientHostError ? true : undefined}
                    className="w-[262px]"
                  />
                  <span
                    className={cn(
                      "block text-caption",
                      clientHostError ? "text-danger-text" : "text-fg-3",
                    )}
                  >
                    {clientHostError ?? t("routingSettings.clientHostHint")}
                  </span>
                </label>
                <Button
                  variant="neutral"
                  size="regular"
                  disabled={
                    savedClientHost === undefined ||
                    saveClientHostMutation.isPending
                  }
                  onClick={() => void saveClientHost()}
                >
                  {t("common.save")}
                </Button>
              </div>
            }
          />
          <SettingsSwitchRow
            label={t("routingSettings.logging")}
            help={{
              title: t("routingSettings.logging"),
              body: t("routingSettings.loggingHelp"),
            }}
            checked={config?.enableLogging ?? false}
            disabled={!config}
            onCheckedChange={(value) => void toggleLogging(value)}
          />
        </SettingsCard>
      </SettingsBlock>

      {/* 外部接入：PHI 不写配置的客户端（Cursor、Cline、脚本）用这里的密钥。 */}
      <div className="rounded-panel border border-border bg-surface p-4">
        <AccessBindings />
      </div>

      <SettingsBlock
        title={t("settings.advanced.rectifier.title")}
        help={{
          title: t("settings.advanced.rectifier.title"),
          body: t("settings.advanced.rectifier.description"),
        }}
      >
        <div className="rounded-panel border border-border bg-surface p-5">
          <RectifierConfigPanel />
        </div>
      </SettingsBlock>
    </>
  );
}
