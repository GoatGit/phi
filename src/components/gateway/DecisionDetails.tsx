import { useTranslation } from "react-i18next";
import type { GatewayRouteDecision } from "@/lib/api/gateway";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";

export function DecisionDetails({
  decision,
}: {
  decision: GatewayRouteDecision;
}) {
  const { t } = useTranslation();
  const name = (id: string) =>
    decision.groups.find((g) => g.id === id)?.name ?? id;
  return (
    <div className="flex flex-col gap-4 text-sm">
      <p>
        {t("gateway.decisions.affinity")} ·{" "}
        {t(`gateway.decisions.affinityStates.${decision.affinity}`, {
          defaultValue: decision.affinity,
        })}
      </p>
      {!!decision.intents.length && (
        <section
          className="flex flex-col gap-2"
          aria-label={t("gateway.groups.intent")}
        >
          <h3 className="font-medium">{t("gateway.groups.intent")}</h3>
          {decision.intents.map((intent, index) => (
            <div
              key={`${intent.groupId}-${index}`}
              className="rounded-md border p-3 flex flex-col gap-1"
            >
              <div className="flex flex-wrap gap-2 items-center">
                <span>{name(intent.groupId)}</span>
                <Badge variant="secondary">
                  {t(`gateway.decisions.intentOutcomes.${intent.outcome}`, {
                    defaultValue: intent.outcome,
                  })}
                </Badge>
                {intent.cached && (
                  <Badge variant="outline">
                    {t("gateway.decisions.cached")}
                  </Badge>
                )}
              </div>
              {intent.ruleName && <p>{intent.ruleName}</p>}
              <p className="font-mono text-xs text-fg-2 break-all">
                {intent.model} ·{" "}
                {intent.outcome === "pending" ? "—" : intent.latencyMs} ms ·{" "}
                {intent.inputTokens ?? "?"} / {intent.outputTokens ?? "?"}{" "}
                tokens ·{" "}
                {intent.estimatedCost == null
                  ? t("gateway.trace.unknownUsage")
                  : `$${intent.estimatedCost}`}
              </p>
            </div>
          ))}
        </section>
      )}
      <section
        className="flex flex-col gap-2"
        aria-label={t("gateway.decisions.candidates")}
      >
        <h3 className="font-medium">{t("gateway.decisions.candidates")}</h3>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("gateway.trace.route")}</TableHead>
              <TableHead>{t("gateway.decisions.reason")}</TableHead>
              <TableHead>{t("gateway.decisions.load")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {decision.candidates.map((c, i) => (
              <TableRow key={`${c.supplierId}-${c.model}-${i}`}>
                <TableCell className="max-w-80 break-words">
                  <span className="text-xs text-fg-2">
                    {i + 1}. {c.groupPath.map(name).join(" → ")}
                  </span>
                  <span className="block">
                    {c.supplierName || c.supplierId} → {c.model}
                  </span>
                </TableCell>
                <TableCell>
                  <span>
                    {t(`gateway.decisions.reasons.${c.reason}`, {
                      defaultValue: c.reason,
                    })}
                  </span>
                  {!c.available && (
                    <Badge className="ms-2" variant="outline">
                      {t("gateway.decisions.skipped")}
                    </Badge>
                  )}
                  {c.cooldownUntil && (
                    <span className="block text-xs text-fg-3">
                      {new Date(c.cooldownUntil).toLocaleString()}
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-xs tabular-nums">
                  {t("gateway.decisions.loadValue", {
                    tokens: Math.round(c.recentTokens),
                    active: c.active,
                  })}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {!decision.candidates.length && (
          <p className="text-fg-2">{t("gateway.decisions.noCandidates")}</p>
        )}
      </section>
    </div>
  );
}
