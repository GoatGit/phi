import { invoke } from "@tauri-apps/api/core";

/**
 * 插件中心的三组命令。
 *
 * DTO 与后端一一对应：
 * - 请求插件：`src-tauri/src/plugin/{manifest,registry,runtime}.rs` + `commands/plugins.rs`
 * - 隐私脱敏：`src-tauri/src/privacy/config.rs` + `commands/privacy.rs`
 * - MCP 路由：`src-tauri/src/mcp_router/{config,catalog}.rs` + `commands/mcp_router.rs`
 *
 * 三块能力在后端各自独立（插件阶段、脱敏配置、路由配置是三份文件），前端只是
 * 把它们放在同一页里，所以这里也保持三组独立的 api 对象，别合成一个大对象。
 */

// ─── 请求插件 ──────────────────────────────────────────────────────────────

export type PluginKind = "rules" | "script";

/**
 * 插件挂载点。
 * - `request`：代理出站请求体的改写阶段；
 * - `session-exit`：托管会话异常退出时的接棒决策（脚本导出 `onSessionExit`）。
 */
export type PluginHook = "request" | "session-exit";

export interface PluginSummary {
  id: string;
  name: string;
  version: string;
  kind: PluginKind;
  hooks: PluginHook[];
  /** 数值小的先跑，同值按 id 字典序 */
  priority: number;
  /** 合并了用户覆盖后的实际启用状态 */
  enabled: boolean;
  description: string | null;
  author: string | null;
  ruleCount: number;
  /** 插件目录名（不是绝对路径） */
  sourceDir: string;
}

export interface PluginLoadError {
  pluginDir: string;
  message: string;
}

export interface PluginSummaryResponse {
  /** 插件根目录，方便用户自己放插件 */
  root: string;
  plugins: PluginSummary[];
  errors: PluginLoadError[];
}

export interface PluginPreviewResponse {
  pluginId: string;
  /** 命中次数；null 表示这个阶段本次跳过 */
  hits: number | null;
  error: string | null;
  /** 改写后的请求体，失败时等于输入 */
  payload: unknown;
}

/** `session-exit` 钩子的决策。`null` 表示插件弃权（交回内置策略）。 */
export interface SessionExitDecision {
  action: "resume" | "record";
  mode: "same-session" | "fresh-session" | null;
  reason: string;
}

export interface SessionExitPreviewResponse {
  pluginId: string;
  decision: SessionExitDecision | null;
}

export const pluginsApi = {
  list: () => invoke<PluginSummaryResponse>("list_plugins"),
  setEnabled: (id: string, enabled: boolean) =>
    invoke<PluginSummaryResponse>("set_plugin_enabled", { id, enabled }),
  /** 干跑：不受启用状态影响，也不会真的发请求 */
  preview: (id: string, payload: unknown) =>
    invoke<PluginPreviewResponse>("preview_plugin_request", { id, payload }),
  /** 干跑接棒钩子：只拿一段示例事件跑决策，不会真的重启会话 */
  previewSessionExit: (id: string, event: unknown) =>
    invoke<SessionExitPreviewResponse>("preview_plugin_session_exit", {
      id,
      event,
    }),
};

// ─── 隐私脱敏 ──────────────────────────────────────────────────────────────

export type DetectorKind =
  | "api-key"
  | "bearer-token"
  | "aws-access-key"
  | "private-key-block"
  | "email"
  | "phone"
  | "id-card"
  | "credit-card"
  | "ip-address"
  | "custom";

export type RedactionAction = "mask" | "remove";

/** 检测器列举顺序与后端 `DetectorKind::ALL` 一致，`custom` 排最后。 */
export const DETECTOR_KINDS: DetectorKind[] = [
  "api-key",
  "bearer-token",
  "aws-access-key",
  "private-key-block",
  "email",
  "phone",
  "id-card",
  "credit-card",
  "ip-address",
  "custom",
];

export interface RedactionRuleConfig {
  detector: DetectorKind;
  action: RedactionAction;
  /** 缺省为 `[REDACTED:<detector>]`，最多 64 字 */
  replacement?: string | null;
  /** 只有 `custom` 能带，其它检测器带上会被后端拒 */
  customPattern?: string | null;
}

export interface PrivacyConfig {
  version: number;
  enabled: boolean;
  /** 是否改写发往上游的请求体（默认关） */
  applyToRequestBody: boolean;
  /** 是否脱敏写入本地库的错误摘要（默认开） */
  redactErrorLogs: boolean;
  rules: RedactionRuleConfig[];
}

export interface PrivacyDetectorInfo {
  id: DetectorKind;
  /** `custom` 之外都有内置形状 */
  builtin: boolean;
}

export interface PrivacyConfigResponse {
  path: string;
  config: PrivacyConfig;
  detectors: PrivacyDetectorInfo[];
}

export interface PrivacyPreviewResponse {
  text: string;
  hits: number;
}

export const privacyApi = {
  get: () => invoke<PrivacyConfigResponse>("get_privacy_config"),
  save: (config: PrivacyConfig) =>
    invoke<PrivacyConfigResponse>("save_privacy_config", { config }),
  /** 用已保存的配置干跑一段文本 */
  preview: (text: string) =>
    invoke<PrivacyPreviewResponse>("preview_privacy_redaction", { text }),
};

// ─── MCP 路由中心 ──────────────────────────────────────────────────────────

export interface McpRoute {
  /** 被路由的服务器 id */
  serverId: string;
  /** 给了就忽略 namespace */
  alias?: string | null;
  namespace?: string | null;
  /** 只投影给这些客户端；空数组 = 全部 */
  apps: string[];
  enabled: boolean;
  /** 撞名时数值大的赢，同值按 serverId 字典序 */
  priority: number;
  tags: string[];
}

export interface McpRouterConfig {
  version: number;
  enabled: boolean;
  namespaceSeparator: string;
  routes: McpRoute[];
}

export interface McpRouterResponse {
  path: string;
  config: McpRouterConfig;
  /** 配置是否已成功投影到各客户端的 live 配置 */
  applied: boolean;
  /** 投影失败的原因（配置本身已保存） */
  applyError?: string;
}

export interface CatalogEntry {
  serverId: string;
  name: string;
  /** 最终暴露给客户端的名字 */
  exposedId: string;
  /** 是否会被投影（路由关闭时为 false） */
  enabled: boolean;
  /** 路由放行的客户端；空 = 全部 */
  routedApps: string[];
  /** 数据库里当前勾选的客户端 */
  sourceApps: string[];
  /** 是否命中显式路由 */
  routeConfigured: boolean;
  /** 撞名时被谁遮蔽 */
  shadowedBy?: string | null;
}

export interface CatalogConflict {
  exposedId: string;
  serverIds: string[];
  /** 实际生效的服务器 id */
  winner: string;
}

export interface RouterCatalog {
  entries: CatalogEntry[];
  conflicts: CatalogConflict[];
}

export const mcpRouterApi = {
  get: () => invoke<McpRouterResponse>("get_mcp_router_config"),
  /** 保存并立刻重投影；投影失败会回 applied=false + applyError */
  save: (config: McpRouterConfig) =>
    invoke<McpRouterResponse>("save_mcp_router_config", { config }),
  catalog: () => invoke<RouterCatalog>("preview_mcp_router_catalog"),
};

/** 后端命令错误是纯字符串（配置校验的原文），统一收成一句可展示的话。 */
export function commandErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}
