import { describe, expect, it } from "vitest";
import {
  addArgumentTokens,
  agentArgumentGroups,
  agentArgumentOptions,
  parseArgumentText,
  removeArgumentTokens,
} from "@/components/tasks/agentArguments";

const claude = agentArgumentOptions("claude");

describe("agentArguments", () => {
  it("按应用列参数：claude 有输出与思考强度，codex 只有会话开关", () => {
    expect(claude.map((option) => option.tokens.join(" "))).toEqual([
      "--verbose",
      "--effort low",
      "--effort medium",
      "--effort high",
    ]);
    expect(
      agentArgumentOptions("codex").map((option) => option.tokens.join(" ")),
    ).toEqual(["--ephemeral"]);
    // 没有允许项的应用要给一个空列表，界面据此换成说明，而不是摆一个空下拉。
    expect(agentArgumentGroups("gemini")).toEqual([]);
  });

  it("带取值的参数整体认出来，取值不会被当成残留", () => {
    const { picks, extra } = parseArgumentText("--effort high", claude);
    expect(picks.map((option) => option.tokens.join(" "))).toEqual([
      "--effort high",
    ]);
    expect(extra).toEqual([]);
  });

  it("列表之外的写法留在 extra 里，不会被悄悄丢掉", () => {
    const { picks, extra } = parseArgumentText(
      "--verbose --model glm-5",
      claude,
    );
    expect(picks.map((option) => option.tokens.join(" "))).toEqual([
      "--verbose",
    ]);
    // 认不出来也要看得见：界面上有的和真的会传进去的必须一致。
    expect(extra).toEqual(["--model", "glm-5"]);
  });

  it("取值不在名单里的参数只算残留，不算已选", () => {
    const { picks, extra } = parseArgumentText("--effort ultra", claude);
    expect(picks).toEqual([]);
    expect(extra).toEqual(["--effort", "ultra"]);
  });

  it("加一项就是把 token 追加到原文，去一项只去这一段", () => {
    const added = addArgumentTokens("--verbose", ["--effort", "high"]);
    expect(added).toBe("--verbose --effort high");
    expect(removeArgumentTokens(added, ["--effort", "high"])).toBe("--verbose");
    // 空白归一：只发生在移除这一步，输入过程仍然是原文。
    expect(
      removeArgumentTokens("--verbose   --effort high", ["--verbose"]),
    ).toBe("--effort high");
  });

  it("带引号的旧写法按空白切词显示、移除只清掉那一段，旁边的项不受影响", () => {
    const text = '--verbose --model "glm 5"';
    const { picks, extra } = parseArgumentText(text, claude);
    expect(picks.map((option) => option.tokens.join(" "))).toEqual([
      "--verbose",
    ]);
    // 胶囊上显示的就是原文那一段，不会少一半。
    expect(extra.join(" ")).toBe('--model "glm 5"');
    expect(removeArgumentTokens(text, extra)).toBe("--verbose");
  });
});
