import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { getAppLabel, type ProxyAppId } from "@/config/appConfig";
import { AppGlyph } from "@/components/shell/AppGlyph";
import { providersApi, type AppId } from "@/lib/api";
import { piApi } from "@/lib/api/pi";
import { Button } from "@/components/ui/button";
import { badgeVariants } from "@/components/ui/badge";
import { TableCell, TableRow } from "@/components/ui/table";

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
  return (
    <TableRow>
      <TableCell className="whitespace-nowrap">
        <span className="flex items-center gap-2">
          <AppGlyph app={app} size={16} badgeClassName="bg-surface" />
          {getAppLabel(app)}
        </span>
      </TableCell>
      <TableCell className="max-w-64 break-words">
        {query.isError ? (
          <div role="alert" className="flex items-center gap-2">
            {t("gateway.loadError")}
            <Button
              variant="ghost"
              size="sm"
              disabled={query.isFetching}
              onClick={() => void query.refetch()}
            >
              {t("gateway.retry")}
            </Button>
          </div>
        ) : query.isPending ? (
          <span role="status">{t("gateway.loading")}</span>
        ) : connection?.targets.length ? (
          connection.targets.join("、")
        ) : (
          "—"
        )}
      </TableCell>
      <TableCell className="w-64">
        {query.isSuccess && connection && (
          <button
            type="button"
            className={badgeVariants({ variant: "secondary" })}
            onClick={() => onOpenApp(app)}
          >
            {t(`gateway.connections.${connection.method}`)}
          </button>
        )}
        {query.isSuccess && connection?.needsRepair && (
          <p role="status" className="mt-2 text-xs text-fg-2">
            {t("gateway.connections.needsReconnect")}
          </p>
        )}
      </TableCell>
    </TableRow>
  );
}
