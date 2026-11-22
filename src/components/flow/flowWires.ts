/**
 * 流程图连线的几何基础：节点实测盒子 + 贝塞尔路径。
 *
 * 这里只放「怎么算」，不放「画什么」：流转图（网关）与编制图（任务看板）
 * 各画各的节点，但都要让线贴着节点的真实边缘。抽出来共用，才不会一边改了
 * 边缘余量、另一边还按老算法画。
 *
 * 线一律由实测坐标算，不手摆：窗口缩放、卡片增减、换语言之后，节点的位置
 * 都会变，写死坐标的线立刻飘到空白处。
 */

/** 节点在画布坐标系里的盒子。 */
export type NodeBox = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  cy: number;
};

export const round1 = (value: number) => Math.round(value * 10) / 10;

export function boxOf(el: Element, stage: DOMRect): NodeBox {
  const rect = el.getBoundingClientRect();
  return {
    left: round1(rect.left - stage.left),
    top: round1(rect.top - stage.top),
    right: round1(rect.right - stage.left),
    bottom: round1(rect.bottom - stage.top),
    cy: round1(rect.top + rect.height / 2 - stage.top),
  };
}

/**
 * 量一个画布里所有带 `data-flow-node` 的节点。
 *
 * 一个属性管全部节点，而不是按种类分别查：两类图的节点种类不同，但「量盒子」
 * 这一步是同一件事。
 */
export function readNodeBoxes(
  stage: HTMLElement,
  attribute = "data-flow-node",
): { width: number; height: number; boxes: Map<string, NodeBox> } {
  const stageBox = stage.getBoundingClientRect();
  const boxes = new Map<string, NodeBox>();
  stage.querySelectorAll<HTMLElement>(`[${attribute}]`).forEach((el) => {
    const key = el.getAttribute(attribute);
    if (key) boxes.set(key, boxOf(el, stageBox));
  });
  return {
    width: round1(stageBox.width),
    height: round1(stageBox.height),
    boxes,
  };
}

export const sameBox = (a?: NodeBox, b?: NodeBox) =>
  a === b ||
  (!!a &&
    !!b &&
    a.left === b.left &&
    a.top === b.top &&
    a.right === b.right &&
    a.bottom === b.bottom &&
    a.cy === b.cy);

export function sameBoxes(
  a: Map<string, NodeBox>,
  b: Map<string, NodeBox>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [key, box] of a) {
    if (!sameBox(box, b.get(key))) return false;
  }
  return true;
}

/** 连线在节点边缘上的落点与节点圆角之间保留的余量：扇出再大也不会画到
 *  节点外面去。 */
export const WIRE_EDGE_INSET = 8;

/** 平行线之间的间距。 */
export const WIRE_FAN_GAP = 5;

type WireEnd = Pick<NodeBox, "cy"> & Partial<Pick<NodeBox, "top" | "bottom">>;

/** 线在节点上的落点：节点纵轴中心加上这条线的扇出偏移，并收在节点边缘
 *  之内。偏移一旦超出节点高度，线就会飘到节点上下的空白处。 */
export function edgeY(box: WireEnd, offset: number): number {
  const y = box.cy + offset;
  if (box.top == null || box.bottom == null) return round1(y);
  const inset = Math.min(WIRE_EDGE_INSET, (box.bottom - box.top) / 4);
  return round1(Math.min(Math.max(y, box.top + inset), box.bottom - inset));
}

/** Horizontal cubic that leaves the source's right edge and lands exactly
 *  on the target's left edge. Pure function so the shape stays testable. */
export function wirePath(
  from: Pick<NodeBox, "right"> & WireEnd,
  to: Pick<NodeBox, "left"> & WireEnd,
  offset = 0,
): string {
  const x1 = round1(from.right);
  const y1 = edgeY(from, offset);
  const x2 = round1(to.left);
  const y2 = edgeY(to, offset);
  const bend = round1(Math.max(18, (x2 - x1) * 0.45));
  return `M ${x1} ${y1} C ${round1(x1 + bend)} ${y1}, ${round1(x2 - bend)} ${y2}, ${x2} ${y2}`;
}

/**
 * 水平 cubic：在源节点这一侧把线错开，目标端只落在一点。
 *
 * 一个节点连着多条线时（编制图里「它的每一张卡」），线若从同一点出发会叠成
 * 一条；卡那一侧不需要错开——每张卡自己就是一个落点。
 */
export function wirePathTo(
  from: Pick<NodeBox, "right"> & WireEnd,
  to: Pick<NodeBox, "left" | "cy">,
  offset = 0,
): string {
  const x1 = round1(from.right);
  const y1 = edgeY(from, offset);
  const x2 = round1(to.left);
  const y2 = round1(to.cy);
  const bend = round1(Math.max(18, (x2 - x1) * 0.45));
  return `M ${x1} ${y1} C ${round1(x1 + bend)} ${y1}, ${round1(x2 - bend)} ${y2}, ${x2} ${y2}`;
}
