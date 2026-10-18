# PHI 开源准备清单

[文档导航](README.md) · [贡献指南](../CONTRIBUTING.md)

本清单记录公开仓库和发布版本前的核验项，不代表这些设置已经生效。未核验的项目保持未勾选；仓库文件无法替代 GitHub 后台设置和实际安装验证。

## 1. 仓库身份与展示

- [ ] 确认公开地址为 `GoatGit/phi`，官网为 `https://phi.semibot.ai`。
- [ ] About 描述建议：`Local-first desktop app for AI coding tools, model routing, MCP, and usage analytics.`
- [ ] Topics 建议：`ai`、`tauri`、`rust`、`react`、`claude-code`、`codex`、`gemini-cli`、`llm-gateway`、`mcp`、`desktop-app`。
- [ ] 为 Social preview 准备不含私人信息的 1280 × 640 图片。
- [ ] 在受控演示环境录制一次「添加供应商 → 启动 CLI → 发起请求 → 查看用量」，使用合成账号与项目，并检查所有帧和截图中是否有敏感信息。
- [ ] 核对中英文 README 和主要指南，确认承诺的功能与当前发布包一致。
- [ ] 确认 Releases 中有新用户可以直接下载的安装包；仓库公开不等于安装包已发布。

## 2. 版权与依赖

- [ ] 保留 [MIT 许可](../LICENSE)中的上游版权声明，并核对 [Fork 基线](../FORK-BASELINE.md)的描述。
- [ ] 保留 Ghostty 许可和原生依赖许可，确认最终安装包包含收集到的 notices；参阅[构建说明](../scripts/ghostty/README.md)。
- [ ] 核对新增代码、图片、字体与品牌素材的使用权，避免将第三方标识理解为官方背书。
- [ ] 供应商价格、模型额度与第三方服务条款由相应服务决定，文案不能承诺 PHI 免费提供模型。

## 3. 密钥与私人数据

- [ ] 在隔离环境对**所有拟公开的 Git refs 与完整历史**进行密钥扫描，例如使用 Gitleaks 的 Git 模式；记录扫描器版本、扫描范围与脱敏报告，不把报告提交到仓库。
- [ ] 另外检查当前工作区与将随发布包分发的文件：环境变量文件、签名私钥、OAuth 文件、SQLite 数据库及 WAL、配置备份、日志、截图和录屏。
- [ ] 如发现曾提交过的真实密钥，先撤销或轮换，再决定是否清理历史；只删除最新版本中的文件不能消除历史泄露。
- [ ] 清理拟公开的远端分支、标签和 Release 附件中的私人材料。不要未经确认重写协作者使用中的 Git 历史。
- [ ] 检查 [安全策略](../SECURITY.md)与实际凭据存储一致，不能将「本地优先」写成「所有凭据均已加密」或「不发生对外连接」。

`python3 scripts/check_repository.py` 只检查常见敏感文件的**跟踪路径**及文档和元数据，不检查凭据内容或 Git 历史。现有 `scripts/audit_no_plaintext_secrets.py` 用于显式选择的运行数据副本或合成夹具，也不能替代 Git 历史扫描。不要将真实用户配置复制到公开的 Issue 或 CI 日志。

## 4. GitHub 设置

- [ ] 在仓库 Security 设置启用 Private vulnerability reporting，确认 [私密报告入口](https://github.com/GoatGit/phi/security/advisories/new)可用，并确认 `admin@semibot.ai` 有维护者接收。
- [ ] 启用可用的 Secret scanning / Push protection / Dependabot alerts；具体可用性以仓库方案为准。
- [ ] 保护 `main`：要求 Pull Request、Code Owner 审查，并限制绕过规则的主体。`.github/CODEOWNERS` 本身不会强制审批。
- [ ] 配置必需状态检查：至少包含始终运行的 `Repository quality` 和 `Secret audit synthetic fixtures`。前后端检查存在路径过滤，不要直接将可能被跳过的 job 配成永远必需，除非增加统一聚合状态。
- [ ] Actions 默认工作流权限保持最小；外部 Fork 的工作流不得获得发布凭据。
- [ ] `release` Environment 配置发布所需 Secret 和适当的审批者；发布操作不要直接依赖未审查 PR。
- [ ] 检查 Issue 模板、PR 模板、文档和安全报告链接。需要使用 Discussions 时先启用它。

## 5. 首次发布

- [ ] `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 版本一致；标签为 `v<version>`。
- [ ] 补齐该版本的 `CHANGELOG.md` 和 `src/whats-new/<version>.json`；从干净克隆执行文档中的安装步骤。
- [ ] 运行 `python3 scripts/check_repository.py` 和 `python3 -B -m unittest discover -s scripts/tests -p 'test_*.py'`。
- [ ] 前端类型检查、格式、单测与构建通过；后端 fmt、Clippy 与相关测试通过，并使用 `PHI_TEST_HOME` 隔离配置。
- [ ] 手动执行 Release workflow 的 dry run，核验 Windows x64 / ARM64、Linux x64 / ARM64 和 macOS 通用包产物。
- [ ] 在目标平台实际安装、启动、执行模型请求，检查卸载和数据目录行为；macOS 同时验证签名、公证与内嵌终端。CI 编译成功不等于已完成真机验证。
- [ ] 核对下载文件名、架构、校验值、第三方许可与 Release notes，再发布标签。当前应用内更新只打开 Releases，不承诺自动安装。

## 6. 开放后的维护

- [ ] 标记适合新贡献者的问题，补充范围与验收标准，核验后再加 `good first issue`。
- [ ] 用真实用户反馈维护上手指南和常见问题，给复现信息不足的问题提供具体反馈。
- [ ] 定期处理依赖告警与私密安全报告，发布修复版本时同步更新日志。

## English note

This is a verification checklist, not a statement that GitHub settings, history scanning, signing, or platform testing are complete. Before publication, verify repository identity, upstream and dependency notices, all intended public Git refs and artifacts, private vulnerability reporting, branch rules, release credentials, and installation on target platforms. The repository checker does not inspect secret content or Git history. Rotate exposed credentials before considering history cleanup.
