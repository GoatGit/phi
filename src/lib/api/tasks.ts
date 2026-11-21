import { invoke } from "@tauri-apps/api/core";

/** 与 `src-tauri/src/tasks/model.rs` 一一对应的任务 DTO。字段是 camelCase。 */

/** 持续 / 定时任务。普通任务没有这一项。 */
export type TaskScheduleKind = "interval" | "daily" | "once";

/**
 * 卡片类型。
 *
 * `discussion` 是讨论卡：它只收敛结论，不占执行槽位、不派 worker、不产出交付物。
 * 讨论结束的方式是把卡拖出待办列，它就会转成 `task` 开始执行。
 */
export type TaskKind = "task" | "discussion";

export interface TaskSchedule {
  kind: TaskScheduleKind;
  /** 间隔任务的分钟数 */
  minutes: number | null;
  /** 每日任务的时间（本地时区，HH:MM） */
  time: string | null;
  /** 一次性任务的时间（本地时区，YYYY-MM-DD HH:MM） */
  at: string | null;
  /** 上一次被调度器触发的时刻（毫秒） */
  lastRunAt: number | null;
  /** 下一次该跑的时刻（毫秒）；已经过去的时刻表示「现在就该跑」 */
  nextRunAt: number | null;
}

export interface TaskCard {
  id: string;
  /** `task` 要执行；`discussion` 只讨论 */
  kind: TaskKind;
  /** 讨论卡从哪张已完成的任务派生出来 */
  sourceTask: string | null;
  /** 同一张源任务派生出的第几轮讨论 */
  round: number | null;
  /** 这张卡正在讨论：不参与自动派发，也不会被「新建即派发」带走 */
  discussionHold: boolean;
  /** 卡面上那一句「待决定的问题」；讨论清楚之前它就是这张卡的全部内容 */
  discussionQuestion: string | null;
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
  /** 卡片「产物」段落里的条数 */
  artifactCount: number;
  /** 持续 / 定时任务的排期 */
  schedule: TaskSchedule | null;
  /** 相对仓库根的任务文件路径 */
  file: string;
  /** 内容指纹：写回时带上，文件被外部改过会返回 stale-fingerprint */
  fingerprint: string;
}

/** 一个产物：文件或链接。 */
export interface TaskArtifact {
  label: string;
  /** 卡片里写的原始路径或链接 */
  path: string;
  /** 文件是否真的在仓库里 */
  exists: boolean;
  size: number | null;
  url: string | null;
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

/** 一张派生出去的讨论卡。原任务只读这份摘要，不读它的正文。 */
export interface DerivedDiscussion {
  id: string;
  title: string;
  status: string;
  round: number | null;
  createdDate: string | null;
  /** 这张讨论卡上还没定的问题 */
  question: string | null;
}

export interface TaskDetail {
  task: TaskCard;
  body: string;
  sections: TaskSection[];
  acceptance: TaskAcceptanceItem[];
  links: TaskLink[];
  /** 结果摘要：卡片里的「结果」段落（老卡片退回 Conclusion） */
  outcome: string | null;
  /** 讨论写回同一张卡、已由人确认的需求 */
  confirmed: string | null;
  /** 由这张任务派生出的讨论卡，按轮次升序 */
  derived: DerivedDiscussion[];
  /** 用户要拿走的产物 */
  artifacts: TaskArtifact[];
  /** 这一轮讨论的对话记录，按时间先后。发言者只有用户与 Router。 */
  discussionTurns: DiscussionTurn[];
}

/**
 * 讨论的一轮发言。
 *
 * 讨论记录放在 phi 自己的库里，不写进任务文件：卡片里只留结论
 * （`discussionQuestion` / `confirmed`），用户的任务资产不被聊天记录撑大。
 */
export interface DiscussionTurn {
  /** `user`（用户）或 `router`（Router） */
  role: "user" | "router";
  text: string;
  /** 毫秒时间戳 */
  createdAt: number;
  /**
   * Router 这一轮抛给用户填写的表单（从回复里的 `phi-form` 块解析）。
   * `text` 已经去掉了那段块，表单在这里单独给。
   */
  form?: DiscussionForm | null;
}

/** 讨论里的一张表单：把「还需要你定什么」变成可以直接填的几项。 */
export interface DiscussionForm {
  title: string | null;
  fields: DiscussionFormField[];
}

/** 表单里的一项。`choice` 一定带至少两个选项，否则后端会降级成 `text`。 */
export interface DiscussionFormField {
  id: string;
  label: string;
  type: "text" | "choice";
  placeholder: string | null;
  options: string[];
  required: boolean;
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
  /** 建卡即进入讨论：这张卡先不交给自动调度 */
  discussionHold?: boolean;
  description?: string;
  status?: string;
  priority?: string;
  assignees?: string[];
  labels?: string[];
  dependencies?: string[];
  acceptance?: string[];
  /** 持续任务：每隔多久跑一次（2h / 30m / 1d） */
  recurrence?: string;
  /** 定时任务：每天 09:30 或一次性的 2026-11-20 09:30 */
  schedule?: string;
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
  /**
   * 改排期。两个参数最多给一个：`recurrence` 是持续任务，`schedule` 是定时任务，
   * 都给 `null` 就是取消排期。后端会先校验能不能解析，写坏的排期不会落盘。
   */
  setSchedule: (
    root: string,
    taskId: string,
    recurrence: string | null,
    schedule: string | null,
    fingerprint: string,
  ) =>
    invoke<TaskDetail>("task_set_schedule", {
      root,
      taskId,
      recurrence,
      schedule,
      fingerprint,
    }),
  /** 在文件管理器中显示一个产物（只接受仓库内确实存在的文件） */
  revealArtifact: (root: string, path: string) =>
    invoke<boolean>("task_reveal_artifact", { root, path }),
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
  /**
   * 把待决定的问题与已确认的需求写回同一张卡。
   *
   * 两个都传：`null` 表示不动那一个，空字符串表示清掉。写回后这张卡进入
   * 讨论（自动调度不碰它）；离开待办列时后端自动解除。
   */
  discussionUpdate: (
    root: string,
    taskId: string,
    question: string | null,
    confirmed: string | null,
    fingerprint: string,
  ) =>
    invoke<TaskDetail>("task_discussion_update", {
      root,
      taskId,
      question,
      confirmed,
      fingerprint,
    }),
  /**
   * 跟 Router 说一句，等它回一句。
   *
   * 讨论的承载者是 Router，不是某个 worker 的终端会话：这一句会进 timeline，
   * 回复也留在同一张卡上。返回更新后的详情（含新增的两轮发言）。
   */
  discussionSay: (
    root: string,
    taskId: string,
    message: string,
    fingerprint: string,
  ) =>
    invoke<TaskDetail>("task_discussion_say", {
      root,
      taskId,
      message,
      fingerprint,
    }),
  /**
   * 从一张已完成的任务派生出一张新的讨论卡。
   *
   * 原卡不改：状态、结束时间与结论都保持原样，新卡用 `sourceTask` 指回去。
   */
  deriveDiscussion: (root: string, taskId: string, note: string) =>
    invoke<TaskDetail>("task_discussion_derive", {
      root,
      taskId,
      note,
    }),
  /**
   * 把待办列上的一张执行卡就地转成讨论卡。
   *
   * 讨论只在讨论卡里发生：普通待办卡不能直接讨论，先转类型。卡片本身不改，
   * 已经开工的卡会被 `discussion-not-pending` 拒绝。
   */
  convertDiscussion: (root: string, taskId: string, fingerprint: string) =>
    invoke<TaskDetail>("task_discussion_convert", {
      root,
      taskId,
      fingerprint,
    }),
  /** 删掉一张讨论卡（卡片文件、讨论记录与已谈出的结论一起消失） */
  discardDiscussion: (root: string, taskId: string, fingerprint: string) =>
    invoke<void>("task_discussion_discard", {
      root,
      taskId,
      fingerprint,
    }),
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
    case "invalid-recurrence":
      return t("tasks.errors.invalidRecurrence");
    case "invalid-schedule":
      return t("tasks.errors.invalidSchedule");
    case "conflicting-schedule":
      return t("tasks.errors.conflictingSchedule");
    case "discussion-not-pending":
      return t("tasks.errors.discussionNotPending");
    case "router-model-missing":
      return t("tasks.errors.routerModelMissing");
    case "router-sidecar-missing":
    case "router-gateway-unavailable":
      return t("tasks.errors.routerSidecarMissing");
    case "empty-discussion-message":
      return t("tasks.errors.emptyDiscussionMessage");
    case "invalid-discussion-message":
      return t("tasks.errors.invalidDiscussionMessage");
    case "empty-reply":
    case "discussion-failed":
    case "router-sidecar-exited":
      return t("tasks.errors.discussionFailed");
    case "empty-discussion-note":
      return t("tasks.errors.emptyDiscussionNote");
    case "invalid-discussion-note":
      return t("tasks.errors.invalidDiscussionNote");
    case "discussion-source-not-done":
      return t("tasks.errors.discussionSourceNotDone");
    case "not-a-discussion":
      return t("tasks.errors.notADiscussion");
    case "invalid-discussion-question":
      return t("tasks.errors.invalidDiscussionQuestion");
    case "invalid-discussion":
      return t("tasks.errors.invalidDiscussion");
    case "archive-scheduled":
      return t("tasks.errors.archiveScheduled");
    case "archive-has-dependents":
      return t("tasks.errors.archiveHasDependents");
    case "terminal-unsupported":
    case "unsupported-platform":
      return t("tasks.errors.terminalUnsupported");
    default:
      return code;
  }
}
