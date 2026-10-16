import { invoke } from "@tauri-apps/api/core";

/** 单个会话的聚合（Rust services/session_stats.rs） */
export interface SessionStatsEntry {
  appType: string;
  sessionId: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  firstAt: number;
  lastAt: number;
  activeSeconds: number;
  peakContextTokens: number;
  compactions: number;
}

export interface SessionStatsDay {
  date: string;
  appType: string;
  requests: number;
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  activeSeconds: number;
}

export interface SessionStatsHour {
  /** 0 = 周一 */
  weekday: number;
  hour: number;
  appType: string;
  seconds: number;
}

/** 上下文水位采样点：contextTokens = 会话内累计的 fresh input + cache read + cache creation */
export interface SessionContextPoint {
  appType: string;
  sessionId: string;
  createdAt: number;
  model: string;
  contextTokens: number;
  outputTokens: number;
}

export interface SessionStatsPage {
  sessions: SessionStatsEntry[];
  days: SessionStatsDay[];
  hours: SessionStatsHour[];
  contextPoints: SessionContextPoint[];
  generatedAt: number;
}

export const sessionStatsApi = {
  /** days = 0 表示全部可用明细（明细保留 30 天，更早已 rollup 成无会话维度） */
  get: (days: number): Promise<SessionStatsPage> =>
    invoke("get_session_stats", { days }),
};
