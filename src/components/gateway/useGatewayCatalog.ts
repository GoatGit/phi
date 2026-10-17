import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { PROXY_APP_IDS } from "@/config/appConfig";
import { gatewayApi, type GatewayCatalog } from "@/lib/api";

/** 目录只有一个整体，revision 是乐观锁：读改写都基于同一份缓存。 */
export const gatewayCatalogKey = ["gateway", "catalog"] as const;

export function useGatewayCatalog() {
  return useQuery({
    queryKey: gatewayCatalogKey,
    queryFn: () => gatewayApi.getCatalog(),
  });
}

/** 保存目录：成功后用后端返回的新 revision 覆盖缓存。 */
export function useSaveGatewayCatalog() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (catalog: GatewayCatalog) => gatewayApi.saveCatalog(catalog),
    onSuccess: (saved) => {
      qc.setQueryData(gatewayCatalogKey, saved);
    },
    onError: () => {
      void qc.invalidateQueries({ queryKey: gatewayCatalogKey });
    },
  });
}

/** 后端错误串形如 `gateway.staleRevision`（i18n key），这里取出 key 交给 t()。 */
export function extractGatewayErrorKey(message: string): string | null {
  const match = /gateway\.[A-Za-z]+/.exec(message);
  return match ? match[0] : null;
}

export function useGatewayErrorMessage() {
  const { t } = useTranslation();
  return (error: unknown): string => {
    const raw = error instanceof Error ? error.message : String(error);
    const key = extractGatewayErrorKey(raw);
    if (key) {
      const short = key.replace("gateway.", "");
      const translated = t(`gateway.errors.${short}`);
      if (translated !== `gateway.errors.${short}`) return translated;
    }
    return t("gateway.errors.generic", { detail: raw });
  };
}

/**
 * 与后端 gateway::compatible() 对齐：策略所在应用接受哪些供应商协议。
 * 编辑器里用于过滤候选供应商；后端保存时仍会最终校验。
 */
export function protocolCompatibleWith(app: string, protocol: string): boolean {
  const allowed: Record<string, string[]> = {
    claude: ["anthropic", "openai_chat", "openai_responses", "gemini_native"],
    codex: ["anthropic", "openai_chat", "openai_responses"],
    gemini: ["gemini_native"],
    grokbuild: ["anthropic", "openai_chat", "openai_responses"],
  };
  return allowed[app]?.includes(protocol) ?? false;
}

/**
 * 与后端 gateway::direct_protocol_for 对齐：每个应用能直接消费的本地协议。
 * 转换类协议只能走本地路由，路由页据此禁用不可直连的池内供应商。
 */
export function supplierDirectCompatible(
  app: string,
  protocol: string,
): boolean {
  const native: Record<string, string> = {
    claude: "anthropic",
    codex: "openai_responses",
    grokbuild: "openai_responses",
    gemini: "gemini_native",
  };
  return native[app] === protocol;
}

/** Deletion can empty an ancestor too; disable it until the user repairs it. */
export function disableEmptyGroups(catalog: GatewayCatalog): GatewayCatalog {
  const groups = catalog.groups?.map((g) => ({ ...g }));
  if (!groups) return catalog;
  let changed = true;
  while (changed) {
    changed = false;
    for (const group of groups) {
      if (
        group.enabled &&
        !group.members.some(
          (m) =>
            m.enabled &&
            (group.strategy !== "manual" || group.manualMemberId === m.id) &&
            (m.groupId
              ? groups.some((g) => g.id === m.groupId && g.enabled)
              : !!m.supplierId),
        )
      ) {
        group.enabled = false;
        changed = true;
      }
    }
  }
  return { ...catalog, groups };
}

/** 从目录中移除供应商：同时摘除策略里引用它的候选；候选清空则停用策略。 */
export function catalogWithoutSupplier(
  catalog: GatewayCatalog,
  supplierId: string,
): GatewayCatalog {
  const groups = catalog.groups?.map((group) => {
    const removed = new Set(
      group.members.filter((m) => m.supplierId === supplierId).map((m) => m.id),
    );
    const members = group.members.filter((m) => !removed.has(m.id));
    const classifierRemoved = group.classifier?.supplierId === supplierId;
    return {
      ...group,
      members,
      classifier: classifierRemoved ? null : group.classifier,
      rules: group.rules
        .filter((r) => !removed.has(r.memberId))
        .map((r) => (classifierRemoved ? { ...r, enabled: false } : r)),
      enabled:
        group.enabled &&
        members.some((m) => m.enabled) &&
        !(
          group.strategy === "manual" && removed.has(group.manualMemberId ?? "")
        ),
      manualMemberId: removed.has(group.manualMemberId ?? "")
        ? null
        : group.manualMemberId,
    };
  });
  return disableEmptyGroups({
    ...catalog,
    ...(groups ? { groups } : {}),
    suppliers: catalog.suppliers.filter((s) => s.id !== supplierId),
    policies: catalog.policies.map((policy) => {
      const candidates = policy.candidates.filter(
        (c) => c.supplierId !== supplierId,
      );
      if (policy.groupId || candidates.length === policy.candidates.length)
        return policy;
      return {
        ...policy,
        candidates,
        enabled: policy.enabled && candidates.length > 0,
      };
    }),
  });
}

/** 固定的网关应用清单，供路由组、策略与请求筛选使用。 */
export const GATEWAY_APPS = PROXY_APP_IDS;
