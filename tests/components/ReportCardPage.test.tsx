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

    await waitFor(() =>
      expect(screen.getAllByText("gpt-5").length).toBeGreaterThan(0),
    );
    // 失败率、中断率、空交付率三列都够样本：14.3% / 12.5% / 0.0%
    // （表格一行，分布图每行一个标注，所以各可能不止一处）
    expect(screen.getAllByText("14.3%").length).toBeGreaterThan(0);
    expect(screen.getAllByText("12.5%").length).toBeGreaterThan(0);
    expect(screen.getAllByText("0.0%").length).toBeGreaterThan(0);
    // 样本不足的模型只报样本量，不给百分比
    expect(screen.getByText("tiny")).toBeInTheDocument();
    expect(
      screen.getAllByText("reportCard.insufficient").length,
    ).toBeGreaterThan(0);
  });

  it("drops its own page header when embedded as a plugin tab", async () => {
    render(<ReportCardPage embedded />);

    await waitFor(() =>
      expect(screen.getAllByText("gpt-5").length).toBeGreaterThan(0),
    );
    // 页头由插件中心提供；内层不再画一个标题，也不占用 main-content
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: "reportCard.windowDays" }),
    ).toHaveLength(3);
    expect(document.querySelectorAll("#main-content")).toHaveLength(0);
  });

  it("gives the table a wide page so it fits without a scrollbar", async () => {
    const { container } = render(<ReportCardPage embedded />);

    await waitFor(() => expect(screen.getByRole("table")).toBeInTheDocument());
    // 表格页用 1080 版心、表格不再强制 880 最小宽：九列在版心内铺开
    expect(container.firstElementChild?.className).toContain("max-w-[1080px]");
    expect(screen.getByRole("table").className).not.toContain("min-w-[880px]");
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
    await waitFor(() =>
      expect(screen.getAllByText("week").length).toBeGreaterThan(0),
    );
    resolveWide(card({ rows: [row({ model: "month" })] }));

    await waitFor(() => expect(screen.queryByText("month")).toBeNull());
    expect(screen.getAllByText("week").length).toBeGreaterThan(0);
  });

  it("labels every scoreboard as reliability, not quality", async () => {
    render(<ReportCardPage />);

    await waitFor(() => expect(apiMocks.page).toHaveBeenCalled());
    const caveat = screen.getByText("reportCard.unprovenTitle");
    const table = screen.getByRole("table");
    // 说明压在表格下面，不再顶在上方占一条黄色警告
    expect(
      table.compareDocumentPosition(caveat) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(caveat.closest(".bg-warning-soft")).toBeNull();
    expect(screen.getByText("reportCard.footnote")).toBeInTheDocument();
  });

  // 首屏要有可视化，否则表格下面大片空白、对比只能一行行看。
  it("puts a distribution chart above the table", async () => {
    render(<ReportCardPage embedded />);

    await waitFor(() => expect(screen.getByRole("table")).toBeInTheDocument());
    const caption = screen.getByText("reportCard.chart.title");
    const table = screen.getByRole("table");
    expect(
      caption.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  // 语义色只在越过阈值时出现，避免满屏染色。
  it("colours only the rates that cross a threshold", async () => {
    apiMocks.page.mockResolvedValue(
      card({
        rows: [
          row({ model: "steady", toolFailureRate: 0.01, interruptionRate: 0 }),
          row({ model: "risky", toolFailureRate: 0.2, interruptionRate: 0.1 }),
        ],
      }),
    );

    render(<ReportCardPage embedded />);

    // 稳定模型的失败率不上色（低于阈值），分布图里的那个是图表文字
    const steadyCells = await screen.findAllByText("1.0%");
    expect(steadyCells[0].className).toContain("text-fg-1");
    // 表格里的 20.0% 与分布图里的同一个数都存在，表格那个带语义色
    const risky = screen
      .getAllByText("20.0%")
      .find((node) => node.className.includes("text-danger-text"));
    expect(risky).toBeDefined();
  });
});
