import { describe, expect, it } from "vitest";
import {
  childPaneIds,
  contains,
  dividerPaths,
  navigatePane,
  paneIds,
  removePane,
  setRatioAtPath,
  splitAt,
  type SplitNode,
} from "@/components/terminal/splitTree";

const pane = (id: string): SplitNode => ({ kind: "pane", id });

describe("splitTree", () => {
  it("splits a single pane right: new pane goes second on the x axis", () => {
    const tree = splitAt(pane("a"), "a", "right", "b");
    expect(tree).toEqual({
      kind: "split",
      axis: "x",
      ratio: 0.5,
      first: pane("a"),
      second: pane("b"),
    });
    expect(paneIds(tree)).toEqual(["a", "b"]);
  });

  it("splits up and left: new pane takes the first slot on the y/x axis", () => {
    expect(splitAt(pane("a"), "a", "up", "b")).toEqual({
      kind: "split",
      axis: "y",
      ratio: 0.5,
      first: pane("b"),
      second: pane("a"),
    });
    const left = splitAt(pane("a"), "a", "left", "b");
    expect(left.kind === "split" && left.first).toEqual(pane("b"));
  });

  it("nests: splitting a child pane leaves the sibling untouched", () => {
    // a | (b 下加 c)
    let tree = splitAt(pane("a"), "a", "right", "b");
    tree = splitAt(tree, "b", "down", "c");
    expect(paneIds(tree)).toEqual(["a", "b", "c"]);
    expect(contains(tree, "c")).toBe(true);
    // 根仍是 x 轴
    expect(tree.kind === "split" && tree.axis).toBe("x");
    // b 的格子内部是 y 轴
    const right = tree.kind === "split" ? tree.second : tree;
    expect(right.kind === "split" && right.axis).toBe("y");
  });

  it("splitting an unknown id is a no-op", () => {
    const tree = splitAt(pane("a"), "missing", "right", "b");
    expect(tree).toEqual(pane("a"));
  });

  it("removing a middle pane collapses single-child splits", () => {
    let tree = splitAt(pane("a"), "a", "right", "b");
    tree = splitAt(tree, "b", "down", "c");
    // 去掉 b：a 与 c 变成直接 x 轴邻居
    const afterB = removePane(tree, "b");
    expect(afterB && paneIds(afterB)).toEqual(["a", "c"]);
    // 再去掉 c：回到单窗格
    const afterC = afterB ? removePane(afterB, "c") : null;
    expect(afterC && afterC.kind).toBe("pane");
    // 去掉最后一个 = 整树清空
    expect(removePane(pane("a"), "a")).toBeNull();
  });

  it("navigates panes in visual order, cyclically", () => {
    let tree = splitAt(pane("a"), "a", "right", "b");
    tree = splitAt(tree, "b", "down", "c"); // 顺序 a b c
    expect(navigatePane(tree, "a", 1)).toBe("b");
    expect(navigatePane(tree, "c", 1)).toBe("a");
    expect(navigatePane(tree, "a", -1)).toBe("c");
    expect(navigatePane(tree, "missing", 1)).toBeNull();
    expect(navigatePane(pane("a"), "a", 1)).toBeNull();
  });

  it("tracks dividers by path and clamps ratios", () => {
    let tree = splitAt(pane("a"), "a", "right", "b");
    tree = splitAt(tree, "b", "down", "c");
    const paths = dividerPaths(tree).sort();
    // 根分隔条 + b/c 之间那条（右侧首层，路径 "1"）
    expect(paths).toEqual(["", "1"]);
    const adjusted = setRatioAtPath(tree, "1", 0.99);
    expect(adjusted.kind === "split").toBe(true);
    if (adjusted.kind === "split") {
      // 根比例不动，路径指向的 b/c 节点被夹到上限
      expect(adjusted.ratio).toBe(0.5);
      expect(adjusted.second.kind === "split" && adjusted.second.ratio).toBe(
        0.9,
      );
    }
    expect(setRatioAtPath(pane("a"), "", 0.5)).toEqual(pane("a"));
  });

  it("childPaneIds lists split children so tab bars can exclude them", () => {
    expect(childPaneIds("a", null)).toEqual([]);
    expect(childPaneIds("a", pane("a"))).toEqual([]);
    let tree = splitAt(pane("a"), "a", "right", "b");
    tree = splitAt(tree, "b", "down", "c");
    expect(childPaneIds("a", tree)).toEqual(["b", "c"]);
  });
});
