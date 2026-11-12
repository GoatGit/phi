import { invoke } from "@tauri-apps/api/core";

/** 与 `src-tauri/src/tasks/model.rs` 一一对应的任务 DTO。字段是 camelCase。 */

export interface TaskCard {
  id: string;
  title: string;
  status: string;
  assignees: string[];
  priority: string | null;
  labels: string[];
  dependencies: string[];
  createdDate: string | null;
  updatedDate: string | null;
  acceptanceTotal: number;
  acceptanceDone: number;
  /** 相对仓库根的任务文件路径 */
  file: string;
  /** 内容指纹：写回时带上，文件被外部改过会返回 stale-fingerprint */
  fingerprint: string;
}

export interface TaskAcceptanceItem {
  text: string;
  done: boolean;
}

export interface TaskSection {
  title: string;
  body: string;
}

export interface TaskLink {
  sessionId: string;
  appId: string;
  createdAt: number;
  costUsd: number;
  requests: number;
}

export interface TaskDetail {
  task: TaskCard;
  body: string;
  sections: TaskSection[];
  acceptance: TaskAcceptanceItem[];
  links: TaskLink[];
}

export interface TaskColumn {
  status: string;
  tasks: TaskCard[];
}

export interface TaskBoard {
  root: string;
  projectName: string;
  defaultStatus: string;
  taskPrefix: string;
  /** config.yml 里配置的列顺序（不含临时多出来的列） */
  statuses: string[];
  columns: TaskColumn[];
}

export interface TaskWorkspace {
  root: string;
  name: string;
  projectName: string | null;
  statuses: string[];
  defaultStatus: string | null;
  taskPrefix: string | null;
  valid: boolean;
  error: string | null;
}

export interface NewTaskInput {
  title: string;
  description?: string;
  status?: string;
  priority?: string;
  assignees?: string[];
  labels?: string[];
  dependencies?: string[];
  acceptance?: string[];
}

export const tasksApi = {
  workspaces: () => invoke<TaskWorkspace[]>("task_workspaces"),
  addWorkspace: (root: string) =>
    invoke<TaskWorkspace>("task_workspace_add", { root }),
  /** 目录里还没有 backlog 配置时，建一份最小的 `backlog/config.yml` + tasks/ */
  initWorkspace: (root: string, projectName?: string) =>
    invoke<TaskWorkspace>("task_workspace_init", { root, projectName }),
  removeWorkspace: (root: string) =>
    invoke<void>("task_workspace_remove", { root }),
  board: (root: string) => invoke<TaskBoard>("task_board", { root }),
  detail: (root: string, taskId: string) =>
    invoke<TaskDetail>("task_detail", { root, taskId }),
  create: (root: string, input: NewTaskInput) =>
    invoke<TaskDetail>("task_create", { root, input }),
  setStatus: (
    root: string,
    taskId: string,
    status: string,
    fingerprint: string,
  ) =>
    invoke<TaskDetail>("task_set_status", {
      root,
      taskId,
      status,
      fingerprint,
    }),
  archive: (root: string, taskId: string, fingerprint: string) =>
    invoke<void>("task_archive", { root, taskId, fingerprint }),
  linkSession: (
    root: string,
    taskId: string,
    sessionId: string,
    appId: string,
  ) =>
    invoke<TaskLink>("task_link_session", {
      root,
      taskId,
      sessionId,
      appId,
    }),
  unlinkSession: (root: string, taskId: string, sessionId: string) =>
    invoke<void>("task_unlink_session", { root, taskId, sessionId }),
};

/** 把 Rust 侧的错误码翻成用户能看懂的一句话。 */
export function taskErrorMessage(
  error: unknown,
  t: (key: string) => string,
): string {
  const code = error instanceof Error ? error.message : String(error);
  switch (code) {
    case "no-backlog":
      return t("tasks.errors.noBacklog");
    case "stale-fingerprint":
      return t("tasks.errors.stale");
    case "task-not-found":
      return t("tasks.errors.notFound");
    case "invalid-directory":
      return t("tasks.errors.invalidDirectory");
    case "workspace-not-registered":
      return t("tasks.errors.notRegistered");
    case "unknown-status":
      return t("tasks.errors.unknownStatus");
    case "empty-title":
      return t("tasks.errors.emptyTitle");
    case "terminal-unsupported":
    case "unsupported-platform":
      return t("tasks.errors.terminalUnsupported");
    default:
      return code;
  }
}
