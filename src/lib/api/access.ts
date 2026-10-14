import { invoke } from "@tauri-apps/api/core";

export interface LedgerTotals {
  cost: string;
  tokens: number;
  unknownCost: number;
  unknownUsage: number;
  attempts: number;
  requests: number;
}

export interface AccessBinding {
  id: string;
  name: string;
  agent: string;
  tool: string;
  projectId: string | null;
  allowedGroups: string[];
  enabled: boolean;
}
export interface AccessProject {
  id: string;
  displayPath: string;
}
export const accessApi = {
  bindings: (): Promise<AccessBinding[]> => invoke("get_access_bindings"),
  issue: (
    binding: AccessBinding,
  ): Promise<{ binding: AccessBinding; token: string }> =>
    invoke("issue_access_binding", { binding }),
  enabled: (id: string, enabled: boolean): Promise<void> =>
    invoke("set_access_binding_enabled", { id, enabled }),
  projects: (): Promise<AccessProject[]> => invoke("get_access_projects"),
  createProject: (path: string): Promise<AccessProject> =>
    invoke("create_access_project", { path }),
};

export interface BillingAdjustment {
  id: string;
  accountId: string;
  since: number;
  until: number;
  currency: string;
  amount: string;
}
export interface BillingComparison {
  statement: BillingAdjustment;
  estimate: LedgerTotals;
  differenceUsd: string | null;
  completeCoverage: boolean;
}
export const billingApi = {
  list: (): Promise<BillingComparison[]> => invoke("get_billing_comparisons"),
  save: (statement: BillingAdjustment): Promise<void> =>
    invoke("save_billing_adjustment", { statement }),
  remove: (id: string): Promise<void> =>
    invoke("delete_billing_adjustment", { id }),
};
