import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { getAppLabel, type ProxyAppId } from "@/config/appConfig";
import { AppRouteRow } from "@/components/gateway/AppRouteRow";
import { Button } from "@/components/ui/button";
import { providersApi, type AppId } from "@/lib/api";
import { piApi } from "@/lib/api/pi";

type NativeAppId = Exclude<AppId, ProxyAppId>;
interface Connection {
  targets: string[];
  method: "direct" | "proxy" | "appManaged" | "unsupported";
  needsRepair?: boolean;
}

/** Read each adapter's actual configuration; a saved provider is not a live target. */
async function readConnection(app: NativeAppId): Promise<Connection> {
  const providers = await providersApi.getAll(app);
  if (app === "claude-desktop") {
    const [status, providerId] = await Promise.all([
      providersApi.getClaudeDesktopStatus(),
      providersApi.getCurrent(app),
    ]);
    if (!status.supported) return { targets: [], method: "unsupported" };
    return {
      // appliedId identifies Desktop's configuration profile, not a provider.
      targets: providerId ? [providers[providerId]?.name ?? providerId] : [],
      method: status.mode ?? "appManaged",
      needsRepair:
        status.mode === "proxy" &&
        (!status.configured ||
          !status.proxyRunning ||
          !status.gatewayTokenConfigured ||
          status.staleRawModels ||
          status.missingRouteMappings ||
          !status.expectedBaseUrl ||
          status.actualBaseUrl !== status.expectedBaseUrl),
    };
  }
  let ids: string[];
  switch (app) {
    case "opencode":
      ids = await providersApi.getOpenCodeLiveProviderIds();
      break;
    case "openclaw":
      ids = await providersApi.getOpenClawLiveProviderIds();
      break;
    case "hermes":
      ids = await providersApi.getHermesLiveProviderIds();
      break;
    case "pi":
      ids = (await piApi.getCurrentState()).enabledProviderIds;
      break;
    case "mcode":
      ids = Object.values(providers)
        .filter((p) => p.meta?.liveConfigManaged === true)
        .map((p) => p.id);
      break;
    default:
      // zcode 等新应用的连接方式仍在规划中：归入应用内管理，不报错
      ids = [];
      break;
  }
  return {
    targets: [...new Set(ids)].map((id) => providers[id]?.name ?? id),
    // Coexisting providers can mix direct and gateway endpoints; there is no
    // single takeover switch, and provider membership does not prove connectivity.
    method: "appManaged",
  };
}

export function NativeAppConnectionRow({
  app,
  onOpenApp,
}: {
  app: NativeAppId;
  onOpenApp: (app: AppId) => void;
}) {
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: ["providers", app, "connection"],
    queryFn: () => readConnection(app),
  });
  const connection = query.data;
  const label = getAppLabel(app);
  const targets = connection?.targets ?? [];
  const openLabel = t("gateway.connections.openApp", { app: label });
  return (
    <AppRouteRow
      app={app}
      control={
        query.isSuccess && connection ? (
          connection.method === "unsupported" ? (
            <span className="pe-1 text-caption text-fg-3">
              {t("gateway.connections.unsupported")}
            </span>
          ) : (
            <Button
              variant="ghost"
              size="compact"
              className="-me-2 text-fg-2"
              title={openLabel}
              aria-label={openLabel}
              onClick={() => onOpenApp(app)}
            >
              {t(`gateway.connections.${connection.method}`)}
              <ChevronRight className="h-3.5 w-3.5" aria-hidden />
            </Button>
          )
        ) : null
      }
    >
      {query.isError ? (
        <span role="alert" className="flex flex-wrap items-center gap-2">
          {t("gateway.loadError")}
          <Button
            variant="ghost"
            size="sm"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            {t("gateway.retry")}
          </Button>
        </span>
      ) : query.isPending ? (
        <span role="status">{t("gateway.loading")}</span>
      ) : (
        <>
          <span
            className="block truncate"
            title={targets.length ? targets.join("、") : undefined}
          >
            {targets.length
              ? targets.join("、")
              : t("gateway.connections.unconfigured")}
          </span>
          {connection?.needsRepair && (
            <span role="status" className="mt-0.5 block text-warning-text">
              {t("gateway.connections.needsReconnect")}
            </span>
          )}
        </>
      )}
    </AppRouteRow>
  );
}
