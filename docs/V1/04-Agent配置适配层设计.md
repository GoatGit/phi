# 04 · Agent 配置适配层设计（phi-adapters）

> 改造级别：**增强**。基线：`src-tauri/src/{*_config.rs, pi_config/, live/, mode/}`、`proxy_live_backup` 表、`ProfileService`。

---

## 1. 职责与基线

适配层负责"SSOT（SQLite）→ 各 Agent live 配置文件"的读写。基线已实现：

### 1.1 覆盖面（10 个 Agent）

| 写入器 | Agent | 模式 |
|---|---|---|
| `claude_config`（Claude Code）、`claude_desktop_config.rs`、`codex_config.rs`、`gemini_config.rs`、`grok_config.rs` | Claude Code / Claude Desktop / Codex / Gemini CLI / Grok Build | **switch**：切换前先把当前 live 配置回填到当前 provider，再写入新 provider |
| `opencode_config.rs`、`openclaw_config.rs`、`hermes_config.rs`、`pi_config/`、`mcode_config.rs` | OpenCode / OpenClaw / Hermes / Pi / MiniMax Code | **coexist**：全部 provider 共存于同一 live 文件，无回填 |

模式控制与切换编排：`mode/controller.rs`。共性机制：**原子写**（临时文件 + rename）、注释/顺序/格式保留、`proxy_live_backup` 表兜底。

### 1.2 周边能力

- `ProfileService`：项目级配置快照（保存/切换）；
- MCP/Skills/Prompt 同步：`mcp/`、`SkillService`、`PromptService`（V1 继承不动）；
- 测试隔离：`PHI_TEST_HOME` 指向临时目录，避免污染真实 `~/.claude` 等。

**这一层是 fork 价值密度最高的资产**（每个 Agent 的格式怪癖都靠它消化），V1 原则：**结构不动，外围加固**。

## 2. phi 增量一：配置版本化与一键恢复（G5）

### 2.1 版本快照

新表 `config_versions`（DDL 见 06 §3）：

版本字段见 06：记录存在性、来源与可信状态；content 为压缩后 AEAD 密文，encryption_key_ref 指向 phi-secrets。不得将旧内容、diff 或 Profile 中的凭据再次明文落库。

- 写入前保存旧版本及受管字段变更集；首次观察只标记 observed，不自动标记原生 baseline。
- 迁入时检查代理 URL、占位令牌与旧接管状态，结合旧 proxy_live_backup 验证来源；只有可恢复的非代理配置且凭据可解析时才标记 native_verified。无法证明则为 unknown，要求用户补全原生目标，禁止宣称一键可恢复。
- 外部修改按内容摘要检测并归档；每次写前再次校验摘要，变化则中止重算。快照先 zstd 再加密，明文大小上限 5MB，每文件保留最近 50 版与可信 baseline；引用中的密钥不得提前清理。
- content_hash 为安装级密钥 HMAC（密钥保存在凭据库），避免用裸摘要暴露含低熵秘密的配置；解密只在内存中，UI diff 脱敏。

### 2.2 回滚与恢复语义

- **退出接管（一键恢复原生）**：依据可信接管前值、phi 最后写入值、当前值做字段级三方比较。仅将仍等于 phi 写入值的受管字段恢复；保留用户后续 hooks/MCP 等修改。受管字段冲突则展示差异要求选择，不静默覆盖。
- **单文件历史回滚**：用户确认脱敏 diff 后全量恢复指定历史版本，明确会覆盖后续修改；与退出接管分开入口。
- 不存在的原始文件单独记录 existed=false；退出时仅在文件完全由 phi 创建且无外部新增字段时删除，否则只移除受管字段。无法解密或凭据失效时保留现状并提示补全，不写空值。
- 多文件操作保存 operation_id、各文件前后摘要和加密补偿材料，逐文件原子写；全部成功才标记完成。中断后重入，发现外部修改转入冲突处理，不能谎报整体成功。
- 托盘“恢复全部原生配置”调用同一恢复服务，不依赖主窗口；逐 Agent 报告成功、冲突或缺失可信备份。紧急恢复仍需要解锁凭据库，不能绕过密文校验。

### 2.3 与 Provider 切换的关系

switch 回填必须先抽取凭据为引用，之后保存加密版本和变更集，最后写 live；profiles.payload 同样引用化，无法安全拆分的内容加密保存。历史回滚依赖的旧凭据由引用计数保护。profiles 是语义快照，config_versions 是操作历史，均遵守 07 的凭据边界。

## 3. phi 增量二：诊断

新增 `diagnose_adapters` command（结果进 UI 诊断页）：

- 受管文件清单 × 存在性 × 可写性 × 与 phi 期望状态的 hash 比对；
- 冲突检测：同一文件被多个工具引用、字段被外部工具改写、phi 注入字段被清除；
- 过期模型引用：live 配置里引用的模型在当前 provider 目录中不存在（配合 `model_fetch`）；
- 输出结构化报告 + 一键修复按钮（走版本化写入路径）。

## 4. 新增 Agent 适配 Playbook

后续新增 Agent 支持时按此流程（预期 V1.x 首个候选：Windsurf 类 IDE 插件）：

1. 确认模式：switch 还是 coexist（能否多 provider 共存）；
2. 新建 `<agent>_config.rs`：实现读、写、注入字段、清理字段四接口；**只改必要字段**原则不变；
3. 补测试：真实格式样例（含注释与极端格式）→ 写入 → 重读 → 幂等性断言；`PHI_TEST_HOME` 隔离；
4. 黄金集：该 Agent 的 inbound 协议组合补录（02 §4）；
5. 文档：接入指引 + 已知限制。

## 5. 上游追踪 SOP（D1 的配套机制）

不合并上游 ≠ 忽略上游。上游对适配层与协议层的修复是人类标注过的"格式又变了"信号，移植成本远低于自行发现：

### 5.1 监控

- GitHub Actions 每日拉取上游 `main` 的 commit 列表（只读 metadata + diff，不合并）；
- 分级规则：
  - **P0 必移植**：`*_config.rs`、`mode/`、`proxy/providers/`、`proxy/usage/`、安全类修复；
  - **P1 评估**：`services/` 其他部分、`database/migration.rs`（若上游 schema 演进含我们需要的修正）；
  - **P2 忽略**：UI/文档/品牌类。

### 5.2 移植流程

1. 周会评审 P0/P1 diff → 决策（移植 / 忽略 / 已用其他方式解决），记录 `docs/upstream-porting-log.md`（日期、上游 commit、决策、负责人）；
2. 移植 = 手动 cherry 内容（不改 git 历史）+ 对应适配器测试 + 黄金集相关用例全绿；
3. 安全类（CVE、凭据泄漏路径）走紧急通道，48h 内决策。

### 5.3 退出条件

连续两个季度 P0 移植数为 0（说明上游适配层进入稳态或已与 phi 分叉过远），则降频为每月检查。

## 6. 验收要点

- 每个 Agent：切换 A→B→A 后 live 配置与初始状态语义等价（测试自动化，继承并加强幂等断言）；
- 可信 baseline 的 Agent 退出接管后独立可用；已被上游接管、备份缺失、凭据失效时不得误标可恢复；
- 外部 hooks/MCP 修改保留，受管字段冲突可见；不存在文件、多文件中断、解锁失败均有用例；
- 版本化对性能无感：单次切换增加的快照耗时 P95 < 50ms；
- 外部修改检测：手工改动 `~/.claude/settings.json` 后 phi 能发现并正确归档。

## 当前实施口径（2026-10-13）

`diagnostics/adapters.rs` 已实现严格只读的代理接入检查：Claude/Codex/Gemini/Grok 的地址、当前本地令牌、协议或认证方式，已停用/删除的 `group/` 模型，以及 pending 文件偏离写前/计划摘要的冲突。仅报告字段类别，不导出凭据或原始配置；不把 hooks/MCP 的修改当作接入漂移。损坏状态不迁移、不重命名，也不自动执行恢复。

已有 `mode/operation.rs` 的多文件前滚继续使用。上述诊断不等同于全部受管字段的版本化 hash 检查；加密历史、可信 baseline、三方冲突选择界面及经历史保护的一键修复仍未完成。
