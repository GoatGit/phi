// 接棒（Session Baton）的默认策略。
//
// 这个脚本只能在沙箱里做一件事：看一眼宿主给出的退出事件，回一个决策。
// 它没有进程、文件系统、网络——真正重启会话的是宿主。所以这里不做任何
// 「聪明事」，只把取舍写清楚，让用户能在插件中心读到、改掉、或直接停用。
//
// 事件字段（宿主提供，只增不改）：
//   app          应用 id，如 claude / codex
//   cwd          会话工作目录
//   exitCode     CLI 自己的退出码
//   failureKind  quota | context | provider | crash
//   reason       宿主给出的人话原因
//   hasTarget    有没有可 resume 的旧会话
//   attempts     这个终端会话已经接过几次
//   lastKind     上一次的失败类别，没有则为 null
//   maxAttempts  宿主允许的最大尝试次数
//   autoResume   用户设置里是否允许自动接棒
//   evidence     失败证据短句（上游状态码、会话里的错误标记）
//
// 返回：
//   { action: "resume" | "record", mode?: "same-session" | "fresh-session", reason }
//   返回 null 表示弃权，宿主回落到内置策略。

function onSessionExit(event) {
  var kind = String(event.failureKind || "");

  // 用户关掉了自动接棒：只记录，不擅自重启。
  if (event.autoResume !== true) {
    return { action: "record", reason: "自动接棒已关闭" };
  }

  // 上下文已经塞满：再续同一会话只会原地再挂一次，开新会话并把交接单带过去。
  if (kind === "context") {
    return {
      action: "resume",
      mode: "fresh-session",
      reason: "上下文超限，开新会话并交接",
    };
  }

  // 额度耗尽与供应商抖动：会话本身是好的，还回原来那条继续。
  if (kind === "quota") {
    return {
      action: "resume",
      mode: "same-session",
      reason: "额度/限流打断，换条链路续同一会话",
    };
  }
  if (kind === "provider") {
    return {
      action: "resume",
      mode: "same-session",
      reason: "上游抖动，原地重试一次",
    };
  }

  // 硬崩：还回原会话，但只给一次机会（宿主另有次数上限与无进展保护）。
  if (kind === "crash") {
    return {
      action: "resume",
      mode: "same-session",
      reason: "进程崩溃，回原会话继续",
    };
  }

  return { action: "record", reason: "无法归因，先记录" };
}
