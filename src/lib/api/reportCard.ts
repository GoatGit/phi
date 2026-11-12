import { invoke } from "@tauri-apps/api/core";

/**
 * 与 `src-tauri/src/report_card/aggregate.rs` 一一对应（camelCase）。
 *
 * 这些数字全部来自会话里已有的工具调用结果，没有跑用户的验收命令，
 * 也没有跟踪改动是否被回滚，所以只能叫「可靠性」，不能叫「质量」。
 */

export interface ModelScoreboardRow {
  providerId: string;
  model: string;
  tasks: number;
  toolCalls: number;
  toolFailures: number;
  /** 被中断的调用单独统计，不算失败 */
  interruptions: number;
  /** 失败率的分母：工具调用数扣掉被中断的 */
  effectiveCalls: number;
  toolFailureRate: number | null;
  interruptionRate: number | null;
  writeAttempts: number;
  writeSuccesses: number;
  /** 有写盘意图的任务数（空交付率的分母） */
  deliveryTasks: number;
  emptyTasks: number;
  emptyDeliveryRate: number | null;
  /** 中途换过模型的任务数（接棒场景） */
  mixedModelTasks: number;
  costUsd: number;
  costPerTask: number | null;
  timedCalls: number;
  avgStepMs: number | null;
  exitSamples: number;
  exitFailures: number;
  /** 样本量（工具调用数）；小于 5 只显示「样本不足」 */
  sampleSize: number;
  sufficient: boolean;
  lastSeenAt: number;
}

export interface ReportCardSync {
  scannedSessions: number;
  parsedSessions: number;
  unchangedSessions: number;
  failedSessions: number;
  droppedSessions: number;
  /** 本轮被节流或已有同步在跑，数据没动 */
  skipped: boolean;
  syncedAt: number;
  durationMs: number;
}

export interface ReportCard {
  rows: ModelScoreboardRow[];
  windowDays: number;
  since: number;
  generatedAt: number;
  /** 目前恒为 unproven：只有可靠性观察，没有验收与返工证据 */
  observationState: string;
  totalTasks: number;
  providers: number;
  projects: number;
  scannedSources: number;
  sync: ReportCardSync;
}

export const reportCardApi = {
  /** 读成绩单；`refresh` 为真时跳过 5 分钟节流，强制扫一轮会话 */
  page: (days: number, refresh = false) =>
    invoke<ReportCard>("report_card_page", { days, refresh }),
};
