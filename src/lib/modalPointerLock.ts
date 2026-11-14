import { logFrontendInfo } from "@/lib/frontendLogger";

/**
 * 切页后补一次「解除全局点击封锁」。
 *
 * Radix 的模态层（抽屉、菜单、对话框）打开时会把 `pointer-events: none` 写到
 * `<body>` 上，关闭时还原。多层模态与整页替换在同一帧里一起卸载时，这个还原
 * 可能被漏掉：界面看着完全正常、无障碍树也完整，但 WebView 里点哪儿都没反应。
 * 原生终端视图不在 DOM 里，所以它照常可用——表现就是「除了终端都点不动」。
 *
 * 因此切页之后检查一次：只有 body 仍被锁住、且文档里确实没有任何打开的模态层时
 * 才解锁。正常打开着的抽屉/菜单不会被误解锁。
 */
const OPEN_LAYER_SELECTOR = [
  '[role="dialog"][data-state="open"]',
  '[role="alertdialog"][data-state="open"]',
  '[role="menu"][data-state="open"]',
  '[role="listbox"][data-state="open"]',
  '[data-radix-popper-content-wrapper] > [data-state="open"]',
  // 模态层挂载期间 Radix 会在 body 上留焦点护栏，用它兜住没有 role 的自定义弹层
  "[data-radix-focus-guard]",
].join(",");

/** @returns 是否真的解开了封锁（调用方一般不需要用返回值） */
export function releaseStuckPointerLock(doc: Document = document): boolean {
  const body = doc.body;
  if (!body || body.style.pointerEvents !== "none") return false;
  if (doc.querySelector(OPEN_LAYER_SELECTOR)) return false;
  body.style.removeProperty("pointer-events");
  // 自愈只应发生在「模态层已经走了但封锁没撤掉」的异常情形；写一行诊断日志，
  // 万一再出现时日志里能直接看到是哪一次切页触发的。
  logFrontendInfo(
    `[pointer-lock] 解锁残留的 body pointer-events（没有任何打开的模态层）`,
  );
  return true;
}
