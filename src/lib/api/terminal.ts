import { invoke } from "@tauri-apps/api/core";
import type { AppId } from "./types";

export type TerminalPhase =
  | "checking"
  | "starting"
  | "running"
  | "missing-cli"
  | "failed"
  | "exited";
export interface TerminalSession {
  id: string;
  appId: AppId;
  title: string;
  launchCwd: string;
  launchArgs: string;
  phase: TerminalPhase;
  generation: number;
  sequence: number;
  errorCode: string | null;
}
export interface TerminalPresentation {
  id: string | null;
  revision: number;
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
  focus: boolean;
  dark: boolean;
  theme: string;
  overlays?: { x: number; y: number; width: number; height: number }[];
  blocked?: boolean;
  dimmed?: boolean;
}
export interface TerminalCreateOptions {
  /** 与 present 同一套受信字段：create 时先于 PTY 应用，CLI 启动期的
   * OSC 10/11 背景探测才能拿到最终配色（否则 TUI 会缓存错误的浅色假设） */
  dark?: boolean;
  theme?: string;
}
export const terminalApi = {
  capabilities: () =>
    invoke<{ supported: boolean; apps: AppId[]; defaultCwd: string }>(
      "terminal_capabilities",
    ),
  list: () => invoke<TerminalSession[]>("terminal_list"),
  create: (
    appId: AppId,
    cwd: string,
    argumentsText = "",
    { dark = false, theme = "auto" }: TerminalCreateOptions = {},
    requestId = crypto.randomUUID(),
  ) =>
    invoke<TerminalSession>("terminal_create", {
      appId,
      cwd,
      arguments: argumentsText,
      requestId,
      theme,
      dark,
    }),
  close: (session: TerminalSession, confirmed = false) =>
    invoke<void>("terminal_close", {
      id: session.id,
      generation: session.generation,
      confirmed,
    }),
  restart: (session: TerminalSession) =>
    invoke<TerminalSession>("terminal_restart", {
      id: session.id,
      generation: session.generation,
    }),
  present: (presentation: TerminalPresentation) =>
    invoke<void>("terminal_present", { presentation }),
  /** 分屏：声明当前恰好可见的会话集合（切标签页/关窗格/离开终端页时收敛） */
  setVisible: (ids: string[]) => invoke<void>("terminal_set_visible", { ids }),
};
