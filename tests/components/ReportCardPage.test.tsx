import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReportCardPage } from "@/components/reportcard/ReportCardPage";
import type { ModelScoreboardRow, ReportCard } from "@/lib/api/reportCard";

const apiMocks = vi.hoisted(() => ({
  page: vi.fn(),
}));

vi.mock("@/lib/api/reportCard", () => ({
  reportCardApi: { page: (...args: unknown[]) => apiMocks.page(...args) },
}));

function row(overrides: Partial<ModelScoreboardRow> = {}): ModelScoreboardRow {
  return {
    providerId: "codex",
    model: "gpt-5",
    tasks: 3,
    toolCalls: 8,
    toolFailures: 1,
    interruptions: 1,
    effectiveCalls: 7,
    toolFailureRate: 1 / 7,
    interruptionRate: 1 / 8,
    writeAttempts: 4,
    writeSuccesses: 3,
    deliveryTasks: 6,
    emptyTasks: 0,
    emptyDeliveryRate: 0,
    mixedModelTasks: 0,
    costUsd: 0.4,
    costPerTask: 0.133,
    timedCalls: 8,
    avgStepMs: 1_500,
    exitSamples: 2,
    exitFailures: 0,
    sampleSize: 8,
    sufficient: true,
    lastSeenAt: Date.now(),
    ...overrides,
  };
}

function card(overrides: Partial<ReportCard> = {}): ReportCard {
  return {
    rows: [row()],
    windowDays: 30,
    since: 0,
    generatedAt: Date.now(),
    observationState: "unproven",
    totalTasks: 3,
    providers: 1,
    projects: 1,
    scannedSources: 2,
    sync: {
      scannedSessions: 2,
      parsedSessions: 1,
      unchangedSessions: 1,
      failedSessions: 0,
      droppedSessions: 0,
      skipped: false,
      syncedAt: 0,
      durationMs: 12,
    },
    ...overrides,
  };
}

describe("ReportCardPage", () => {
  beforeEach(() => {
    apiMocks.page.mockResolvedValue(card());
  });

  it("renders rates only when the sample is large enough", async () => {
    apiMocks.page.mockResolvedValue(
      card({
        rows: [
          row(),
          row({
            model: "tiny",
            toolCalls: 3,
            interruptions: 0,
            interruptionRate: 0,
            deliveryTasks: 2,
            emptyDeliveryRate: null,
            sampleSize: 3,
            sufficient: false,
          }),
        ],
      }),
    );

    render(<ReportCardPage />);

    await waitFor(() => expect(screen.getByText("gpt-5")).toBeInTheDocument());
    // 失败率、中断率、空交付率三列都够样本：14.3% / 12.5% / 0.0%
    expect(screen.getAllByText("14.3%")).toHaveLength(1);
    expect(screen.getAllByText("12.5%")).toHaveLength(1);
    expect(screen.getAllByText("0.0%")).toHaveLength(1);
    // 样本不足的模型只报样本量，不给百分比
    expect(screen.getByText("tiny")).toBeInTheDocument();
    expect(
      screen.getAllByText("reportCard.insufficient").length,
    ).toBeGreaterThan(0);
  });

  it("shows the empty state when there are no tasks yet", async () => {
    apiMocks.page.mockResolvedValue(
      card({ rows: [], totalTasks: 0, scannedSources: 0 }),
    );

    render(<ReportCardPage />);

    expect(
      await screen.findByText("reportCard.emptyTitle"),
    ).toBeInTheDocument();
  });

  it("does not also claim the history is empty when loading failed", async () => {
    apiMocks.page.mockRejectedValue(new Error("database is locked"));

    render(<ReportCardPage />);

    expect(
      await screen.findByText("reportCard.loadFailed"),
    ).toBeInTheDocument();
    expect(screen.getByText("database is locked")).toBeInTheDocument();
    // 错误提示旁边再挂一句「还没有可统计的会话」会让人以为是空库
    expect(screen.queryByText("reportCard.emptyTitle")).not.toBeInTheDocument();
  });

  it("keeps the newest window when answers arrive out of order", async () => {
    let resolveWide: (value: ReportCard) => void = () => {};
    let resolveNarrow: (value: ReportCard) => void = () => {};
    apiMocks.page
      .mockReturnValueOnce(
        new Promise<ReportCard>((resolve) => {
          resolveWide = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise<ReportCard>((resolve) => {
          resolveNarrow = resolve;
        }),
      );

    render(<ReportCardPage />);

    // 切到 7 天：三个窗口按钮文案相同（i18n 空资源时就是 key），取第一个
    const [first] = screen.getAllByRole("button", {
      name: "reportCard.windowDays",
    });
    fireEvent.click(first);
    await waitFor(() => expect(apiMocks.page).toHaveBeenCalledTimes(2));

    // 7 天先回，30 天后回：晚到的那份不能把页面改回 30 天
    resolveNarrow(card({ windowDays: 7, rows: [row({ model: "week" })] }));
    await screen.findByText("week");
    resolveWide(card({ rows: [row({ model: "month" })] }));

    await waitFor(() => expect(screen.queryByText("month")).toBeNull());
    expect(screen.getByText("week")).toBeInTheDocument();
  });

  it("labels every scoreboard as reliability, not quality", async () => {
    render(<ReportCardPage />);

    await waitFor(() => expect(apiMocks.page).toHaveBeenCalled());
    expect(screen.getByText("reportCard.unprovenTitle")).toBeInTheDocument();
    expect(screen.getByText("reportCard.footnote")).toBeInTheDocument();
  });
});
