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
    requestId = crypto.randomUUID(),
  ) =>
    invoke<TerminalSession>("terminal_create", {
      appId,
      cwd,
      arguments: argumentsText,
      requestId,
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
};
