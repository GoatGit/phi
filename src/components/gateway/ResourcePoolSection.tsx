import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ChevronDown, Pencil, Trash2 } from "lucide-react";
import { ProviderIcon } from "@/components/ProviderIcon";
import { getAppLabel } from "@/config/appConfig";
import {
  gatewayApi,
  type GatewayCatalog,
  type GatewaySupplier,
} from "@/lib/api";
import { SearchField } from "@/components/ui/search-field";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Notice } from "@/components/ui/notice";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { AddPoolSupplier } from "./AddPoolSupplier";
import { SupplierEditorDialog, protocolLabel } from "./SupplierEditorDialog";
import {
  gatewayCatalogKey,
  useGatewayErrorMessage,
  catalogWithoutSupplier,
} from "./useGatewayCatalog";

interface ResourcePoolSectionProps {
  catalog: GatewayCatalog;
  onOpenPolicy?: (id: string) => void;
  /** 新建弹窗由页头按钮控制（受控）。 */
  createOpen: boolean;
  onCreateOpenChange: (open: boolean) => void;
}

export function ResourcePoolSection({
  catalog,
  onOpenPolicy,
  createOpen,
  onCreateOpenChange,
}: ResourcePoolSectionProps) {
  const { t } = useTranslation();
  const describeError = useGatewayErrorMessage();
  const setCreateOpen = onCreateOpenChange;
  const [editorTarget, setEditorTarget] = useState<GatewaySupplier | null>(
    null,
  );
  const [editorOpen, setEditorOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<GatewaySupplier | null>(
    null,
  );
  const save = useSaveOrReport();
  const [search, setSearch] = useState("");
  const [protocolFilter, setProtocolFilter] = useState("all");
  // 协议筛选只在池子里确实存在多种协议时才出现，避免常驻无效控件。
  const presentProtocols = [
    ...new Set(catalog.suppliers.map((s) => s.endpoint.protocol)),
  ];
  const showProtocolFilter = presentProtocols.length > 1;
  const visibleSuppliers = catalog.suppliers.filter(
    (supplier) =>
      (!showProtocolFilter ||
        protocolFilter === "all" ||
        supplier.endpoint.protocol === protocolFilter) &&
      [supplier.name, supplier.endpoint.baseUrl, ...supplier.models]
        .join(" ")
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  // 引用关系默认只显示数量，按行展开完整列表。
  const [expandedRefs, setExpandedRefs] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [editorRevision, setEditorRevision] = useState(catalog.revision);
  // 弹窗打开瞬间锁定当前 catalog revision，供保存时做乐观并发校验。
  useEffect(() => {
    if (createOpen) setEditorRevision(catalog.revision);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createOpen]);

  const confirmDelete = () => {
    if (!deleteTarget) return;
    save.mutate(catalogWithoutSupplier(catalog, deleteTarget.id), {
      onSuccess: () => setDeleteTarget(null),
    });
  };

  return (
    <section
      className="flex flex-col gap-3"
      aria-label={t("gateway.pool.title")}
    >
      <div className="flex flex-wrap items-center gap-2">
        <SearchField
          collapsible
          containerClassName="w-56"
          aria-label={t("gateway.pool.search")}
          placeholder={t("gateway.pool.search")}
          value={search}
          onValueChange={setSearch}
          clearLabel={t("gateway.pool.clearSearch")}
        />
        {showProtocolFilter && (
          <Select value={protocolFilter} onValueChange={setProtocolFilter}>
            <SelectTrigger
              className="w-40"
              aria-label={t("gateway.pool.protocol")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="all">
                  {t("gateway.pool.allProtocols")}
                </SelectItem>
                {presentProtocols.map((protocol) => (
                  <SelectItem key={protocol} value={protocol}>
                    {protocolLabel(protocol)}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        )}
        <span className="text-xs text-fg-3">
          {t("gateway.pool.count", { count: visibleSuppliers.length })}
        </span>
      </div>
      {save.error ? (
        <Notice tone="danger" title={describeError(save.error)} />
      ) : null}
      {catalog.suppliers.length === 0 ? (
        <div className="rounded-lg border border-dashed px-4 py-10 text-center">
          <p className="text-sm text-fg-3">{t("gateway.pool.empty")}</p>
        </div>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {visibleSuppliers.map((supplier) => {
            const policyRefs = catalog.policies.filter((policy) =>
              policy.candidates.some(
                (candidate) => candidate.supplierId === supplier.id,
              ),
            );
            const groupRefs = (catalog.groups ?? []).filter(
              (g) =>
                g.members.some((m) => m.supplierId === supplier.id) ||
                g.classifier?.supplierId === supplier.id,
            );
            const refCount = policyRefs.length + groupRefs.length;
            const refsOpen = expandedRefs.has(supplier.id);
            return (
              <article
                key={supplier.id}
                className="group flex flex-col gap-3 rounded-lg border p-4 transition-colors hover:border-border-strong"
              >
                <div className="flex items-start gap-3">
                  <ProviderIcon
                    icon={supplierIcon(supplier)}
                    name={supplier.name}
                    size={30}
                    className="mt-0.5 rounded-lg"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span
                        className="truncate text-sm font-medium text-fg-1"
                        title={supplier.name}
                      >
                        {supplier.name}
                      </span>
                      <span className="shrink-0 rounded bg-subtle px-1.5 font-mono text-[10px] leading-4 text-fg-3">
                        {protocolLabel(supplier.endpoint.protocol)}
                      </span>
                    </div>
                    <p
                      className="mt-0.5 truncate font-mono text-xs text-fg-3"
                      title={supplier.endpoint.baseUrl}
                    >
                      {endpointHost(supplier.endpoint.baseUrl)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                    <Button
                      variant="ghost"
                      size="icon-compact"
                      aria-label={t("gateway.pool.edit")}
                      title={t("gateway.pool.edit")}
                      onClick={() => {
                        setEditorTarget(supplier);
                        setEditorRevision(catalog.revision);
                        setEditorOpen(true);
                      }}
                    >
                      <Pencil data-icon aria-hidden />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-compact"
                      aria-label={t("gateway.pool.remove")}
                      title={t("gateway.pool.removeTitle")}
                      onClick={() => setDeleteTarget(supplier)}
                    >
                      <Trash2 data-icon aria-hidden />
                    </Button>
                  </div>
                </div>

                {supplier.models.length > 0 && (
                  <ModelBadges models={supplier.models} />
                )}

                <div className="mt-auto border-t pt-2.5">
                  {refCount === 0 ? (
                    <span className="text-xs text-fg-3">
                      {t("gateway.pool.unused")}
                    </span>
                  ) : (
                    <div className="flex flex-col gap-1.5">
                      <button
                        type="button"
                        className="flex w-fit items-center gap-1 text-xs text-fg-3 transition-colors hover:text-fg-2"
                        aria-expanded={refsOpen}
                        aria-label={t(
                          refsOpen
                            ? "gateway.pool.hideReferences"
                            : "gateway.pool.showReferences",
                        )}
                        onClick={() =>
                          setExpandedRefs((current) => {
                            const next = new Set(current);
                            if (next.has(supplier.id)) next.delete(supplier.id);
                            else next.add(supplier.id);
                            return next;
                          })
                        }
                      >
                        {t("gateway.pool.usedBySummary", { count: refCount })}
                        <ChevronDown
                          aria-hidden
                          className={cn(
                            "h-3 w-3 transition-transform",
                            refsOpen && "rotate-180",
                          )}
                        />
                      </button>
                      {refsOpen && (
                        <div className="flex flex-wrap gap-1">
                          {policyRefs.map((policy) => (
                            <Button
                              key={policy.id}
                              variant="secondary"
                              size="sm"
                              className="h-auto rounded-full px-2.5 py-0.5 text-xs font-normal"
                              onClick={() => onOpenPolicy?.(policy.id)}
                            >
                              {getAppLabel(policy.appId)} · {policy.name}
                              {!policy.enabled
                                ? ` (${t("gateway.policy.disabled")})`
                                : ""}
                            </Button>
                          ))}
                          {groupRefs.map((g) => (
                            <Badge
                              key={g.id}
                              variant="secondary"
                              className="rounded-full px-2.5 font-normal"
                            >
                              {g.name}
                              {g.classifier?.supplierId === supplier.id
                                ? ` · ${t("gateway.groups.classifier")}`
                                : ""}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}

      {createOpen && (
        <AddPoolSupplier
          revision={editorRevision}
          onClose={() => setCreateOpen(false)}
        />
      )}

      <SupplierEditorDialog
        open={editorOpen}
        supplier={editorTarget}
        revision={editorRevision}
        onClose={() => setEditorOpen(false)}
      />

      <ConfirmDialog
        isOpen={deleteTarget !== null}
        title={t("gateway.pool.removeTitle")}
        message={t("gateway.pool.removeMessage", {
          name: deleteTarget?.name ?? "",
          count: deleteTarget
            ? catalog.policies.filter((p) =>
                p.candidates.some((c) => c.supplierId === deleteTarget.id),
              ).length
            : 0,
        })}
        pending={save.isPending}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </section>
  );
}

function ModelBadges({ models }: { models: string[] }) {
  const { t } = useTranslation();
  const shown = models.slice(0, 3);
  const rest = models.length - shown.length;
  return (
    <div className="flex flex-wrap gap-1">
      {shown.map((model) => (
        <Badge
          key={model}
          variant="secondary"
          className="font-mono text-[11px]"
        >
          {model}
        </Badge>
      ))}
      {rest > 0 ? (
        <Badge variant="secondary">
          {t("gateway.pool.moreModels", { count: rest })}
        </Badge>
      ) : null}
    </div>
  );
}

/** 与 useSaveGatewayCatalog 相同，但这里需要 error/isPending 状态透出。 */
function useSaveOrReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (catalog: GatewayCatalog) => gatewayApi.saveCatalog(catalog),
    onSuccess: (saved) => {
      qc.setQueryData(gatewayCatalogKey, saved);
    },
    onError: () => {
      void qc.invalidateQueries({ queryKey: gatewayCatalogKey });
    },
  });
}

/** 表格里只展示主机名，完整地址放 title，避免长 URL 撑宽列。 */
function endpointHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// 按名称/端点猜品牌图标，仅取图标库里确定存在的 SVG；猜不中就回落到首字母。
const SUPPLIER_ICON_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/deepseek/i, "deepseek"],
  [/openai|\bgpt\b/i, "openai"],
  [/anthropic|claude/i, "anthropic"],
  [/gemini|google/i, "gemini"],
  [/openrouter/i, "openrouter"],
  [/siliconflow|硅基/i, "siliconflow"],
  [/moonshot|kimi/i, "kimi"],
  [/qwen|通义/i, "qwen"],
  [/zhipu|智谱|bigmodel|glm/i, "zhipu"],
  [/doubao|豆包|volc|火山/i, "doubao"],
  [/minimax/i, "minimax"],
  [/ollama/i, "ollama"],
  [/packy/i, "packycode"],
];

function supplierIcon(supplier: GatewaySupplier): string | undefined {
  const haystack = `${supplier.name} ${supplier.endpoint.baseUrl}`;
  for (const [pattern, icon] of SUPPLIER_ICON_PATTERNS) {
    if (pattern.test(haystack)) return icon;
  }
  return undefined;
}
