import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "i18next";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import zh from "@/i18n/locales/zh.json";
import { RouterAgentDialog } from "@/components/tasks/AutoRouterPanel";
import { blankAgent } from "@/components/tasks/agentSettings";
import type { RouterAgent } from "@/lib/api/superAgent";

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  i18n.addResourceBundle("zh", "translation", zh, true, true);
});

// 工作室与编辑器都会问 superAgentApi：模型名单在挂载时读，草稿只在按下发送时读。
// 每条用例自己决定回什么，才能验「第二句带着右栏当前这一版」。
const { agentDraft } = vi.hoisted(() => ({ agentDraft: vi.fn() }));

vi.mock("@/lib/api/superAgent", () => ({
  superAgentApi: {
    agentModels: () => Promise.resolve({ models: [], overridable: true }),
    agentDraft: (...args: unknown[]) => agentDraft(...args),
  },
}));

const baseDraft: RouterAgent = {
  id: "",
  name: "文档写手",
  description: "改文档、补说明",
  appId: "claude",
  prompt: "",
  model: "",
  arguments: [],
  outcome: "交付一份改动过的文档",
  boundary: "不动代码",
  askUserWhen: ["涉及对外承诺"],
  steps: ["先读卡片", "按既有文风改写"],
  constraints: ["不删除已确认的结论"],
  completion: { result: "文档已改完", evidence: ["列出改动的章节"] },
};

beforeEach(() => {
  agentDraft.mockReset();
  agentDraft.mockImplementation(() =>
    Promise.resolve({ reply: "我先按文档岗收了一版。", draft: baseDraft }),
  );
});

const renderDialog = (isNew: boolean) => {
  const onSave = vi.fn();
  render(
    <RouterAgentDialog
      draft={blankAgent("claude")}
      isNew={isNew}
      terminalApps={["claude"]}
      onCancel={vi.fn()}
      onSave={onSave}
    />,
  );
  return onSave;
};

const say = async (user: ReturnType<typeof userEvent.setup>, text: string) => {
  await user.type(
    screen.getByPlaceholderText(zh.tasks.router.agentStudioPlaceholder),
    text,
  );
  await user.click(
    screen.getByRole("button", { name: zh.tasks.router.agentStudioSend }),
  );
};

describe("RouterAgentDialog", () => {
  it("添加智能体里一句话起草：草稿直接填进右边，且不改应用与提示词", async () => {
    const user = userEvent.setup();
    const onSave = renderDialog(true);

    // 还没名字时存不了：草稿与人填共用同一张表。
    const save = screen.getByRole("button", {
      name: zh.tasks.router.agentSave,
    });
    expect(save).toBeDisabled();

    // 人先自己写了一版提示词：它属于「怎么启动」，草稿不该动它。
    await user.type(
      screen.getByLabelText(zh.tasks.router.agentPrompt),
      "保留我写的提示词",
    );
    await say(user, "我要一个专门改文档的人");

    // 工作室只要回一句话；草稿落到右边的字段里，本来就是同一张表单。
    expect(
      await screen.findByText("我先按文档岗收了一版。"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(zh.tasks.router.agentName)).toHaveValue(
      "文档写手",
    );
    expect(screen.getByLabelText(zh.tasks.router.agentPurpose)).toHaveValue(
      "改文档、补说明",
    );
    expect(screen.getByLabelText(zh.tasks.router.agentPrompt)).toHaveValue(
      "保留我写的提示词",
    );
    // 落下来的那一版进了版本条，右栏就在这一版上，且不在预览态。
    expect(
      screen.getByRole("button", { name: "第 1 版", pressed: true }),
    ).toBeInTheDocument();
    await waitFor(() => expect(save).toBeEnabled());

    await user.click(save);
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "文档写手",
        // 应用仍取编辑器里选的那个，不是草稿带回来的。
        appId: "claude",
        prompt: "保留我写的提示词",
        steps: ["先读卡片", "按既有文风改写"],
      }),
    );
  });

  it("多轮：timeline 记下每轮，第二句带着右栏当前这一版继续改", async () => {
    const user = userEvent.setup();
    agentDraft.mockImplementation(
      (
        _appId: string,
        _history: unknown,
        _message: string,
        current: RouterAgent | null,
      ) => {
        const second = current?.name === "文档写手";
        return Promise.resolve({
          reply: second ? "加了「不碰发布」这一条。" : "先按文档岗收一版。",
          draft: second
            ? { ...baseDraft, constraints: ["不删除已确认的结论", "不碰发布"] }
            : baseDraft,
        });
      },
    );
    renderDialog(true);

    await say(user, "我要一个专门改文档的人");
    await waitFor(() =>
      expect(screen.getByLabelText(zh.tasks.router.agentName)).toHaveValue(
        "文档写手",
      ),
    );

    await say(user, "再加一条：不碰发布");
    await waitFor(() =>
      expect(
        screen.getByLabelText(zh.tasks.router.agentConstraints),
      ).toHaveValue("不删除已确认的结论\n不碰发布"),
    );

    // 第二句把右栏当时那一版交给了模型，而不是只发对话历史。
    const [, , , current] = agentDraft.mock.calls[1] as [
      string,
      unknown,
      string,
      RouterAgent,
    ];
    expect(current.name).toBe("文档写手");
    expect(current.steps).toEqual(["先读卡片", "按既有文风改写"]);

    // timeline 里两句都在，各带说话人；每轮都标了落到右边的第几版。
    expect(screen.getAllByText(zh.tasks.router.agentStudioYou)).toHaveLength(2);
    expect(screen.getAllByText("Router")).toHaveLength(2);
    const first = screen.getByText(/^第 1 版 · /);
    expect(first.textContent).toContain(zh.tasks.router.agentSteps);
    const second = screen.getByText(/^第 2 版 · /);
    expect(second.textContent).toContain(zh.tasks.router.agentConstraints);
    // 第二轮没动步骤，就不该说它改了步骤。
    expect(second.textContent).not.toContain(zh.tasks.router.agentSteps);
  });

  it("回车只是换行，Ctrl+回车才发送", async () => {
    const user = userEvent.setup();
    renderDialog(true);

    const input = screen.getByPlaceholderText(
      zh.tasks.router.agentStudioPlaceholder,
    );
    await user.type(input, "我要一个改文档的人{Enter}不碰代码");
    // 一句话常常要分几段说清一个岗位：回车不该把人逼成挤在一行里写。
    expect(agentDraft).not.toHaveBeenCalled();
    expect(input).toHaveValue("我要一个改文档的人\n不碰代码");

    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(agentDraft).toHaveBeenCalledTimes(1));
    expect(agentDraft.mock.calls[0][2]).toBe("我要一个改文档的人\n不碰代码");
  });

  it("任意一版都能切回去看：切到初始版只读，回到当前草稿不丢东西", async () => {
    const user = userEvent.setup();
    let round = 0;
    agentDraft.mockImplementation(() => {
      round += 1;
      return Promise.resolve({
        reply: round === 1 ? "先收一版。" : "加了「不碰发布」。",
        draft:
          round === 1
            ? baseDraft
            : { ...baseDraft, constraints: ["不删除已确认的结论", "不碰发布"] },
      });
    });
    renderDialog(true);

    await say(user, "我要一个专门改文档的人");
    await say(user, "再加一条：不碰发布");
    await waitFor(() =>
      expect(
        screen.getByLabelText(zh.tasks.router.agentConstraints),
      ).toHaveValue("不删除已确认的结论\n不碰发布"),
    );

    // 切到「初始」：右栏换成开始对话之前那一份，并且只读。
    await user.click(screen.getByRole("button", { name: "初始" }));
    expect(screen.getByLabelText(zh.tasks.router.agentName)).toHaveValue("");
    expect(screen.getByLabelText(zh.tasks.router.agentName)).toBeDisabled();
    expect(
      screen.getByText(
        zh.tasks.router.agentVersionPreview.replace("{{version}}", "初始"),
      ),
    ).toBeInTheDocument();
    // 屏幕上这份不是要存的那份：不能存。
    expect(
      screen.getByRole("button", { name: zh.tasks.router.agentSave }),
    ).toBeDisabled();

    // 回到当前草稿：右栏原样回来，没有丢任何一版。
    await user.click(
      screen.getByRole("button", { name: zh.tasks.router.agentVersionBack }),
    );
    expect(screen.getByLabelText(zh.tasks.router.agentConstraints)).toHaveValue(
      "不删除已确认的结论\n不碰发布",
    );

    // 再切到第 1 版并「以这一版继续」：右栏真的退回那一版。
    await user.click(screen.getByRole("button", { name: "第 1 版" }));
    expect(screen.getByLabelText(zh.tasks.router.agentConstraints)).toHaveValue(
      "不删除已确认的结论",
    );
    await user.click(
      screen.getByRole("button", {
        name: zh.tasks.router.agentVersionContinue,
      }),
    );
    expect(screen.getByLabelText(zh.tasks.router.agentConstraints)).toHaveValue(
      "不删除已确认的结论",
    );
    expect(
      screen.getByLabelText(zh.tasks.router.agentConstraints),
    ).toBeEnabled();
    // 后面的第 2 版仍在版本条上备查：回退不销毁任何一版。
    expect(screen.getByRole("button", { name: "第 2 版" })).toBeInTheDocument();
  });

  it("看旧版也能接着说：发送就以这一版为起点", async () => {
    const user = userEvent.setup();
    let round = 0;
    agentDraft.mockImplementation(() => {
      round += 1;
      if (round === 1) {
        return Promise.resolve({ reply: "先收一版。", draft: baseDraft });
      }
      if (round === 2) {
        return Promise.resolve({
          reply: "加了「不碰发布」。",
          draft: {
            ...baseDraft,
            constraints: ["不删除已确认的结论", "不碰发布"],
          },
        });
      }
      return Promise.resolve({
        reply: "在第 1 版上加了一条。",
        draft: {
          ...baseDraft,
          constraints: ["不删除已确认的结论", "改前先问"],
        },
      });
    });
    renderDialog(true);

    await say(user, "我要一个专门改文档的人");
    await say(user, "再加一条：不碰发布");
    await waitFor(() =>
      expect(
        screen.getByLabelText(zh.tasks.router.agentConstraints),
      ).toHaveValue("不删除已确认的结论\n不碰发布"),
    );

    // 切回第 1 版只是看一眼：输入框仍然能写，因为看旧版不该妨碍接着聊。
    await user.click(screen.getByRole("button", { name: "第 1 版" }));
    const input = screen.getByPlaceholderText(
      zh.tasks.router.agentStudioPlaceholder,
    );
    expect(input).toBeEnabled();
    expect(
      screen.getByText(
        zh.tasks.router.agentStudioPreviewContinue.replace(
          "{{version}}",
          "第 1 版",
        ),
      ),
    ).toBeInTheDocument();

    await say(user, "再加一条：改前先问");
    await waitFor(() => expect(agentDraft).toHaveBeenCalledTimes(3));

    // 这一句交给模型的不是右栏实时那份（第 2 版），而是正在看的第 1 版。
    const [, , , current] = agentDraft.mock.calls[2] as [
      string,
      unknown,
      string,
      RouterAgent,
    ];
    expect(current.constraints).toEqual(["不删除已确认的结论"]);

    // 回复落在第 1 版之上：右栏跟着切到新一版，并且可以继续改、可以保存。
    await waitFor(() =>
      expect(
        screen.getByLabelText(zh.tasks.router.agentConstraints),
      ).toHaveValue("不删除已确认的结论\n改前先问"),
    );
    expect(
      screen.getByLabelText(zh.tasks.router.agentConstraints),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "第 3 版", pressed: true }),
    ).toBeInTheDocument();
    // 第 2 版仍在版本条上：以旧版继续不等于把后面的版本删掉。
    expect(screen.getByRole("button", { name: "第 2 版" })).toBeInTheDocument();
  });

  it("左栏点某一轮的版本徽标，右栏跟着切到那一版", async () => {
    const user = userEvent.setup();
    renderDialog(true);

    await say(user, "我要一个专门改文档的人");
    await waitFor(() =>
      expect(screen.getByLabelText(zh.tasks.router.agentName)).toHaveValue(
        "文档写手",
      ),
    );
    await user.type(screen.getByLabelText(zh.tasks.router.agentName), "二号");

    // 手改之后，当前那一版与右栏已经不是同一份：点徽标应当真的进预览。
    await user.click(screen.getByText(/^第 1 版 · /));
    expect(screen.getByLabelText(zh.tasks.router.agentName)).toHaveValue(
      "文档写手",
    );
    expect(
      screen.getByText(zh.tasks.router.agentVersionPreviewEdited),
    ).toBeInTheDocument();
  });

  it("编辑已有智能体没有工作室：改配置不该被一段话覆盖", () => {
    renderDialog(false);
    expect(
      screen.queryByPlaceholderText(zh.tasks.router.agentStudioPlaceholder),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", {
        name: zh.tasks.router.agentStudioTitle,
      }),
    ).not.toBeInTheDocument();
    // 版本条也只服务新建：改一份调好的配置不需要它。
    expect(
      screen.queryByText(zh.tasks.router.agentVersionsTitle),
    ).not.toBeInTheDocument();
    // 编辑器本身还在：名称、用途照旧可改。
    expect(
      screen.getByLabelText(zh.tasks.router.agentName),
    ).toBeInTheDocument();
  });
});
