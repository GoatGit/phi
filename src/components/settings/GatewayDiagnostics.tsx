import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldLabel } from "@/components/ui/field";
import { Badge } from "@/components/ui/badge";
import { Notice } from "@/components/ui/notice";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { SettingsBlock } from "./SettingsLayout";

interface DiagnosticCheck {
  id: string;
  subject: string;
  state: "ok" | "info" | "warning" | "error";
  code: string;
  latencyMs: number | null;
}
interface DiagnosticReport {
  checkedAt: number;
  checks: DiagnosticCheck[];
}

export function GatewayDiagnostics() {
  const { t } = useTranslation();
  const [upstreams, setUpstreams] = useState(false);
  const [copyError, setCopyError] = useState("");
  const query = useQuery({
    queryKey: ["gateway-diagnostics"],
    enabled: false,
    retry: false,
    queryFn: async () => {
      const [gateway, adapters] = await Promise.all([
        invoke<DiagnosticReport>("diagnose_gateway", {
          includeUpstreams: upstreams,
        }),
        invoke<DiagnosticReport>("diagnose_adapters"),
      ]);
      return {
        checkedAt: gateway.checkedAt,
        checks: [...gateway.checks, ...adapters.checks],
      };
    },
  });
  return (
    <SettingsBlock title={t("diagnostics.title")}>
      <div className="flex flex-col gap-4">
        <p>{t("diagnostics.hint")}</p>
        <Field orientation="horizontal">
          <Checkbox
            id="diagnostic-upstreams"
            checked={upstreams}
            disabled={query.isFetching}
            onCheckedChange={(value) => setUpstreams(value === true)}
          />
          <FieldLabel htmlFor="diagnostic-upstreams">
            {t("diagnostics.upstreams")}
          </FieldLabel>
        </Field>
        <div className="flex gap-2">
          <Button
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            {t(query.isFetching ? "diagnostics.running" : "diagnostics.run")}
          </Button>
          {query.data && (
            <Button
              variant="outline"
              onClick={() => {
                setCopyError("");
                void navigator.clipboard
                  .writeText(JSON.stringify(query.data, null, 2))
                  .catch(() => setCopyError(t("diagnostics.copyFailed")));
              }}
            >
              {t("diagnostics.copy")}
            </Button>
          )}
        </div>
        {(query.error || copyError) && (
          <Notice tone="danger" title={copyError || String(query.error)} />
        )}
        {query.data && (
          <>
            <p>
              {new Date(query.data.checkedAt).toLocaleString()} ·{" "}
              {t("diagnostics.reportHint")}
            </p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("diagnostics.subject")}</TableHead>
                  <TableHead>{t("diagnostics.result")}</TableHead>
                  <TableHead>{t("diagnostics.latency")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {query.data.checks.map((check, index) => (
                  <TableRow key={`${check.id}-${index}`}>
                    <TableCell className="max-w-80 break-all">
                      {check.subject}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          check.state === "error" ? "destructive" : "secondary"
                        }
                      >
                        {t(`diagnostics.states.${check.state}`)}
                      </Badge>{" "}
                      {t(`diagnostics.codes.${check.code}`, {
                        defaultValue: check.code,
                      })}
                    </TableCell>
                    <TableCell>
                      {check.latencyMs === null ? "—" : `${check.latencyMs} ms`}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </>
        )}
      </div>
    </SettingsBlock>
  );
}
