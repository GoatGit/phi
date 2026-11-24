import { beforeAll, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "i18next";
import zh from "@/i18n/locales/zh.json";
import { ResumeSessionField } from "@/components/tasks/ResumeSessionField";
import type { RouterAgent } from "@/lib/api/superAgent";
import type { TaskCard } from "@/lib/api/tasks";
import { listSessions, setSessionFixtures } from "../msw/state";
import { renderWithQueryClient } from "../utils/testQueryClient";

beforeAll(() => {
  // jsdom 没有 scrollIntoView，下拉打开时 Radix 会调它。
  Element.prototype.scrollIntoView = vi.fn();
  i18n.addResourceBundle("zh", "translation", zh, true, true);
});

const agent = (overrides: Partial<RouterAgent> = {}): RouterAgent => ({
  id: "doc-writer",
  name: "文档写手",
  avatar: "",
  description: "",
  appId: "claude",
  prompt: "",
  model: "",
  arguments: [],
  outcome: "",
  boundary: "",
  askUserWhen: [],
  steps: [],
  constraints: [],
  completion: { result: "", evidence: [] },
  ...overrides,
});

const card = (overrides: Partial<TaskCard> = {}): TaskCard => ({
  id: "TASK-1",
  kind: "task",
  sourceTask: null,
  round: null,
  discussionHold: false,
  discussionQuestion: null,
  title: "整理资料",
  status: "To Do",
  assignees: ["doc-writer"],
  session: null,
  priority: null,
  labels: [],
  dependencies: [],
  createdDate: "2026-11-01",
  updatedDate: null,
  acceptanceTotal: 0,
  acceptanceDone: 0,
  artifactCount: 0,
  schedule: null,
  file: "backlog/tasks/task-1.md",
  fingerprint: "1:aa",
  ...overrides,
});

describe("ResumeSessionField", () => {
  it("没指派智能体时只说清缺什么，不摆一个选了也没用的下拉", () => {
    renderWithQueryClient(
      <ResumeSessionField
        task={card({ assignees: [] })}
        agents={[agent()]}
        repoRoot="/mock/claude"
        onSave={vi.fn()}
      />,
    );
    expect(screen.getByText(zh.tasks.session.needsAgent)).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("应用不支持按会话续接时说明原因", () => {
    renderWithQueryClient(
      <ResumeSessionField
        task={card()}
        agents={[agent({ appId: "codex" })]}
        repoRoot="/mock/codex"
        onSave={vi.fn()}
      />,
    );
    expect(
      screen.getByText(/不支持按会话续接/, { exact: false }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("只列同一个应用、同一个仓库里的会话；选中就把 id 交回去", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    renderWithQueryClient(
      <ResumeSessionField
        task={card()}
        agents={[agent()]}
        repoRoot="/mock/claude"
        onSave={onSave}
      />,
    );
    const trigger = screen.getByRole("combobox", {
      name: zh.tasks.session.title,
    });
    await waitFor(() =>
      expect(trigger).toHaveTextContent(zh.tasks.session.new),
    );
    await user.click(trigger);
    // codex 的那条不该出现在 claude 的清单里。
    expect(screen.queryByText("Codex Session One")).toBeNull();
    const option = await screen.findByText("Claude Session One");
    await user.click(option);
    expect(onSave).toHaveBeenCalledWith("claude-session-1");
  });

  it("不把来源仓库不明的会话当作当前仓库的候选", async () => {
    const user = userEvent.setup();
    const known = listSessions().find((item) => item.providerId === "claude")!;
    setSessionFixtures(
      [
        known,
        {
          ...known,
          sessionId: "unknown",
          projectDir: undefined,
          title: "Unknown origin",
        },
      ],
      {},
    );
    renderWithQueryClient(
      <ResumeSessionField
        task={card()}
        agents={[agent()]}
        repoRoot="/mock/claude"
        onSave={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("combobox"));
    expect(await screen.findByText("Claude Session One")).toBeInTheDocument();
    expect(screen.queryByText("Unknown origin")).toBeNull();
  });

  it("改派给不支持续接的应用后仍能解除旧绑定", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    renderWithQueryClient(
      <ResumeSessionField
        task={card({ session: "old-session" })}
        agents={[agent({ appId: "codex" })]}
        repoRoot="/mock/claude"
        onSave={onSave}
      />,
    );
    await user.click(screen.getByRole("button", { name: "取消续接" }));
    expect(onSave).toHaveBeenCalledWith(null);
  });

  it("选回「新建会话」就是取消续接", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    renderWithQueryClient(
      <ResumeSessionField
        task={card({ session: "claude-session-1" })}
        agents={[agent()]}
        repoRoot="/mock/claude"
        onSave={onSave}
      />,
    );
    const trigger = screen.getByRole("combobox", {
      name: zh.tasks.session.title,
    });
    await user.click(trigger);
    await user.click(
      await screen.findByRole("option", { name: zh.tasks.session.new }),
    );
    expect(onSave).toHaveBeenCalledWith(null);
  });

  it("选中的会话已经不在清单里时仍然显示出来", async () => {
    renderWithQueryClient(
      <ResumeSessionField
        task={card({ session: "gone-session" })}
        agents={[agent()]}
        repoRoot="/mock/claude"
        onSave={vi.fn()}
      />,
    );
    expect(await screen.findByText(/gone-session/)).toBeInTheDocument();
  });
});
