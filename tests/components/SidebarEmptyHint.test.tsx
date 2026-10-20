import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EMPTY_APPS_HINT_MS,
  SidebarEmptyHint,
} from "@/components/shell/SidebarEmptyHint";

describe("SidebarEmptyHint", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("hides itself after a few seconds instead of staying in the sidebar", () => {
    render(<SidebarEmptyHint visible />);
    expect(screen.getByText("nav.emptyAppsHint")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(EMPTY_APPS_HINT_MS - 1);
    });
    expect(screen.getByText("nav.emptyAppsHint")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByText("nav.emptyAppsHint")).not.toBeInTheDocument();
  });

  it("stays out of the way while the sidebar already has apps", () => {
    render(<SidebarEmptyHint visible={false} />);
    expect(screen.queryByText("nav.emptyAppsHint")).not.toBeInTheDocument();
  });

  it("prompts again when the list becomes empty a second time", () => {
    const { rerender } = render(<SidebarEmptyHint visible={false} />);
    rerender(<SidebarEmptyHint visible />);
    expect(screen.getByText("nav.emptyAppsHint")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(EMPTY_APPS_HINT_MS);
    });
    expect(screen.queryByText("nav.emptyAppsHint")).not.toBeInTheDocument();

    // 加了应用再移除最后一个：重新提示，并重新开始计时
    rerender(<SidebarEmptyHint visible={false} />);
    rerender(<SidebarEmptyHint visible />);
    expect(screen.getByText("nav.emptyAppsHint")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(EMPTY_APPS_HINT_MS);
    });
    expect(screen.queryByText("nav.emptyAppsHint")).not.toBeInTheDocument();
  });
});
