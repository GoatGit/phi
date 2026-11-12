import { useTranslation } from "react-i18next";
import {
  CircleAlert,
  CircleCheck,
  CircleSlash,
  CircleX,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import type { RelayRun, RelayView } from "@/lib/api/orchestration";
import { cn } from "@/lib/utils";

interface TaskRelayPanelProps {
  relay: RelayView;
  busy: boolean;
  onRunGate: (gate: 2 | 3) => void;
}

const STATUS: Record<string, { Icon: LucideIcon; className: string }> = {
  pass: { Icon: CircleCheck, className: "text-success-text" },
  fail: { Icon: CircleX, className: "text-danger-text" },
  invalid: { Icon: CircleSlash, className: "text-warning-text" },
};

function GateStatus({ status }: { status?: string }) {
  const { t } = useTranslation();
  if (!status) {
    return (
      <span className="text-caption text-fg-3">{t("tasks.relay.notRun")}</span>
    );
  }
  const style = STATUS[status];
  const label = t(`tasks.relay.status.${status}`, { defaultValue: status });
  if (!style) {
    return <span className="text-caption text-fg-1">{label}</span>;
  }
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-caption",
        style.className,
      )}
    >
      <style.Icon aria-hidden="true" className="size-3.5" strokeWidth={1.5} />
      {label}
    </span>
  );
}

function Line({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline gap-2">
      <span className="shrink-0 text-caption text-fg-3">{label}</span>
      <span className="min-w-0 flex-1 text-caption text-fg-1">{value}</span>
    </div>
  );
}

function Paths({ paths }: { paths: string[] }) {
  if (paths.length === 0) return <span className="text-fg-3">—</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {paths.map((path) => (
        <span
          key={path}
          className="rounded-[5px] bg-subtle px-1.5 py-0.5 font-mono text-[11px] text-fg-2"
        >
          {path}
        </span>
      ))}
    </span>
  );
}

/** 最近一次门判定的证据：命令、越界、锚点，够人一眼判断要不要放行。 */
function RunEvidence({ run }: { run: RelayRun }) {
  const { t } = useTranslation();
  const { evidence } = run;
  return (
    <div className="space-y-1.5">
      {evidence.steps.map((step, index) => (
        <div
          key={`${step.cmd}-${index}`}
          className="rounded-control border border-border px-2.5 py-1.5"
        >
          <div className="flex items-baseline gap-2">
            <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-1">
              {step.cmd}
            </code>
            <span
              className={cn(
                "shrink-0 text-[11px] tabular-nums",
                step.timedOut || step.exitCode !== step.expectExit
                  ? "text-danger-text"
                  : "text-fg-3",
              )}
            >
              {step.timedOut
                ? t("tasks.relay.timeout")
                : t("tasks.relay.exitCode", {
                    code: step.exitCode ?? "—",
                    expect: step.expectExit,
                  })}
            </span>
          </div>
          {step.outputTail ? (
            <pre className="m-0 mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-fg-3">
              {step.outputTail}
            </pre>
          ) : null}
        </div>
      ))}

      {evidence.violations.length > 0 ? (
        <div className="space-y-1">
          {evidence.violations.map((violation) => (
            <div
              key={`${violation.path}-${violation.rule}`}
              className="flex items-center gap-2 text-caption text-danger-text"
            >
              <CircleAlert
                aria-hidden="true"
                className="size-3.5 shrink-0"
                strokeWidth={1.5}
              />
              <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
                {violation.path}
              </span>
              <span className="shrink-0 text-[11px]">
                {t(`tasks.relay.rule.${violation.rule}`, {
                  defaultValue: violation.rule,
                })}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {evidence.claims.length > 0 ? (
        <div className="space-y-1">
          {evidence.claims.map((claim, index) => (
            <div
              key={`${claim.file}-${claim.line}-${index}`}
              className="flex items-baseline gap-2 text-[11px]"
            >
              <span className={claim.ok ? "text-fg-3" : "text-danger-text"}>
                {claim.ok ? "✓" : "✗"}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-fg-2">
                {claim.file}:{claim.line}
              </span>
              <span className="max-w-[45%] truncate text-fg-3">
                {claim.reason ?? claim.quote}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {evidence.note ? (
        <p className="m-0 text-caption text-fg-2">{evidence.note}</p>
      ) : null}
    </div>
  );
}

/**
 * 「编排接力」面板：卡片里的契约、最近的门结论、以及门判定的历史证据。
 *
 * 这里只展示与触发判定，不放行也不改状态：门通过了这张卡仍然由人决定去留。
 */
export function TaskRelayPanel({
  relay,
  busy,
  onRunGate,
}: TaskRelayPanelProps) {
  const { t } = useTranslation();
  const { contract, verdict, runs } = relay;
  const latest = runs[0] ?? null;
  // 契约解析和基线核对都会报同一件事（比如基线解析不了），去个重，
  // 否则同一条警告叠两遍、React 的 key 还会撞车
  const warnings = [...new Set([...contract.warnings, ...relay.warnings])];

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <h3 className="m-0 text-body font-medium text-fg-1">
          {t("tasks.relay.title")}
        </h3>
        <div className="flex-1" />
        <Button
          variant="outline"
          size="compact"
          disabled={busy || contract.accept.length === 0}
          title={
            contract.accept.length === 0
              ? t("tasks.relay.noAccept")
              : t("tasks.relay.runGate2Hint")
          }
          onClick={() => onRunGate(2)}
        >
          {t("tasks.relay.runGate2")}
        </Button>
        <Button
          variant="outline"
          size="compact"
          disabled={busy}
          title={t("tasks.relay.runGate3Hint")}
          onClick={() => onRunGate(3)}
        >
          {t("tasks.relay.runGate3")}
        </Button>
      </div>

      {!contract.ready ? (
        <p className="m-0 text-caption text-fg-3">
          {t("tasks.relay.noContract")}
        </p>
      ) : null}

      <div className="space-y-1.5">
        <Line
          label={t("tasks.relay.gate2")}
          value={<GateStatus status={verdict.gate2} />}
        />
        <Line
          label={t("tasks.relay.gate3")}
          value={<GateStatus status={verdict.gate3} />}
        />
        {verdict.at ? (
          <Line
            label={t("tasks.relay.verdictAt")}
            value={
              <span className="tabular-nums text-fg-2">
                {verdict.at}
                {verdict.base ? ` · ${verdict.base}` : ""}
              </span>
            }
          />
        ) : null}
        {contract.role ? (
          <Line
            label={t("tasks.relay.role")}
            value={
              <span className="font-mono text-[11px]">{contract.role}</span>
            }
          />
        ) : null}
        <Line
          label={t("tasks.relay.touched")}
          value={<Paths paths={contract.touched} />}
        />
        <Line
          label={t("tasks.relay.forbidden")}
          value={<Paths paths={contract.forbidden} />}
        />
        <Line
          label={t("tasks.relay.changed")}
          value={t("tasks.relay.changedCount", {
            value: relay.changed.length,
          })}
        />
        <Line
          label={t("tasks.relay.claims")}
          value={t("tasks.relay.claimCount", {
            value: relay.reviewClaims,
          })}
        />
        {contract.maxMinutes || contract.maxTokens ? (
          <Line
            label={t("tasks.relay.budget")}
            value={[
              contract.maxTokens
                ? t("tasks.relay.tokens", { value: contract.maxTokens })
                : null,
              contract.maxMinutes
                ? t("tasks.relay.minutes", { value: contract.maxMinutes })
                : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          />
        ) : null}
      </div>

      {contract.accept.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {contract.accept.map((step, index) => (
            <li
              key={`${step.cmd}-${index}`}
              className="flex items-baseline gap-2 text-[11px]"
            >
              <span className="shrink-0 text-fg-3">
                {t("tasks.relay.accept")}
              </span>
              <code className="min-w-0 flex-1 truncate font-mono text-fg-2">
                {step.cmd}
              </code>
              {step.expectExit !== 0 ? (
                <span className="shrink-0 tabular-nums text-fg-3">
                  ≠ {step.expectExit}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {warnings.map((warning) => (
        <Notice key={warning} tone="warning" title={warning} />
      ))}

      {latest ? (
        <div className="space-y-2">
          <h4 className="m-0 text-caption font-medium text-fg-2">
            {t("tasks.relay.latest", {
              gate: latest.gate,
              ms: latest.durationMs,
            })}
          </h4>
          <RunEvidence run={latest} />
        </div>
      ) : (
        <p className="m-0 text-caption text-fg-3">
          {t("tasks.relay.emptyHistory")}
        </p>
      )}
    </section>
  );
}
