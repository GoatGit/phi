# phi V1 设计文档集（基于 cc-switch fork）

> **版本**：V1 设计稿 v1.4（持久汇总、归因、诊断与通知实施修订）（2026-10）
> **Fork 基线**：cc-switch v4.0.8（本地快照 `tmp/cc-switch`，git `2b0ec81`，2026-10-11，main 分支）
> **上游**：github.com/farion1231/cc-switch（MIT © Jason Young）
> **前置文档**：`docs/ai-agent-gateway-product-plan.md`（V0 产品计划，本文档集在其基础上按 V1 策略修订）

---

## 策略一句话

**phi V1 当前以 cc-switch 的 2b0ec81 main 快照为起点独立开发，此后不合并上游代码**（版本标识 v4.0.8，release tag 对应关系须在发布冻结时核验）（仅按 SOP 手动移植安全与适配器关键修复）。fork 把"核心体验——让用户自由使用所有模型"从 0 抬到约七成，phi 的工程资源集中在 fork 没有的部分：深度协议黄金集保障、请求级账本归因、可解释路由、配置版本化、凭据安全升级与品牌化交付。

2026-10-13 路由范围扩展：路由组、组内策略、会话保持、意图路由及状态数据展示纳入 V1，详见 03 和 10。当前路由快照使用 gateway_catalog / gateway_traces，与后续权威账本设计区分。

此前修订统一了：凭据与快照加密、迁移及跨设备备份、全入口鉴权、可信在线归因、逐尝试计费、已结算预算阈值、可恢复配置基线、流式重试边界及任务自愈限制。文中新增表、脚本和验收项是待实现设计，不代表已交付功能。

## 文档索引

| 文档 | 内容 | 读者 |
|---|---|---|
| [01-总体设计.md](01-总体设计.md) | 产品定位、fork 策略、V1 范围、总体架构、关键决策、里程碑、风险 | 全体 |
| [02-网关核心设计.md](02-网关核心设计.md) | 协议互转引擎：继承能力盘点、黄金集测试、crate 化、进程模型 | 网关研发 |
| [03-路由与故障转移设计.md](03-路由与故障转移设计.md) | 路由策略模型、熔断/故障转移、路由决策解释 | 网关研发 |
| [04-Agent配置适配层设计.md](04-Agent配置适配层设计.md) | 双模式写入、配置版本化、上游追踪 SOP、新 Agent 适配流程 | 平台研发 |
| [05-账本与观测设计.md](05-账本与观测设计.md) | 请求级账本、归因、预算限流、估算口径 | 数据/后端 |
| [06-数据模型与存储.md](06-数据模型与存储.md) | 基线表清单、新增表 DDL、迁移策略 | 后端 |
| [07-凭据与安全设计.md](07-凭据与安全设计.md) | Keychain 迁移、回环监听、脱敏、订阅合规立场 | 安全/后端 |
| [08-品牌迁移与桌面端设计.md](08-品牌迁移与桌面端设计.md) | 改名清单、UI 信息架构、发布通道 | 前端/发布 |
| [09-测试与验收.md](09-测试与验收.md) | 继承测试基建、黄金集、迁移测试、验收标准 | QA/全体 |
| [10-magpie路由对照与实施.md](10-magpie路由对照与实施.md) | magpie 行为对照、实际实现位置、边界和验证 | 全体 |
| [11-代码审查与补齐记录.md](11-代码审查与补齐记录.md) | 实施状态、代码证据、验证结果与未完成项 | 全体 |
| [12-嵌入终端与应用标签页设计.md](12-嵌入终端与应用标签页设计.md) | 应用页终端标签、macOS Ghostty 集成、CLI 启动与生命周期（macOS 首版已接入） | 桌面端研发 / 全体 |

2026-10-14 桌面范围补充：支持 CLI 的应用页增加终端标签和 ＋，首版设计采用 macOS 原生 libghostty，详见 12。已接入 macOS 13+ 原生终端；构建、实测和剩余发布验收见 12 §7.4。

## 阅读顺序

第一次阅读按编号顺序；只想了解"改什么"的读者读 01（总体）→ 06（数据模型）→ 09（验收）。

## 基线事实速览（来自源码调研，2026-10-11）

- 技术栈：Tauri 2.8 + Rust（tokio/axum 0.7/hyper 1/reqwest+rustls/rusqlite bundled/rquickjs）＋ React 18 + TypeScript + Vite 7 + shadcn/ui + TanStack Query v5
- 架构分层：Commands → Services → DAO → SQLite（SSOT：`~/.cc-switch/cc-switch.db`）；live 配置经 `*_config.rs` 原子写入
- 本地网关：`src-tauri/src/proxy/`（约 40 个模块），进程内 axum 服务器，含 provider 适配（claude/codex/gemini/copilot/xai）、跨协议 transform/streaming、熔断、故障转移、thinking 系列矫正器、usage 统计（calculator/logger/parser）
- 数据库 17+ 张表：providers、provider_endpoints、mcp_servers、prompts、skills、skill_repos、settings、proxy_config、provider_health、proxy_request_logs、model_pricing、stream_check_logs、proxy_live_backup、usage_daily_rollups、session_log_sync、session_usage_dedup、profiles
- 凭据现状：API Key 明文存 SQLite；仅 OAuth token（Codex/Claude 订阅、Copilot、xAI）涉及系统 Keychain
- 支持的 Agent（live 配置读写）：Claude Code、Claude Desktop、Codex、Gemini CLI、Grok Build（switch 模式）；OpenCode、OpenClaw、Hermes、Pi、MiniMax Code（coexist 模式）
- 测试：vitest + MSW（前端）、cargo test + serial_test/tempfile（后端，`PHI_TEST_HOME` 隔离）、CI 覆盖 Linux/macOS/Windows

## 与 V0 产品计划的关系

V0（`ai-agent-gateway-product-plan.md`）的六层架构与"成本-质量闭环"叙事继续有效，但按后续讨论做了两处修订，本文档集以修订后为准：

1. **核心体验重定义**：核心 = 让用户自由使用所有模型（接入、模型、凭据、切换、连续性、反锁定六要素）；账本、可靠性观测、故障恢复属于延伸体验，承担留存与付费，不承担获客。
2. **实现策略重定义**：V0 假设从零自建（Tauri+Rust 全部自研）；V1 改为 fork cc-switch 起步。V0 阶段一（0–3 个月）的"两协议 + 6–8 Agent"由 fork 基线直接超越。
