import { getAppDisplayName } from "@/components/shell/AppGlyph";
import type { RouterAgent, RouterSettings } from "@/lib/api/superAgent";
import type { TaskCard } from "@/lib/api/tasks";

/**
 * 智能体与卡片归属的共同口径。
 *
 * 三个地方都要回答同一个问题——「这张卡现在归谁」「这份设置里到底有几个智能体」：
 * 自动调度面板、智能体视图、详情页的指派行。口径写在这里一份，避免三处各猜一次。
 */

/** 新智能体草稿。id 留空：由后端在保存时按名称派生，前端不猜 uniqueness。 */
export function blankAgent(appId: string): RouterAgent {
  return {
    id: "",
    name: "",
    // 空头像 = 按 id 派生一张：新智能体不必先挑脸才能保存。
    avatar: "",
    description: "",
    appId,
    prompt: "",
    model: "",
    arguments: [],
    outcome: "",
    boundary: "",
    askUserWhen: [],
    steps: [],
    constraints: [],
    completion: { result: "", evidence: [] },
  };
}

/**
 * 设置里的智能体 = 显式定义 + 老配置里的应用 id。
 *
 * 老版本 `workerApps` 里存的是应用 id，没有定义。把它们按「跟随应用」补出来，
 * 一保存就变成显式定义，不会一升级就停派，也不会丢一个还在允许列表里的 id。
 */
export function resolveRouterAgents(
  settings: RouterSettings | null | undefined,
): RouterAgent[] {
  if (!settings) return [];
  const explicit = settings.agents ?? [];
  const legacy = settings.workerApps
    .filter((id) => !explicit.some((agent) => agent.id === id))
    .map((appId) => ({
      ...blankAgent(appId),
      id: appId,
      name: getAppDisplayName(appId),
    }));
  return [...explicit, ...legacy];
}

/** 保存一个智能体。新建时允许名单由后端补（id 也是那时才有的）。 */
export function withAgentSaved(
  settings: RouterSettings,
  agent: RouterAgent,
  isNew: boolean,
): Partial<RouterSettings> {
  const agents = resolveRouterAgents(settings);
  const next = isNew
    ? [...agents, agent]
    : agents.map((entry) => (entry.id === agent.id ? agent : entry));
  if (isNew) return { agents: next };
  // 允许名单的顺序跟着智能体列表走：第一个就是规则调度的默认派发对象。
  const ordered = next
    .map((entry) => entry.id)
    .filter((id) => settings.workerApps.includes(id));
  return { agents: next, workerApps: ordered };
}

/**
 * 启停一个智能体的派发（勾选/取消「参与派发」）。
 *
 * 只改 `workerApps`，顺序跟着智能体列表走：第一个允许的就是规则调度的默认对象。
 * 定义本身一个字不动——停用不是删除，卡片上的归属还留着，重新启用就继续生效。
 */
export function withAgentEnabled(
  settings: RouterSettings,
  agentId: string,
  enabled: boolean,
): Partial<RouterSettings> {
  const ids = resolveRouterAgents(settings).map((agent) => agent.id);
  // 开了又开两次（双击、两个入口同时点）不该在允许名单里留下同一个 id 两遍：
  // 它会原样落盘，判官与工作列表都会看到重复的人。
  const allowed = enabled
    ? [...new Set([...settings.workerApps, agentId])]
    : settings.workerApps.filter((id) => id !== agentId);
  const ordered = ids.filter((id) => allowed.includes(id));
  return { workerApps: ordered };
}

/**
 * 换一个智能体的头像。
 *
 * 只动这一个字段：换脸不该顺手改写角色定义，也不该动允许名单。传空串表示
 * 「回到按 id 派生」，所以这里不做「空就不写」的省略。
 */
export function withAgentAvatar(
  settings: RouterSettings,
  agentId: string,
  avatar: string,
): Partial<RouterSettings> {
  const agents = resolveRouterAgents(settings).map((entry) =>
    entry.id === agentId ? { ...entry, avatar } : entry,
  );
  return { agents };
}

export function withAgentDeleted(
  settings: RouterSettings,
  agentId: string,
): Partial<RouterSettings> {
  const agents = resolveRouterAgents(settings).filter(
    (entry) => entry.id !== agentId,
  );
  const workerApps = settings.workerApps.filter((id) => id !== agentId);
  return { agents, workerApps };
}

/**
 * 一张卡归属给谁。
 *
 * `@codex` 这类老写法认回该应用下第一个被允许的智能体；认不出来返回
 * `unknown`，界面标「未注册」，派发前会被后端拦住——不猜、也不换人。
 */
export function resolveAssignee(
  task: Pick<TaskCard, "assignees">,
  agents: RouterAgent[],
  allowed: readonly string[],
): { agentId?: string; unknown?: string } {
  const raw = task.assignees
    .map((value) => value.trim())
    .find((value) => value.length > 0);
  if (!raw) return {};
  const id = raw.replace(/^@/, "");
  if (!id) return {};
  const direct = agents.find(
    (agent) => agent.id === id && allowed.includes(agent.id),
  );
  if (direct) return { agentId: direct.id };
  const byApp = agents.find(
    (agent) => agent.appId === id && allowed.includes(agent.id),
  );
  if (byApp) return { agentId: byApp.id };
  return { unknown: id };
}

/** 角色上下文的字数上限，与 Rust 侧 `AGENT_HARNESS_LIMIT` 同一个数。 */
export const AGENT_HARNESS_LIMIT = 6000;

function useful(items: readonly string[]): boolean {
  return items.some((item) => item.trim().length > 0);
}

/**
 * 预览 Rust 编译出来的角色上下文。
 *
 * 只用来显示字数与超限提示：真正的拼接与校验在后端一处。两边差一个换行不影响
 * 判断，但**保存能不能过以 Rust 为准**——这里超限时就不该让人白点一次保存。
 */
export function harnessPreview(agent: RouterAgent): string {
  const parts: string[] = [];
  const defined =
    agent.outcome.trim() !== "" ||
    agent.boundary.trim() !== "" ||
    useful(agent.askUserWhen) ||
    useful(agent.steps) ||
    useful(agent.constraints) ||
    agent.completion.result.trim() !== "" ||
    useful(agent.completion.evidence);
  if (defined) {
    const summary = agent.description.trim();
    parts.push(
      summary
        ? `你是「${agent.name.trim()}」：${summary}`
        : `你是「${agent.name.trim()}」。`,
    );
    if (agent.outcome.trim()) {
      parts.push(`你负责的结果：${agent.outcome.trim()}`);
    }
    if (agent.boundary.trim()) {
      parts.push(`负责边界：${agent.boundary.trim()}`);
    }
    const ask = agent.askUserWhen.map((item) => item.trim()).filter(Boolean);
    if (ask.length > 0) {
      parts.push(
        `需要先问用户：\n${ask.map((item) => `- ${item}`).join("\n")}\n遇到上面这些情况，先问用户再动手；其余可逆选择自行决定。`,
      );
    }
    const steps = agent.steps.map((item) => item.trim()).filter(Boolean);
    if (steps.length > 0) {
      parts.push(
        `执行步骤：\n${steps.map((item, index) => `${index + 1}. ${item}`).join("\n")}`,
      );
    }
    const constraints = agent.constraints
      .map((item) => item.trim())
      .filter(Boolean);
    if (constraints.length > 0) {
      parts.push(
        `必须遵守：\n${constraints.map((item) => `- ${item}`).join("\n")}`,
      );
    }
    if (agent.completion.result.trim()) {
      parts.push(`完成时：${agent.completion.result.trim()}`);
    }
    const evidence = agent.completion.evidence
      .map((item) => item.trim())
      .filter(Boolean);
    if (evidence.length > 0) {
      parts.push(
        `完工自查：\n${evidence.map((item) => `- ${item}`).join("\n")}`,
      );
    }
    parts.push("若不能完成，说明原因以及下一步由谁处理。");
  }
  if (agent.prompt.trim()) parts.push(agent.prompt.trim());
  return parts.join("\n");
}

/** 只保留非空行：多行文本域里空行是排版，不是内容。 */
export function linesOf(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
