import { invoke } from "@tauri-apps/api/core";

/**
 * 与 `src-tauri/src/super_agent/model.rs` 一一对应的自动调度 DTO。
 *
 * 前端不参与调度判断：这里只有开关、状态、暂停/恢复/开始四个动作。
 */

/**
 * 一个可被派发的智能体。判官只在它们之间按用途选人，应用、模型与
 * 追加参数都跟着定义走，不在派发时临时猜。
 *
 * `id` 是稳定标识（允许列表与历史记录都用它），`name` 与 `description` 给人看。
 */
export interface AgentCompletion {
  /** 交付时做到什么算完。 */
  result: string;
  /** 交付前逐条自查的证据。 */
  evidence: string[];
}

export interface RouterAgent {
  /** 稳定标识：改名不改 id，卡片上的 assignee 一直有效。 */
  id: string;
  name: string;
  /**
   * 选过的头像键（`avatar-NN`）。空或缺失表示按 id 派生——老设置里没有这一项，
   * 后端存的时候也会按空串落盘。
   */
  avatar?: string;
  /** 一句话说明什么任务适合派给它，判官据此选人。 */
  description: string;
  /** 执行用的应用 id（claude / codex / ...）。 */
  appId: string;
  /** 角色提示词，拼在任务说明之前。 */
  prompt: string;
  /** 会话级模型覆盖。空 = 跟随应用。 */
  model: string;
  /** 追加给 CLI 的参数；启动必需的参数由 phi 自动附加，不能在这里覆盖。 */
  arguments: string[];
  /** 它负责的结果：接这类活要交出什么。 */
  outcome: string;
  /** 负责边界：什么不接。 */
  boundary: string;
  /** 动手前必须先问用户的情况。 */
  askUserWhen: string[];
  /** 执行步骤，按顺序。 */
  steps: string[];
  /** 必须遵守的约束。 */
  constraints: string[];
  /** 怎样才算完成。 */
  completion: AgentCompletion;
}

/** 「指派」/「指派并开工」的结果。 */
export interface AgentAssignResult {
  assignees: string[];
  /** 是否真的起了进程；影子模式与只指派时为 false。 */
  started: boolean;
  /** 只落了指派时说明原因（如影子模式）。 */
  detail: string | null;
}

/** 工作室的一轮发言。 */
export interface AgentStudioTurn {
  role: "user" | "router";
  text: string;
}

export interface AgentStudioReply {
  reply: string;
  /** 这一轮产出的草稿；模型没给或给歪了时为 null。 */
  draft: RouterAgent | null;
}

/** 调度器提议：近 14 天同类活反复派给同一应用，但还没有对应智能体。 */
export interface AgentSuggestion {
  name: string;
  appId: string;
  summary: string;
  steps: string[];
  evidence: string[];
  completed: number;
}

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
  /** 允许被派发的智能体 id，顺序即优先级（第一个是默认）。 */
  workerApps: string[];
  /** 可被派发的智能体定义。为空时旧配置里的 workerApps 按应用 id 解释。 */
  agents: RouterAgent[];
  /** Router 自己的头像键；空 = 按固定 id 派生一张。它只管显示，不参与派发。 */
  routerAvatar: string;
  maxAttempts: number;
  /** 一次运行最多跑多久（秒），超过就当作卡死：停掉并按失败重派。0 表示不设上限。 */
  stallSeconds: number;
  /** 巡检节拍（秒）：多久看一次看板、收尾一次已结束的 worker。 */
  monitorIntervalSeconds: number;
  /** 「等你看」多久没人处理就按原卡片自动继续（秒）。0 表示一直等。 */
  needsYouSeconds: number;
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
  /** 派发那一刻的智能体快照：改配置或删智能体都不改历史。 */
  agentId: string | null;
  agentName: string | null;
  agentModel: string | null;
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

/** 一个 worker 自己的状态；`unknown` 是「查不到」，不能当成「还在跑」。 */
export interface WorkerSnapshot {
  state: "alive" | "exited" | "unknown";
  exitCode: number | null;
}

/** 智能体编辑器里能选的执行模型。 */
export interface AgentModelChoices {
  /** 现在可以按会话指定的模型 id；带 Stack 前缀的 id 由网关落到具体那家。 */
  models: string[];
  /** 这个应用支不支持按会话指定模型（`--model` / `-m`）。 */
  overridable: boolean;
}

export const superAgentApi = {
  settings: () => invoke<RouterSettings>("router_settings"),
  /**
   * 某个应用现在可以按会话指定的模型；不支持的应用 `overridable` 为 false，
   * 前端把下拉置灰，不展示一个兼现不了的选项。
   */
  agentModels: (appId: string) =>
    invoke<AgentModelChoices>("router_agent_models", { appId }),
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
   * 指派（可选立即开工）。
   *
   * `agentId` 为 null 是清掉指派。`start` 才是第二个动作「指派并开工」：
   * 拖放只做指派，改归属与授权起跑是两件事。
   */
  assign: (
    root: string,
    taskId: string,
    agentId: string | null,
    start: boolean,
    fingerprint: string,
  ) =>
    invoke<AgentAssignResult>("router_assign_task", {
      root,
      taskId,
      agentId,
      start,
      fingerprint,
    }),
  /** 工作室一轮对话：只产出可编辑草稿，保存仍要人点。 */
  /**
   * 工作室的一轮对话。
   *
   * `current` 是右栏此刻那一版：模型据此接着改，而不是只凭对话记忆重写一遍。
   */
  agentDraft: (
    appId: string,
    history: AgentStudioTurn[],
    message: string,
    current: RouterAgent | null,
  ) =>
    invoke<AgentStudioReply>("router_agent_draft", {
      appId,
      history,
      message,
      current,
    }),
  /**
   * 调度器提议：只提议，不落库。
   *
   * 看板不再展示这条提议（它占着头条位置、又经常对不上人正在做的事），
   * 后端能力保留，将来要挪到设置里或改成按需触发时直接用这里。
   */
  agentSuggestions: () => invoke<AgentSuggestion[]>("router_agent_suggestions"),
  /**
   * 打开这次运行的 worker。
   *
   * 关掉打开的终端只是断开查看：worker 跑在 zellij 里，不会跟着退出。
   */
  openWorker: (root: string, taskId: string) =>
    invoke<OpenedWorker>("task_open_worker", { root, taskId }),
  /**
   * 查一个 worker 自己的状态。
   *
   * 查看器窗格自己会一直开着（它是 zellij 客户端），所以它活着不能当任务在跑。
   */
  workerState: (sessionId: string) =>
    invoke<WorkerSnapshot>("router_worker_state", { sessionId }),
};
