import { invoke } from "@tauri-apps/api/core";

/**
 * 编排接力的 DTO，与 `src-tauri/src/orchestration/model.rs` 一一对应。
 * 字段是 camelCase，改一边必须改另一边。
 */

/** 门判定的三种结论：跑了但没过是 fail，证据不成立是 invalid。 */
export type GateStatus = "pass" | "fail" | "invalid";

export interface RelayAcceptStep {
  cmd: string;
  expectExit: number;
  timeoutMinutes: number | null;
}

export interface RelayContract {
  accept: RelayAcceptStep[];
  /** 允许改动的路径；为空表示卡片没声明边界 */
  touched: string[];
  forbidden: string[];
  role: string | null;
  base: string | null;
  maxTokens: number | null;
  maxMinutes: number | null;
  /** 解析时读不懂的地方 */
  warnings: string[];
  /** accept 与 touched 都齐了，门 2 才有意义 */
  ready: boolean;
}

/** 卡片 `phi_verdict` 块：卡片是唯一事实源，这里只记最近一次的结论。 */
export interface RelayVerdict {
  gate2?: string;
  gate3?: string;
  at?: string;
  base?: string;
}

export interface RelayStepResult {
  cmd: string;
  expectExit: number;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  outputTail: string;
}

export interface RelayViolation {
  path: string;
  rule: "forbidden" | "out-of-scope";
}

export interface RelayClaimCheck {
  file: string;
  line: number;
  quote: string;
  ok: boolean;
  actual: string | null;
  reason: string | null;
}

export interface RelayEvidence {
  steps: RelayStepResult[];
  changed: string[];
  violations: RelayViolation[];
  claims: RelayClaimCheck[];
  note: string | null;
}

export interface RelayRun {
  id: string;
  /** 2 = 实现是否成立，3 = 复查是否成立 */
  gate: number;
  status: GateStatus;
  baseCommit: string | null;
  createdAt: number;
  durationMs: number;
  evidence: RelayEvidence;
}

export interface RelayView {
  taskId: string;
  contract: RelayContract;
  verdict: RelayVerdict;
  /** 最近几次门判定，新的在前 */
  runs: RelayRun[];
  /** 卡片里能解析出的复查证据锚点条数 */
  reviewClaims: number;
  /** 当前工作区相对基线的改动，只作提示 */
  changed: string[];
  /** 基线解析失败之类的问题 */
  warnings: string[];
}

export const orchestrationApi = {
  relay: (root: string, taskId: string) =>
    invoke<RelayView>("task_relay", { root, taskId }),
  /** 跑一次门判定：会在仓库里执行卡片声明的 shell 命令，并把结论回写卡片 */
  runGate: (root: string, taskId: string, gateNumber: 2 | 3) =>
    invoke<RelayRun>("task_gate_run", { root, taskId, gateNumber }),
};
