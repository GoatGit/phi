import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppHomePage, type AppHomeTile } from "@/components/app/AppHomePage";
import { Home, Route } from "lucide-react";

const tiles: AppHomeTile[] = [
  { key: "providers", label: "供应商", icon: Home, onSelect: vi.fn() },
  {
    key: "routing",
    label: "路由",
    icon: Route,
    disabled: true,
    onSelect: vi.fn(),
  },
];

describe("AppHomePage", () => {
  it("renders one tile per capability and ignores disabled ones", () => {
    render(<AppHomePage tiles={tiles} />);

    const providers = screen.getByRole("button", { name: "供应商" });
    expect(providers).toBeEnabled();
    fireEvent.click(providers);
    expect(tiles[0].onSelect).toHaveBeenCalledTimes(1);

    expect(screen.getByRole("button", { name: "路由" })).toBeDisabled();
  });

  it("renders exactly nine tiles in the 3-column grid for full-capability apps", () => {
    const nine: AppHomeTile[] = Array.from({ length: 9 }, (_, i) => ({
      key: `tile-${i}`,
      label: `宫格${i}`,
      icon: Home,
      onSelect: vi.fn(),
    }));
    const { container } = render(<AppHomePage tiles={nine} />);
    expect(container.querySelectorAll("button")).toHaveLength(9);
  });

  // 主宫格是这一页唯一的视觉落点：要单独排在网格之前，并带上那句说明。
  it("lifts the primary tile out of the grid and shows its hint", () => {
    const withPrimary: AppHomeTile[] = [
      {
        key: "terminal",
        label: "打开终端",
        icon: Home,
        hint: "在托管终端里新开一个会话",
        primary: true,
        onSelect: vi.fn(),
      },
      ...tiles,
    ];
    const { container } = render(<AppHomePage tiles={withPrimary} />);

    expect(screen.getByText("在托管终端里新开一个会话")).toBeInTheDocument();

    const primary = screen.getByRole("button", { name: /打开终端/ });
    const grid = container.querySelector("ul")!;
    // 主宫格不能出现在网格里，否则又变回「等大格子」
    expect(grid.contains(primary)).toBe(false);
    expect(container.querySelectorAll("button")).toHaveLength(3);
  });
});
