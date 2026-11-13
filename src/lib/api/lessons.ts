import { invoke } from "@tauri-apps/api/core";

/** 与 `src-tauri/src/lessons/model.rs` 一一对应的 DTO。字段是 camelCase。 */

/** 一条教训 = 一处「禁区」。 */
export interface Lesson {
  id: string;
  /** 仓库相对路径标签；空表示没能归因到具体文件 */
  paths: string[];
  /** 现象：一句话说明哪一步炸了 */
  trigger: string;
  /** 证据：哪个应用的哪个会话、什么退出码 */
  evidence: string;
  /** 下次怎么做 */
  nextStep: string;
  /** 命中次数（不同会话各算一次） */
  hits: number;
  firstSeen: number;
  lastSeen: number;
  apps: string[];
  /** 被用户删掉：留在列表里但不再注入 */
  dismissed: boolean;
  dismissReason?: string;
}

export interface InjectionState {
  enabled: boolean;
  /** 落点文件名，目前是 `AGENTS.md` */
  file: string;
  version: number;
  usedChars: number;
  budgetChars: number;
  /** 文件里的块是否与当前教训算出来的块一致 */
  applied: boolean;
}

export interface LessonState {
  root: string;
  lessons: Lesson[];
  injection: InjectionState;
  lastScanAt?: number;
  scannedSessions: number;
  pendingSessions: number;
  failures: number;
}

export interface InjectionPreview {
  file: string;
  block: string;
  usedChars: number;
  budgetChars: number;
  lessonCount: number;
  version: number;
}

export const lessonsApi = {
  state: (root: string) => invoke<LessonState>("lesson_state", { root }),
  /** 增量扫一遍本机会话，把新失败沉淀成教训 */
  refresh: (root: string) => invoke<LessonState>("lesson_refresh", { root }),
  /** 阀一：这些路径命中了哪些禁区 */
  matches: (root: string, paths: string[]) =>
    invoke<Lesson[]>("lesson_matches", { root, paths }),
  dismiss: (root: string, id: string, reason: string) =>
    invoke<LessonState>("lesson_dismiss", { root, id, reason }),
  restore: (root: string, id: string) =>
    invoke<LessonState>("lesson_restore", { root, id }),
  preview: (root: string) =>
    invoke<InjectionPreview>("lesson_injection_preview", { root }),
  /** 开关往 `AGENTS.md` 写注入块 */
  setInjection: (root: string, enabled: boolean) =>
    invoke<InjectionPreview>("lesson_set_injection", { root, enabled }),
};

/** 把 Rust 侧的错误码翻成用户能看懂的一句话。 */
export function lessonErrorMessage(
  error: unknown,
  t: (key: string) => string,
): string {
  const code = error instanceof Error ? error.message : String(error);
  switch (code) {
    case "invalid-directory":
      return t("pluginCenter.lessons.errors.invalidDirectory");
    case "workspace-not-registered":
      return t("pluginCenter.lessons.errors.notRegistered");
    case "reason-required":
      return t("pluginCenter.lessons.errors.reasonRequired");
    case "lesson-not-found":
      return t("pluginCenter.lessons.errors.notFound");
    default:
      return code;
  }
}
