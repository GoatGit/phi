import { useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  GatewayCatalog,
  GatewayGroupMember,
  GatewayRouteGroup,
  GatewayStrategy,
} from "@/lib/api/gateway";
import { ChevronDown, Trash2 } from "lucide-react";
import { SortableGroupList } from "./SortableGroupList";
import { GatewaySelect } from "./GatewaySelect";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  Dialog,
  DialogContent,
  DialogBody,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Notice } from "@/components/ui/notice";
import { GATEWAY_APPS, protocolCompatibleWith } from "./useGatewayCatalog";

const strategies: GatewayStrategy[] = [
  "ordered",
  "round_robin",
  "least_used",
  "weighted",
];

/** 新建路由组的初值；应用范围由成员协议推导，不在表单里手选。 */
export function createGroupDraft(): GatewayRouteGroup {
  return {
    id: `group-${crypto.randomUUID()}`,
    name: "",
    appIds: [...GATEWAY_APPS],
    enabled: true,
    strategy: "ordered",
    members: [],
    sessionAffinity: false,
    affinityTtlSeconds: 1800,
    failover: true,
    maxAttempts: 3,
    // 与后端 ProxyConfig 默认值一致（秒）
    streamingFirstByteTimeout: 60,
    streamingIdleTimeout: 120,
    nonStreamingTimeout: 600,
    rules: [],
  };
}

export function memberLabel(
  member: GatewayGroupMember | undefined,
  catalog: GatewayCatalog,
): string {
  if (!member) return "—";
  return member.groupId
    ? (catalog.groups?.find((g) => g.id === member.groupId)?.name ??
        member.groupId)
    : `${catalog.suppliers.find((s) => s.id === member.supplierId)?.name ?? member.supplierId} → ${member.model}`;
}

/** Application compatibility follows the chosen endpoints; it is not a form setting. */
export function inferGroupApps(
  group: GatewayRouteGroup,
  catalog: GatewayCatalog,
): string[] {
  return GATEWAY_APPS.filter((app) =>
    group.members.every((member) => {
      if (member.groupId) {
        return (
          catalog.groups
            ?.find((g) => g.id === member.groupId)
            ?.appIds.includes(app) ?? false
        );
      }
      const supplier = catalog.suppliers.find(
        (s) => s.id === member.supplierId,
      );
      return (
        !!supplier && protocolCompatibleWith(app, supplier.endpoint.protocol)
      );
    }),
  );
}

export function GroupDialog({
  catalog,
  group,
  isNew = false,
  pending,
  error,
  stale,
  onClose,
  onSave,
  onDeleteRequest,
}: {
  catalog: GatewayCatalog;
  group: GatewayRouteGroup;
  isNew?: boolean;
  pending: boolean;
  error: string | null;
  stale: boolean;
  onClose: () => void;
  onSave: (group: GatewayRouteGroup) => void;
  /** 只读历史组（已从目录删除）不提供删除入口。 */
  onDeleteRequest?: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(group);
  const [validation, setValidation] = useState("");
  const suppliers = catalog.suppliers.filter((s) => s.models.length);
  // Exclude descendants that would lead back to this group.
  function references(id: string, seen = new Set<string>()): boolean {
    if (id === draft.id) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return (
      (catalog.groups ?? [])
        .find((g) => g.id === id)
        ?.members.some((m) => m.groupId && references(m.groupId, seen)) ?? false
    );
  }
  const childGroups = (catalog.groups ?? []).filter((g) => !references(g.id));
  const targets = [
    ...suppliers.map((s) => ({ value: `s:${s.id}`, label: s.name })),
    ...childGroups.map((g) => ({
      value: `g:${g.id}`,
      label: `${t("gateway.groups.group")} · ${g.name}`,
    })),
  ];
  function updateMember(id: string, patch: Partial<GatewayGroupMember>) {
    setDraft((prev) => ({
      ...prev,
      members: prev.members.map((m) => (m.id === id ? { ...m, ...patch } : m)),
    }));
  }
  function submit() {
    if (pending || stale) return;
    if (
      !draft.name.trim() ||
      (draft.enabled && !draft.members.some((m) => m.enabled))
    ) {
      setValidation(t("gateway.groups.required"));
      return;
    }
    if (
      draft.members.some((m) =>
        m.supplierId
          ? !suppliers.some(
              (s) => s.id === m.supplierId && s.models.includes(m.model),
            )
          : !childGroups.some((g) => g.id === m.groupId),
      )
    ) {
      setValidation(t("gateway.groups.incompatible"));
      return;
    }
    if (
      draft.rules.some(
        (r) =>
          !r.name.trim() ||
          !r.description.trim() ||
          !draft.members.some((m) => m.id === r.memberId),
      ) ||
      (draft.rules.some((r) => r.enabled) && !draft.classifier)
    ) {
      setValidation(t("gateway.groups.ruleRequired"));
      return;
    }
    const appIds = inferGroupApps(draft, catalog);
    if (!appIds.length) {
      setValidation(t("gateway.groups.incompatible"));
      return;
    }
    // Existing references must remain compatible; saving must not silently
    // disconnect a policy or break a parent group.
    if (
      catalog.policies.some(
        (p) => p.groupId === draft.id && !appIds.includes(p.appId),
      ) ||
      (catalog.groups ?? []).some(
        (g) =>
          g.id !== draft.id &&
          g.members.some((m) => m.groupId === draft.id) &&
          g.appIds.some((app) => !appIds.includes(app)),
      )
    ) {
      setValidation(t("gateway.groups.incompatibleReference"));
      return;
    }
    onSave({ ...draft, appIds, name: draft.name.trim() });
  }
  const optionMembers = draft.members.map((m) => ({
    value: m.id,
    label: memberLabel(m, catalog),
    disabled: !m.enabled,
  }));
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-hidden">
        <DialogHeader>
          <DialogTitle>
            {t(isNew ? "gateway.groups.new" : "gateway.groups.edit")}
          </DialogTitle>
          <DialogDescription>
            {t("gateway.groups.editorHint")}
          </DialogDescription>
          {/* 技术 ID 从列表移除后，编辑弹窗成为它的固定查看入口。 */}
          <p className="font-mono text-xs text-fg-3">group/{draft.id}</p>
        </DialogHeader>
        {(error || validation || stale) && (
          <div
            role="alert"
            className="flex max-h-[25vh] shrink-0 flex-col gap-2 overflow-y-auto px-6 py-2"
          >
            {(error || validation) && (
              <Notice tone="danger" title={error || validation} />
            )}
            {stale && (
              <Notice tone="warning" title={t("gateway.policy.staleEditor")} />
            )}
          </div>
        )}
        <DialogBody>
          <fieldset disabled={pending} className="flex min-w-0 flex-col gap-5">
            <FieldGroup className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="group-name">
                  {t("gateway.pool.name")}
                </FieldLabel>
                <Input
                  id="group-name"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </Field>
              <Field>
                <FieldLabel>{t("gateway.groups.strategy")}</FieldLabel>
                <GatewaySelect
                  disabled={pending}
                  label={t("gateway.groups.strategy")}
                  value={draft.strategy}
                  selectedLabel={
                    draft.strategy === "manual"
                      ? t("gateway.groups.legacyManualLabel")
                      : undefined
                  }
                  onChange={(strategy) =>
                    setDraft({
                      ...draft,
                      strategy: strategy as GatewayStrategy,
                      manualMemberId: null,
                    })
                  }
                  options={strategies.map((value) => ({
                    value,
                    label: t(`gateway.groups.strategies.${value}`),
                  }))}
                />
              </Field>
            </FieldGroup>
            <p className="text-xs text-fg-2">
              {t(`gateway.groups.strategyHints.${draft.strategy}`)}
            </p>
            {draft.strategy === "manual" && (
              <Notice
                title={t("gateway.groups.legacyManual", {
                  target: memberLabel(
                    draft.members.find((m) => m.id === draft.manualMemberId) ??
                      draft.members[0],
                    catalog,
                  ),
                })}
              />
            )}
            <div className="flex flex-wrap gap-5">
              <label className="flex items-center gap-2 text-sm">
                <Switch
                  checked={draft.enabled}
                  onCheckedChange={(enabled) => setDraft({ ...draft, enabled })}
                />
                {t("gateway.policy.enabled")}
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Switch
                  checked={draft.failover}
                  onCheckedChange={(failover) =>
                    setDraft({ ...draft, failover })
                  }
                />
                {t("gateway.policy.failover")}
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Switch
                  checked={draft.sessionAffinity}
                  onCheckedChange={(sessionAffinity) =>
                    setDraft({ ...draft, sessionAffinity })
                  }
                />
                {t("gateway.groups.affinity")}
              </label>
            </div>
            {(draft.failover || draft.sessionAffinity) && (
              <FieldGroup className="grid gap-4 sm:grid-cols-2">
                {draft.failover && (
                  <Field>
                    <FieldLabel htmlFor="group-attempts">
                      {t("gateway.groups.maxAttempts")}
                    </FieldLabel>
                    <Input
                      id="group-attempts"
                      type="number"
                      min={1}
                      max={11}
                      value={draft.maxAttempts}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          maxAttempts: Number(e.target.value),
                        })
                      }
                    />
                  </Field>
                )}
                {draft.sessionAffinity && (
                  <Field>
                    <FieldLabel htmlFor="group-ttl">
                      {t("gateway.groups.ttl")}
                    </FieldLabel>
                    <Input
                      id="group-ttl"
                      type="number"
                      min={60}
                      max={86400}
                      value={draft.affinityTtlSeconds}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          affinityTtlSeconds: Number(e.target.value),
                        })
                      }
                    />
                  </Field>
                )}
              </FieldGroup>
            )}
            <section
              className="flex flex-col gap-3"
              aria-label={t("gateway.groups.members")}
            >
              <div className="flex items-center justify-between">
                <h3 className="font-medium">{t("gateway.groups.members")}</h3>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!targets.length || draft.members.length >= 32}
                  onClick={() => {
                    const s = suppliers[0];
                    const g = childGroups[0];
                    setDraft({
                      ...draft,
                      members: [
                        ...draft.members,
                        {
                          id: crypto.randomUUID(),
                          supplierId: s?.id,
                          groupId: s ? null : g?.id,
                          model: s?.models[0] ?? "",
                          enabled: true,
                          weight: 1,
                        },
                      ],
                    });
                  }}
                >
                  {t("gateway.groups.addMember")}
                </Button>
              </div>
              {!targets.length && (
                <p className="text-sm text-fg-2">
                  {t("gateway.policy.noEligibleSuppliers")}
                </p>
              )}
              <SortableGroupList
                items={draft.members}
                label={t("gateway.groups.members")}
                itemLabel={(member) => memberLabel(member, catalog)}
                disabled={pending}
                onReorder={(members) =>
                  setDraft((prev) => ({ ...prev, members }))
                }
              >
                {(member, index) => (
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <div className="min-w-0 flex-1 basis-32">
                      <GatewaySelect
                        disabled={pending}
                        label={t("gateway.groups.target")}
                        value={
                          member.groupId
                            ? `g:${member.groupId}`
                            : `s:${member.supplierId}`
                        }
                        options={targets}
                        onChange={(value) => {
                          const id = value.slice(2);
                          updateMember(
                            member.id,
                            value.startsWith("g:")
                              ? { groupId: id, supplierId: null, model: "" }
                              : {
                                  groupId: null,
                                  supplierId: id,
                                  model:
                                    suppliers.find((s) => s.id === id)
                                      ?.models[0] ?? "",
                                },
                          );
                        }}
                      />
                    </div>
                    {member.supplierId && (
                      <div className="min-w-0 flex-1 basis-32">
                        <GatewaySelect
                          disabled={pending}
                          label={t("gateway.pool.models")}
                          value={member.model}
                          options={(
                            catalog.suppliers.find(
                              (s) => s.id === member.supplierId,
                            )?.models ?? []
                          ).map((value) => ({ value, label: value }))}
                          onChange={(model) =>
                            updateMember(member.id, { model })
                          }
                        />
                      </div>
                    )}
                    {draft.strategy === "weighted" && (
                      <label className="flex shrink-0 items-center gap-2 text-sm">
                        {t("gateway.groups.weight")}
                        <Input
                          className="w-20"
                          type="number"
                          min={1}
                          max={1000}
                          value={member.weight}
                          onChange={(e) =>
                            updateMember(member.id, {
                              weight: Number(e.target.value),
                            })
                          }
                        />
                      </label>
                    )}
                    {!member.enabled && (
                      <Badge variant="outline">{t("gateway.groups.off")}</Badge>
                    )}
                    <Button
                      size="icon-compact"
                      variant="ghost"
                      aria-label={t("gateway.groups.removeMember", {
                        index: index + 1,
                      })}
                      title={t("gateway.groups.remove")}
                      disabled={pending}
                      onClick={() =>
                        setDraft((prev) => ({
                          ...prev,
                          members: prev.members.filter(
                            (m) => m.id !== member.id,
                          ),
                          rules: prev.rules.filter(
                            (r) => r.memberId !== member.id,
                          ),
                          manualMemberId:
                            prev.manualMemberId === member.id
                              ? null
                              : prev.manualMemberId,
                        }))
                      }
                    >
                      <Trash2 data-icon="inline-start" aria-hidden />
                    </Button>
                  </div>
                )}
              </SortableGroupList>
            </section>
            {(draft.rules.length > 0 || draft.classifier) && (
              <Collapsible className="flex flex-col gap-3 border-t border-border pt-4">
                <CollapsibleTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    className="group w-full justify-between"
                  >
                    {t("gateway.groups.existingIntent")}
                    <ChevronDown
                      data-icon="inline-end"
                      aria-hidden
                      className="transition-transform group-data-[state=open]:rotate-180"
                    />
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent className="flex flex-col gap-3">
                  <p className="text-sm text-fg-2">
                    {t("gateway.groups.intentHint")}
                  </p>
                  <div className="grid sm:grid-cols-2 gap-3">
                    <Field>
                      <FieldLabel>{t("gateway.groups.classifier")}</FieldLabel>
                      <GatewaySelect
                        disabled={pending}
                        label={t("gateway.groups.classifier")}
                        value={draft.classifier?.supplierId ?? "none"}
                        options={[
                          {
                            value: "none",
                            label: t("gateway.groups.noClassifier"),
                          },
                          ...catalog.suppliers
                            .filter((s) => s.models.length)
                            .map((s) => ({ value: s.id, label: s.name })),
                        ]}
                        onChange={(id) =>
                          setDraft({
                            ...draft,
                            classifier:
                              id === "none"
                                ? null
                                : {
                                    supplierId: id,
                                    model:
                                      catalog.suppliers.find((s) => s.id === id)
                                        ?.models[0] ?? "",
                                  },
                          })
                        }
                      />
                    </Field>
                    {draft.classifier && (
                      <Field>
                        <FieldLabel>
                          {t("gateway.groups.classifierModel")}
                        </FieldLabel>
                        <GatewaySelect
                          disabled={pending}
                          label={t("gateway.groups.classifierModel")}
                          value={draft.classifier.model}
                          options={(
                            catalog.suppliers.find(
                              (s) => s.id === draft.classifier?.supplierId,
                            )?.models ?? []
                          ).map((value) => ({ value, label: value }))}
                          onChange={(model) =>
                            setDraft({
                              ...draft,
                              classifier: { ...draft.classifier!, model },
                            })
                          }
                        />
                      </Field>
                    )}
                  </div>
                  <SortableGroupList
                    items={draft.rules}
                    label={t("gateway.groups.existingIntent")}
                    itemLabel={(rule) => rule.name}
                    disabled={pending}
                    onReorder={(rules) =>
                      setDraft((prev) => ({ ...prev, rules }))
                    }
                  >
                    {(rule, index) => (
                      <div className="flex min-w-0 flex-col gap-2">
                        <div className="flex items-center gap-2">
                          <Switch
                            aria-label={t("gateway.groups.ruleEnabled", {
                              index: index + 1,
                            })}
                            checked={rule.enabled}
                            onCheckedChange={(enabled) =>
                              setDraft({
                                ...draft,
                                rules: draft.rules.map((r) =>
                                  r.id === rule.id ? { ...r, enabled } : r,
                                ),
                              })
                            }
                          />
                          <Input
                            aria-label={t("gateway.groups.ruleName")}
                            placeholder={t("gateway.groups.ruleName")}
                            value={rule.name}
                            onChange={(e) =>
                              setDraft({
                                ...draft,
                                rules: draft.rules.map((r) =>
                                  r.id === rule.id
                                    ? { ...r, name: e.target.value }
                                    : r,
                                ),
                              })
                            }
                          />
                        </div>
                        <Textarea
                          aria-label={t("gateway.groups.ruleDescription")}
                          placeholder={t("gateway.groups.ruleDescription")}
                          maxLength={2000}
                          value={rule.description}
                          onChange={(e) =>
                            setDraft({
                              ...draft,
                              rules: draft.rules.map((r) =>
                                r.id === rule.id
                                  ? { ...r, description: e.target.value }
                                  : r,
                              ),
                            })
                          }
                        />
                        <GatewaySelect
                          disabled={pending}
                          label={t("gateway.groups.ruleTarget")}
                          value={rule.memberId}
                          options={optionMembers}
                          onChange={(memberId) =>
                            setDraft({
                              ...draft,
                              rules: draft.rules.map((r) =>
                                r.id === rule.id ? { ...r, memberId } : r,
                              ),
                            })
                          }
                        />
                        <div className="flex justify-end">
                          <Button
                            size="icon-compact"
                            variant="ghost"
                            aria-label={t("gateway.groups.removeRule", {
                              name: rule.name,
                            })}
                            title={t("gateway.groups.remove")}
                            onClick={() =>
                              setDraft({
                                ...draft,
                                rules: draft.rules.filter(
                                  (r) => r.id !== rule.id,
                                ),
                              })
                            }
                          >
                            <Trash2 data-icon="inline-start" aria-hidden />
                          </Button>
                        </div>
                      </div>
                    )}
                  </SortableGroupList>
                </CollapsibleContent>
              </Collapsible>
            )}
          </fieldset>
        </DialogBody>
        <DialogFooter className="border-t border-border">
          {onDeleteRequest && !isNew && (
            <Button
              variant="ghost"
              className="me-auto text-danger-text"
              disabled={pending}
              onClick={onDeleteRequest}
            >
              <Trash2 data-icon="inline-start" aria-hidden />
              {t("gateway.groups.removeTitle")}
            </Button>
          )}
          <Button variant="ghost" disabled={pending} onClick={onClose}>
            {t("gateway.cancel")}
          </Button>
          <Button disabled={pending || stale} onClick={submit}>
            {t(pending ? "gateway.saving" : "gateway.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
