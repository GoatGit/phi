import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SearchField } from "@/components/ui/search-field";

function setup(value = "", collapsible = true) {
  const onValueChange = vi.fn();
  const utils = render(
    <SearchField
      collapsible={collapsible}
      value={value}
      onValueChange={onValueChange}
      placeholder="Search items"
      aria-label="Search items"
      clearLabel="Clear search"
    />,
  );
  return { onValueChange, ...utils };
}

describe("SearchField collapsible", () => {
  it("keeps the same accessible textbox when collapsed", () => {
    setup();
    const input = screen.getByRole("textbox", { name: "Search items" });
    // 折叠态：容器收窄成图标位（w-9），但输入框与 aria 不变
    const container = input.parentElement as HTMLElement;
    expect(container.className).toContain("w-9");
    fireEvent.change(input, { target: { value: "alpha" } });
    expect(screen.getByRole("textbox")).toBe(input);
  });

  it("expands while focused and collapses again after blur when empty", () => {
    setup();
    const input = screen.getByRole("textbox", { name: "Search items" });
    const container = input.parentElement as HTMLElement;

    fireEvent.focus(input);
    expect(container.className).not.toContain("w-9");

    fireEvent.blur(input);
    expect(container.className).toContain("w-9");
  });

  it("stays expanded while holding a value even after blur", () => {
    setup("alpha");
    const input = screen.getByRole("textbox", { name: "Search items" });
    const container = input.parentElement as HTMLElement;
    fireEvent.blur(input);
    expect(container.className).not.toContain("w-9");
    // 有值时清除按钮可见
    expect(screen.getByRole("button", { name: "Clear search" })).toBeVisible();
  });

  it("does not collapse when collapsible is off (default behavior)", () => {
    setup("", false);
    const input = screen.getByRole("textbox", { name: "Search items" });
    const container = input.parentElement as HTMLElement;
    fireEvent.blur(input);
    expect(container.className).not.toContain("w-9");
  });
});
