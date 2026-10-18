import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppRouteRow } from "./AppRouteRow";

describe("AppRouteRow", () => {
  it("renders the app name and the current target as one scannable row", () => {
    render(
      <ul>
        <AppRouteRow app="claude" control={<button>更改</button>}>
          krill · Zhipu GLM
        </AppRouteRow>
      </ul>,
    );

    const row = screen.getByRole("listitem");
    expect(row).toHaveTextContent("Claude");
    expect(row).toHaveTextContent("krill · Zhipu GLM");
  });

  it("keeps the control after the text so it reads last and aligns to the right", () => {
    render(
      <ul>
        <AppRouteRow app="codex" control={<button>更改</button>}>
          default
        </AppRouteRow>
      </ul>,
    );

    const row = screen.getByRole("listitem");
    const control = screen.getByRole("button", { name: "更改" });
    expect(row.lastElementChild).toContainElement(control);
  });
});
