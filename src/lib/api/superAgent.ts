import { invoke } from "@tauri-apps/api/core";

/**
 * 与 `src-tauri/src/super_agent/model.rs` 一一对应的自动调度 DTO。
 *
 * 前端不参与调度判断：这里只有开关、状态、暂停/恢复/开始四个动作。
 */

/** 运行态。与看板列（markdown 里的 status）是两件事，不要互相推导。 */
export type RouterRunState =
  | "idle"
  | "queued"
  | "dispatched"
  | "working"
  | "done"
  | "failed"
  | "needs-you"
  | "paused";

export interface RouterSettings {
  /** 总开关。关闭时 tick 直接空跑。 */
  enabled: boolean;
  /** 影子模式：照常判断与记账，但不派发。第一次开自动调度建议先跑一段。 */
  shadow: boolean;
  /** 哪一列的卡片会被派发。 */
  triggerStatus: string;
  concurrency: number;
  dispatchesPerTick: number;
  dispatchesPerDay: number;
  judgeCallsPerDay: number;
  attentionThreshold: number;
  /** 允许被派发的 worker（应用 id），第一个是默认值。 */
  workerApps: string[];
  maxAttempts: number;
  /** 退出码 0 且卡片被改过才判完成；关掉之后一律转人工确认。 */
  trustExitZero: boolean;
  leaseSeconds: number;
  cooldownSeconds: number;
  judgeModel: string;
  /** 调度器自己用的模型。空 = 不用模型，只按确定性规则判断；
   * 非空时是网关认得的模型名（界面给的是路由组别名 `group/<组名>`）。 */
  episodeModel: string;
}

export interface RouterTaskRun {
  taskId: string;
  root: string;
  state: RouterRunState;
  workerApp: string | null;
  sessionId: string | null;
  attempts: number;
  /** 最后一次的说明：问题、失败原因或收尾结论。 */
  detail: string | null;
  cardFingerprint: string | null;
  /** 这条记录来自影子模式：只记「本来会派谁」，没有真的派发 */
  shadow: boolean;
  updatedAt: number;
}

export type RouterAction = "dispatch" | "ask" | "skip";

export interface RouterDecision {
  taskId: string;
  action: RouterAction;
  appId?: string;
  reason?: string;
  question?: string;
}

export interface RouterFiltered {
  taskId: string;
  reason: string;
}

export interface RouterTrace {
  id: string;
  root: string | null;
  createdAt: number;
  trigger: string;
  candidates: number;
  narrowed: boolean;
  degraded: string[];
  decisions: RouterDecision[];
  judgeCalls: number;
  durationMs: number;
  unfinished: boolean;
  shadow: boolean;
}

export interface RouterTickReport {
  traceId: string;
  at: number;
  trigger: string;
  /** 空跑原因：disabled / no-tasks / no-candidates / dispatch-quota-used / concurrency-full */
  skipped: string | null;
  scanned: number;
  candidates: number;
  filtered: RouterFiltered[];
  narrowed: boolean;
  degraded: string[];
  decisions: RouterDecision[];
  dispatched: string[];
  needsYou: string[];
  judgeCalls: number;
  durationMs: number;
  shadow: boolean;
}

export interface RouterQuotaUsage {
  dispatches: number;
  judgeCalls: number;
}

export interface RouterStatus {
  settings: RouterSettings;
  runs: RouterTaskRun[];
  traces: RouterTrace[];
  today: RouterQuotaUsage;
}

/** 规划 DAG 的节点。`plan_task` 的产物，规则版 episode 目前不拆任务。 */
export interface RouterPlanNode {
  taskId: string;
  nodeId: string;
  title: string;
  workerApp: string | null;
  dependsOn: string[];
  state: string;
}

export const superAgentApi = {
  settings: () => invoke<RouterSettings>("router_settings"),
  saveSettings: (settings: RouterSettings) =>
    invoke<RouterSettings>("router_save_settings", { settings }),
  status: () => invoke<RouterStatus>("router_status"),
  /** 手动跑一次 tick，行为与定时 tick 一致（同样的开关、配额、影子模式）。 */
  tick: (trigger?: string) =>
    invoke<RouterTickReport>("router_tick", { trigger: trigger ?? null }),
  plan: (taskId: string) => invoke<RouterPlanNode[]>("router_plan", { taskId }),
  pause: (root: string, taskId: string) =>
    invoke<void>("router_pause_task", { root, taskId }),
  resume: (root: string, taskId: string) =>
    invoke<void>("router_resume_task", { root, taskId }),
  /** 立刻开始：跳过冷却与配额，仍受 worker 白名单与租约约束。 */
  start: (root: string, taskId: string) =>
    invoke<void>("router_start_task", { root, taskId }),
};
