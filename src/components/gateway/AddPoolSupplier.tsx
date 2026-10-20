import { useState } from "react";
import { subscriptionFromTemplate } from "./subscriptionTemplates";
import { SubscriptionSupplierDialog } from "./SubscriptionSupplierDialog";
import { useQueryClient } from "@tanstack/react-query";
import { AddProviderDialog } from "@/components/providers/AddProviderDialog";
import { gatewayApi, type GatewayCatalog } from "@/lib/api";
import type { ProxyAppId } from "@/config/appConfig";
import { gatewayCatalogKey, useGatewayErrorMessage } from "./useGatewayCatalog";
import { SYSTEM_ONE_TEMPLATE_ID, supplierTemplates } from "./supplierTemplates";
import {
  SupplierEditorDialog,
  type SupplierEditorInitial,
} from "./SupplierEditorDialog";

/** TypeSafe 的 System One 决策协议出口；没有应用模板，直接进资源池编辑器。 */
const SYSTEM_ONE_INITIAL: SupplierEditorInitial = {
  name: "TypeSafe System One",
  protocol: "systemone",
  baseUrl: "https://api.typesafe.ai",
  models: ["jev-latest"],
  authField: "TYPESAFE_API_KEY",
};

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
  const subscription = subscriptionFromTemplate(presetId);
  if (subscription) {
    return (
      <SubscriptionSupplierDialog
        key={subscription.id}
        subscription={subscription}
        revision={revision}
        onClose={onClose}
        onBack={() => setTemplate({ appId: "claude" })}
      />
    );
  }
  // System One 没有应用表单：选中后直接打开资源池供应商编辑器。
  if (presetId === SYSTEM_ONE_TEMPLATE_ID) {
    return (
      <SupplierEditorDialog
        open
        supplier={null}
        revision={revision}
        initial={SYSTEM_ONE_INITIAL}
        onClose={onClose}
      />
    );
  }
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
