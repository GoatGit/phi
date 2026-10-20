import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { gatewayApi } from "@/lib/api";
import { useGatewayCatalog } from "@/components/gateway/useGatewayCatalog";
import {
  buildSidebarApps,
  type SidebarAppEntry,
} from "@/components/shell/sidebarApps";

/** 侧栏自己的轨迹缓存：只读最近 100 条，不和路由页的分页查询抢缓存。 */
export const sidebarTracesKey = ["gateway", "sidebar-traces"] as const;

/**
 * 侧栏应用列表：只列用户自己添加进侧栏的应用，按“进行中 → 最近有流量 →
 * 已接入路由组 → 其余”排序。轨迹 15 秒刷新一次，侧栏常驻也不会打重查询。
 */
export function useSidebarApps(appIds: readonly string[]): SidebarAppEntry[] {
  const { data: catalog } = useGatewayCatalog();
  const { data: traces } = useQuery({
    queryKey: sidebarTracesKey,
    queryFn: () => gatewayApi.getTraces(),
    refetchInterval: 15_000,
    staleTime: 5_000,
  });
  return useMemo(
    () => buildSidebarApps({ appIds, catalog, traces }),
    [appIds, catalog, traces],
  );
}
