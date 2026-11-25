/**
 * 智能体「追加参数」的可选项。
 *
 * 这里不是一份想当然的 CLI 参数表，而是后端允许列表的镜像：`super_agent/agents.rs`
 * 的 `validate` 只放行这里的几项，别的写法保存时会被拒
 * （`unsupported-agent-argument`）。所以界面上按应用列出来的，就是真的存得进去的，
 * 不会出现「点了一下、保存报错」。
 *
 * 改这个文件必须同步改 `src-tauri/src/super_agent/agents.rs` 的允许列表；
 * 反过来加后端项时也要在这里补一条，否则那一项只能靠自定义输入手打。
 *
 * 三条边界：
 * 1. 带取值的只放「取值是可枚举的几个」的（`--effort high`）。一人一值的
 *    （`--add-dir ./x`、`--fallback-model`）不走这里——它们的值属于这台机器的路径或
 *    模型，不是「多一个开关」。
 * 2. 审批类开关（`--dangerously-skip-permissions`、`--yolo`、`--auto`…）单独成组，
 *    提示里写清「等于放开审批」。它们不改 phi 自己的边界（沙箱、并发、超时），改的是
 *    CLI 在无人值守时还会不会停下来问人——这一项必须是人自己点的。
 * 3. 会话续接不在这里：选哪一个会话是每张卡的事，入口在卡片详情的「续接会话」，
 *    派发时由 phi 翻译成各应用自己的 resume 参数（id 先校验）。
 */

export interface AgentArgumentOption {
  /** 这一项落在命令行上的 token；带取值的参数是两个 token。 */
  tokens: string[];
  /** 一句说明：这一项到底改变了什么。 */
  hintKey: string;
}

export interface AgentArgumentGroup {
  titleKey: string;
  options: AgentArgumentOption[];
}

const CLAUDE_GROUPS: AgentArgumentGroup[] = [
  {
    titleKey: "tasks.router.agentArgumentGroupOutput",
    options: [
      {
        tokens: ["--verbose"],
        hintKey: "tasks.router.agentArgumentVerbose",
      },
      {
        tokens: ["--strict-mcp-config"],
        hintKey: "tasks.router.agentArgumentStrictMcp",
      },
    ],
  },
  {
    titleKey: "tasks.router.agentArgumentGroupEffort",
    options: [
      {
        tokens: ["--effort", "low"],
        hintKey: "tasks.router.agentArgumentEffortLow",
      },
      {
        tokens: ["--effort", "medium"],
        hintKey: "tasks.router.agentArgumentEffortMedium",
      },
      {
        tokens: ["--effort", "high"],
        hintKey: "tasks.router.agentArgumentEffortHigh",
      },
    ],
  },
  {
    titleKey: "tasks.router.agentArgumentGroupPermission",
    options: [
      {
        tokens: ["--dangerously-skip-permissions"],
        hintKey: "tasks.router.agentArgumentSkipPermissions",
      },
    ],
  },
];

const CODEX_GROUPS: AgentArgumentGroup[] = [
  {
    titleKey: "tasks.router.agentArgumentGroupSession",
    options: [
      {
        tokens: ["--ephemeral"],
        hintKey: "tasks.router.agentArgumentEphemeral",
      },
    ],
  },
  {
    titleKey: "tasks.router.agentArgumentGroupConfig",
    options: [
      {
        tokens: ["--ignore-user-config"],
        hintKey: "tasks.router.agentArgumentIgnoreUserConfig",
      },
      {
        tokens: ["--ignore-rules"],
        hintKey: "tasks.router.agentArgumentIgnoreRules",
      },
    ],
  },
  {
    titleKey: "tasks.router.agentArgumentGroupSandbox",
    options: [
      {
        tokens: ["--sandbox", "read-only"],
        hintKey: "tasks.router.agentArgumentSandboxReadOnly",
      },
    ],
  },
  {
    titleKey: "tasks.router.agentArgumentGroupPermission",
    options: [
      {
        tokens: ["--dangerously-bypass-approvals-and-sandbox"],
        hintKey: "tasks.router.agentArgumentBypassSandbox",
      },
    ],
  },
];

const GEMINI_GROUPS: AgentArgumentGroup[] = [
  {
    titleKey: "tasks.router.agentArgumentGroupSandbox",
    options: [
      {
        tokens: ["--sandbox"],
        hintKey: "tasks.router.agentArgumentGeminiSandbox",
      },
      {
        tokens: ["--skip-trust"],
        hintKey: "tasks.router.agentArgumentSkipTrust",
      },
    ],
  },
  {
    titleKey: "tasks.router.agentArgumentGroupPermission",
    options: [
      {
        tokens: ["--yolo"],
        hintKey: "tasks.router.agentArgumentYolo",
      },
    ],
  },
];

const OPENCODE_GROUPS: AgentArgumentGroup[] = [
  {
    titleKey: "tasks.router.agentArgumentGroupPlugin",
    options: [
      {
        tokens: ["--pure"],
        hintKey: "tasks.router.agentArgumentPure",
      },
    ],
  },
  {
    titleKey: "tasks.router.agentArgumentGroupPermission",
    options: [
      {
        tokens: ["--auto"],
        hintKey: "tasks.router.agentArgumentAuto",
      },
    ],
  },
];

/** 某个应用能追加的参数。没有可选参数的应用返回空数组，界面据此换成一句说明。 */
export function agentArgumentGroups(appId: string): AgentArgumentGroup[] {
  switch (appId) {
    case "claude":
      return CLAUDE_GROUPS;
    case "codex":
      return CODEX_GROUPS;
    case "gemini":
      return GEMINI_GROUPS;
    case "opencode":
      return OPENCODE_GROUPS;
    default:
      return [];
  }
}

export function agentArgumentOptions(appId: string): AgentArgumentOption[] {
  return agentArgumentGroups(appId).flatMap((group) => group.options);
}

/** 按空白切词：与保存时的 `split(/\s+/)` 同一个口径。 */
export function argumentTokens(raw: string): string[] {
  return raw.trim() === "" ? [] : raw.trim().split(/\s+/);
}

/**
 * 从一段原文里认出已选的参数。
 *
 * 两项的参数（`--effort high`）必须先整体匹配：只认 `--effort` 会让后面的取值
 * 变成一条「认不出来」的残留，看起来像填错了。
 */
export function parseArgumentText(
  raw: string,
  options: readonly AgentArgumentOption[],
): { picks: AgentArgumentOption[]; extra: string[] } {
  const tokens = argumentTokens(raw);
  const picks: AgentArgumentOption[] = [];
  const extra: string[] = [];
  let index = 0;
  while (index < tokens.length) {
    const pair = options.find(
      (option) =>
        option.tokens.length === 2 &&
        option.tokens[0] === tokens[index] &&
        option.tokens[1] === tokens[index + 1],
    );
    if (pair) {
      if (!picks.includes(pair)) picks.push(pair);
      index += 2;
      continue;
    }
    const single = options.find(
      (option) =>
        option.tokens.length === 1 && option.tokens[0] === tokens[index],
    );
    if (single) {
      if (!picks.includes(single)) picks.push(single);
      index += 1;
      continue;
    }
    extra.push(tokens[index]);
    index += 1;
  }
  return { picks, extra };
}

/**
 * 拼回去：一个 token 一个空格的原文。
 *
 * 不在这里加引号：界面上（与保存时）都是按空白切词，一个带空格的 token 本来就拆不成
 * 一项，回拼时也不该凭空多出一对引号——旧文本里已经有的引号会被当成普通字符原样留着。
 */
function joinTokens(tokens: string[]): string {
  return tokens.join(" ");
}

export function addArgumentTokens(raw: string, tokens: string[]): string {
  return joinTokens([...argumentTokens(raw), ...tokens]);
}

/**
 * 去掉一段 token。
 *
 * 按 token 序列重建，而不是在原字符串上做替换：同一段里可能有空格、引号与重复项，
 * 字符串替换会删错位置。只在「移除」这一个动作上重建，输入过程仍然是原文。
 */
export function removeArgumentTokens(raw: string, remove: string[]): string {
  const tokens = argumentTokens(raw);
  const at = tokens.findIndex((_, index) =>
    remove.every((token, offset) => tokens[index + offset] === token),
  );
  if (at === -1) return raw;
  tokens.splice(at, remove.length);
  return joinTokens(tokens);
}
