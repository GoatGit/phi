import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "i18next";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import zh from "@/i18n/locales/zh.json";
import { LessonsPanel } from "@/components/plugins/LessonsPanel";
import type { Lesson, LessonOverview, LessonState } from "@/lib/api/lessons";

const apiMocks = vi.hoisted(() => ({
  overview: vi.fn(),
  scan: vi.fn(),
  state: vi.fn(),
}));

vi.mock("@/lib/api/lessons", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/lessons")>();
  return {
    ...actual,
    lessonsApi: {
      ...actual.lessonsApi,
      overview: () => apiMocks.overview(),
      scan: () => apiMocks.scan(),
      state: (root: string) => apiMocks.state(root),
    },
  };
});

beforeAll(() => {
  i18n.addResourceBundle("zh", "translation", zh, true, true);
});

const lesson = (id: string): Lesson => ({
  id,
  paths: ["src-tauri/src/lessons/detect.rs"],
  trigger: "`cargo test` 退出码 1",
  evidence: "codex 会话 abcdef12（2026-11-13）",
  nextStep: "下次：先跑 `cargo test` 确认基线",
  hits: 2,
  firstSeen: 1_700_000_000_000,
  lastSeen: 1_700_000_000_000,
  apps: ["codex"],
  dismissed: false,
});

const state = (root: string, lessons: Lesson[]): LessonState => ({
  root,
  lessons,
  injection: {
    enabled: false,
    file: "AGENTS.md",
    version: 0,
    usedChars: 0,
    budgetChars: 500,
    applied: false,
  },
  scannedSessions: 12,
  pendingSessions: 0,
  failures: lessons.length,
});

const overview: LessonOverview = {
  projects: [
    {
      root: "/work/phi",
      name: "phi",
      state: state("/work/phi", [lesson("a")]),
    },
    {
      root: "/work/quiet",
      name: "quiet",
      state: state("/work/quiet", []),
    },
  ],
  scannedProjects: 2,
  scannedSessions: 12,
  pendingSessions: 0,
  failures: 1,
  lastScanAt: 1_700_000_000_000,
};

describe("lessons panel", () => {
  beforeEach(() => {
    apiMocks.overview.mockResolvedValue(overview);
    apiMocks.scan.mockResolvedValue(overview);
  });

  it("lists every discovered repository without asking which one to scan", async () => {
    render(<LessonsPanel />);

    // 仓库自己就列出来了，没有「选一个仓库」这一步
    expect(await screen.findByText("phi")).toBeInTheDocument();
    expect(screen.getByText("/work/phi")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();

    // 没有失败记录的仓库不占版面，但计数照样说清扫到了几个
    expect(screen.queryByText("quiet")).not.toBeInTheDocument();
    expect(screen.getByText(/已发现 2 个仓库/)).toBeInTheDocument();
  });

  it("shows the lesson under its own repository with the hit count", async () => {
    render(<LessonsPanel />);

    expect(
      await screen.findByText("`cargo test` 退出码 1"),
    ).toBeInTheDocument();
    expect(screen.getByText("1 条")).toBeInTheDocument();
    expect(screen.getByText("命中 2 次")).toBeInTheDocument();
  });

  it("scans all sessions in one click", async () => {
    render(<LessonsPanel />);
    const user = userEvent.setup();

    await screen.findByText("phi");
    // 页尾说明：作用与用法都在，不只是一张清单
    expect(
      screen.getByRole("heading", { name: "这个插件做什么" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/整理成仓库级的清单/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /扫描全部会话/ }));

    expect(apiMocks.scan).toHaveBeenCalledTimes(1);
  });
});
