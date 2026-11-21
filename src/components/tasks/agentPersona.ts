import type { RouterAgent } from "@/lib/api/superAgent";
import { linesOf } from "./agentSettings";

/**
 * 工作室草稿能改的那半边：它是谁、负责什么、怎么做、怎样算完成。
 *
 * 应用、模型、追加参数与提示词不在里面——那些是「怎么启动它」，只由人选。
 * 版本快照也只存这半边，所以切换版本不会把已经调好的模型换回去。
 */
export interface AgentPersona {
  name: string;
  description: string;
  outcome: string;
  boundary: string;
  askText: string;
  stepsText: string;
  constraintsText: string;
  completionResult: string;
  evidenceText: string;
}

/** 编辑器里与 persona 一一对应的状态。列表字段按多行文本编辑，快照也存文本。 */
export interface PersonaForm {
  agent: RouterAgent;
  askText: string;
  stepsText: string;
  constraintsText: string;
  evidenceText: string;
}

/**
 * 一版草稿。
 *
 * `round` 是它由第几轮对话产生；`null` 表示「初始」——开始对话之前右栏的样子。
 * 版本号只能用下标表示：某一轮可能只回了话没给草稿，所以版号与轮次不一定对齐。
 */
export interface AgentDraftVersion {
  round: number | null;
  /** 这一版真的改到了哪几项（已翻译的字段名），用来在界面上说清改了什么。 */
  fields: string[];
  persona: AgentPersona;
}

export function personaOf(form: PersonaForm): AgentPersona {
  return {
    name: form.agent.name,
    description: form.agent.description,
    outcome: form.agent.outcome,
    boundary: form.agent.boundary,
    askText: form.askText,
    stepsText: form.stepsText,
    constraintsText: form.constraintsText,
    completionResult: form.agent.completion.result,
    evidenceText: form.evidenceText,
  };
}

/** 从一份完整定义里取出 persona。新建弹窗的「初始」版本靠它。 */
export function personaOfAgent(agent: RouterAgent): AgentPersona {
  return {
    name: agent.name,
    description: agent.description,
    outcome: agent.outcome,
    boundary: agent.boundary,
    askText: agent.askUserWhen.join("\n"),
    stepsText: agent.steps.join("\n"),
    constraintsText: agent.constraints.join("\n"),
    completionResult: agent.completion.result,
    evidenceText: agent.completion.evidence.join("\n"),
  };
}

/**
 * 草稿叠到现有 persona 上。
 *
 * 名称与用途在草稿里为空时沿用右栏的那一份：模型常只回改动的段，
 * 直接清空会让人刚写好的名字凭空消失。
 */
export function personaFromDraft(
  draft: RouterAgent,
  base: AgentPersona,
): AgentPersona {
  return {
    name: draft.name || base.name,
    description: draft.description || base.description,
    outcome: draft.outcome,
    boundary: draft.boundary,
    askText: draft.askUserWhen.join("\n"),
    stepsText: draft.steps.join("\n"),
    constraintsText: draft.constraints.join("\n"),
    completionResult: draft.completion.result,
    evidenceText: draft.completion.evidence.join("\n"),
  };
}

/**
 * 把 persona 盖回编辑器状态：只动这半边，启动配置原样保留。
 *
 * 恢复一版、填入一份草稿都走这里，两条路径才不会各自漏掉某个字段。
 */
export function personaIntoForm(
  persona: AgentPersona,
  form: PersonaForm,
): PersonaForm {
  return {
    agent: {
      ...form.agent,
      name: persona.name,
      description: persona.description,
      outcome: persona.outcome,
      boundary: persona.boundary,
      askUserWhen: linesOf(persona.askText),
      steps: linesOf(persona.stepsText),
      constraints: linesOf(persona.constraintsText),
      completion: {
        result: persona.completionResult,
        evidence: linesOf(persona.evidenceText),
      },
    },
    askText: persona.askText,
    stepsText: persona.stepsText,
    constraintsText: persona.constraintsText,
    evidenceText: persona.evidenceText,
  };
}

/** 两份 persona 是否一字不差。用来判断右栏在这一版之后有没有被手改过。 */
export function samePersona(a: AgentPersona, b: AgentPersona): boolean {
  return (Object.keys(a) as (keyof AgentPersona)[]).every(
    (key) => a[key] === b[key],
  );
}
