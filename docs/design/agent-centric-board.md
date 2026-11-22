# 以智能体为单位的任务看板

> 状态：已落盘，按本文件实施。最后更新：2026-11-21
> 相关实现：`src-tauri/src/super_agent/`、`src-tauri/src/tasks/`、`src/components/tasks/`、`sidecar/src/episode.mjs`
> 前置设计：[super-agent-router.md](./super-agent-router.md)（调度循环、Jev 谓词、进程边界）

## 1. 要解决的问题

现在的看板最小单位是「一张任务卡」，智能体只是自动调度弹窗里的一个派发参数容器：

- `RouterAgent`（`super_agent/model.rs`）只有 name / description / app / model / arguments / prompt，
  六个字段全是「怎么启动」，没有一句描述**边界**，也没有一句描述**做到什么程度算完成**；
- 智能体定义藏在「自动调度」弹窗里，界面上不是一级概念；
- 卡片的 `assignee` 字段一直存在，但派发链路（`prefilter` / `tick`）完全不看它，
  判官只按一句 `description` 挑人——人写的归属机器不认。

本次把最小单位从「一个任务」改成「一个任务 × 一个智能体」：智能体成为组织成员，
人可以直接按智能体派活，机器必须服从这个归属。

## 2. 目标（用户四条要求的落地口径）

| 要求 | 落地 |
|---|---|
| ① 智能体范式升级为「它是谁 / 负责什么 / 能使用什么 / 怎样算完成」 | `RouterAgent` 增加五段式字段（§3），Rust 唯一出口编译成 harness，保存时校验长度 |
| ② 智能体提到一级入口（与自动调度、仓库一排） | 看板操作行加「看板 / 智能体」视图切换；智能体管理（增删改、允许名单）从弹窗移到该视图 |
| ③ 看板增加智能体视图（行 = 智能体） | 行视图：第 0 行「与 Router 讨论」、每个智能体一行、末尾「未分配」行；行内未结束卡全显示，Done 默认 3 张 + 计数 |
| ④ 看板 = 调度器协助人指挥一群智能体 | `assignee` 真正参与调度：有归属时判官不再选人；拖到某行 = 指派，指派并开工是第二个动作 |

## 3. 数据模型：五段式定义

`RouterAgent` 新增字段（`serde(rename_all = "camelCase", default)`，老 JSON 原样可读）：

| 字段 | 类型 | 上限 | 读者 |
|---|---|---|---|
| `name` | string | 160 字符 | 人 + 判官 |
| `description` | string | 400 字符 | 判官（选人只读这条 + name） |
| `outcome` | string | 2000 字符 | 人 + 执行体（负责什么结果） |
| `boundary` | string | 2000 字符 | 执行体（不接什么） |
| `askUserWhen` | string[] | 8 项 × 600 字符 | 执行体（遇到什么先问人） |
| `steps` | string[] | 12 项 × 600 字符 | 执行体（怎么做） |
| `constraints` | string[] | 8 项 × 600 字符 | 执行体（必须遵守） |
| `completion.result` | string | 2000 字符 | 执行体（交付标准） |
| `completion.evidence` | string[] | 8 项 × 600 字符 | 执行体（自查证据） |
| （沿用）`prompt` | string | 8192 字符 | 执行体（老的角色提示词，保留） |

**与 semibot-v3 的一处刻意差异**：不加 `capabilityRefs`。v3 的专员跑在 Core 里、工具由网关按
引用授予；phi 的智能体跑在外部 CLI 里，能力由该 CLI 的权限模式决定。照搬会变成一张填了也不生效的表。
「能使用什么」在 phi 里仍然只表达为**应用 + 执行模型 + 追加参数**。

### 3.1 harness 编译（Rust 是唯一出口）

`RouterAgent::harness()`（`super_agent/agents.rs`）按固定顺序拼出一段带标题的上下文：

```
你是「name」：description
你负责的结果：outcome
负责边界：boundary
需要先问用户：- askUserWhen...
执行步骤：1. steps...
必须遵守：- constraints...
完成时：completion.result
完工自查：- completion.evidence...
（老的角色提示词 prompt，原样保留在最后）
若不能完成，说明原因以及下一步由谁处理。
```

三条纪律：

1. **退化路径**：五个新段全为空时 `harness()` 返回空串，`task_prompt()` 退回「prompt + 任务说明」，
   老智能体派发行为一字不变，不逼人回头补写。
2. **上限 6000 字符**：在**保存时**校验（`agent-harness-too-large`），不是派发时才失败。
   派发时超长会变成 CLI 的 `invalid-arguments`，卡片停在「运行中」其实从没跑起来。
3. 前端只预览 harness 与字数，不再自己拼提示词；拼接处只有一处，改文案不会两边分叉。

### 3.2 id 由名称派生

- 新智能体保存时若 `id` 为空，后端从 `name` 派生可读 slug（小写 ASCII、保留中日韩字母数字、
  其余折成 `-`，限 40 字符），重名时追加 `-2`、`-3`；派生时避开应用 id，免得落进
  「跟随应用」那条歧义里。
- 新建的智能体由后端补进允许名单：刚建完却一条都派不出去是反直觉的。前端不自己拼新 id——
  那个 id 在保存前还不存在。
- 已有 id 永不变：**改名不改 id**，卡片上的 `assignee: [文档写手]` 继续有效。
- 允许名单 `workerApps` 仍存智能体 id；老配置里的应用 id 走既有 `agent()` 兼容路径认回「跟随应用」。

## 4. 调度接线：assignee 参与派发

### 4.1 候选与预过滤

- `Candidate` 增加 `assignees`、`labels`（快照层从任务卡带过来）。
- `prefilter::apply` 新增一条，排在状态判断之后、依赖判断之前：
  - 归属能认出来（本机存在该 id 且在允许名单里；或 `@codex` 这类应用名认回该应用下的智能体）→ 放行；
  - 认不出来 → `unknown-assignee:<id>`，不派发、不降级、不猜。
- 没有归属的卡照旧走判官选人。

### 4.2 结算：人工指派覆盖判官

`tick::settle` 在 `Action::Dispatch` 上做一次硬覆盖：候选有可识别的归属时，
`decision.app_id` 一律改成该智能体 id。判官仍可以 `ask` / `skip`（那是判断，不是选人），
但它**不能**把一张已指派的卡派给别人。这条放在结算层而不是提示词里：能被绕过的东西不能当闸门。

### 4.3 手动入口

- `router_start_task` 的选人顺序改为「卡片归属 → 上次运行快照 → 默认智能体」。
- 新增 `router_assign_task`：写 `assignee`（可选立即开工）。四条守卫：
  1. 依赖未满足 → 拒绝并说明是哪张卡（`blocked-by:<id>`）；
  2. 影子模式 → 只写「排队」运行态，不真起进程；
  3. 模型未就绪 → 原样报错，不换模型；
  4. 智能体不在允许名单 / 未注册 → 拒绝。
- 写 `assignee` 不动 `updated_date`：改的是归属，不是任务内容（与改排期同一条约定）。

## 5. 后端接口

| 命令 | 作用 |
|---|---|
| `router_assign_task(root, taskId, agentId, start, fingerprint)` | 指派（可立即开工），返回 `{assignees, started, detail}` |
| `router_agent_draft(history, message)` | 工作室一轮对话，返回 `{reply, draft?}`：模型唯一写入口是一段 `phi-agent` JSON |
| `router_agent_suggestions(root?)` | 调度器提议：近 14 天同类已完成卡 ≥ 3 张且没有对应智能体时给一条预填建议 |
| （改）`router_save_settings` | 保存前派生 id、校验 harness 上限与各段长度 |
| （改）`router_start_task` | 归属优先选人 |
| （改）`task_*: set_assignees` | 看板仓储新增写 `assignee` 的方法 |

工作室不新开工具表：复用 `SidecarEpisode::chat`（无工具通道），模型只被允许在回复里给一段
`phi-agent` 围栏 JSON，Rust 侧做结构校验后再交给编辑器。**写入口仍然只有一个**，
而且它没有文件写、没有进程、没有数据库。

## 6. 前端

### 6.1 一级入口与视图切换

看板操作行（与「自动调度」「仓库」同一排）新增分段控件：**看板 / 智能体**。
「智能体」视图承担两件事：按人派活（行视图）与智能体管理——添加、编辑、**启停派发**、
**删除（行内二次确认）**、工作室都在这个视图里完成。

自动调度面板里那套列表保留：它就在「开关/配额」旁边，就地改配置比来回切视图顺手。
两处写的是同一份 `router_settings`，口径都走 `agentSettings.ts`，不会出现两套行为。

### 6.2 智能体视图

- **第 0 行「与 Router 讨论」**：讨论卡（`kind === "discussion"`）一行，行头写明「讨论不等于派发」，
  不接受拖放指派（讨论卡没有归属）。
- **智能体行**：按允许名单顺序，一行一个智能体。行头 = 名称 + 应用/模型 + 「空闲 / N 张在跑」
  + 参与派发开关 + 编辑 + 删除（点一次变「确认删除」，再点才真删）。
  行内：未结束卡全部显示；Done 默认最多 3 张 + 「已完成 N · 全部」展开。
- **未分配行**：没有任何可识别归属的卡；它是「谁都没接」的唯一可见信号。
- **未注册归属**：卡面标「未注册的智能体」，可拖到别的行修好；不会被自动派发。
- **拖放 = 指派（意图）**，不等于授权开工——与「讨论 ≠ 授权开工」同一类判断。
- 行内卡片上的 ▶ 是第二个动作：**指派并开工**（只在未结束、非讨论卡上出现）。

### 6.3 详情页

「自动调度」一节新增一行归属：当前归属智能体下拉 + 「指派」/「指派并开工」按钮。
下拉只列允许名单，另有「未指派」；未注册归属按原值显示并说明「本机没有这个智能体」，
不静默改写。已经是 Done 的卡不给「指派并开工」（它已经结束了）。

### 6.4 智能体编辑器

在原有六项之后追加五段式编辑区（结果 / 边界 / 先问用户 / 步骤 / 约束 / 完工标准与证据），
每段独立、可留空；底部实时显示 harness 字数与 6000 上限，超限禁止保存并说明原因。

「工作室」的入口在**智能体视图顶部**（不在编辑器弹窗里再叠一层弹窗）：说清要一个什么智能体 →
模型给出可编辑草稿 → 点「用这份草稿」填进编辑器 → 人改完再保存。

## 7. 文件级改动清单

后端：

- `src-tauri/src/super_agent/model.rs`：`RouterAgent` 新字段、`AgentCompletion`、上限常量；`Candidate` 加 `assignees/labels` 与归属解析。
- `src-tauri/src/super_agent/agents.rs`：`harness()`、各段校验、slug 派生、`save` 前的 `normalize_agents`。
- `src-tauri/src/super_agent/prefilter.rs`：`unknown-assignee` 规则。
- `src-tauri/src/super_agent/tick.rs`：`settle` 归属覆盖；`start` 选人顺序。
- `src-tauri/src/super_agent/snapshot.rs`：带出 assignees / labels。
- `src-tauri/src/super_agent/commands.rs`：`router_assign_task`、`router_agent_draft`、`router_agent_suggestions`、保存前归一。
- `src-tauri/src/super_agent/studio.rs`（新）：工作室提示词、`phi-agent` 解析与校验。
- `src-tauri/src/super_agent/proposals.rs`（新）：提议规则。
- `src-tauri/src/tasks/repository.rs`：`set_assignees`。
- `src-tauri/src/lib.rs`：注册新命令。

前端：

- `src/lib/api/superAgent.ts`：新字段与三个新接口的类型。
- `src/components/tasks/AutoRouterPanel.tsx`：编辑器五段式 + harness 计数 + slug；工作室对话框；建议条。
- `src/components/tasks/AgentBoardView.tsx`（新）：行视图。
- `src/components/tasks/TaskBoardPage.tsx`：视图切换、行视图数据装配、拖放指派、指派并开工。
- `src/components/tasks/AutoRouterSection.tsx`：归属下拉 + 指派并开工。
- `src/i18n/locales/{zh,en,ja,zh-TW}.json`：新文案。

## 8. 验收标准

1. 老智能体（只有 name/description/prompt）保存、派发行为不变；新字段进入 harness，超 6000 字保存直接报错。
2. 卡片写 `assignee: [文档写手]` 且该智能体存在时，自动派发必须派给它，判官提名别人也会被覆盖。
3. 卡片归属一个不存在的 id：卡面标「未注册的智能体」，不进入自动派发，拖到别的行可修好。
4. 智能体视图：讨论卡在第 0 行；每行只显示本行卡；Done 默认 3 张 + 计数可展开；未分配行不为空时不丢卡。
5. 详情页「指派并开工」：依赖未满足被拒并指名依赖；影子模式只记排队；模型未就绪原样报错。
6. 工作室：一轮对话能产出可编辑草稿，且模型无法直接写入设置（保存仍需人点）。
7. 提议：近 14 天同类已完成卡 ≥ 3 且无对应智能体时出现建议；已有智能体覆盖时不重复提示。
8. `cargo test` 相关模块、`pnpm typecheck`、`vitest` 相关用例通过。

## 9. 本次不做（明确留出）

- **智能体随仓库走**（`.phi/agents/*.md`）：本轮明确「定义在本机，仓库只存 id」。
- **能力引用（capabilityRefs）**：见 §3 的差异说明。
- **工作室对话持久化**：草稿未发布，对话只存在这一次界面会话里，重开即废（计划里原写「存 sqlite turns」，
  这里按「未发布草稿不该占库」收敛；若要跨重启继续编辑，再补表）。
- **调度器提议自动创建**：只提议、不落库；人点开编辑器改完保存才算数。
- **按会话隔离模型**：仍保留「不支持会话级模型的应用只能跟随应用」的原有限制。

## 10. 实施与验证记录（2026-11-21）

已按本文件实施完毕。逐项对照：

| # | 验收项 | 结果 | 证据 |
|---|---|---|---|
| 1 | 老智能体行为不变；超 6000 字保存报错 | 通过 | `the_harness_follows_the_fixed_section_order`、`an_agent_without_a_definition_keeps_the_old_prompt`、`an_oversized_harness_is_rejected_at_save_time`；前端 `角色上下文超过 6000 字时直接拦住保存` |
| 2 | 归属决定派发给谁，判官提名被覆盖 | 通过 | `the_assignee_overrides_the_judges_nomination`、端到端 `an_assigned_card_is_dispatched_to_its_own_agent` |
| 3 | 未注册归属不派发、不换人 | 通过 | `an_unknown_assignee_blocks_automatic_dispatch`、`an_unregistered_assignee_never_reaches_the_dispatcher`；视图 `归属认不出来时落在「未分配」` |
| 4 | 行视图：讨论行 / 每行归属 / Done 3＋计数 / 未分配 | 通过 | `AgentBoardView` 8 条用例；`TaskBoardPage — 智能体视图` 2 条集成用例 |
| 5 | 指派并开工的四条守卫 | 通过（代码路径） | `router_assign_task` 依赖前置检查、影子只排队、`agent.ready` 原样报错、白名单校验；前端 `指派只改归属` 用例 |
| 6 | 工作室只产草稿，写入仍要人点 | 通过 | Rust `studio` 5 条解析用例；前端 `AgentStudioDialog` 用例 |
| 7 | 提议的三张门槛与去重 | 通过 | `repeated_completed_cards_propose_a_new_agent`、`two_completed_cards_are_not_a_suggestion` |
| 8 | 门禁 | 通过（见下） | — |

验证命令与结果：

- `cargo check --all-targets`：通过（无 error / warning）
- `cargo fmt --check`：通过
- `cargo test --lib super_agent::tests`：**74 passed**
- `cargo test --lib tasks::repository::tests`：**33 passed**（含 `set_assignees` 3 条）
- `pnpm typecheck`：通过
- `pnpm format:check`：通过
- `npx vitest run`：**246 文件 / 2920 用例全部通过**

一条必须写明的限制：全量 `cargo test --lib` 仍有一批 `proxy::*`、`gateway::*`、`mode::*` 的网络类用例
在本机沙箱里失败（`ForwardFailed` → 502、上游目录发现失败），单条运行同样失败，不是并发抖动。
本文件改动没有触及这些模块；但「改动前是否同样失败」未能机械证明——干净的 HEAD worktree 在本机
无法编译（缺 `ghostty-sdk`、`binaries`、`sidecar/dist` 这些生成物），所以这一条留作未验证项。


### 10.1 评审整改（同日）

第一次整体评估被独立审计驳回，逐条修完：

| 审计意见 | 修法 | 取证 |
|---|---|---|
| 智能体视图没有承接完整管理（缺删除/允许名单） | 行头加「参与派发」开关与删除（二次确认）；`withAgentEnabled` / `withAgentDeleted` 走同一份设置 | `允许名单就在行头改`、`删除要二次确认` |
| 讨论卡仍可被拖放指派 | 卡片 `draggable` 与两处 `onDrop` 都排除 `kind === "discussion"` 与已完成的卡 | `讨论卡不接受拖放指派` |
| 「Done 的卡不给指派并开工」判断错位（只看运行态） | 新增 `taskStatus`，`finished` = 运行态 done 或卡片在 Done 列；开工入口与「开始」同时受它约束 | `卡片已在 Done 列时……也不给开工入口` |
| 整体评估的产物无法核对 | 新增 [agent-centric-board-evaluation.md](./agent-centric-board-evaluation.md)：逐项对照、偏差、未验证项、6 条待拍板调整 | 该文件 |

整体评估与待决调整见 `agent-centric-board-evaluation.md`。


