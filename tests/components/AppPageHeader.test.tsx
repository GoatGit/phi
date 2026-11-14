import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppPageHeader } from "@/components/shell/AppPageHeader";

/**
 * 页头的操作区永远贴最右端。
 *
 * 这里守的是那条撑开的占位：它一旦退回固定宽度，页签后面的按钮就会停在
 * 页签旁边（插件页的「钉在侧栏」就是这么跑偏的），而页头本身看不出报错。
 */
describe("AppPageHeader — 操作区位置", () => {
  it("有页签也有操作时，操作区被推到页头最右端", () => {
    render(
      <AppPageHeader
        title={null}
        tabs={<span>页签</span>}
        actions={<button type="button">钉在侧栏</button>}
      />,
    );

    const actions = screen.getByRole("button", {
      name: "钉在侧栏",
    }).parentElement;
    expect(actions?.previousElementSibling?.className).toContain("flex-1");
  });

  it("只有页签、没有操作时，页签后面是一条窄缝，不把页签行拉满", () => {
    const { container } = render(
      <AppPageHeader title={null} tabs={<span>页签</span>} />,
    );

    const header = container.querySelector("header");
    expect(header?.querySelector(":scope > div.w-5")).not.toBeNull();
    expect(header?.querySelector(":scope > div.flex-1")).toBeNull();
  });

  it("没有页签的老页面仍然靠撑开的占位把操作区推到右边", () => {
    render(
      <AppPageHeader
        title="用量"
        actions={<button type="button">刷新</button>}
      />,
    );

    const actions = screen.getByRole("button", { name: "刷新" }).parentElement;
    expect(actions?.previousElementSibling?.className).toContain("flex-1");
  });
});
