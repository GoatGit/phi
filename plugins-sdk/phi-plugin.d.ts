/**
 * phi 插件 SDK —— 只有类型，没有运行时。
 *
 * 插件脚本跑在宿主内置的 QuickJS 沙箱里：每次执行都新建一个运行时，
 * 没有 `require`、没有 `import`、没有网络、没有文件系统，也拿不到宿主的
 * 进程与配置。所以这里不是一份「可以 import 的库」，而是给编辑器看的
 * 契约声明：把它放到插件旁边（或任意位置），脚本开头写
 *
 *     // @ts-check
 *     /// <reference path="./phi-plugin.d.ts" />
 *
 * 再打开 VS Code 之类的编辑器，`event.` 后面就会有字段补全，写错字段名当场报错。
 *
 * 声明与 `src-tauri/src/plugin/` 一一对应：
 * - 清单            → `manifest.rs`
 * - 请求改写        → `sandbox.rs`（`onRequest`）、`stage.rs`
 * - 接棒决策        → `session_exit.rs`（`onSessionExit`）
 * - 沙箱上限 / 版本 → 由宿主命令 `get_plugin_protocol` 提供（插件中心那一页协议）
 *
 * 数字不要在这里抄：上限以运行时为准，改实现时这里不会跟着变。
 */

/** 请求体：代理转发给上游的 JSON，字段因供应商而异。 */
type PhiRequestBody = Record<string, unknown>;

/**
 * 请求改写入口。
 *
 * 只拿到**请求体本身**——没有应用 id、没有端点路径。
 * 返回一个对象即替换整份请求体；返回 `undefined` / `null` 表示不动。
 * 原样返回入参等于没改（宿主会记 0 处命中）。
 */
declare function onRequest(
  request: PhiRequestBody,
): PhiRequestBody | null | undefined;

/** 会话异常退出的原因分类。 */
type PhiFailureKind = "quota" | "context" | "provider" | "crash";

/**
 * 接棒事件：宿主掌握的事实，字段只增不改。
 *
 * 宿主先用内置策略判断「该不该接」；只有它认为该接时，才把事件交给插件
 * 决定「怎么接」。所以插件没法把宿主不打算接的会话硬拉起来。
 */
interface PhiSessionExitEvent {
  /** 应用 id，如 `claude`、`codex`。 */
  app: string;
  /** 会话的工作目录。 */
  cwd: string;
  /** 进程退出码；多数情况是 0 或非 0 的真值，分类结果另见 failureKind。 */
  exitCode: number;
  failureKind: PhiFailureKind;
  /** 分类依据（命中了哪条标记），给人看的一句话。 */
  reason: string;
  /** 能否找回原来的会话（能才能续原会话）。 */
  hasTarget: boolean;
  /** 这张会话此前已经接过几次。 */
  attempts: number;
  /** 上一次接棒时的失败分类。 */
  lastKind: PhiFailureKind | null;
  /** 策略允许的最大接棒次数。 */
  maxAttempts: number;
  /** 用户是否开着自动接棒。 */
  autoResume: boolean;
  /** 崩溃前已经做成功的步骤（给人看）。 */
  evidence: string[];
  /** 同一会话累计成功步骤数。 */
  successes: number;
}

/** 接棒决策。字段不对会被整条拒掉，宿主回落到内置策略。 */
interface PhiSessionExitDecision {
  /** `resume` 接棒；`record` 只记录不重启。 */
  action: "resume" | "record";
  /** 怎么接；省略时按内置判定。 */
  mode?: "same-session" | "fresh-session" | null;
  /** 一句理由，必填，超过 200 字会被截断。 */
  reason: string;
}

/**
 * 接棒决策入口。
 *
 * 返回 `null` / `undefined` 表示弃权，交给下一个插件；都弃权则用内置策略。
 * 同一个钩子上按优先级顺序问，第一个表态的插件生效。
 */
declare function onSessionExit(
  event: PhiSessionExitEvent,
): PhiSessionExitDecision | null | undefined;

/** 清单里一条声明式规则。 */
interface PhiDeclarativeRule {
  /** `remove` 删掉命中的键或数组元素；`mask` 改写命中的字符串。 */
  op: "remove" | "mask";
  /** 点分路径；`*` 匹配任意键或数组元素，数字段表示数组下标。 */
  path: string;
  /** 仅 `mask` 可用：正则。省略表示把整个字符串换掉。 */
  replacement?: string;
  pattern?: string;
}

/**
 * `plugin.json` 的形状。
 *
 * 字段名用 snake_case，与清单文件一致；`kind`、`hooks` 的取值见
 * `PhiPluginKind` / `PhiPluginHook`。未知字段会被拒绝（防止拼错后静默失效）。
 */
interface PhiPluginManifest {
  manifest_version?: number;
  id: string;
  name: string;
  version?: string;
  description?: string;
  author?: string;
  kind?: PhiPluginKind;
  hooks?: PhiPluginHook[];
  priority?: number;
  enabled_by_default?: boolean;
  entry?: string;
  rules?: PhiDeclarativeRule[];
  panel?: {
    entry: string;
    title?: string;
    order?: number;
  };
}

type PhiPluginKind =
  /** 声明式规则，不跑代码。 */
  | "rules"
  /** 沙箱里跑 `entry` 指向的脚本。 */
  | "script"
  /** 只在界面挂一个宿主内置面板。 */
  | "feature";

type PhiPluginHook =
  /** 出站请求体改写。 */
  | "request"
  /** 会话异常退出时的接棒决策。 */
  | "session-exit"
  /** 界面面板（只给功能插件）。 */
  | "panel";
