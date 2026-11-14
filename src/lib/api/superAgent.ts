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

/** 人工确认：继续排队、确认完成或暂停；后端校验运行版本和卡片指纹。 */
export type RouterHumanDecision = "continue" | "complete" | "pause";

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
  /** 空跑原因：disabled / no-tasks / no-candidates / dispatch-quota-used / concurrency-full / no-capacity */
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

/**
 * 「打开 worker 的终端」的结果。
 *
 * 两个后端说法不同：托管终端的 worker 本身就是 phi 的一个会话，直接交回 id；
 * 跑在 zellij 里的 worker 不在终端表里，后端会现开一个查看器窗格挂上去。
 * `appId` 是应该切到哪个应用页签（就是 worker 自己那个 CLI）。
 */
export interface OpenedWorker {
  sessionId: string;
  appId: string;
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
  /**
   * 手动「开始会话」要交给 CLI 的参数：与自动派发同一句指令，且已由 Rust 侧转义。
   * 前端不自己拼任务描述，否则两条入口的说法迟早会分叉。
   */
  sessionArguments: (root: string, taskId: string) =>
    invoke<string>("task_session_arguments", { root, taskId }),
  pause: (root: string, taskId: string) =>
    invoke<void>("router_pause_task", { root, taskId }),
  resume: (root: string, taskId: string) =>
    invoke<void>("router_resume_task", { root, taskId }),
  resolve: (
    root: string,
    taskId: string,
    decision: RouterHumanDecision,
    expectedUpdatedAt: number,
    fingerprint: string,
  ) =>
    invoke<void>("router_resolve_task", {
      root,
      taskId,
      decision,
      expectedUpdatedAt,
      fingerprint,
    }),
  /** 立刻开始：跳过冷却与配额，仍受 worker 白名单与租约约束。 */
  start: (root: string, taskId: string) =>
    invoke<void>("router_start_task", { root, taskId }),
  /**
   * 打开这次运行的 worker。
   *
   * 关掉打开的终端只是断开查看：worker 跑在 zellij 里，不会跟着退出。
   */
  openWorker: (root: string, taskId: string) =>
    invoke<OpenedWorker>("task_open_worker", { root, taskId }),
};
