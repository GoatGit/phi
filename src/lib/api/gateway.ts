import { invoke } from "@tauri-apps/api/core";
import type { Provider, UniversalProvider } from "@/types";

/** 旧资源池供应商的迁移来源（运行时不回读应用配置）。 */
export interface GatewayCredentialRef {
  appId: string;
  providerId: string;
}

/** 供应商在网关侧的对外端点。protocol 与凭证鉴权方式绑定。 */
export interface GatewayEndpoint {
  protocol: string;
  baseUrl: string;
}

/**
 * 网关资源池供应商：统一池化的路由出口，不随应用切换生效。
 * 新建供应商直接保存到资源池；旧数据可携带 credential 迁移来源。
 * 密钥保存在独立密钥表，目录 DTO 不携带。
 */
export interface GatewaySupplier {
  id: string;
  name: string;
  /** 迁移来源，仅供展示与导入去重；直建供应商没有该字段。 */
  credential?: GatewayCredentialRef | null;
  endpoint: GatewayEndpoint;
  models: string[];
}

/** 新建/编辑资源池供应商的输入；apiKey/authField 只写入密钥表，不进入目录。 */
export interface GatewaySupplierUpsert {
  revision?: number;
  name?: string;
  endpoint?: GatewayEndpoint;
  models?: string[];
  apiKey?: string;
  authField?: string;
}

/** 策略候选：路由到某个资源池供应商，可改写请求模型名。 */
export interface GatewayRouteCandidate {
  supplierId: string;
  model: string;
}

/**
 * 路由策略。matchModel 为空表示 catch-all；
 * 同应用内按 priority 升序取第一个命中的启用策略（数字小者优先）。
 */
export interface GatewayRoutePolicy {
  id: string;
  name: string;
  appId: string;
  enabled: boolean;
  matchModel: string;
  priority: number;
  failover: boolean;
  candidates: GatewayRouteCandidate[];
  groupId?: string | null;
}

/** 资源池 + 策略的整份目录，revision 做乐观锁。 */
export interface GatewayCatalog {
  revision: number;
  suppliers: GatewaySupplier[];
  policies: GatewayRoutePolicy[];
  groups?: GatewayRouteGroup[];
}

/** Reserved catch-all record for the group selected in Application connections. */
export const appConnectionId = (appId: string) => `connection/${appId}`;

export function appRouteGroup(catalog: GatewayCatalog, appId: string) {
  const connection = catalog.policies.find(
    (p) => p.id === appConnectionId(appId) && p.appId === appId,
  );
  if (connection) return connection.groupId ?? null;
  // Keep existing pool connections readable until the user chooses a group.
  const legacy = catalog.policies
    .filter((p) => p.enabled && p.appId === appId)
    .sort(
      (a, b) =>
        a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )[0];
  if (legacy) return legacy.groupId ?? null;
  return (
    (catalog.groups ?? [])
      .filter((g) => g.enabled && g.appIds.includes(appId))
      .sort((a, b) => (a.id < b.id ? -1 : 1))[0]?.id ?? null
  );
}

/** 轨迹事件：一次请求经过的供应商与结果。 */
export interface GatewayTraceEvent {
  supplierName?: string;
  supplierId: string;
  model: string;
  outcome: string;
  groupPath?: string[];
  startedAt?: number;
  latencyMs?: number;
}

/** 请求轨迹：只含策略结构与固定错误类别，不含上游响应体与密钥。 */
export interface GatewayRequestTrace {
  id: string;
  createdAt: number;
  appId: string;
  requestModel?: string;
  catalogRevision: number;
  policy: GatewayRoutePolicy;
  events: GatewayTraceEvent[];
  outcome: string;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCost: string | null;
  decision?: GatewayRouteDecision | null;
}

export interface GatewayRoutePreview {
  revision: number;
  policy: GatewayRoutePolicy | null;
  reason: "model_match" | "catch_all" | "no_match" | "group";
  decision?: GatewayRouteDecision | null;
}

export type GatewayStrategy =
  | "ordered"
  | "round_robin"
  | "least_used"
  | "weighted"
  | "manual";
export interface GatewayGroupMember {
  id: string;
  supplierId?: string | null;
  model: string;
  groupId?: string | null;
  enabled: boolean;
  weight: number;
}
export interface GatewayIntentRule {
  id: string;
  name: string;
  description: string;
  memberId: string;
  enabled: boolean;
}
export interface GatewayRouteGroup {
  id: string;
  name: string;
  enabled: boolean;
  appIds: string[];
  strategy: GatewayStrategy;
  members: GatewayGroupMember[];
  manualMemberId?: string | null;
  sessionAffinity: boolean;
  affinityTtlSeconds: number;
  failover: boolean;
  maxAttempts: number;
  classifier?: { supplierId: string; model: string } | null;
  rules: GatewayIntentRule[];
}
export interface GatewayCandidateDecision {
  supplierId: string;
  supplierName: string;
  model: string;
  groupPath: string[];
  memberPath: string[];
  reason: string;
  available: boolean;
  recentTokens: number;
  active: number;
  cooldownUntil: number | null;
}
export interface GatewayIntentDecision {
  groupId: string;
  outcome: string;
  ruleId: string | null;
  ruleName: string | null;
  supplierId: string;
  model: string;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCost: string | null;
  cached: boolean;
}
export interface GatewayRouteDecision {
  reason: string;
  groupId: string | null;
  groups: GatewayRouteGroup[];
  candidates: GatewayCandidateDecision[];
  intents: GatewayIntentDecision[];
  affinity: string;
}
export interface GatewayMemberStatus {
  supplierId: string;
  model: string;
  active: number;
  requests: number;
  successes: number;
  failures: number;
  recentTokens: number;
  unknownUsage: number;
  cooldownUntil: number | null;
  lastError: string | null;
  lastLatencyMs: number | null;
  lastUsedAt: number | null;
}
export interface GatewayTraceQuery {
  since?: number;
  appId?: string;
  groupId?: string;
  policyId?: string;
  outcome?: string;
  offset?: number;
}
export interface GatewayRoutingSummary {
  requests: number;
  completed: number;
  failed: number;
  interrupted: number;
  failovers: number;
  inputTokens: number;
  outputTokens: number;
  unknownUsage: number;
  estimatedCost: string;
  unknownCost: number;
  classifierCalls: number;
  classifierCost: string;
  classifierUnknownCost: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
}
export interface GatewayTracePage {
  traces: GatewayRequestTrace[];
  total: number;
  summary: GatewayRoutingSummary;
  retainedSince: number | null;
  members: GatewayMemberStatus[];
  active: GatewayRequestTrace[];
}

export const gatewayApi = {
  async getTracePage(query: GatewayTraceQuery): Promise<GatewayTracePage> {
    return invoke("get_gateway_trace_page", { query });
  },
  tracePage(query: GatewayTraceQuery = {}): Promise<GatewayTracePage> {
    return invoke("get_gateway_trace_page", { query });
  },
  async createFromTemplate(
    appId: string,
    provider: Omit<Provider, "id">,
    revision: number,
  ): Promise<GatewayCatalog> {
    return invoke("create_gateway_supplier_from_template", {
      appId,
      provider: { ...provider, id: "gateway-template" },
      revision,
    });
  },
  async createFromUniversal(
    provider: UniversalProvider,
    revision: number,
  ): Promise<GatewayCatalog> {
    return invoke("create_gateway_suppliers_from_universal", {
      provider,
      revision,
    });
  },
  async fetchModels(supplierId: string): Promise<string[]> {
    return invoke("fetch_gateway_models", { supplierId });
  },
  async previewRoute(
    appId: string,
    model: string,
  ): Promise<GatewayRoutePreview> {
    return invoke("preview_gateway_route", { appId, model });
  },
  async connectApp(
    appId: string,
    groupId?: string,
    revision?: number,
  ): Promise<void> {
    return invoke("connect_gateway_app", { appId, groupId, revision });
  },
  /** 读取整份网关目录（资源池 + 策略）。 */
  async getCatalog(): Promise<GatewayCatalog> {
    return invoke("get_gateway_catalog");
  },

  /** 保存整份目录。catalog.revision 必须等于当前值，否则报 staleRevision。 */
  async saveCatalog(catalog: GatewayCatalog): Promise<GatewayCatalog> {
    return invoke("save_gateway_catalog", { catalog });
  },

  /** 直连新建资源池供应商；name/endpoint/models/apiKey/authField 均必填。 */
  async createSupplier(input: GatewaySupplierUpsert): Promise<GatewayCatalog> {
    return invoke("create_gateway_supplier", { input });
  },

  /** 补丁式更新；apiKey 为 undefined/空串表示保持现有密钥不变。 */
  async updateSupplier(
    supplierId: string,
    input: GatewaySupplierUpsert,
  ): Promise<GatewayCatalog> {
    return invoke("update_gateway_supplier", { supplierId, input });
  },

  /** 最近请求轨迹（最新在前，最多 100 条）。 */
  async getTraces(): Promise<GatewayRequestTrace[]> {
    return invoke("get_gateway_traces");
  },
};
