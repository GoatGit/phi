import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { KeyRound, Plus } from "lucide-react";
import { accessApi, type AccessBinding } from "@/lib/api/access";
import { useGatewayCatalog } from "./useGatewayCatalog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Notice } from "@/components/ui/notice";
import { cn } from "@/lib/utils";
import {
  AccessDeleteDialog,
  AccessKeyDialog,
  EXTERNAL_TOOL,
  IssuedTokenDialog,
  freshBinding,
} from "./AccessKeyDialog";

const WEEK_MS = 7 * 86_400_000;
const isExternal = (binding: AccessBinding) => binding.tool === EXTERNAL_TOOL;

function formatTokens(value: number | undefined): string {
  if (!value) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

function formatCost(value: string | undefined): string {
  const amount = Number(value ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) return "$0";
  if (amount < 0.01) return "<$0.01";
  return `$${amount.toFixed(2)}`;
}

/**
 * 三方应用：给 PHI 不写配置的客户端（Cursor、Cline、脚本）使用。
 *
 * 每个三方应用就是一枚接入令牌，相当于一个独立应用，用量按它分开统计。应用
 * 自己的接入由 PHI 自动写进客户端配置，不在这里暴露。
 */
export function AccessBindings() {
  return <ExternalKeyManager />;
}

function ExternalKeyManager() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [draft, setDraft] = useState<AccessBinding | null>(null);
  const [issued, setIssued] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<AccessBinding | null>(null);
  const [usageSince] = useState(() => Date.now() - WEEK_MS);

  const bindings = useQuery({
    queryKey: ["access-bindings"],
    queryFn: accessApi.bindings,
  });
  const catalog = useGatewayCatalog();
  const usage = useQuery({
    queryKey: ["access-binding-usage", usageSince],
    queryFn: () => accessApi.usage(usageSince, Date.now()),
    refetchInterval: 30_000,
  });

  const keys = useMemo(
    () =>
      (bindings.data ?? [])
        .filter(isExternal)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [bindings.data],
  );
  const enabled = useMutation({
    mutationFn: ({ id, value }: { id: string; value: boolean }) =>
      accessApi.enabled(id, value),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: ["access-bindings"] }),
  });

  const openCreate = () => {
    setDraft(freshBinding(keys.length === 0 ? "PHI" : ""));
  };

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="m-0 flex items-center gap-1.5 text-base font-medium text-fg-1">
            <KeyRound className="h-4 w-4 text-fg-2" aria-hidden />
            {t("access.title")}
          </h2>
          <p className="m-0 text-caption text-fg-2">
            {t("access.description")}
          </p>
        </div>
        <Button variant="neutral" size="regular" onClick={openCreate}>
          <Plus className="h-4 w-4" aria-hidden />
          {t("access.create")}
        </Button>
      </div>

      {(bindings.error || usage.error) && (
        <Notice tone="danger" title={String(bindings.error ?? usage.error)} />
      )}

      <p className="m-0 text-caption text-fg-3">{t("access.boundary")}</p>

      {keys.length === 0 && bindings.isSuccess ? (
        <div className="rounded-panel border border-dashed border-border px-4 py-4">
          <p className="m-0 text-body text-fg-2">{t("access.empty")}</p>
        </div>
      ) : (
        <ul className="m-0 flex list-none flex-col divide-y divide-border overflow-hidden rounded-panel border border-border">
          {keys.map((binding) => {
            const totals = usage.data?.[binding.id];
            return (
              <li
                key={binding.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3"
              >
                <div className="flex min-w-[140px] flex-1 flex-col gap-0.5">
                  <span className="flex items-center gap-2 text-body font-medium text-fg-1">
                    {binding.name}
                    <span className="rounded-[4px] bg-subtle px-1.5 text-badge font-normal text-fg-2">
                      {t("access.externalBadge")}
                    </span>
                  </span>
                  <span className="text-caption text-fg-2">
                    {binding.agent}
                    {" · "}
                    {binding.allowedGroups.length
                      ? binding.allowedGroups
                          .map(
                            (id) =>
                              catalog.data?.groups?.find((g) => g.id === id)
                                ?.name ?? id,
                          )
                          .join(" · ")
                      : t("access.allGroups")}
                  </span>
                </div>
                <div className="flex min-w-[150px] flex-col items-end gap-0.5 text-end">
                  <span className="text-caption text-fg-3">
                    {t("access.keyUsage")}
                  </span>
                  <span
                    className={cn(
                      "text-body tabular-nums",
                      totals?.requests ? "text-fg-1" : "text-fg-3",
                    )}
                  >
                    {totals?.requests
                      ? `${formatTokens(totals.tokens)} tokens · ${formatCost(totals.cost)}`
                      : t("access.keyUsageEmpty")}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setDraft({ ...binding });
                    }}
                  >
                    {t("access.rotate")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-danger"
                    disabled={enabled.isPending}
                    onClick={() => {
                      setDeleting(binding);
                    }}
                  >
                    {t("access.delete")}
                  </Button>
                  <Switch
                    aria-label={t("access.enabled", { name: binding.name })}
                    checked={binding.enabled}
                    disabled={enabled.isPending}
                    onCheckedChange={(value) =>
                      enabled.mutate({ id: binding.id, value })
                    }
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <AccessKeyDialog
        draft={draft}
        onChange={setDraft}
        onClose={() => setDraft(null)}
        onIssued={(token) => {
          setDraft(null);
          setIssued(token);
        }}
      />

      <AccessDeleteDialog
        binding={deleting}
        onClose={() => setDeleting(null)}
      />

      <IssuedTokenDialog token={issued} onClose={() => setIssued(null)} />
    </section>
  );
}
