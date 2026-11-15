# Router 与 Jev：把判断放回控制流里

这份文档描述 phi 的自动调度器（下称 super-agent）的设计。它要回答三个问题：
怎么在没有新看板列、没有新表单的前提下让任务自动跑起来；为什么调度循环里要放一个
判别模型（Jev）；以及这两者之间到底是什么关系。

文末第 10 节记录了这份设计经过评审后改掉的地方，包括初稿里几处会真正出事的错误。

---

## 1. 要解决的问题

一个人同时跟住 3 到 5 个 agent 会话就到顶了。单个任务的天花板是模型能力，多个任务的天花板
是人的注意力——你要不断地看谁卡住了、谁在等我拍板、下一张卡该派给谁。这些判断单次都很轻，
但它们的总量随任务数线性增长，而且必须由人来做。

phi 已经有零件：任务卡是仓库里的 markdown（Backlog.md 格式），agent 跑在托管终端里，
会话的退出码有 journal 记录。缺的是中间那一层：**谁来决定现在该动哪张卡、派给谁、卡住了要不要叫人。**

这一层如果做成"再写一个更聪明的 agent"，会立刻遇到一个陷阱：能自己干活的 agent 不会委派。
DeepSeek 在 super-agent 的设计文章里给过实测：给单个 agent 加一句"需要时可以起子 agent"，
五次测试里一次都没发生。这不是提示词写得不好，是结构问题——它自己能做完，就没有理由把活交出去。
所以调度器必须是**不能干活的一层**：它没有 shell、没有文件写权限，物理上没有退化成本人的可能。

## 2. 地基：控制流与谓词

这个循环里有两个角色，它们不是前后两步，而是不同种类的东西。

**pi 是控制流。** 它决定现在该问什么：是先读卡，还是先判断这张卡到底缺什么，还是直接提名一个
worker。它可以读三张卡再决定，也可以一上来就放弃。

**Jev 是谓词。** 它只回答三种问题：像不像（choice）、值不值得（score）、属于哪一类（noul）。
它不发起动作，不决定流程，也不记得上一次问了什么。

一旦把 Jev 写成"派发之前必须过一遍"或者"收尾之后再校验一遍"，控制流就被压成了一条直线，
而这条直线恰恰是人不想要的东西——真实情况里，有时缺的是注意力（卡太多，先收窄），
有时缺的是许可（这一步该不该做），有时缺的是判断（这属于哪类阻塞）。这三种缺口出现在
循环的不同位置，只有控制流自己知道现在缺哪个。

### 2.1 为什么这里必须有进程边界

phi 是 Rust + React，运行时不带 Node。现有唯一的 sidecar 是 Go 写的 `phi-subscriptions`。
所以"内嵌 pi"在 phi 里只能是：**一个 Node sidecar 进程跑 pi SDK，与 Rust 侧用 stdio 上的 JSON-RPC 说话。**

这个边界不是妥协，它正好把职责切干净：

| 归 sidecar | 归 Rust |
|---|---|
| pi 会话、模型调用、工具注册 | 快照、配额、租约、执行决定、记账 |
| 模型可见的 Jev 工具（它可以随时调） | 模型不可绕过的闸门（它看不到实现） |

判断依据只有一句：**能被绕过的东西不能当闸门。** sidecar 里的一切都是模型可以不听劝的，
所以"派发前必须通过 Jev"这类检查放在 Rust。模型只能提交一个提名，Rust 判定之后回
"通过"或"拒绝 + 原因"，模型看到的是自己的一次工具调用失败。

## 3. Jev 出现在三个位置

| 位置 | 谁触发 | 问什么 | 失败时 |
|---|---|---|---|
| 注意力分桶 | 代码（候选超过阈值时） | 这批里现在值得处理的哪几张 | 全量进循环 |
| 动作闸门 | 代码（挂在工具上，模型绕不过） | 这张卡和这个 worker 匹配吗；这事真的需要人吗 | 见 3.1，按判断子类分档 |
| 循环内工具 | 模型自己 | 哪个更像我想要的；这是哪种阻塞 | 工具返回错误，模型自己应变 |

第三行才是"顺序会变"的来源。模型可以一次都不调判官，这不是缺陷：Jev 是"有它更稳"的工具，
不是必经节点。但有个前提要在实现里守住——如果观察下来它几乎从不使用，就把那一段升级成
代码强制的闸门，而不是再往提示词里加一句。这跟 DeepSeek 那条"结构 > 提示"是同一个道理。

### 3.1 闸门的失败语义不能一刀切

初稿写的是"闸门 fail-closed，拒绝并转人工"。评审时发现这条会在 Jev 抖动时把整个看板变成人工队列：
一次超时，所有提名都变 `needs-you`，而 `needs-you` 是要人来看的——等于用判官故障换来了注意力债务。

正确的分档是按**判断的后果**分，不是按"是不是闸门"分：

| 判断 | 错了会怎样 | 失败时 |
|---|---|---|
| 这张卡该不该现在动 | 多花一次派发，可回滚 | 放行（fail-open），标记 `degraded` |
| 派给哪个 worker | 派错人，重派一次 | 用默认 worker（fail-open） |
| 是不是在等人给决定 / 有没有越权 | 打扰人、越界执行 | 拒绝 + 转 `needs-you`（fail-closed） |

也就是：**代价可回滚的判断放行，代价不可逆的判断拦住。** 注意力分桶天然是放行档。

## 4. 一个 tick 的控制结构

```
tick:
  snapshot     纯代码：任务、运行态、配额、暂停标记
  prefilter    纯代码：归档 / Done / 暂停 / 租约生效中 / 冷却中 直接剔除
  gate-0       纯代码：配额为 0 → 空跑，不进循环（省一次会话）
  attention    [可选 Jev] 候选超过阈值时收窄；失败则全量进
  episode      pi 会话，工具白名单，预算：8 步 / 5 次判官 / 60s
      每步：模型 → 工具调用 →(闸门)→ 工具结果 → 观察
  settle       校验 decisions 的 schema 与枚举；丢弃非法项并记因
  apply        代码执行：写运行态、拉租约、派发、记账
```

工具白名单就是全部"手"：

- 读：`read_task` / `list_workers` / `read_budget`
- 判：`judge_choice(question, options)`，**options 由代码给**，封闭枚举，不让模型自己编候选
- 判：`judge_score(state, rubric)` / `judge_class(state, labels)`
- 提名（唯一副作用，而且只是提名）：`nominate_worker(task_id, app_id, reason)`
- 提名：`ask_user(question, options)`
- 规划：`plan_task(task_id)`（内部起一个只读子会话产出 DAG）
- 收尾：`finish(decisions)`

没有 shell、没有文件写、没有网络。这不是靠提示词禁止，而是工具表里本来就没有。

## 5. 顺序真的会变

- **简单卡**：prefilter → 循环 → `read_task` → `nominate_worker`（闸门判匹配，通过）→ `finish`。
  判官只出现一次，在循环中间。
- **含糊卡**：prefilter → 循环 → `read_task` → `judge_class`（判为"缺一个只有人能给的答案"）
  → `ask_user`（闸门再判一次"值不值得打扰人"）→ `finish`。判官出现两次，都在动作之前。
- **大卡**：prefilter → attention（先收窄）→ 循环 → `read_task` → `plan_task`（产出 DAG）
  → 对每个子任务逐个 `nominate_worker`（每次一道闸门）→ `finish`。判官在进入循环之前、
  循环之中、每个动作之前都出现过。

同一个谓词，三次出现的时机完全不同，取决于这一 tick 缺的是注意力、许可还是判断。

## 6. 让一次往返问三个问题

System One 的请求体是 `{ model, state, questions: { <id>: { type, instructions } } }`，
`type` 只接受 `noul / choice / score / box`。一个 `questions` 里可以放多个问题，
一次网络往返拿到全部答案。Router 每 tick 的判别成本因此可以压到一次调用：

```
questions:
  should_act:  { type: noul,   instructions: "这张卡现在值得动吗" }
  needs_human: { type: noul,   instructions: "这件事是否需要人先给一个决定" }
  worker:      { type: choice, instructions: "哪个 worker 更匹配：claude / codex / gemini" }
```

注意答案里的 `probabilities` 只用来排序和告警。所有"派 / 不派"的边界必须由阈值加确定性
规则（配额、暂停、租约）兜住。另外 choice 答案要求 top1 减 top2 不低于一个 margin，
否则视为"判官也不确定"，走确定性兜底而不是赌第一个。把机器判定建在概率上是删掉的跑门
犯过的错，不能再犯一次。

## 7. 任务运行态与看板文件的关系

看板文件的 frontmatter 是用户和其他 agent 的公共约定，phi 不往里塞自定义状态。运行态存数据库：

```
idle → queued → dispatched → working → done | failed | needs-you | paused
```

规则只有一条：**markdown 里的 status 是用户意图的唯一权威，自动路径一个字都不写。**

自动派发只看「卡片在不在触发列」，所以不需要回写；判断也只看运行态表，不从列名反推。
唯一会写 markdown 的是人按下「开始」那一刻：如果这张卡还不在触发列，先把列改过去
（`status` 与 `updated_date` 两行，写前比对内容指纹，卡片被外部改过就放弃写入），
否则它只是一次孤立派发——跑完没有 tick 会去收尾。用户把卡片拖出触发列，等价于撤销这次运行。

**收尾靠三个信号，逐级降级**：托管会话还在不在 → journal 里的退出码 → 卡片内容有没有被改过。
只有「退出码 0 且卡片确实被改过」才判完成，其余一律转 `needs-you` 并写清原因。
宁可让人看一眼，也不自动宣布成功。

用户能对任何任务做的四个动作：

| 动作 | 实际行为 | 对 markdown |
|---|---|---|
| 暂停 | 杀掉整个进程组，进入 `paused`，不再自动重派 | 不改 |
| 启动 | 跳过 tick 的冷却，立即派发 | 写 `In Progress`（带指纹校验） |
| 恢复 | `paused → queued`，有交接单则注入续跑 | 不改 |
| 归档 | 先停进程，再走现有的归档命令 | 移入 `archive/` |

## 8. 配额、租约与记账

**配额用次数，不用钱。** 钱要经过定价表，而成绩单那边已经证实很多会话拿不到 `cost_usd`。
所以 gate-0 看两个计数器：本 tick 的派发次数上限、当天的派发次数上限、当天的判官调用次数上限。
三个都落库，重启不清零。

**租约防重复派发。** `(task_id)` 一行，TTL 90 秒，tick 每轮续。进程被杀之后，过期租约在下一轮
自动回收——没有这一条，一次崩溃会让任务永远停在 `dispatched`，谁也不敢再动它。

**trace 只写不读。** 每 tick 落一条：候选、判官调用次数与耗时、决策、被闸门拒绝的原因。
排障时看它，运行态只看 `task_runs` 表。两套真相迟早对不上。

## 9. 数据表

| 表 | 内容 |
|---|---|
| `router_settings` | 单行 JSON：开关、触发列、并发上限、三个配额、阈值 |
| `router_task_runs` | `task_id` 主键 + 根路径、状态、worker、会话 id、尝试次数、最后说明、派发时的卡片指纹、更新时间 |
| `router_dispatches` | 每次派发一行（任务、仓库、worker、时间），配额按它算，不从运行态推 |
| `router_leases` | `task_id` 主键 + 持有者、到期时间 |
| `router_traces` | 一次 tick 一行：触发来源、候选、决策、判官用量、耗时、降级标记 |
| `router_plan_nodes` | 规划 DAG 的节点：任务、节点 id、标题、依赖、分配的 worker、状态 |

`router_task_runs` 的 `state` 与看板列是两个东西，不要互相推导。

## 10. 评审记录：改掉了什么

设计初稿写完之后做了一轮对照代码的评审，下面每条都是**初稿会真的出问题**的地方。

1. **初稿把"pi 能否打成单文件 sidecar"当成前置阻塞。** 这是把整条线押在一个没验证的工程问题上。
   修正：先定 sidecar 的 JSON-RPC 契约，Rust 侧实现一个不依赖 sidecar 的确定性 episode
   （规则版），sidecar 到位后替换。判官同理，先用可注入的 trait，接 Jev 只换实现。
2. **初稿说"没有 `finish` 就没有下一步"。** 这会把一次超时变成一次全量丢弃：已经合法产生的提名
   也被扔掉。修正：缺 `finish` 只降级——取已观测到的提名，标记 `unfinished`；只有"没有任何合法提名"
   才算空跑。强制的是**结算必须有 schema 校验**，不是"必须有 finish"。
3. **闸门一律 fail-closed。** 见 3.1，按后果分档。这是初稿最危险的一条。
4. **"预算为 0 → 空跑"没说预算口径。** 修正为三个次数配额。用钱会导致配额永远显示为 0，
   因为很多会话没有价格，gate-0 就成了永久空跑。
5. **注意力分桶没有排除已在跑的任务。** 候选里混进 `dispatched` / `working` 会造成重复派发。
   修正：分桶只对 `idle` / `queued` 生效，其余状态在 prefilter 已经剔除。
6. **概率直接变判决。** 见第 6 节末，补了 margin 与兜底规则。
7. **phi 回写 status 会和用户拖动打架。** 修正为"只在 queued→dispatched 那一次写，且校验指纹"。
8. **租约没定义过期。** 修正为 TTL 90 秒 + 每轮续 + 过期回收。
9. **trace 与运行态两套真相。** 修正为 trace 只写不读。
10. **`plan_task` 的子会话会吃光 episode 预算。** 修正：规划子会话有独立预算（4 步 / 2 次判官），
    且它的花费单独记在 trace 的 `plan_judge_calls` 上。

## 10.1 实现阶段的第二轮评审

写完代码对着实现再走了一遍，改掉的是会直接出问题的四处：

11. **初稿没有「收尾」。** 派发之后没有任何东西会把 `dispatched` 改成别的状态，
    一次派发就让任务永久占着并发名额，表现为「调度器跑了一轮就再也不动了」。
    修正：每轮 tick 先结算已结束的 worker（见第 7 节的三级信号），再决定这一轮派谁。
12. **收尾会误判完成。** 只看「进程没了」或「退出码 0」都会把「agent 说完了但什么都没做」
    判成完成。修正：记下派发那一刻的卡片指纹，退出码 0 且指纹变了才算完成。
13. **「开始」会派发一张不在触发列的卡。** 那样它跑完没人收尾，因为 tick 只认触发列。
    修正：「开始」先按指纹校验把卡片挪进触发列，再派发。
14. **写运行态的参数有 9 个。** 位置参数一多，漏写一个字段编译器不会发现。
    修正：收成一个 `RunWrite` 结构，每个调用点必须显式声明是否保留 worker、会话、
    指纹与尝试次数。
15. **运行态只按任务 id 做主键。** 每个 backlog 仓库都有自己的 TASK-1，两个仓库一起
    用时状态会互相覆盖。修正：主键改成 `(root, task_id)`，租约同理；界面只显示当前仓库
    的运行态。
16. **改了建表语句却没有迁移。** `CREATE TABLE IF NOT EXISTS` 不会给已有的表补列，
    本机跑过一次中间版本之后，界面直接报「no such column: shadow」。修正：补 v28→v29
    迁移（重建两张表、搬迁数据）并加迁移测试。这条已写进 `LESSONS.md`。

## 11. 落地顺序

1. 确定性内核：快照、prefilter、门、决策校验、规则版 episode、运行态与租约、trace。
   这一层没有任何模型调用，可以完整单测。
2. 接 Jev：注意力分桶与动作闸门，走 phi 自己的代理（`/typesafe/v1/systemone` 已在进程内可用），
   失败按 3.1 分档。
3. 派发：macOS 走托管终端（`terminal_create`，任务描述作为初始指令），其他平台需要一条
   headless 通道，在那之前明确返回"不支持"，不假装派发成功。
4. pi sidecar：按已定的 JSON-RPC 契约接入，替换规则版 episode。
5. 界面：详情页画出 worker 分配与 DAG，看板上只多三个标记（运行中 / 等你看 / 已暂停）。

每一步都能单独回滚。第 1 步做完就能跑 shadow（只写 trace、不派发），先确认判断得对不对，
再开放执行——不拿一整周的额度去调一个自己没观测过的循环。

当前进度：

- 第 1 步（确定性内核）、第 2 步（注意力分桶与配额）、第 3 步的 macOS 分支（托管终端派发 + 收尾）已完成。
- 第 5 步的界面已完成第一版：卡片上的运行标记（运行中 / 等你看 / 上次失败 / 已暂停 / 影子）、
  头部「自动调度」开关面板（开关、影子、触发列、并发、派给谁、今日配额、跑一轮）、
  详情抽屉里的执行状态与计划列表（有规划节点时按依赖顺序画出）。
- 第 4 步做了一半：**管道、闸门、分发已落地，脑子还没换**。stdin/stdout 上的行分隔 JSON、
  七个工具的 Rust 侧实现、步数与判官额度、提名闸门、三条降级规则都在
  `super_agent/sidecar.rs` 里，并用一个 node 写的参考实现跑了端到端测试。
  缺的是把参考实现里的那段确定性策略换成 pi 的循环——工具表和协议不用再动。
- headless 派发也还没有。

界面第一版有一个刻意的克制：不显示「预算还剩多少钱」。配额是次数，钱要经过定价表，
而很多会话拿不到价格——显示一个永远为 0 的金额比不显示更糟。

## 11.1 sidecar 协议

行分隔 JSON，一次 episode 一个子进程，双向一问一答：

```text
Rust → sidecar   {"type":"episode.request", id, budget, settings, candidates, tools, deadlineMs}
sidecar → Rust   {"type":"tool.call",  id, name, args}
Rust → sidecar   {"type":"tool.result", id, ok, result | error:{code,message}}
sidecar → Rust   {"type":"episode.done", note?}
```

工具表就是全部的手，由 Rust 定，sidecar 改不了：`read_task` / `list_workers` / `read_budget` /
`judge` / `nominate_worker` / `ask_user` / `finish`。没有 shell、没有文件写、没有网络。

**闸门现在实际检查什么**（写清楚，免得以后把设计当成现状）：

| 工具 | 已实现的检查 | 还没接的 |
|---|---|---|
| `read_task` | 任务必须在这一轮候选里 | — |
| `judge` | 判官额度、choice 的候选只能是 `list_workers` 里的人 | 题型的细分（score 现在走 noul 入口） |
| `nominate_worker` | worker 在允许表里、任务在候选里、同一张卡一轮只收一个结论 | 「这张卡配不配这个 worker」的判官判定 |
| `ask_user` | 问题非空、同一张卡一轮只收一个结论 | 「值不值得打扰人」的判官判定 |
| `finish` | 只是收尾，不改任何决策 | — |

**模型请求走 phi 自己的网关**。侧车不做任何供应商配置：请求发到
`http://127.0.0.1:<网关端口>/pi/v1/chat/completions`，凭据是 phi 为本机 `pi` 身份签的令牌
（`proxy/ingress.rs` 的 `token("pi")`）。这么定的三条理由：凭据不出本机；故障转移与记账
复用 phi 已有那条链路；路由页里改 pi 的模型就等于改调度器用的模型。网关没在监听时 Rust
不把 `model` 字段放进请求，侧车直接走确定性策略——不让模型干等一次超时。

界面上的入口是头部面板里的「调度模型」，默认「按规则（不用模型）」。选项只列**包含 pi 的
路由组**，写进设置的值是 `group/<组名>`——网关收到后展开成组内成员，所以调度器不需要知道
具体模型叫什么。实测：用 `group/dfsfs` 打网关，回包 `model: glm-5.3`，链路通。

默认关着是刻意的：tick 每 30 秒一轮，开着模型就是每 30 秒一次调用，一天几千次。
先让人看清它判断得对不对，再让人决定要不要一直花钱。

侧车内部两条路实测过（pi 的 agent 循环、确定性策略）：`sidecar/test/episode.test.mjs`
起一个假的 OpenAI 兼容服务，不依赖真网关，`cd sidecar && npm test` 即可。它覆盖三件事——
模型要工具时变成 `tool.call`、模型这条路挂了退回确定性策略、没有 `model` 字段时根本不连模型。

三种失败的分档写在实现里：

- **步数/判官额度用完**：工具返回错误，模型自己应变，整轮继续。
- **没有 `episode.done`**（超时、子进程退出）：已通过闸门的提名照用，整轮标 `unfinished`。
- **子进程起不来、协议乱、崩溃**：这一轮退回规则版 episode，并在 trace 里留一行
  `sidecar-failed:<原因>`。退回只接「实现故障」，不接「这一轮本来就不该动」。

**分发形态**（已落地）：安装包自带 node 运行时，不再依赖用户机器上有 node。

- `sidecar/` 有自己的 `package.json`，pi SDK 与 esbuild 装在那里，不污染应用依赖。
- `scripts/build-sidecar.mjs` 把 `sidecar/src/episode.mjs` 打成 `sidecar/dist/router-episode.mjs`。
  两个坑写在脚本注释里：CJS 依赖在 ESM 产物里 `require` 内置模块要靠 `createRequire` 兜底；
  photon / koffi 这类原生模块只能标外部（实测我们的路径不碰它们，单独放到空目录也能启动）。
- `scripts/build-node-runtime.mjs` 下载官方 node 到 `src-tauri/binaries/phi-node-<triple>`，带缓存。
- `tauri.conf.json`：`externalBin` 加 `binaries/phi-node`，`resources` 把打好的脚本映射成
  `Resources/sidecar/router-episode.mjs`，两个构建钩子都串上。
- Rust 侧 `SidecarEpisode::bundled(app)`：`phi-node` 与主程序同目录、脚本在 resources 里，
  两者都在才会启用；环境变量 `PHI_ROUTER_SIDECAR` 仍然是调试用的覆盖项。
- 模型名用 `PHI_ROUTER_MODEL=<网关认得的模型>` 打开 pi 循环；不设就是确定性策略。
  两个环境变量都还没进设置界面——先把链路跑稳，再决定它在界面上长什么样。

实测代价（macOS arm64，本轮真实构建）：PHI.app 从 77 MB 变成 **194 MB**，
DMG 从约 27 MB 变成 **69 MB**。也就是说占盘 +117 MB、下载 +42 MB，和预估一致。
侧车脚本本身 2.6 MB（pi-agent-core + pi-ai，去掉 provider SDK 的 tree-shaking 后），
其余全是 node 运行时。

**一个必须记住的坑**：node 跑 V8 需要可执行内存，而 Tauri 默认给 app 开 hardened runtime。
裸签的子进程一启动就报 `Failed to reserve virtual memory for CodeRange`，然后每轮静默退回
规则版——界面完全正常，问题藏得住。修法是 `src-tauri/entitlements.plist` 里给
`allow-jit` / `allow-unsigned-executable-memory` / `disable-library-validation`，
并在 `bundle.macOS.entitlements` 引用；Tauri 会把同一份 entitlements 也签给侧车。
这条已写进 `LESSONS.md`。

## 12. 还没验证的事

- pi 循环的「打断当前步」：现在只靠 Rust 的墙钟上限（40 秒）杀进程。模型自己停下来靠的是
  工具报错与 `finish` 的 `terminate`，没有单独的取消通道。
- 模型这条路的成本没有计量：网关记账了，调度器这一侧只记「这一轮用没用模型」，不记花了多少。
  等真正天天开着用再决定要不要在这层也算一次账。
- pi 能否打成单文件 sidecar。**已实测，答案是不成立**：要么带 node 运行时，要么要求用户自己装。
  实测数据（macOS arm64，pi 0.73.1）：

  | 件 | 解包 | 压缩后 |
  |---|---|---|
  | node 24.16 官方单文件 | 115 MB | 36.9 MB（gzip） |
  | node 24.16 官方 tar.gz（含 npm/头文件） | — | 51.9 MB |
  | pi SDK 打成 bundle（minify，含全部 provider） | 6.4 MB | — |
  | 同上，把 provider 标成 external | 4.5 MB | — |
  | 原生件：photon 2.2 / clipboard 2.8 / koffi 单平台 1.6 | 最多 6.6 MB | — |
  | 对照：现在的 PHI.app | 77 MB | — |

  结论：装完多占约 120 MB 磁盘，下载包大约多 40 MB。另外它不是一个自足的 bundle——
  `@mistralai/mistralai` 静态引用了 `@opentelemetry/api`，把它标成 external 之后
  运行时会直接 `ERR_MODULE_NOT_FOUND`，所以「只装需要的包」这条路走不通，依赖得整带上。
  不装 bundle 而直接用 node_modules 的话是 200 MB（provider SDK 各占十几兆）。
  想省体积只有两条：换 Bun（zip 20.6 MB，与 pi 的兼容性未验证）或者依赖用户机器上的 node。
- 非 macOS 的 headless 执行：CLI 各自的一次性调用参数不同，需要一张模板表，且要处理
  交互式提示（比如权限确认）在无 TTY 下的行为。

## 13. 这一轮的验证记录

在 aarch64-apple-darwin 上实际跑过的：

| 检查 | 结果 |
|---|---|
| `cargo fmt --check` | 通过 |
| `cargo clippy --lib --tests -- -D warnings` | 通过，无警告 |
| `cargo test --lib super_agent` | 23 通过（快照/过滤/配额门/结算/影子/派发失败/收尾/租约相关的行为断言）|
| `cargo test --lib exit_hook::journal` | 9 通过（新增的尾部读取不影响既有的增量读取）|
| `cargo test --lib database` | 122 通过（v27→v28 迁移）|
| `pnpm typecheck` | 通过 |

没有验证的，写清楚：

- **判官的真实调用**：`SystemOneJudge` 走的是进程内 `/typesafe/v1/systemone`，需要本地配好 typesafe 组
  和一个可达上游。本机没有可用上游，所以这条路径只有单元层面的解析测试（noul 取值、margin、
  选项白名单），没有真实回包。同一环境里 32 个需要真实 TCP 上游的 proxy/gateway 用例也全部失败
  （502 与首包超时），这是本机环境限制，不是本次改动引入的。
- **真实派发**：没有启动过真正的 CLI 会话，`terminal_create` 的调用路径靠类型与既有实现保证；
  冒烟时应该先在影子模式看几轮 trace，再关掉 shadow 派一张卡。
- **界面**：这一轮只加了 `src/lib/api/superAgent.ts` 作为命令契约，没有改任何页面。

