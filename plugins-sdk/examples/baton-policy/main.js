// @ts-check
/// <reference path="../../phi-plugin.d.ts" />

/**
 * 接棒决策示例：只在「上下文超限」时接棒，并且开一条新会话。
 *
 * 返回 null = 弃权，交给下一个插件；都弃权则用内置策略。
 * 沙箱里没有网络、文件和 require：这段代码只能读 event、返回决策对象。
 */
function onSessionExit(event) {
  if (event.failureKind !== "context") return null;
  return {
    action: "resume",
    mode: "fresh-session",
    reason: "上下文超限：开新会话，交接单里带上已完成的部分",
  };
}
