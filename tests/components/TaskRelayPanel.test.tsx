import { fireEvent, render, screen } from "@testing-library/react";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { TaskRelayPanel } from "@/components/tasks/TaskRelayPanel";
import type { RelayRun, RelayView } from "@/lib/api/orchestration";
import zh from "@/i18n/locales/zh.json";

const i18n = createInstance();

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: "zh",
    resources: { zh: { translation: zh } },
    interpolation: { escapeValue: false },
  });
});

function run(overrides: Partial<RelayRun> = {}): RelayRun {
  return {
    id: "run-1",
    gate: 2,
    status: "pass",
    baseCommit: "10466fa",
    createdAt: 1_700_000_000_000,
    durationMs: 1234,
    evidence: {
      steps: [
        {
          cmd: "cargo test",
          expectExit: 0,
          exitCode: 0,
          timedOut: false,
          durationMs: 1200,
          outputTail: "test result: ok. 25 passed",
        },
      ],
      changed: ["src/auth/login.rs"],
      violations: [],
      claims: [],
      note: null,
    },
    ...overrides,
  };
}

function relay(overrides: Partial<RelayView> = {}): RelayView {
  return {
    taskId: "TASK-1",
    contract: {
      accept: [{ cmd: "cargo test", expectExit: 0, timeoutMinutes: null }],
      touched: ["src/auth/**"],
      forbidden: ["package.json"],
      role: "implement",
      base: null,
      maxTokens: null,
      maxMinutes: 30,
      warnings: [],
      ready: true,
    },
    verdict: { gate2: "pass", at: "2026-11-13 02:40", base: "10466fa" },
    runs: [],
    reviewClaims: 0,
    changed: ["src/auth/login.rs"],
    warnings: [],
    ...overrides,
  };
}

function renderPanel(
  view: RelayView,
  onRunGate: (gate: 2 | 3) => void = vi.fn(),
  busy = false,
) {
  render(
    <I18nextProvider i18n={i18n}>
      <TaskRelayPanel relay={view} busy={busy} onRunGate={onRunGate} />
    </I18nextProvider>,
  );
  return onRunGate;
}

describe("TaskRelayPanel", () => {
  it("没有契约时说明缺什么，并且门 2 不能跑", () => {
    renderPanel(
      relay({
        contract: {
          accept: [],
          touched: [],
          forbidden: [],
          role: null,
          base: null,
          maxTokens: null,
          maxMinutes: null,
          warnings: [],
          ready: false,
        },
        verdict: {},
      }),
    );

    expect(screen.getByText(/没有 phi 契約|没有 phi 契约/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "跑门 2" })).toBeDisabled();
    // 门 3 只看复查意见，没有验收命令也能跑
    expect(screen.getByRole("button", { name: "跑门 3" })).toBeEnabled();
    expect(screen.getByText("还没跑过门判定。")).toBeInTheDocument();
  });

  it("展示契约、结论与最近一次判定的证据", () => {
    renderPanel(relay({ runs: [run()] }));

    expect(screen.getByText("通过")).toBeInTheDocument();
    expect(screen.getByText("未跑")).toBeInTheDocument();
    expect(screen.getByText("src/auth/**")).toBeInTheDocument();
    expect(screen.getByText("package.json")).toBeInTheDocument();
    expect(screen.getByText("1 个文件")).toBeInTheDocument();
    expect(
      screen.getByText("最近一次判定：门 2，耗时 1234ms"),
    ).toBeInTheDocument();
    expect(screen.getByText("test result: ok. 25 passed")).toBeInTheDocument();
    expect(screen.getByText("退出码 0（期望 0）")).toBeInTheDocument();
  });

  it("越界改动按规则名标出来", () => {
    renderPanel(
      relay({
        verdict: { gate2: "fail" },
        runs: [
          run({
            status: "fail",
            evidence: {
              steps: [],
              changed: ["src/billing/invoice.rs"],
              violations: [
                { path: "src/billing/invoice.rs", rule: "out-of-scope" },
                { path: "package.json", rule: "forbidden" },
              ],
              claims: [],
              note: "有文件越界",
            },
          }),
        ],
      }),
    );

    expect(screen.getByText("未通过")).toBeInTheDocument();
    expect(screen.getByText("越界")).toBeInTheDocument();
    expect(screen.getByText("src/billing/invoice.rs")).toBeInTheDocument();
    // 契约里的「禁止改动」标签 + 越界条目上的规则名
    expect(screen.getAllByText("禁止改动")).toHaveLength(2);
    expect(screen.getByText("有文件越界")).toBeInTheDocument();
  });

  it("点按钮把门号交给上层，忙的时候不重复触发", () => {
    const onRunGate = renderPanel(relay());
    fireEvent.click(screen.getByRole("button", { name: "跑门 2" }));
    fireEvent.click(screen.getByRole("button", { name: "跑门 3" }));
    expect(onRunGate).toHaveBeenNthCalledWith(1, 2);
    expect(onRunGate).toHaveBeenNthCalledWith(2, 3);

    render(
      <I18nextProvider i18n={i18n}>
        <TaskRelayPanel relay={relay()} busy onRunGate={vi.fn()} />
      </I18nextProvider>,
    );
    const disabled = screen.getAllByRole("button", { name: "跑门 2" }).at(-1)!;
    expect(disabled).toBeDisabled();
  });
});
