import { describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import i18n from "i18next";
import { beforeAll } from "vitest";
import zh from "@/i18n/locales/zh.json";
import { TaskDetailSheet } from "@/components/tasks/TaskDetailSheet";
import { renderWithQueryClient } from "../utils/testQueryClient";
import type { TaskCard, TaskDetail } from "@/lib/api/tasks";

beforeAll(() => {
  // jsdom 没有 scrollIntoView，下拉打开时 Radix 会调它。
  Element.prototype.scrollIntoView = vi.fn();
  i18n.addResourceBundle("zh", "translation", zh, true, true);
});

const task: TaskCard = {
  id: "TASK-1",
  kind: "task",
  sourceTask: null,
  round: null,
  discussionHold: false,
  discussionQuestion: null,
  title: "芳芳说的发生",
  status: "To Do",
  assignees: [],
  priority: "medium",
  labels: [],
  dependencies: [],
  createdDate: "2026-11-13",
  updatedDate: null,
  acceptanceTotal: 0,
  acceptanceDone: 0,
  artifactCount: 0,
  schedule: null,
  session: null,
  file: "backlog/tasks/task-1.md",
  fingerprint: "12:abcd",
};

const detail: TaskDetail = {
  task,
  body: "",
  sections: [],
  acceptance: [],
  links: [],
  outcome: null,
  confirmed: null,
  derived: [],
  artifacts: [],
  discussionTurns: [],
};

function renderSheet(
  overrides: Partial<Parameters<typeof TaskDetailSheet>[0]> = {},
) {
  const onClose = vi.fn();
  const onAutoStart = vi.fn();
  render(
    <TaskDetailSheet
      detail={detail}
      statuses={["To Do", "In Progress", "Done"]}
      busy={false}
      run={undefined}
      onSetSchedule={vi.fn()}
      onRevealArtifact={vi.fn()}
      onClose={onClose}
      onAutoStart={onAutoStart}
      onAutoPause={vi.fn()}
      onAutoResume={vi.fn()}
      onSetStatus={vi.fn()}
      onArchive={vi.fn()}
      onResolve={vi.fn()}
      onUnlink={vi.fn()}
      {...overrides}
    />,
  );
  return { onClose, onAutoStart };
}

describe("TaskDetailSheet — 统一启动", () => {
  it("只保留调度开始入口，不再提供绕过运行态的开始会话", async () => {
    const user = userEvent.setup();
    const { onAutoStart } = renderSheet();

    await user.click(
      await screen.findByRole("button", { name: zh.tasks.router.start }),
    );
    expect(onAutoStart).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("button", { name: zh.tasks.startSession }),
    ).toBeNull();
  });
});

describe("TaskDetailSheet — 跳转到终端会话", () => {
  const linked = (): TaskDetail => ({
    ...detail,
    links: [
      {
        sessionId: "s-live",
        appId: "codex",
        createdAt: 0,
        costUsd: 0,
        requests: 3,
      },
    ],
  });

  it("后台派发的会话能从这里打开终端", async () => {
    const user = userEvent.setup();
    const onOpenSession = vi.fn();
    renderSheet({
      detail: linked(),
      liveSessionIds: new Set(["s-live"]),
      onOpenSession,
    });

    await user.click(
      await screen.findByRole("button", { name: zh.tasks.openSession }),
    );
    expect(onOpenSession).toHaveBeenCalledWith("codex", "s-live");
  });

  it("应用重启后会话不在了，如实写「会话已结束」而不是给一个打不开的按钮", () => {
    renderSheet({
      detail: linked(),
      liveSessionIds: new Set<string>(),
      onOpenSession: vi.fn(),
    });

    expect(
      screen.queryByRole("button", { name: zh.tasks.openSession }),
    ).toBeNull();
    expect(screen.getByText(zh.tasks.sessionEnded)).toBeTruthy();
  });
});

describe("TaskDetailSheet — 结果与产物", () => {
  const withResult = (): TaskDetail => ({
    ...detail,
    outcome: "整理完 7 条新闻，附来源。",
    artifacts: [
      {
        label: "今日简报",
        path: "daily/report.md",
        exists: true,
        size: 2048,
        url: null,
      },
      {
        label: "在线版本",
        path: "https://example.com/report",
        exists: true,
        size: null,
        url: "https://example.com/report",
      },
    ],
    sections: [{ title: "Conclusion", body: "跑了很久。" }],
  });

  it("结果与产物排在运行细节之前，正文不再重复同一段", async () => {
    const user = userEvent.setup();
    const onRevealArtifact = vi.fn();
    renderSheet({ detail: withResult(), onRevealArtifact });

    expect(await screen.findByText("整理完 7 条新闻，附来源。")).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: zh.tasks.result.reveal }),
    );
    expect(onRevealArtifact).toHaveBeenCalledWith("daily/report.md");

    const result = screen.getByRole("region", {
      name: zh.tasks.result.title,
    });
    const router = screen.getByText(zh.tasks.router.section);
    // 结果块必须在自动调度之前：用户先看交付了什么，再看跑了第几次
    expect(
      result.compareDocumentPosition(router) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("没有结果摘要时如实说明，而不是编一段过程", () => {
    renderSheet();
    expect(screen.getByText(zh.tasks.result.empty)).toBeTruthy();
  });
});

describe("TaskDetailSheet — 任务内容与状态分区", () => {
  it("任务描述单独成段，排在结果之前，也不再混进执行记录", () => {
    renderSheet({
      detail: {
        ...detail,
        outcome: "Done 列改成紧凑行。",
        sections: [
          {
            title: "Description",
            body: "卡片一多就看不出 Done 列里哪张是刚跑完的。",
          },
          { title: "Conclusion", body: "跑了 3 分钟。" },
        ],
      },
    });

    const description = screen.getByRole("region", {
      name: zh.tasks.description.title,
    });
    expect(
      within(description).getByText(
        "卡片一多就看不出 Done 列里哪张是刚跑完的。",
      ),
    ).toBeInTheDocument();
    const result = screen.getByRole("region", {
      name: zh.tasks.result.title,
    });
    // 先回答「任务是什么」，再回答「做出了什么」
    expect(
      description.compareDocumentPosition(result) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // 描述不再作为过程段落被折叠收走，执行记录只剩真正的过程段
    expect(screen.getByText("执行记录（1 段）")).toBeInTheDocument();
  });

  it("没有写描述时给一句说明，而不是留一片空白", () => {
    renderSheet();
    expect(screen.getByText(zh.tasks.description.empty)).toBeInTheDocument();
  });

  it("状态与操作集中在右栏：调度与任务类型，不列没有录入入口的元信息", () => {
    renderSheet();
    const aside = screen.getByRole("complementary", {
      name: zh.tasks.operations.title,
    });
    expect(
      within(aside).getByText(zh.tasks.router.section),
    ).toBeInTheDocument();
    expect(
      within(aside).getByText(zh.tasks.schedule.title),
    ).toBeInTheDocument();
    // 指派 / 标签 / 依赖在界面上没有任何录入入口，摆出来只会是三行破折号
    expect(within(aside).queryByText("指派")).toBeNull();
    expect(within(aside).queryByText("依赖")).toBeNull();
    expect(within(aside).queryByText("更多信息")).toBeNull();
    // 中栏（内容）不再重复调度块
    expect(screen.getAllByText(zh.tasks.router.section)).toHaveLength(1);
  });

  it("讨论卡只占一栏：没有交付物与调度，右栏不立在那里空着", () => {
    renderSheet({
      defaultStatus: "To Do",
      detail: {
        ...detail,
        task: { ...task, kind: "discussion" as const, discussionHold: true },
      },
      onSendDiscussion: vi.fn().mockResolvedValue(true),
      onSayDiscussion: vi.fn().mockResolvedValue(true),
    });
    expect(
      screen.queryByRole("complementary", {
        name: zh.tasks.operations.title,
      }),
    ).toBeNull();
    // 讨论卡的「任务是什么」由讨论背景承担，不摆一句「没有写描述」
    expect(screen.queryByText(zh.tasks.description.empty)).toBeNull();
  });
});

describe("TaskDetailSheet — 正文按 Markdown 渲染", () => {
  it("任务描述渲染成结构化正文，而不是把标记原样显示", () => {
    renderSheet({
      detail: {
        ...detail,
        sections: [
          {
            title: "Description",
            body: "- **日期/时区：** 以执行时系统日期为准\n- 交付物：`今日AI新闻简报-2026-11-17.md`",
          },
        ],
      },
    });

    const description = screen.getByRole("region", {
      name: zh.tasks.description.title,
    });
    // 两条各成一项：不再是一段把它们连着折行显示的纯文本
    expect(within(description).getAllByRole("listitem")).toHaveLength(2);
    expect(within(description).getByText("日期/时区：").tagName).toBe("STRONG");
    expect(
      within(description).getByText("今日AI新闻简报-2026-11-17.md").tagName,
    ).toBe("CODE");
    // 标记本身不该出现在面板上
    expect(description.textContent).not.toContain("**");
    expect(description.textContent).not.toContain("`");
  });

  it("结果摘要与过程段用的是同一套渲染", () => {
    renderSheet({
      detail: {
        ...detail,
        outcome: "跑完 `pnpm test`，**0 失败**。",
        sections: [{ title: "执行记录", body: "改了 `TaskDetailSheet.tsx`。" }],
      },
    });

    const result = screen.getByRole("region", { name: zh.tasks.result.title });
    expect(within(result).getByText("pnpm test").tagName).toBe("CODE");
    expect(within(result).getByText("0 失败").tagName).toBe("STRONG");
    // 过程段默认收起，正文在展开时仍是渲染过的
    expect(screen.getByText("TaskDetailSheet.tsx").tagName).toBe("CODE");
  });

  it("讨论发言按 Markdown 渲染：Router 的回复不再是一串星号", () => {
    renderSheet({
      defaultStatus: "To Do",
      detail: {
        ...detail,
        task: { ...task, kind: "discussion" as const, discussionHold: true },
        discussionTurns: [
          { role: "router", text: "**建议**先改验收", createdAt: 1 },
        ],
      },
      onSendDiscussion: vi.fn().mockResolvedValue(true),
      onSayDiscussion: vi.fn().mockResolvedValue(true),
    });

    expect(screen.getByText("建议").tagName).toBe("STRONG");
    expect(screen.queryByText(/\*\*/)).toBeNull();
  });
});

describe("TaskDetailSheet — 不重复、不留空的声明", () => {
  it("状态、优先级、验收计数都不再与页脚 / 验收清单重复", () => {
    renderSheet({
      detail: {
        ...detail,
        acceptance: [{ text: "跑通构建", done: true }],
        task: { ...task, acceptanceDone: 1, acceptanceTotal: 1 },
      },
    });
    // 页尾那个下拉是改状态的唯一入口，正文里不再另写一份
    expect(screen.queryByText(zh.tasks.status)).toBeNull();
    // 优先级字段在看板上已去掉：抽屉里也不再有这一行
    expect(screen.queryByText("优先级")).toBeNull();
    expect(screen.queryByText(zh.tasks.acceptanceProgress)).toBeNull();
    expect(screen.getByText("跑通构建")).toBeTruthy();
  });

  it("没有关联会话时不留一空段，也不显示卡片文件路径", () => {
    renderSheet();
    expect(screen.queryByText(zh.tasks.sessions)).toBeNull();
    expect(screen.queryByText(zh.tasks.noSessions)).toBeNull();
    expect(screen.queryByText(task.file)).toBeNull();
  });

  it("没有规划节点时不出现永远为空的「执行计划」", () => {
    renderSheet();
    expect(screen.queryByText(zh.tasks.router.planTitle)).toBeNull();
    expect(screen.queryByText(zh.tasks.router.planEmpty)).toBeNull();
  });
});

describe("TaskDetailSheet — 任务类型", () => {
  it.each(["1.5", "0", "-2", "", "721"])(
    "持续任务拒绝无效小时数 %j，保留输入直到用户改正",
    async (value) => {
      const user = userEvent.setup();
      const onSetSchedule = vi.fn();
      renderSheet({
        detail: {
          ...detail,
          task: {
            ...task,
            schedule: {
              kind: "interval",
              minutes: 120,
              time: null,
              at: null,
              lastRunAt: null,
              nextRunAt: null,
            },
          },
        },
        onSetSchedule,
      });
      const amount = screen.getByRole("spinbutton", {
        name: zh.tasks.schedule.intervalAmount,
      });
      const save = screen.getByRole("button", {
        name: zh.tasks.schedule.save,
      });
      fireEvent.change(amount, { target: { value } });
      expect(amount).toHaveValue(value === "" ? null : Number(value));
      expect(save).toBeDisabled();
      await user.click(save);
      expect(onSetSchedule).not.toHaveBeenCalled();

      fireEvent.change(amount, { target: { value: "720" } });
      expect(save).toBeEnabled();
      await user.click(save);
      expect(onSetSchedule).toHaveBeenCalledExactlyOnceWith("720h", null);
    },
  );

  it("设成持续任务：选间隔数值与单位，不用手敲简写", async () => {
    const user = userEvent.setup();
    const onSetSchedule = vi.fn();
    Element.prototype.scrollIntoView = vi.fn();
    renderSheet({ onSetSchedule });

    await user.click(
      screen.getByRole("combobox", { name: zh.tasks.schedule.title }),
    );
    await user.click(
      await screen.findByRole("option", {
        name: zh.tasks.schedule.mode.interval,
      }),
    );
    const amount = screen.getByRole("spinbutton", {
      name: zh.tasks.schedule.intervalAmount,
    });
    fireEvent.change(amount, { target: { value: "2" } });
    await user.click(
      screen.getByRole("combobox", { name: zh.tasks.schedule.intervalUnit }),
    );
    await user.click(await screen.findByRole("option", { name: "小时" }));
    await user.click(
      screen.getByRole("button", { name: zh.tasks.schedule.save }),
    );

    expect(onSetSchedule).toHaveBeenCalledWith("2h", null);
  });

  it("定时任务用时间组件，保存时补成 09:30 这种格式", async () => {
    const user = userEvent.setup();
    const onSetSchedule = vi.fn();
    Element.prototype.scrollIntoView = vi.fn();
    renderSheet({ onSetSchedule });

    await user.click(
      screen.getByRole("combobox", { name: zh.tasks.schedule.title }),
    );
    await user.click(
      await screen.findByRole("option", { name: zh.tasks.schedule.mode.daily }),
    );
    const time = screen.getByLabelText(zh.tasks.schedule.timeLabel);
    expect(time).toHaveAttribute("type", "time");
    fireEvent.change(time, { target: { value: "09:30" } });
    await user.click(
      screen.getByRole("button", { name: zh.tasks.schedule.save }),
    );

    expect(onSetSchedule).toHaveBeenCalledWith(null, "09:30");
  });

  it("一次性任务给出日期和时间的原生组件", async () => {
    const user = userEvent.setup();
    const onSetSchedule = vi.fn();
    Element.prototype.scrollIntoView = vi.fn();
    renderSheet({
      detail: {
        ...detail,
        task: {
          ...task,
          schedule: {
            kind: "once",
            minutes: null,
            time: null,
            at: "2026-11-20 14:05",
            lastRunAt: null,
            nextRunAt: null,
          },
        },
      },
      onSetSchedule,
    });

    const date = screen.getByLabelText(zh.tasks.schedule.dateLabel);
    const time = screen.getByLabelText(zh.tasks.schedule.timeLabel);
    expect(date).toHaveAttribute("type", "date");
    expect(date).toHaveValue("2026-11-20");
    expect(time).toHaveValue("14:05");

    await user.click(
      screen.getByRole("button", { name: zh.tasks.schedule.save }),
    );
    expect(onSetSchedule).toHaveBeenCalledWith(null, "2026-11-20 14:05");
  });

  it("取消排期时两个参数都给 null", async () => {
    const user = userEvent.setup();
    const onSetSchedule = vi.fn();
    renderSheet({
      detail: {
        ...detail,
        task: {
          ...task,
          schedule: {
            kind: "interval",
            minutes: 120,
            time: null,
            at: null,
            lastRunAt: null,
            nextRunAt: null,
          },
        },
      },
      onSetSchedule,
    });

    await user.click(
      screen.getByRole("combobox", { name: zh.tasks.schedule.title }),
    );
    await user.click(
      await screen.findByRole("option", {
        name: zh.tasks.schedule.mode.none,
      }),
    );
    await user.click(
      screen.getByRole("button", { name: zh.tasks.schedule.save }),
    );
    expect(onSetSchedule).toHaveBeenCalledWith(null, null);
  });
});

describe("TaskDetailSheet — 需求讨论", () => {
  const discussionProps = () => ({
    defaultStatus: "To Do",
    terminalApps: ["codex"],
    // 只有讨论卡才能发起讨论：这些用例默认就是一种已经转成讨论卡的卡
    detail: {
      ...detail,
      task: { ...task, kind: "discussion" as const, discussionHold: true },
    },
    onSendDiscussion: vi.fn().mockResolvedValue(true),
    onSayDiscussion: vi.fn().mockResolvedValue(true),
  });

  it("待办卡不能就地讨论：先转成讨论卡，输入框才会出现", async () => {
    const user = userEvent.setup();
    const onConvertDiscussion = vi.fn().mockResolvedValue(true);
    renderSheet({
      defaultStatus: "To Do",
      onConvertDiscussion,
      onSendDiscussion: vi.fn().mockResolvedValue(true),
      onSayDiscussion: vi.fn().mockResolvedValue(true),
    });

    // 普通待办卡没有输入框与 timeline，只有一次显式类型转换
    expect(
      screen.queryByPlaceholderText(zh.tasks.discussion.sayPlaceholder),
    ).toBeNull();
    expect(
      screen.getByText(zh.tasks.discussion.pendingHint),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: zh.tasks.discussion.pendingConvert }),
    );
    expect(onConvertDiscussion).toHaveBeenCalledTimes(1);
  });

  it("结论只读：问题与确认由讨论写回，不让人再手抄一遍", () => {
    renderSheet({
      ...discussionProps(),
      detail: {
        ...detail,
        confirmed: "其他列不动",
        task: {
          ...task,
          kind: "discussion" as const,
          discussionHold: true,
          discussionQuestion: "默认看最近 5 条？",
        },
      },
    });

    expect(screen.getByText("默认看最近 5 条？")).toBeInTheDocument();
    expect(screen.getByText("其他列不动")).toBeInTheDocument();
    // 两个结论都不再是输入框：手写一遍就等于把讨论重做一遍
    expect(document.getElementById("task-discussion-question")).toBeNull();
    expect(document.getElementById("task-discussion-confirmed")).toBeNull();
  });

  it("还没有结论时两个位置给出占位说明，而不是空白", () => {
    renderSheet(discussionProps());

    expect(
      screen.getByText(zh.tasks.discussion.questionEmpty),
    ).toBeInTheDocument();
    expect(
      screen.getByText(zh.tasks.discussion.confirmedEmpty),
    ).toBeInTheDocument();
  });

  it("第一句已发出、Router 还没回时，先把这句话显示出来", () => {
    renderSheet({
      ...discussionProps(),
      discussionReplying: true,
      discussionFirstMessage: "每天整理 AI 新闻是不是该换个做法",
    });

    expect(
      screen.getByText("每天整理 AI 新闻是不是该换个做法"),
    ).toBeInTheDocument();
    expect(screen.getByText(zh.tasks.discussion.you)).toBeInTheDocument();
    expect(screen.getByText(zh.tasks.discussion.thinking)).toBeInTheDocument();
    // 用户已经说过了，空态提示不该再挂着
    expect(screen.queryByText(zh.tasks.discussion.emptyTimeline)).toBeNull();
  });

  it("轮询把已写入的那句拉回来之后，本地气泡让位给真实记录", () => {
    renderSheet({
      ...discussionProps(),
      discussionReplying: true,
      discussionFirstMessage: "先定范围",
      detail: {
        ...detail,
        task: { ...task, kind: "discussion" as const, discussionHold: true },
        discussionTurns: [{ role: "user", text: "先定范围", createdAt: 1 }],
      },
    });

    // 同一句话不能因为「本地乐观显示 + 后端已写入」而在对话里出现两遍
    expect(screen.getAllByText("先定范围")).toHaveLength(1);
  });

  it("讨论卡不在待办列时只读：不给一个必然失败的输入框", () => {
    renderSheet({
      ...discussionProps(),
      detail: {
        ...detail,
        confirmed: "其他列不动",
        task: {
          ...task,
          kind: "discussion" as const,
          discussionHold: true,
          status: "In Progress",
          discussionQuestion: "按日期分组？",
        },
      },
    });

    expect(
      screen.getByText(zh.tasks.discussion.notPendingHint),
    ).toBeInTheDocument();
    // 谈定的结论还要能读到
    expect(screen.getByText("按日期分组？")).toBeInTheDocument();
    expect(screen.getByText("其他列不动")).toBeInTheDocument();
    // 但不再提供输入与发送：后端会以 discussion-not-pending 拒绝
    expect(
      screen.queryByPlaceholderText(zh.tasks.discussion.sayPlaceholder),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: zh.tasks.discussion.sendTask }),
    ).toBeNull();
  });

  it("发送任务：讨论到此结束，交给执行列", async () => {
    const user = userEvent.setup();
    const onSendDiscussion = vi.fn().mockResolvedValue(true);
    renderSheet({ ...discussionProps(), onSendDiscussion });

    await user.click(
      screen.getByRole("button", { name: zh.tasks.discussion.sendTask }),
    );
    expect(onSendDiscussion).toHaveBeenCalledTimes(1);
  });

  it("保存草稿退出只关详情页，不删卡片", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderSheet({ ...discussionProps(), onClose });

    await user.click(
      screen.getByRole("button", { name: zh.tasks.discussion.closeDraft }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("timeline 按角色分开显示：用户是「你」，Router 是「Router」", () => {
    renderSheet({
      ...discussionProps(),
      detail: {
        ...detail,
        task: { ...task, kind: "discussion" as const, discussionHold: true },
        discussionTurns: [
          { role: "user", text: "先定范围", createdAt: 1 },
          { role: "router", text: "建议先改验收", createdAt: 2 },
        ],
      },
    });

    expect(screen.getByText("先定范围")).toBeInTheDocument();
    expect(screen.getByText("建议先改验收")).toBeInTheDocument();
    expect(screen.getByText(zh.tasks.discussion.you)).toBeInTheDocument();
    expect(screen.getByText(zh.tasks.discussion.router)).toBeInTheDocument();
  });

  it("Router 给的表单能在 timeline 里直接填、直接提交", async () => {
    const user = userEvent.setup();
    const props = discussionProps();
    renderSheet({
      ...props,
      detail: {
        ...detail,
        task: { ...task, kind: "discussion" as const, discussionHold: true },
        discussionTurns: [
          { role: "user", text: "整理芯片新闻", createdAt: 1 },
          {
            role: "router",
            text: "做法 A 更稳，但还缺两个信息。",
            createdAt: 2,
            form: {
              title: "还需要你定两件事",
              fields: [
                {
                  id: "source",
                  label: "新闻从哪里取？",
                  type: "text" as const,
                  placeholder: "订阅源",
                  options: [],
                  required: true,
                },
                {
                  id: "target",
                  label: "整理结果写到哪",
                  type: "choice" as const,
                  placeholder: null,
                  options: ["追加到这张卡", "单独一个文件"],
                  required: true,
                },
              ],
            },
          },
        ],
      },
    });

    expect(screen.getByText("还需要你定两件事")).toBeInTheDocument();
    // 必填还没填：提交键点不动，不给一个空提交
    expect(
      screen.getByRole("button", { name: zh.tasks.discussion.formSubmit }),
    ).toBeDisabled();

    await user.type(screen.getByLabelText("新闻从哪里取？"), "36 氪");
    await user.click(
      screen.getByRole("button", { name: zh.tasks.discussion.formSubmit }),
    );

    // 提交的就是一句话，走的是和手打一样的通道
    await waitFor(() =>
      expect(props.onSayDiscussion).toHaveBeenCalledWith(
        "新闻从哪里取？ 36 氪\n整理结果写到哪 追加到这张卡",
      ),
    );
  });

  it("提交键是看得见的按钮，不是一行灰字", () => {
    renderSheet({
      ...discussionProps(),
      detail: {
        ...detail,
        task: { ...task, kind: "discussion" as const, discussionHold: true },
        discussionTurns: [
          {
            role: "router",
            text: "还缺一个信息。",
            createdAt: 1,
            form: {
              title: "还需要你定一件事",
              fields: [
                {
                  id: "source",
                  label: "新闻从哪里取？",
                  type: "text" as const,
                  placeholder: null,
                  options: [],
                  required: false,
                },
              ],
            },
          },
        ],
      },
    });

    // 表单自己就是 bg-subtle：只靠悬停底色的那一档在这里既没有边、也没有悬停变化，
    // 屏幕上只剩「提交这几项」几个字，用户会以为没有提交按钮。
    const submit = screen.getByRole("button", {
      name: zh.tasks.discussion.formSubmit,
    });
    expect(submit.className).toContain("border-border-strong");
    expect(submit.className).toContain("bg-surface");
  });

  it("表单里 Ctrl+回车就提交，回车本身不会", async () => {
    const user = userEvent.setup();
    const props = discussionProps();
    renderSheet({
      ...props,
      detail: {
        ...detail,
        task: { ...task, kind: "discussion" as const, discussionHold: true },
        discussionTurns: [
          {
            role: "router",
            text: "还缺一个信息。",
            createdAt: 1,
            form: {
              title: "还需要你定一件事",
              fields: [
                {
                  id: "source",
                  label: "新闻从哪里取？",
                  type: "text" as const,
                  placeholder: null,
                  options: [],
                  required: true,
                },
              ],
            },
          },
        ],
      },
    });

    const field = screen.getByLabelText("新闻从哪里取？");
    await user.type(field, "36 氪");
    fireEvent.keyDown(field, { key: "Enter" });
    expect(props.onSayDiscussion).not.toHaveBeenCalled();

    fireEvent.keyDown(field, { key: "Enter", ctrlKey: true });
    await waitFor(() =>
      expect(props.onSayDiscussion).toHaveBeenCalledWith(
        "新闻从哪里取？ 36 氪",
      ),
    );
  });

  it("提交表单后进入等待态：答案不消失，Lead 回完才收起", async () => {
    const user = userEvent.setup();
    let resolveSay: (sent: boolean) => void = () => {};
    const onSayDiscussion = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveSay = resolve;
        }),
    );
    renderSheet({
      ...discussionProps(),
      onSayDiscussion,
      detail: {
        ...detail,
        task: { ...task, kind: "discussion" as const, discussionHold: true },
        discussionTurns: [
          {
            role: "router",
            text: "还缺一个信息。",
            createdAt: 1,
            form: {
              title: "还需要你定一件事",
              fields: [
                {
                  id: "source",
                  label: "新闻从哪里取？",
                  type: "text" as const,
                  placeholder: null,
                  options: [],
                  required: true,
                },
              ],
            },
          },
        ],
      },
    });

    await user.type(screen.getByLabelText("新闻从哪里取？"), "36 氪");
    await user.click(
      screen.getByRole("button", { name: zh.tasks.discussion.formSubmit }),
    );

    // 点了提交，屏幕上必须有反应：和手打一样进入「Lead 正在回复…」，输入框锁住
    expect(screen.getByText(zh.tasks.discussion.thinking)).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText(zh.tasks.discussion.sayPlaceholder),
    ).toBeDisabled();
    // 刚填的答案不能在这几十秒里凭空消失
    expect(screen.getByText("还需要你定一件事")).toBeInTheDocument();

    resolveSay(true);
    await waitFor(() =>
      expect(
        screen.getByPlaceholderText(zh.tasks.discussion.sayPlaceholder),
      ).toBeEnabled(),
    );
  });

  it("答过之后，上一轮的表单不再挂在 timeline 上", () => {
    renderSheet({
      ...discussionProps(),
      detail: {
        ...detail,
        task: { ...task, kind: "discussion" as const, discussionHold: true },
        discussionTurns: [
          {
            role: "router",
            text: "还缺一个信息。",
            createdAt: 1,
            form: {
              title: "还需要你定一件事",
              fields: [
                {
                  id: "source",
                  label: "新闻从哪里取？",
                  type: "text" as const,
                  placeholder: null,
                  options: [],
                  required: true,
                },
              ],
            },
          },
          { role: "user", text: "新闻从哪里取？ 36 氪", createdAt: 2 },
        ],
      },
    });

    // 最后一轮是用户说的：那条表单已经答过了，不再显示成一排可填的控件
    expect(screen.queryByText("还需要你定一件事")).toBeNull();
    expect(
      screen.queryByRole("button", { name: zh.tasks.discussion.formSubmit }),
    ).toBeNull();
  });

  it("发送一句话交给 Router，成功后才清空输入框", async () => {
    const user = userEvent.setup();
    const props = discussionProps();
    renderSheet(props);

    const input = screen.getByPlaceholderText(
      zh.tasks.discussion.sayPlaceholder,
    );
    await user.type(input, "还有哪个方案？");
    await user.click(
      screen.getByRole("button", { name: zh.tasks.discussion.send }),
    );

    await waitFor(() =>
      expect(props.onSayDiscussion).toHaveBeenCalledWith("还有哪个方案？"),
    );
    await waitFor(() => expect(input).toHaveValue(""));
  });

  it("发不出去时这句话留在输入框里，重发一次就行", async () => {
    const user = userEvent.setup();
    const props = {
      ...discussionProps(),
      onSayDiscussion: vi.fn().mockResolvedValue(false),
    };
    renderSheet(props);

    const input = screen.getByPlaceholderText(
      zh.tasks.discussion.sayPlaceholder,
    );
    await user.type(input, "A 还是 B？");
    await user.click(
      screen.getByRole("button", { name: zh.tasks.discussion.send }),
    );

    await waitFor(() => expect(props.onSayDiscussion).toHaveBeenCalledTimes(1));
    expect(input).toHaveValue("A 还是 B？");
  });

  it("已经开工的卡不显示需求讨论板块：结论不在这一块再摆一遍", () => {
    renderSheet({
      ...discussionProps(),
      detail: {
        ...detail,
        confirmed: "其他列不动",
        task: { ...task, status: "In Progress" },
      },
    });

    // 运行中：讨论与运行互斥，这一块整块不出现，说明、结论、入口都不摆。
    expect(screen.queryByText(zh.tasks.discussion.title)).toBeNull();
    expect(screen.queryByText("其他列不动")).toBeNull();
    expect(
      screen.queryByLabelText(zh.tasks.discussion.questionLabel),
    ).toBeNull();
  });

  it("原任务详情反向列出由此派生的讨论，点一下就回到那一轮", async () => {
    const user = userEvent.setup();
    const onOpenTask = vi.fn();
    renderSheet({
      ...discussionProps(),
      onOpenTask,
      onDeriveDiscussion: vi.fn().mockResolvedValue(true),
      detail: {
        ...detail,
        task: { ...task, status: "Done" },
        derived: [
          {
            id: "TASK-2",
            title: "讨论：芳芳说的发生",
            status: "To Do",
            round: 1,
            createdDate: "2026-11-21",
            question: "按日期分组？",
          },
          {
            id: "TASK-3",
            title: "讨论：芳芳说的发生",
            status: "To Do",
            round: 2,
            createdDate: "2026-11-22",
            question: null,
          },
        ],
      },
    });

    expect(
      screen.getByText(zh.tasks.discussion.derivedTitle),
    ).toBeInTheDocument();
    // 已完成的任务只有「重新讨论」，没有就地编辑的输入框；
    // 而且它是动作，应该落在右欄（状态与下一步），不与左欄的事实混在一起。
    expect(
      screen.queryByLabelText(zh.tasks.discussion.questionLabel),
    ).toBeNull();
    const operations = screen.getByRole("complementary", {
      name: zh.tasks.operations.title,
    });
    expect(
      within(operations).getByRole("button", {
        name: zh.tasks.discussion.derive,
      }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /按日期分组？/ }));
    expect(onOpenTask).toHaveBeenCalledWith("TASK-2");
  });

  it("讨论卡在详情里标出轮次与来源，并能关闭", async () => {
    const user = userEvent.setup();
    const onDiscardDiscussion = vi.fn().mockResolvedValue(undefined);
    renderSheet({
      ...discussionProps(),
      onDiscardDiscussion,
      detail: {
        ...detail,
        task: {
          ...task,
          kind: "discussion",
          round: 3,
          sourceTask: "TASK-1",
          discussionHold: true,
        },
      },
    });

    expect(screen.getByText("第 3 轮讨论")).toBeInTheDocument();
    expect(screen.getByText("来自 TASK-1")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: zh.tasks.discussion.discard }),
    );
    expect(onDiscardDiscussion).toHaveBeenCalledTimes(1);
  });

  it("指派到支持续接的智能体后，右栏能挑一段会话接着聊", async () => {
    const user = userEvent.setup();
    const onSetSession = vi.fn();
    renderWithQueryClient(
      <TaskDetailSheet
        detail={{ ...detail, task: { ...task, assignees: ["doc-writer"] } }}
        statuses={["To Do", "In Progress", "Done"]}
        busy={false}
        run={undefined}
        agents={[
          {
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
          },
        ]}
        allowedAgents={["doc-writer"]}
        repoRoot="/mock/claude"
        onSetSession={onSetSession}
        onSetSchedule={vi.fn()}
        onRevealArtifact={vi.fn()}
        onClose={vi.fn()}
        onAutoStart={vi.fn()}
        onAutoPause={vi.fn()}
        onAutoResume={vi.fn()}
        onSetStatus={vi.fn()}
        onArchive={vi.fn()}
        onResolve={vi.fn()}
        onUnlink={vi.fn()}
      />,
    );

    const trigger = await screen.findByRole("combobox", {
      name: zh.tasks.session.title,
    });
    await user.click(trigger);
    await user.click(await screen.findByText("Claude Session One"));
    expect(onSetSession).toHaveBeenCalledWith("claude-session-1");
  });

  it("讨论卡不显示排期、自动调度与验收：它不占执行槽位", () => {
    renderSheet({
      ...discussionProps(),
      detail: {
        ...detail,
        task: {
          ...task,
          kind: "discussion",
          round: 1,
          sourceTask: "TASK-9",
          discussionHold: true,
        },
      },
    });

    expect(
      screen.getByText(zh.tasks.discussion.questionLabel),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: zh.tasks.router.start }),
    ).toBeNull();
    expect(screen.queryByText(zh.tasks.result.title)).toBeNull();
    expect(screen.queryByText(zh.tasks.acceptance)).toBeNull();
  });
});
