import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { gatewayApi, type GatewayCatalog } from "@/lib/api";
import { getAppLabel } from "@/config/appConfig";
import { ChevronDown } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DecisionDetails } from "./DecisionDetails";
import { Notice } from "@/components/ui/notice";
import { GATEWAY_APPS, useGatewayErrorMessage } from "./useGatewayCatalog";

export function RoutePreview({ catalog }: { catalog: GatewayCatalog }) {
  const { t } = useTranslation();
  const describeError = useGatewayErrorMessage();
  const [app, setApp] = useState("claude");
  const [model, setModel] = useState("");
  const [request, setRequest] = useState<{ app: string; model: string } | null>(
    null,
  );
  const preview = useQuery({
    queryKey: ["gateway", "preview", catalog.revision, request],
    queryFn: () => gatewayApi.previewRoute(request!.app, request!.model),
    enabled: request !== null,
  });
  const result = preview.data;
  return (
    <Collapsible className="rounded-lg border px-4">
      <CollapsibleTrigger asChild>
        <Button variant="ghost" className="group w-full justify-between px-0">
          {t("gateway.preview.title")}
          <ChevronDown
            data-icon="inline-end"
            className="transition-transform group-data-[state=open]:rotate-180"
            aria-hidden
          />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-3 pb-4">
        <p className="text-sm text-muted-foreground">
          {t("gateway.preview.description")}
        </p>
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setRequest({ app, model: model.trim() });
            if (request?.app === app && request.model === model.trim())
              void preview.refetch();
          }}
        >
          <Select value={app} onValueChange={setApp}>
            <SelectTrigger className="w-40" aria-label={t("gateway.agent")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {GATEWAY_APPS.map((id) => (
                  <SelectItem key={id} value={id}>
                    {getAppLabel(id)}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Input
            className="min-w-48 flex-1"
            aria-label={t("gateway.preview.model")}
            placeholder={t("gateway.preview.model")}
            value={model}
            onChange={(event) => setModel(event.target.value)}
          />
          <Button
            type="submit"
            variant="outline"
            disabled={preview.isFetching || !model.trim()}
          >
            {preview.isFetching
              ? t("gateway.loading")
              : t("gateway.preview.run")}
          </Button>
        </form>
        {preview.isError && (
          <Notice tone="danger" title={describeError(preview.error)} />
        )}
        {result && (
          <div role="status" className="flex flex-col gap-1 text-sm">
            <span>
              {getAppLabel(request!.app)} · {request!.model} ·{" "}
              {t("gateway.preview.revision", { revision: result.revision })}
            </span>
            <span>
              {t(`gateway.preview.${result.reason}`)}
              {result.policy && ` · ${result.policy.name}`}
            </span>
            {result.decision && <DecisionDetails decision={result.decision} />}
            {!result.decision &&
              result.policy?.candidates.map((candidate, index) => (
                <span key={candidate.supplierId}>
                  {index + 1}.{" "}
                  {catalog.suppliers.find(
                    (supplier) => supplier.id === candidate.supplierId,
                  )?.name ?? candidate.supplierId}{" "}
                  → {candidate.model}
                </span>
              ))}
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
