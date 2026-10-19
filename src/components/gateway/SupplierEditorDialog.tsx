import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogBody,
  DialogContent,
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
import {
  gatewayApi,
  type GatewaySupplier,
  type GatewaySupplierUpsert,
} from "@/lib/api";
import { gatewayCatalogKey, useGatewayErrorMessage } from "./useGatewayCatalog";

/** 各协议允许的鉴权字段，与后端 auth_field_for 的映射一致。 */
export const PROTOCOL_AUTH_FIELDS: Record<string, string[]> = {
  anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
  openai_chat: ["OPENAI_API_KEY"],
  openai_responses: ["OPENAI_API_KEY"],
  gemini_native: ["GEMINI_API_KEY"],
  systemone: ["TYPESAFE_API_KEY"],
};

export const SUPPLIER_PROTOCOLS = Object.keys(PROTOCOL_AUTH_FIELDS);

/** 协议在界面上的显示名；System One 是品牌协议名，存储值仍是 `systemone`。 */
export function protocolLabel(protocol: string): string {
  return protocol === "systemone" ? "System One" : protocol;
}

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

/** 新建时的预填值，用于没有应用模板的协议出口（System One）。 */
export interface SupplierEditorInitial {
  name?: string;
  protocol?: string;
  baseUrl?: string;
  models?: string[];
  authField?: string;
}

interface SupplierEditorDialogProps {
  open: boolean;
  /** null = 直连新建；否则编辑既有条目。 */
  supplier: GatewaySupplier | null;
  revision: number;
  onClose: () => void;
  initial?: SupplierEditorInitial;
}

/** 直连新建/编辑资源池供应商；密钥单独提交，目录里永远不回显。 */
export function SupplierEditorDialog({
  open,
  supplier,
  revision,
  onClose,
  initial,
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
    setName(supplier?.name ?? initial?.name ?? "");
    setProtocol(
      supplier?.endpoint.protocol ?? initial?.protocol ?? "anthropic",
    );
    setBaseUrl(supplier?.endpoint.baseUrl ?? initial?.baseUrl ?? "");
    setModelsText((supplier?.models ?? initial?.models)?.join(", ") ?? "");
    setAuthField(supplier ? "" : (initial?.authField ?? ""));
    setApiKey("");
    setError(null);
  }, [open, supplier, initial]);

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
  // System One 没有 /models 目录，模型名由用户手填。
  const canDiscoverModels = isEdit && protocol !== "systemone";

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
                          {protocolLabel(p)}
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
                  {protocol === "systemone"
                    ? t("gateway.pool.systemOneModelsHint")
                    : t("gateway.pool.modelsHint")}
                </p>
                {canDiscoverModels && (
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
