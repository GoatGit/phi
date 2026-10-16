import type { TerminalPresentation } from "@/lib/api/terminal";

export const TERMINAL_FOCUS_EVENT = "phi:terminal-focus";
export function focusNativeTerminal() {
  window.dispatchEvent(new Event(TERMINAL_FOCUS_EVENT));
}

/**
 * present 的全局单调序号：后端用 layout_revision 丢弃乱序更新，
 * 单窗格页（TerminalPane）和分屏区（SplitTerminalArea）必须共用一个计数器。
 */
let terminalRevision = Date.now() * 1000;
export function nextTerminalRevision() {
  return ++terminalRevision;
}

// Only content nodes count: empty Radix positioners and closing/hidden poppers
// must not leave the terminal permanently unable to accept input.
export function terminalOverlays(bounds: DOMRect) {
  const overlays: NonNullable<TerminalPresentation["overlays"]> = [];
  let blocked = false;
  let dimmed = false;
  const candidates = document.querySelectorAll<HTMLElement>(
    '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [role="tooltip"], [data-radix-popper-content-wrapper] > [data-state]',
  );
  const nodes = new Set<HTMLElement>();
  for (const node of candidates) {
    // Radix tooltips put role=tooltip on a visually hidden child. Exclude the
    // visible popper content's bounds rather than that 1px accessible label.
    const content =
      node.getAttribute("role") === "tooltip"
        ? node.closest("[data-radix-popper-content-wrapper]")?.firstElementChild
        : node;
    if (content instanceof HTMLElement) nodes.add(content);
  }
  for (const node of nodes) {
    if (node.closest('[data-state="closed"], [hidden], [aria-hidden="true"]'))
      continue;
    const style = getComputedStyle(node);
    if (
      !node.getClientRects().length ||
      style.visibility === "hidden" ||
      style.display === "none"
    )
      continue;
    const role = node.getAttribute("role");
    if (role !== "tooltip" && !node.querySelector('[role="tooltip"]'))
      blocked = true;
    if (role === "dialog" || role === "alertdialog") dimmed = true;
    const rect = node.getBoundingClientRect();
    // Include the popup border/shadow, clipping to the terminal rectangle.
    const x = Math.max(0, rect.x - bounds.x - 6);
    const y = Math.max(0, rect.y - bounds.y - 6);
    const right = Math.min(bounds.width, rect.x + rect.width - bounds.x + 6);
    const bottom = Math.min(bounds.height, rect.y + rect.height - bounds.y + 6);
    if (right > x && bottom > y)
      overlays.push({ x, y, width: right - x, height: bottom - y });
  }
  return { overlays, blocked, dimmed };
}
