import { describe, expect, it } from "vitest";
import { wirePath, wirePathTo } from "@/components/flow/flowWires";

/** 编制图里最常见的一种落点：节点在左、目标在右，只有中心有用。 */
const node = { right: 100, top: 0, bottom: 40, cy: 20 };

describe("wirePathTo", () => {
  it("在源节点这一侧散开，目标端只落在一点", () => {
    const d = wirePathTo(node, { left: 160, cy: 70 }, 6);
    // 起点带着扇出偏移（20 + 6），终点就是目标中心（70），不受偏移影响
    expect(d.startsWith("M 100 26 ")).toBe(true);
    expect(d.endsWith("160 70")).toBe(true);
  });

  it("扇出再大也收在节点边缘之内", () => {
    const d = wirePathTo(node, { left: 160, cy: 70 }, 999);
    // 收在 下缘 - 8 的余量上，而不是飘到节点外面
    expect(d.startsWith("M 100 32 ")).toBe(true);
  });

  it("与一根线落到同一个目标的写法不同：那边两端都会错开", () => {
    // wirePath 两端各带偏移，落到「卡堆中间」时几张卡会看到同一条线；
    // wirePathTo 只在出发处散开，所以每张卡各得一根。
    const target = { left: 160, top: 50, bottom: 90, cy: 70 };
    expect(wirePath(node, target, 6)).toContain("160 76");
    expect(wirePathTo(node, target, 6)).toContain("160 70");
  });
});
