/**
 * 终端分屏的窗格树：一棵二叉树，叶子是窗格（会话），内部节点是按轴切割的布局。
 * left/right 分屏沿 x 轴并排，up/down 分屏沿 y 轴上下堆叠；连续同向分屏嵌套二分
 * （与 Ghostty 行事一致）。纯函数便于单测。
 */

export type SplitDirection = "left" | "right" | "up" | "down";

export type SplitNode =
  | { kind: "pane"; id: string }
  | {
      kind: "split";
      /** x = 左右并排，y = 上下堆叠 */
      axis: "x" | "y";
      /** first 分到的比例（0.1–0.9），拖拽分隔条调整 */
      ratio: number;
      first: SplitNode;
      second: SplitNode;
    };

export const PANE_MIN_RATIO = 0.1;
export const PANE_MAX_RATIO = 0.9;

const clampRatio = (value: number) =>
  Math.min(PANE_MAX_RATIO, Math.max(PANE_MIN_RATIO, value));

/** 从根到叶的深度优先顺序，即窗格的视觉顺序（左→右、上→下） */
export function paneIds(tree: SplitNode): string[] {
  if (tree.kind === "pane") return [tree.id];
  return [...paneIds(tree.first), ...paneIds(tree.second)];
}

export function contains(tree: SplitNode, id: string): boolean {
  return paneIds(tree).includes(id);
}

/**
 * 在 targetId 所在窗格旁开新窗格：target 窗格被替换为 split 节点，
 * 新窗格按方向放在前（left/up）或后（right/down），初始 50/50。
 */
export function splitAt(
  tree: SplitNode,
  targetId: string,
  direction: SplitDirection,
  newId: string,
): SplitNode {
  if (tree.kind === "pane") {
    if (tree.id !== targetId) return tree;
    const axis = direction === "left" || direction === "right" ? "x" : "y";
    const fresh: SplitNode = { kind: "pane", id: newId };
    const existing: SplitNode = { kind: "pane", id: tree.id };
    return {
      kind: "split",
      axis,
      ratio: 0.5,
      first: direction === "left" || direction === "up" ? fresh : existing,
      second: direction === "left" || direction === "up" ? existing : fresh,
    };
  }
  return {
    ...tree,
    first: splitAt(tree.first, targetId, direction, newId),
    second: splitAt(tree.second, targetId, direction, newId),
  };
}

/** 移除一个窗格：只剩单孩子的 split 折叠；整树只剩目标时返回 null */
export function removePane(tree: SplitNode, id: string): SplitNode | null {
  if (tree.kind === "pane") return tree.id === id ? null : tree;
  const first = removePane(tree.first, id);
  const second = removePane(tree.second, id);
  if (!first && !second) return null;
  if (!first) return second;
  if (!second) return first;
  return { ...tree, first, second };
}

/**
 * 分隔条的路径：每层取 0（进 first）/ 1（进 second）到该分隔节点为止；
 * 根分隔条是 ""，first 侧下层的分隔条是 "0…"。
 */
export type DividerPath = string;

export function dividerPaths(tree: SplitNode): DividerPath[] {
  if (tree.kind === "pane") return [];
  return [
    "",
    ...dividerPaths(tree.first).map((path) => `0${path}`),
    ...dividerPaths(tree.second).map((path) => `1${path}`),
  ];
}

/** 按路径设置该分隔节点 first 的占比（夹在 0.1–0.9） */
export function setRatioAtPath(
  tree: SplitNode,
  path: DividerPath,
  ratio: number,
): SplitNode {
  if (tree.kind === "pane") return tree;
  if (!path) return { ...tree, ratio: clampRatio(ratio) };
  const rest = path.slice(1);
  return path[0] === "0"
    ? { ...tree, first: setRatioAtPath(tree.first, rest, ratio) }
    : { ...tree, second: setRatioAtPath(tree.second, rest, ratio) };
}

/** 视觉顺序里相对 fromId 的下一个（1）/上一个（-1）窗格；单窗格或未知 id 返回 null */
export function navigatePane(
  tree: SplitNode,
  fromId: string,
  delta: 1 | -1,
): string | null {
  const ids = paneIds(tree);
  const index = ids.indexOf(fromId);
  if (index < 0 || ids.length < 2) return null;
  return ids[(index + delta + ids.length) % ids.length];
}

/** 树里除根以外的窗格（分屏产生的子窗格）：页签栏不把它们列为独立标签页 */
export function childPaneIds(rootId: string, tree: SplitNode | null): string[] {
  if (!tree || tree.kind === "pane") return [];
  return paneIds(tree).filter((id) => id !== rootId);
}
