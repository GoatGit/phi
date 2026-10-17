import { invoke } from "@tauri-apps/api/core";
import type { AppId } from "./types";

export interface TrayOption {
  id: string;
  label: string;
  enabled: boolean;
  selected: boolean;
}
export interface TrayAgent {
  id: AppId;
  name: string;
  mode: "direct" | "route" | "failover" | "stack";
  connected: boolean;
  gateway: boolean;
  canConnect: boolean;
  providerName: string | null;
  providers: TrayOption[];
  models: string[];
  modelOptions: TrayOption[];
  quota: { text: string; remaining: number | null; resetsAt: string | null }[];
  quotaError: string | null;
  attention: boolean;
}
export interface TraySnapshot {
  agents: TrayAgent[];
  problems: string[];
  feedback: string | null;
  routingInUse: boolean;
  profiles: { scope: string; name: string; items: TrayOption[] }[];
  updatedAt: number;
}
export const trayPanelApi = {
  snapshot: (): Promise<TraySnapshot> => invoke("get_tray_panel"),
  refresh: (): Promise<void> => invoke("refresh_tray_panel"),
  action: (id: string): Promise<string[]> =>
    invoke("tray_panel_action", { id }),
  hide: (): Promise<void> => invoke("hide_tray_panel"),
};
