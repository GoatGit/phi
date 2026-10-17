import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ChevronDown, Pencil, Trash2 } from "lucide-react";
import { ProviderIcon } from "@/components/ProviderIcon";
import { getAppLabel } from "@/config/appConfig";
import {
  gatewayApi,
  type GatewayCatalog,
  type GatewaySupplier,
  type GatewaySupplierUpsert,
} from "@/lib/api";
import { SearchField } from "@/components/ui/search-field";
import { cn } from "@/lib/utils";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldSet,
  FieldLegend,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
                    {protocol}
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
                        {supplier.endpoint.protocol}
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

/** 各协议允许的鉴权字段，与后端 auth_field_for 的映射一致。 */
const PROTOCOL_AUTH_FIELDS: Record<string, string[]> = {
  anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
  openai_chat: ["OPENAI_API_KEY"],
  openai_responses: ["OPENAI_API_KEY"],
  gemini_native: ["GEMINI_API_KEY"],
};

const SUPPLIER_PROTOCOLS = Object.keys(PROTOCOL_AUTH_FIELDS);

/** 与后端 valid_endpoint 一致：http(s)、有主机、无查询/片段/账号信息。 */
function isValidBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.host.length > 0 &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

/** 与后端 identifier 一致：非空、≤200、限定字符集。 */
function isModelIdentifier(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 200 &&
    /^[A-Za-z0-9_.\-:/@]+$/.test(value)
  );
}

function parseModels(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\s,，、]+/)
        .map((m) => m.trim())
        .filter(Boolean),
    ),
  ];
}

interface SupplierEditorDialogProps {
  open: boolean;
  /** null = 直连新建；否则编辑既有条目。 */
  supplier: GatewaySupplier | null;
  revision: number;
  onClose: () => void;
}

/** 直连新建/编辑资源池供应商；密钥单独提交，目录里永远不回显。 */
function SupplierEditorDialog({
  open,
  supplier,
  revision,
  onClose,
}: SupplierEditorDialogProps) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const describeError = useGatewayErrorMessage();
  const isEdit = supplier !== null;
  const [name, setName] = useState("");
  const [protocol, setProtocol] = useState("anthropic");
  const [baseUrl, setBaseUrl] = useState("");
  const [modelsText, setModelsText] = useState("");
  // 空串表示"保持不变"（编辑）或未选择（新建）。
  const [authField, setAuthField] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);

  // 打开时按目标重置表单；密钥字段永不回填。
  useEffect(() => {
    if (!open) return;
    setName(supplier?.name ?? "");
    setProtocol(supplier?.endpoint.protocol ?? "anthropic");
    setBaseUrl(supplier?.endpoint.baseUrl ?? "");
    setModelsText(supplier?.models.join(", ") ?? "");
    setAuthField("");
    setApiKey("");
    setError(null);
  }, [open, supplier]);

  const protocolChanged =
    supplier !== null && supplier.endpoint.protocol !== protocol;
  const models = useMemo(() => parseModels(modelsText), [modelsText]);

  // 与后端校验规则对齐，先在本地给出反馈。
  const validationError = (() => {
    if (!name.trim()) return t("gateway.pool.nameRequired");
    if (!isValidBaseUrl(baseUrl.trim()))
      return t("gateway.pool.invalidBaseUrl");
    if (models.length > 200 || models.some((m) => !isModelIdentifier(m))) {
      return t("gateway.pool.invalidModels");
    }
    if (!isEdit && !apiKey) return t("gateway.pool.keyRequired");
    if (!isEdit && !authField) return t("gateway.pool.pickAuthField");
    if (protocolChanged && (!apiKey || !authField)) {
      return t("gateway.pool.keyRequiredOnProtocolChange");
    }
    return null;
  })();

  const save = useMutation({
    mutationFn: () => {
      const input: GatewaySupplierUpsert = {
        revision,
        name: name.trim(),
        endpoint: { protocol, baseUrl: baseUrl.trim() },
        models,
      };
      // 密钥是补丁语义：留空表示保持现有值；仅编辑模式允许。
      if (apiKey) input.apiKey = apiKey;
      if (authField) input.authField = authField;
      return isEdit && supplier
        ? gatewayApi.updateSupplier(supplier.id, input)
        : gatewayApi.createSupplier({
            ...input,
            apiKey,
            authField,
          });
    },
    onSuccess: (saved) => {
      qc.setQueryData(gatewayCatalogKey, saved);
      onClose();
    },
    onError: (err) => {
      setError(describeError(err));
      void qc.invalidateQueries({ queryKey: gatewayCatalogKey });
    },
  });

  const discovery = useMutation({
    mutationFn: () => gatewayApi.fetchModels(supplier!.id),
  });
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  useEffect(() => {
    discovery.reset();
    setSelectedModels([]);
  }, [open, supplier]);

  const authOptions = PROTOCOL_AUTH_FIELDS[protocol] ?? [];

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !save.isPending) onClose();
      }}
    >
      <DialogContent className="max-h-[85vh] max-w-lg overflow-hidden">
        <DialogHeader>
          <DialogTitle>
            {isEdit
              ? t("gateway.pool.editTitle")
              : t("gateway.pool.createTitle")}
          </DialogTitle>
          <DialogDescription>
            {isEdit
              ? t("gateway.pool.editDescription")
              : t("gateway.pool.createDescription")}
          </DialogDescription>
        </DialogHeader>

        {(error ?? validationError) && (
          <div
            role="alert"
            className="max-h-[25vh] shrink-0 overflow-y-auto px-6 py-2"
          >
            <Notice tone="danger" title={error ?? validationError} />
          </div>
        )}
        <DialogBody>
          <fieldset disabled={save.isPending} className="min-w-0">
            <FieldGroup className="gap-4">
              <Field>
                <FieldLabel
                  className="text-sm font-medium"
                  htmlFor="gateway-sup-name"
                >
                  {t("gateway.pool.name")}
                </FieldLabel>
                <Input
                  id="gateway-sup-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>

              <Field>
                <FieldLabel
                  className="text-sm font-medium"
                  htmlFor="gateway-sup-protocol"
                >
                  {t("gateway.pool.protocol")}
                </FieldLabel>
                <Select
                  disabled={save.isPending}
                  value={protocol}
                  onValueChange={(next) => {
                    setProtocol(next);
                    setAuthField("");
                  }}
                >
                  <SelectTrigger id="gateway-sup-protocol">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {SUPPLIER_PROTOCOLS.map((p) => (
                        <SelectItem key={p} value={p}>
                          {p}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>

              <Field>
                <FieldLabel
                  className="text-sm font-medium"
                  htmlFor="gateway-sup-base-url"
                >
                  {t("gateway.pool.endpoint")}
                </FieldLabel>
                <Input
                  id="gateway-sup-base-url"
                  className="font-mono text-xs"
                  placeholder="https://"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                />
              </Field>

              <Field>
                <FieldLabel
                  className="text-sm font-medium"
                  htmlFor="gateway-sup-models"
                >
                  {t("gateway.pool.models")}
                </FieldLabel>
                <Input
                  id="gateway-sup-models"
                  className="font-mono text-xs"
                  value={modelsText}
                  onChange={(e) => setModelsText(e.target.value)}
                />
                <p className="text-xs text-fg-3">
                  {t("gateway.pool.modelsHint")}
                </p>
                {isEdit && (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={
                        discovery.isPending ||
                        protocolChanged ||
                        baseUrl !== supplier?.endpoint.baseUrl ||
                        !!apiKey ||
                        !!authField
                      }
                      onClick={() => {
                        setSelectedModels([]);
                        discovery.mutate();
                      }}
                    >
                      {discovery.isPending
                        ? t("gateway.loading")
                        : t("gateway.pool.discoverModels")}
                    </Button>
                    <p className="text-xs text-muted-foreground">
                      {t("gateway.pool.discoveryHint")}
                    </p>
                    {discovery.isError && (
                      <Notice
                        tone="danger"
                        title={describeError(discovery.error)}
                      />
                    )}
                    {discovery.data && (
                      <FieldSet className="max-h-48 gap-2 overflow-auto">
                        <FieldLegend variant="label">
                          {t("gateway.pool.discoveredCount", {
                            count: discovery.data.length,
                          })}
                        </FieldLegend>
                        {discovery.data.map((model) => (
                          <FieldLabel
                            key={model}
                            className="flex items-center gap-2 text-sm"
                          >
                            <Checkbox
                              checked={
                                models.includes(model) ||
                                selectedModels.includes(model)
                              }
                              disabled={models.includes(model)}
                              onCheckedChange={(checked) =>
                                setSelectedModels((current) =>
                                  checked
                                    ? [...current, model]
                                    : current.filter(
                                        (value) => value !== model,
                                      ),
                                )
                              }
                            />
                            {model}
                          </FieldLabel>
                        ))}
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={!selectedModels.length}
                          onClick={() => {
                            setModelsText(
                              [...new Set([...models, ...selectedModels])].join(
                                ", ",
                              ),
                            );
                            setSelectedModels([]);
                            discovery.reset();
                          }}
                        >
                          {t("gateway.pool.mergeModels")}
                        </Button>
                      </FieldSet>
                    )}
                  </>
                )}
              </Field>

              <Field>
                <FieldLabel
                  className="text-sm font-medium"
                  htmlFor="gateway-sup-auth-field"
                >
                  {t("gateway.pool.authField")}
                </FieldLabel>
                <Select
                  disabled={save.isPending}
                  value={authField || (isEdit ? "keep" : "")}
                  onValueChange={(next) =>
                    setAuthField(next === "keep" ? "" : next)
                  }
                >
                  <SelectTrigger id="gateway-sup-auth-field">
                    <SelectValue
                      placeholder={t("gateway.pool.pickAuthField")}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {isEdit ? (
                        <SelectItem value="keep">
                          {t("gateway.pool.authFieldKeep")}
                        </SelectItem>
                      ) : null}
                      {authOptions.map((field) => (
                        <SelectItem key={field} value={field}>
                          {field}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>

              <Field>
                <FieldLabel
                  className="text-sm font-medium"
                  htmlFor="gateway-sup-key"
                >
                  {t("gateway.pool.apiKey")}
                </FieldLabel>
                <Input
                  id="gateway-sup-key"
                  type="password"
                  autoComplete="new-password"
                  placeholder={
                    isEdit ? t("gateway.pool.keyKeepHint") : undefined
                  }
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                />
              </Field>
            </FieldGroup>
          </fieldset>
        </DialogBody>

        <DialogFooter className="border-t border-border">
          <Button variant="ghost" disabled={save.isPending} onClick={onClose}>
            {t("gateway.cancel")}
          </Button>
          <Button
            disabled={validationError !== null || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? t("gateway.saving") : t("gateway.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
