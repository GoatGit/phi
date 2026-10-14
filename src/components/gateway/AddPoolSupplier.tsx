import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AddProviderDialog } from "@/components/providers/AddProviderDialog";
import { gatewayApi, type GatewayCatalog } from "@/lib/api";
import type { ProxyAppId } from "@/config/appConfig";
import { gatewayCatalogKey, useGatewayErrorMessage } from "./useGatewayCatalog";
import { supplierTemplates } from "./supplierTemplates";

/** The existing template picker/form, with a pool-only persistence boundary. */
export function AddPoolSupplier({
  revision,
  onClose,
}: {
  revision: number;
  onClose: () => void;
}) {
  const [{ appId, presetId }, setTemplate] = useState<{
    appId: ProxyAppId;
    presetId?: string;
  }>({ appId: "claude" });
  const qc = useQueryClient();
  const describeError = useGatewayErrorMessage();
  const save = async (request: Promise<GatewayCatalog>) => {
    try {
      qc.setQueryData(gatewayCatalogKey, await request);
    } catch (error) {
      void qc.invalidateQueries({ queryKey: gatewayCatalogKey });
      throw new Error(describeError(error));
    }
  };
  return (
    <AddProviderDialog
      key={appId}
      open
      appId={appId}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      onSubmit={(provider) =>
        save(gatewayApi.createFromTemplate(appId, provider, revision))
      }
      resourcePool={{
        templateCatalog: {
          entries: supplierTemplates,
          selectedPresetId: presetId,
          onSelect: (id) => {
            const template = supplierTemplates.find((entry) => entry.id === id);
            if (id === "custom" || template) {
              setTemplate({ appId: template?.appId ?? "claude", presetId: id });
            }
          },
        },
        onSaveUniversal: (provider) =>
          save(gatewayApi.createFromUniversal(provider, revision)),
      }}
    />
  );
}
