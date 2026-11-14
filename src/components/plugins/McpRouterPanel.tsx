import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import { getAppLabel, MCP_APP_IDS } from "@/config/appConfig";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Notice } from "@/components/ui/notice";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  commandErrorMessage,
  mcpRouterApi,
  type CatalogEntry,
  type McpRoute,
  type McpRouterConfig,
  type RouterCatalog,
} from "@/lib/api/plugins";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { pluginPageClass } from "./pluginPage";
import { McpRouterGuide } from "./pluginGuides";

function blankRoute(serverId: string): McpRoute {
  return {
    serverId,
    alias: null,
    namespace: null,
    apps: [],
    enabled: true,
    priority: 0,
    tags: [],
  };
}

/**
 * MCP 路由页签：服务器在哪个客户端、以什么名字出现。
 *
 * 左侧是可编辑的路由规则（写 `mcp-router.json`），右侧是「保存后各客户端会看到
 * 什么」的预览（读数据库里的服务器 + 当前配置算出来的目录）。预览是算出来的，
 * 不是各客户端 live 配置的实况——保存成功才真的重投影，所以这里把两者的区别
 * 用 applyError 单独说清楚。
 */
export function McpRouterPanel() {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<McpRouterConfig | null>(null);
  const [catalog, setCatalog] = useState<RouterCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // 配置与预览是两条独立命令：配置读文件，预览要读数据库里的服务器，
      // 所以并行发出去，别串成一个等待。
      const [response, preview] = await Promise.all([
        mcpRouterApi.get(),
        mcpRouterApi.catalog(),
      ]);
      setDraft(response.config);
      setCatalog(preview);
      setError(null);
    } catch (err) {
      setError(commandErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const servers = useMemo(() => catalog?.entries ?? [], [catalog]);
  const serverName = useCallback(
    (serverId: string) =>
      servers.find((entry) => entry.serverId === serverId)?.name ?? serverId,
    [servers],
  );

  const patch = useCallback((changes: Partial<McpRouterConfig>) => {
    setDraft((current) => (current ? { ...current, ...changes } : current));
  }, []);

  const patchRoute = useCallback(
    (index: number, changes: Partial<McpRoute>) => {
      setDraft((current) => {
        if (!current) return current;
        const routes = current.routes.map((route, position) =>
          position === index ? { ...route, ...changes } : route,
        );
        return { ...current, routes };
      });
    },
    [],
  );

  const save = useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const response = await mcpRouterApi.save(draft);
      setDraft(response.config);
      // 保存会重投影，预览得重新算一遍才和实际一致。
      setCatalog(await mcpRouterApi.catalog());
      if (response.applied) {
        toast.success(t("pluginCenter.router.applied"));
      } else {
        toast.error(
          t("pluginCenter.router.applyFailed", {
            message: response.applyError ?? "",
          }),
        );
      }
    } catch (err) {
      toast.error(
        t("pluginCenter.router.saveFailed", {
          message: commandErrorMessage(err),
        }),
      );
    } finally {
      setSaving(false);
    }
  }, [draft, t]);

  if (loading) {
    return (
      <div className={cn(pluginPageClass, "text-body text-fg-3")}>
        {t("pluginCenter.loading")}
      </div>
    );
  }

  if (error || !draft) {
    return (
      <div className={cn(pluginPageClass, "space-y-4")}>
        <Notice
          tone="danger"
          title={t("pluginCenter.router.loadFailed")}
          actions={
            <Button size="compact" onClick={() => void load()}>
              {t("pluginCenter.refresh")}
            </Button>
          }
        >
          {error}
        </Notice>
      </div>
    );
  }

  return (
    <div className={cn(pluginPageClass, "space-y-5")}>
      <p className="text-caption text-fg-3">{t("pluginCenter.router.intro")}</p>

      <section
        aria-label={t("pluginCenter.router.enabled")}
        className="divide-y divide-border overflow-hidden rounded-panel border border-border"
      >
        <div className="flex items-start justify-between gap-4 bg-surface px-4 py-2.5">
          <div className="min-w-0 space-y-0.5">
            <p className="text-strong text-fg-1">
              {t("pluginCenter.router.enabled")}
            </p>
            <p className="text-caption text-fg-3">
              {t("pluginCenter.router.enabledHint")}
            </p>
          </div>
          <Switch
            checked={draft.enabled}
            aria-label={t("pluginCenter.router.enabled")}
            onCheckedChange={(enabled) => patch({ enabled })}
          />
        </div>
        <div className="flex items-start justify-between gap-4 bg-surface px-4 py-2.5">
          <div className="min-w-0 space-y-0.5">
            <p className="text-strong text-fg-1">
              {t("pluginCenter.router.separator")}
            </p>
            <p className="text-caption text-fg-3">
              {t("pluginCenter.router.separatorHint")}
            </p>
          </div>
          <Input
            className="w-24 text-center font-mono"
            value={draft.namespaceSeparator}
            maxLength={4}
            disabled={!draft.enabled}
            onChange={(event) =>
              patch({ namespaceSeparator: event.target.value })
            }
          />
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-strong font-medium text-fg-1">
            {t("pluginCenter.router.routes")}
          </h3>
          <Button
            variant="ghost"
            size="compact"
            disabled={!draft.enabled || servers.length === 0}
            onClick={() => {
              const used = new Set(draft.routes.map((route) => route.serverId));
              const next = servers.find((entry) => !used.has(entry.serverId));
              if (!next) return;
              patch({ routes: [...draft.routes, blankRoute(next.serverId)] });
            }}
          >
            <Plus className="me-1.5 h-3.5 w-3.5" />
            {t("pluginCenter.router.addRoute")}
          </Button>
        </div>

        {draft.routes.length === 0 ? (
          <div className="rounded-panel border border-dashed border-border px-4 py-6 text-center text-body text-fg-3">
            {t("pluginCenter.router.noRoutes")}
          </div>
        ) : (
          <ul className="space-y-2">
            {draft.routes.map((route, index) => (
              <li
                key={`${route.serverId}-${index}`}
                className="space-y-3 rounded-panel border border-border bg-surface px-3 py-3"
              >
                {/* 每个输入上面带一个小标题，不再靠占位字兼顾说明与提示：
                    占位字会写成长句然后被输入框裁掉。 */}
                <div className="grid grid-cols-[minmax(140px,1.1fr)_minmax(0,1fr)_minmax(0,1fr)_76px_auto_auto] items-end gap-2">
                  <label className="flex min-w-0 flex-col gap-1">
                    <span className="text-badge text-fg-3">
                      {t("pluginCenter.router.serverLabel")}
                    </span>
                    <Select
                      value={route.serverId}
                      onValueChange={(serverId) =>
                        patchRoute(index, { serverId })
                      }
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue
                          placeholder={t(
                            "pluginCenter.router.serverPlaceholder",
                          )}
                        />
                      </SelectTrigger>
                      <SelectContent>
                        {servers.map((entry) => (
                          <SelectItem
                            key={entry.serverId}
                            value={entry.serverId}
                          >
                            {entry.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>

                  <label className="flex min-w-0 flex-col gap-1">
                    <span className="text-badge text-fg-3">
                      {t("pluginCenter.router.aliasLabel")}
                    </span>
                    <Input
                      value={route.alias ?? ""}
                      placeholder={t("pluginCenter.router.aliasExample")}
                      onChange={(event) =>
                        patchRoute(index, {
                          alias: event.target.value || null,
                        })
                      }
                    />
                  </label>

                  <label className="flex min-w-0 flex-col gap-1">
                    <span className="text-badge text-fg-3">
                      {t("pluginCenter.router.namespaceLabel")}
                    </span>
                    <Input
                      value={route.namespace ?? ""}
                      placeholder={t("pluginCenter.router.namespaceExample")}
                      disabled={Boolean(route.alias)}
                      onChange={(event) =>
                        patchRoute(index, {
                          namespace: event.target.value || null,
                        })
                      }
                    />
                  </label>

                  <label className="flex flex-col gap-1">
                    <span className="text-badge text-fg-3">
                      {t("pluginCenter.router.priority")}
                    </span>
                    <Input
                      className="text-center tabular-nums"
                      type="number"
                      value={route.priority}
                      onChange={(event) =>
                        patchRoute(index, {
                          priority: Number(event.target.value) || 0,
                        })
                      }
                    />
                  </label>

                  <div className="flex flex-col items-center gap-1">
                    <span className="text-badge text-fg-3">
                      {t("pluginCenter.router.enableLabel")}
                    </span>
                    <Switch
                      size="sm"
                      checked={route.enabled}
                      aria-label={serverName(route.serverId)}
                      onCheckedChange={(enabled) =>
                        patchRoute(index, { enabled })
                      }
                    />
                  </div>

                  <Button
                    variant="ghost"
                    size="icon-compact"
                    className="mb-1"
                    aria-label={t("pluginCenter.router.removeRoute")}
                    onClick={() =>
                      patch({
                        routes: draft.routes.filter(
                          (_, position) => position !== index,
                        ),
                      })
                    }
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>

                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-border pt-2.5">
                  <span className="text-caption text-fg-3">
                    {t("pluginCenter.router.apps")}
                  </span>
                  {MCP_APP_IDS.map((appId) => {
                    const checked = route.apps.includes(appId);
                    return (
                      <label
                        key={appId}
                        className="flex items-center gap-1.5 text-caption text-fg-2"
                      >
                        <Checkbox
                          checked={checked}
                          onCheckedChange={(next) =>
                            patchRoute(index, {
                              apps: next
                                ? [...route.apps, appId]
                                : route.apps.filter((id) => id !== appId),
                            })
                          }
                        />
                        {getAppLabel(appId)}
                      </label>
                    );
                  })}
                  {route.apps.length === 0 && (
                    <span className="text-caption text-fg-3">
                      {t("pluginCenter.router.appsHint")}
                    </span>
                  )}
                </div>

                <Input
                  className="text-caption"
                  value={route.tags.join(", ")}
                  placeholder={t("pluginCenter.router.tagsPlaceholder")}
                  aria-label={t("pluginCenter.router.tagsPlaceholder")}
                  onChange={(event) =>
                    patchRoute(index, {
                      tags: event.target.value
                        .split(",")
                        .map((tag) => tag.trim())
                        .filter(Boolean),
                    })
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <McpRouterGuide />

      <div className="flex items-center justify-end border-t border-border pt-4">
        <Button onClick={() => void save()} disabled={saving}>
          {saving
            ? t("pluginCenter.saving")
            : t("pluginCenter.router.saveAndApply")}
        </Button>
      </div>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-strong font-medium text-fg-1">
            {t("pluginCenter.router.catalog")}
          </h3>
          <Button
            variant="ghost"
            size="compact"
            onClick={() => void load()}
            disabled={loading}
          >
            <RefreshCw className="me-1.5 h-3.5 w-3.5" />
            {t("pluginCenter.refresh")}
          </Button>
        </div>

        {catalog && catalog.conflicts.length > 0 && (
          <Notice tone="warning" title={t("pluginCenter.router.conflicts")}>
            <ul className="space-y-0.5">
              {catalog.conflicts.map((conflict) => (
                <li key={conflict.exposedId}>
                  {t("pluginCenter.router.conflictItem", {
                    exposedId: conflict.exposedId,
                    ids: conflict.serverIds.join(" / "),
                    winner: conflict.winner,
                  })}
                </li>
              ))}
            </ul>
          </Notice>
        )}

        {servers.length === 0 ? (
          <div className="rounded-panel border border-dashed border-border px-4 py-6 text-center text-body text-fg-3">
            {t("pluginCenter.router.catalogEmpty")}
          </div>
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-panel border border-border">
            {servers.map((entry) => (
              <CatalogRow key={entry.serverId} entry={entry} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function CatalogRow({ entry }: { entry: CatalogEntry }) {
  const { t } = useTranslation();
  const clients =
    entry.routedApps.length === 0
      ? t("pluginCenter.router.catalogAll")
      : entry.routedApps.map((appId) => getAppLabel(appId)).join("、");

  return (
    <li
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1 bg-surface px-4 py-2.5",
        !entry.enabled && "opacity-60",
      )}
    >
      <span className="min-w-[140px] text-body text-fg-1">{entry.name}</span>
      <span className="font-mono text-caption text-fg-2">
        {entry.exposedId}
      </span>
      {entry.routeConfigured && (
        <Badge variant="outline" className="text-fg-2">
          {t("pluginCenter.router.routed")}
        </Badge>
      )}
      {!entry.enabled && (
        <Badge variant="outline" className="text-fg-2">
          {t("pluginCenter.router.catalogDisabled")}
        </Badge>
      )}
      {entry.shadowedBy && (
        <span className="text-caption text-warning-text">
          {t("pluginCenter.router.shadowed", { by: entry.shadowedBy })}
        </span>
      )}
      <span className="ms-auto text-caption text-fg-3">{clients}</span>
    </li>
  );
}
