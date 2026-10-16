<div align="center">

<img src="docs/logo/phi-app-icon.png" alt="PHI 图标" width="96" />

# PHI

**本地优先的 AI Agent 网关与配置管理桌面应用**

让用户自由使用所有模型 —— 接入、切换、聚合、观测，数据完全留在本机。

[![CI](https://github.com/GoatGit/phi/actions/workflows/ci.yml/badge.svg)](https://github.com/GoatGit/phi/actions/workflows/ci.yml)
[![GitHub Releases](https://img.shields.io/badge/download-Releases-blue)](https://github.com/GoatGit/phi/releases/latest)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)](#-下载安装)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

简体中文 · [English](README.en.md) · [官网](https://phi.semibot.ai)

</div>

---

PHI 基于 Tauri 2、Rust、React 和 TypeScript 构建，把多个 AI 编程工具（Claude Code、Codex、Gemini CLI 等）的模型供应商、凭据、MCP、Skills 与提示词集中到一个本地应用中管理，并通过内置的本地网关提供协议转换、模型聚合与故障转移。

> **本地优先**：没有项目运营的云端后端，配置与统计数据保存在本机 `~/.phi/`。

## ✨ 主要特性

- **多 Agent 配置管理** —— 集中管理 Claude Code、Claude Desktop、Codex、Gemini CLI、Grok Build、ZCode 等工具的供应商与模型配置；对 OpenCode、OpenClaw、Hermes、Pi、MiniMax Code 等 CLI 提供共存模式（不接管其配置文件）。
- **本地网关** —— 进程内 HTTP 代理，提供跨协议转换（Claude / Codex / Gemini 等格式互转）、多供应商模型聚合、故障转移与熔断，一次接入即可在多个工具间复用任意模型。
- **MCP / Skills / 提示词** —— 统一管理 MCP 服务器、Skills 与提示词，并同步到各工具的项目配置。
- **会话与用量统计** —— 会话数 / Token / 费用 / 缓存命中 / 活跃时长汇总，每日趋势、星期×小时热力图、上下文水位曲线与自动压缩阈值调优。
- **内嵌终端** —— 在应用内通过原生 Ghostty 终端启动 CLI 应用（macOS 13+）。
- **凭据安全** —— 订阅类 OAuth Token 存入系统 Keychain；安全模型公开可审计，见 [SECURITY.md](SECURITY.md)。

<!-- TODO（发布前必须完成）：替换为 PHI 1.0 真实界面截图。
assets/screenshots/ 中的图片继承自上游 CC Switch，界面带有旧品牌，禁止直接使用。
建议截取：供应商管理主页 + 用量统计页（zh / en 各一套），存入 docs/images/screenshots/。
<p align="center">
  <img src="docs/images/screenshots/main-zh.png" alt="PHI 主界面" width="800" />
</p>
-->

## 📥 下载安装

从 [GitHub Releases](https://github.com/GoatGit/phi/releases/latest) 下载对应平台的安装包：

| 平台 | 架构 | 安装包 |
|---|---|---|
| macOS 12+（内嵌终端需 13+） | Apple Silicon / Intel（通用二进制） | `.app`（打包为 `.dmg` / `.app.tar.gz`） |
| Windows 10 / 11 | x64 / ARM64 | `.msi` / `.exe` 安装器与便携版 |
| Linux | x64 / ARM64 | `.AppImage` / `.deb` / `.rpm` |

- 应用内「检查更新」会跳转到 GitHub Releases 获取新版本。
- 首次运行遇到 macOS Gatekeeper 提示时，请右键点击应用选择「打开」，或到「系统设置 → 隐私与安全性」中放行。

## 🛠 从源码构建（macOS）

需要 Node.js、pnpm、Rust、Python 3.12+ 和 Xcode Command Line Tools：

```sh
export PATH="/opt/homebrew/bin:$PATH"
pnpm install --frozen-lockfile
python3 scripts/build_ghostty.py   # 首次编译内嵌终端 SDK（下载固定版本 Ghostty 源码与 Zig）
pnpm typecheck
pnpm tauri build --debug --bundles app
```

产物：`src-tauri/target/debug/bundle/macos/PHI.app`。Ghostty SDK、离线资源与原生检查详见 [scripts/ghostty/README.md](scripts/ghostty/README.md)；Linux / Windows 的开发环境搭建见 [CONTRIBUTING.md](CONTRIBUTING.md)。

本机调试启动（使用工作区内隔离的测试数据目录，避免动到 `~/.phi/`）：

```sh
open -n --env "PHI_TEST_HOME=$PWD/tmp/phi-local-home" "src-tauri/target/debug/bundle/macos/PHI.app"
```

> `tmp/` 是本地开发/测试用的隔离 home（含真实请求数据），已被 `.gitignore` 忽略，请勿加入版本控制。

## 📚 文档

| 文档 | 内容 |
|---|---|
| [产品与技术设计](docs/V1/README.md) | V1 总体设计与各模块详细设计 |
| [贡献指南](CONTRIBUTING.md) | 开发环境、测试、PR 规范 |
| [更新日志](CHANGELOG.md) | 每个版本的显著变更 |
| [Fork 基线记录](FORK-BASELINE.md) | 与上游 CC Switch 的关系与核验状态 |
| [内嵌终端构建](scripts/ghostty/README.md) | Ghostty SDK 编译与离线资源 |
| [官网](https://phi.semibot.ai) | 产品介绍单页 |

## ❓ 常见问题

<details>
<summary><b>PHI 和 CC Switch 是什么关系？</b></summary>

PHI 从 [CC Switch](https://github.com/farion1231/cc-switch) v4.0.8（MIT，© Jason Young）的一次性源码快照独立发展而来，此后不合并上游代码；保留 MIT 许可证与原作者版权声明。差异与核验状态见 [FORK-BASELINE.md](FORK-BASELINE.md)，版本级变更见 [CHANGELOG.md](CHANGELOG.md)。

</details>

<details>
<summary><b>数据存在哪里？旧的 CC Switch / cc-switch 数据会迁移吗？</b></summary>

主要配置与 SQLite 数据库位于 `~/.phi/`（数据库为 `phi.db`）。旧版本 `.cc-switch/` 目录的数据**不会**自动迁移。

</details>

<details>
<summary><b>支持哪些平台？</b></summary>

macOS 12+（通用二进制；内嵌终端功能需 macOS 13+）、Windows 10/11（x64 / ARM64）、Linux（x64 / ARM64，提供 AppImage / deb / rpm）。

</details>

<details>
<summary><b>如何更新？</b></summary>

应用内「检查更新」会跳转到 PHI 的 [GitHub Releases](https://github.com/GoatGit/phi/releases/latest)；独立签名的自动更新通道尚未启用。

</details>

<details>
<summary><b>我的 API Key 安全吗？</b></summary>

PHI 是本地应用，配置保存在本机 SQLite 中，不经过项目方的服务器；订阅类 OAuth Token 存入系统 Keychain。完整威胁模型与上报渠道见 [SECURITY.md](SECURITY.md)。

</details>

## 🤝 参与贡献

欢迎 Issue 与 PR！请先阅读[贡献指南](CONTRIBUTING.md)；提问与讨论请用 [Issue 模板](https://github.com/GoatGit/phi/issues/new/choose)或 [Discussions](https://github.com/GoatGit/phi/discussions)。

- 🐛 [报告 Bug](https://github.com/GoatGit/phi/issues/new?template=bug_report.yml)
- 💡 [功能建议](https://github.com/GoatGit/phi/issues/new?template=feature_request.yml)
- 🔒 安全漏洞请勿公开提交，见[安全策略](SECURITY.md)
- 📜 参与社区请遵守[行为准则](CODE_OF_CONDUCT.md)；遇到问题先看[获取帮助](SUPPORT.md)

## 📄 许可证

[MIT](LICENSE) © Jason Young（上游 CC Switch）及 PHI 贡献者。

PHI 从 CC Switch v4.0.8 的一次性源码快照独立开发，来源、版本核验状态与构建说明见 [FORK-BASELINE.md](FORK-BASELINE.md)。历史设计与上游发布资料保留原项目名称，以准确记录来源。
