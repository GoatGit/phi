import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { GatewayCatalog, GatewayRouteGroup } from "@/lib/api/gateway";
import { History, Trash2 } from "lucide-react";
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
import { Switch } from "@/components/ui/switch";
import { Notice } from "@/components/ui/notice";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
  createGroupDraft,
  GroupDialog,
  inferGroupApps,
  memberLabel,
} from "./GroupEditorDialog";
import {
  catalogWithoutGroup,
  useGatewayErrorMessage,
  useSaveGatewayCatalog,
} from "./useGatewayCatalog";

// 旧调用方（测试与外部页面）从这里取编辑器辅助函数。
export { inferGroupApps, memberLabel };

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
              group: createGroupDraft(),
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
            {groups.map((group) => {
              // 辅助策略只作低强调摘要，不再叠加成排徽标。
              const aux = [
                group.failover ? t("gateway.policy.failover") : null,
                group.sessionAffinity ? t("gateway.groups.affinity") : null,
                group.rules.some((r) => r.enabled)
                  ? t("gateway.groups.intent")
                  : null,
              ].filter(Boolean) as string[];
              const disabledCount = group.members.filter(
                (m) => !m.enabled,
              ).length;
              // 完整成员（含停用、权重）放悬浮提示；行内只保留摘要。
              const membersTitle = group.members
                .map(
                  (member) =>
                    memberLabel(member, catalog) +
                    (!member.enabled ? ` · ${t("gateway.groups.off")}` : "") +
                    (group.strategy === "weighted"
                      ? ` · ${t("gateway.groups.weight")} ${member.weight}`
                      : ""),
                )
                .join("\n");
              const shownMembers = group.members.slice(0, 3);
              const restMembers = group.members.length - shownMembers.length;
              return (
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
                    <span className="font-medium" title={group.name}>
                      {group.name}
                    </span>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col items-start gap-1">
                      <Badge variant="secondary">
                        {t(`gateway.groups.strategies.${group.strategy}`)}
                      </Badge>
                      {aux.length > 0 && (
                        <span className="whitespace-nowrap text-xs text-fg-3">
                          {aux.join(" · ")}
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="max-w-64">
                      {group.members.length ? (
                        <span
                          className="block truncate text-xs text-fg-2"
                          title={membersTitle}
                        >
                          {shownMembers
                            .map((member) => memberLabel(member, catalog))
                            .join(" · ")}
                          {restMembers > 0 ? ` +${restMembers}` : ""}
                        </span>
                      ) : (
                        <span className="text-xs text-fg-3">—</span>
                      )}
                      {disabledCount > 0 && (
                        <span className="block text-xs text-fg-3">
                          {t("gateway.groups.disabledMembers", {
                            count: disabledCount,
                          })}
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <Button
                        size="icon-compact"
                        variant="ghost"
                        aria-label={t("gateway.policy.viewRequests")}
                        title={t("gateway.policy.viewRequests")}
                        onClick={() => onOpenTraces(group.id)}
                      >
                        <History data-icon="inline-start" aria-hidden />
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
              );
            })}
          </TableBody>
        </Table>
      )}
      {editing && (
        <GroupDialog
          catalog={catalog}
          group={editing.group}
          isNew={editing.isNew}
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
