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
});
