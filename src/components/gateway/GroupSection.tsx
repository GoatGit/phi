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
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
  GATEWAY_APPS,
  disableEmptyGroups,
  protocolCompatibleWith,
  useGatewayErrorMessage,
  useSaveGatewayCatalog,
} from "./useGatewayCatalog";

const strategies: GatewayStrategy[] = [
  "ordered",
  "round_robin",
  "least_used",
  "weighted",
];
export function GatewaySelect({
  label,
  value,
  onChange,
  options,
  disabled = false,
  selectedLabel,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string; disabled?: boolean }[];
  disabled?: boolean;
  selectedLabel?: string;
}) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger aria-label={label} className="min-w-0">
        <SelectValue placeholder={label}>{selectedLabel}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value} disabled={o.disabled}>
              {o.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

/** Remove a group and its references without silently enabling a different route. */
export function catalogWithoutGroup(
  catalog: GatewayCatalog,
  id: string,
): GatewayCatalog {
  const groups = (catalog.groups ?? [])
    .filter((g) => g.id !== id)
    .map((g) => {
      const removed = new Set(
        g.members.filter((m) => m.groupId === id).map((m) => m.id),
      );
      const members = g.members.filter((m) => !removed.has(m.id));
      return {
        ...g,
        members,
        rules: g.rules.filter((r) => !removed.has(r.memberId)),
        enabled:
          g.enabled &&
          members.some((m) => m.enabled) &&
          !(g.strategy === "manual" && removed.has(g.manualMemberId ?? "")),
        manualMemberId: removed.has(g.manualMemberId ?? "")
          ? null
          : g.manualMemberId,
      };
    });
  return disableEmptyGroups({
    ...catalog,
    groups,
    policies: catalog.policies.map((p) =>
      p.groupId === id
        ? { ...p, groupId: null, candidates: [], enabled: false }
        : p,
    ),
  });
}

export function GroupSection({
  catalog,
  onOpenTraces,
}: {
  catalog: GatewayCatalog;
  onOpenTraces: (id: string) => void;
}) {
  const { t } = useTranslation();
  const save = useSaveGatewayCatalog();
  const describeError = useGatewayErrorMessage();
  const [editing, setEditing] = useState<{
    group: GatewayRouteGroup;
    revision: number;
    isNew: boolean;
  } | null>(null);
  const [deleting, setDeleting] = useState<GatewayRouteGroup | null>(null);
  const groups = catalog.groups ?? [];
  return (
    <section
      className="flex flex-col gap-3"
      aria-label={t("gateway.groups.title")}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-medium">{t("gateway.groups.title")}</h2>
          <p className="text-sm text-fg-2">{t("gateway.groups.description")}</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            save.reset();
            setEditing({
              revision: catalog.revision,
              isNew: true,
              group: {
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
                rules: [],
              },
            });
          }}
        >
          {t("gateway.groups.new")}
        </Button>
      </div>
      {save.isError && (
        <Notice tone="danger" title={describeError(save.error)} />
      )}
      {!groups.length ? (
        <p className="text-sm text-fg-3">{t("gateway.groups.empty")}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16">
                {t("gateway.policy.enabled")}
              </TableHead>
              <TableHead>{t("gateway.pool.name")}</TableHead>
              <TableHead>{t("gateway.groups.strategy")}</TableHead>
              <TableHead>{t("gateway.groups.members")}</TableHead>
              <TableHead>{t("gateway.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {groups.map((group) => (
              <TableRow key={group.id}>
                <TableCell>
                  <Switch
                    size="sm"
                    aria-label={`${group.name} ${t("gateway.policy.enabled")}`}
                    checked={group.enabled}
                    disabled={save.isPending}
                    onCheckedChange={(enabled) =>
                      save.mutate({
                        ...catalog,
                        groups: groups.map((g) =>
                          g.id === group.id ? { ...g, enabled } : g,
                        ),
                      })
                    }
                  />
                </TableCell>
                <TableCell>
                  <span className="font-medium">{group.name}</span>
                  <code
                    className="block max-w-48 truncate text-xs text-fg-3"
                    title={`group/${group.id}`}
                  >
                    group/{group.id}
                  </code>
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    <Badge variant="secondary">
                      {t(`gateway.groups.strategies.${group.strategy}`)}
                    </Badge>
                    {group.failover && (
                      <Badge variant="outline">
                        {t("gateway.policy.failover")}
                      </Badge>
                    )}
                    {group.sessionAffinity && (
                      <Badge variant="outline">
                        {t("gateway.groups.affinity")}
                      </Badge>
                    )}
                    {group.rules.some((r) => r.enabled) && (
                      <Badge variant="outline">
                        {t("gateway.groups.intent")}
                      </Badge>
                    )}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex max-w-64 flex-col gap-1">
                    {group.members.map((member) => (
                      <span
                        key={member.id}
                        className="truncate text-xs text-fg-2"
                        title={memberLabel(member, catalog)}
                      >
                        {memberLabel(member, catalog)}
                        {!member.enabled && ` · ${t("gateway.groups.off")}`}
                        {group.strategy === "weighted" && ` · ${member.weight}`}
                      </span>
                    ))}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onOpenTraces(group.id)}
                    >
                      {t("gateway.policy.viewRequests")}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        save.reset();
                        setEditing({
                          group: structuredClone(group),
                          revision: catalog.revision,
                          isNew: false,
                        });
                      }}
                    >
                      {t("gateway.policy.edit")}
                    </Button>
                    <Button
                      size="icon-compact"
                      variant="ghost"
                      aria-label={t("gateway.groups.removeTitle")}
                      title={t("gateway.groups.removeTitle")}
                      onClick={() => setDeleting(group)}
                    >
                      <Trash2 data-icon="inline-start" aria-hidden />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {editing && (
        <GroupDialog
          catalog={catalog}
          group={editing.group}
          pending={save.isPending}
          error={save.isError ? describeError(save.error) : null}
          stale={editing.revision !== catalog.revision}
          onClose={() => setEditing(null)}
          onSave={(group) =>
            save.mutate(
              {
                ...catalog,
                revision: editing.revision,
                groups: editing.isNew
                  ? [...groups, group]
                  : groups.map((g) => (g.id === group.id ? group : g)),
              },
              { onSuccess: () => setEditing(null) },
            )
          }
        />
      )}
      <ConfirmDialog
        isOpen={!!deleting}
        title={t("gateway.groups.removeTitle")}
        message={t("gateway.groups.removeMessage", { name: deleting?.name })}
        pending={save.isPending}
        onCancel={() => setDeleting(null)}
        onConfirm={() =>
          deleting &&
          save.mutate(catalogWithoutGroup(catalog, deleting.id), {
            onSuccess: () => setDeleting(null),
          })
        }
      />
    </section>
  );
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

function GroupDialog({
  catalog,
  group,
  pending,
  error,
  stale,
  onClose,
  onSave,
}: {
  catalog: GatewayCatalog;
  group: GatewayRouteGroup;
  pending: boolean;
  error: string | null;
  stale: boolean;
  onClose: () => void;
  onSave: (group: GatewayRouteGroup) => void;
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
          <DialogTitle>{t("gateway.groups.edit")}</DialogTitle>
          <DialogDescription>
            {t("gateway.groups.editorHint")}
          </DialogDescription>
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
