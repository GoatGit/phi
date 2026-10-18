<div align="center">

<img src="docs/logo/phi-app-icon.png" alt="PHI" width="96" />

# PHI

**一个桌面应用，管理你的 AI 编程工具、模型与本地网关。**

在 PHI 内直接运行 CLI，切换模型，查看会话和用量。

[![CI](https://github.com/GoatGit/phi/actions/workflows/ci.yml/badge.svg)](https://github.com/GoatGit/phi/actions/workflows/ci.yml)
[![Download](https://img.shields.io/badge/download-Releases-blue)](https://github.com/GoatGit/phi/releases/latest)
[![Platforms](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)](#download)
[![MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

简体中文 · [English](README.en.md)

[下载安装](https://github.com/GoatGit/phi/releases/latest) · [快速上手](docs/getting-started.md) · [文档](docs/README.md) · [官网](https://phi.semibot.ai) · [反馈问题](https://github.com/GoatGit/phi/issues/new/choose)

</div>

## 为什么使用 PHI

同时使用 Claude Code、Codex 和 Gemini CLI 时，每个工具都有自己的供应商配置、模型名称和会话记录。换一个模型，往往需要再改一遍配置。

PHI 把这些操作放在一起：添加供应商，为工具选择模型，直接启动 CLI，再查看请求和用量。你可以继续使用熟悉的编程工具，让 PHI 管理它们之间的连接。

- **直接在 PHI 里运行 CLI**：macOS 内置原生 Ghostty 终端，通过应用标签页使用 CLI，减少在多个终端窗口间切换。
- **集中管理模型与供应商**：管理 Claude Code、Claude Desktop、Codex、Gemini CLI、Grok Build、ZCode 等工具的配置；具体接入方式因工具而异。
- **让不同工具复用模型**：本地网关提供协议转换、模型聚合、故障转移与熔断。跨协议调用仍受上游模型能力限制。
- **统一管理 MCP、Skills 与提示词**：按工具支持的方式同步，减少重复配置。
- **看清会话与用量**：浏览会话，查看 Token、费用估算、缓存命中与趋势。实际账单以供应商为准。

PHI 基于 **Tauri 2 + Rust + React + TypeScript**，界面支持简体中文、繁体中文、英文与日文。内嵌 Ghostty 终端目前仅支持 macOS；其他平台的 CLI 启动方式取决于平台集成。

## 本地优先，意味着什么

PHI 的配置和统计数据默认保存在本机 `~/.phi/`，不需要 PHI 云端账号。**调用模型时，请求仍会发送到你配置的供应商**；更新检查、Skills 下载和你启用的远程同步也会访问相应服务。

本地保存不等于加密保存。API Key、OAuth 数据、导出文件和备份可能包含敏感信息；存储方式取决于具体集成。PHI 也会根据你的操作写入 CLI 配置文件。使用前建议备份已有配置，详细边界见[安全策略](SECURITY.md)。

<a id="download"></a>

## 下载安装

前往 [GitHub Releases](https://github.com/GoatGit/phi/releases/latest)，按系统与架构选择安装包。可用产物以该版本的 Assets 为准。

| 系统 | 架构 | 安装方式 |
| --- | --- | --- |
| macOS 13+ | Apple Silicon / Intel，通用二进制 | 下载 `.dmg` 并拖入 Applications，或使用 `.zip` |
| Windows 10 / 11 | x64 / ARM64 | `.msi` 安装器，或 `Portable.zip` 便携版 |
| Linux | x64 / ARM64 | `.AppImage`、`.deb` 或 `.rpm` |

Windows 安装包目前没有 Authenticode 签名，SmartScreen 可能提示「未知发布者」；签名状态与各平台真机验证范围见[已知限制](docs/known-limitations.md)。

应用内「检查更新」会打开 GitHub Releases；当前未启用应用内自动安装更新。macOS 如提示签名或来源异常，请先核对下载来源与对应发布说明，再通过 Issue 反馈。

## 第一次使用

1. 安装 PHI，在「应用」页确认要使用的 CLI 已安装并能正常运行。
2. 在供应商管理中添加 API 端点与凭据，或使用相应集成支持的登录方式。
3. 为目标工具选择供应商与模型；需要协议转换或多供应商路由时，启用本地网关。
4. 启动工具，发起一次简单请求，再检查会话和用量是否符合预期。

详细说明见[快速上手](docs/getting-started.md)。用 Codex 调用其他模型，可以从 [DeepSeek](docs/guides/codex-deepseek-routing-guide-zh.md)、[Kimi](docs/guides/codex-kimi-routing-guide-zh.md) 或 [Claude](docs/guides/codex-claude-routing-guide-zh.md) 的配置示例开始。

## 从源码运行

需要 Node.js（版本见 `.node-version`）、pnpm（版本见 `package.json`）、Rust（见 `rust-toolchain.toml`）及 [Tauri 2 平台依赖](https://v2.tauri.app/start/prerequisites/)。macOS 还需要 Python 3.12+ 和 Xcode Command Line Tools。

```sh
git clone https://github.com/GoatGit/phi.git
cd phi
corepack enable
pnpm install --frozen-lockfile

# 仅 macOS：首次启动前构建内嵌终端 SDK
python3 scripts/build_ghostty.py

pnpm dev
```

`pnpm dev` 会启动桌面应用并使用本机配置。需要隔离调试数据时，在启动前设置 `PHI_TEST_HOME` 为工作区内的测试目录，例如 macOS / Linux 下执行 `export PHI_TEST_HOME="$PWD/tmp/phi-dev-home"`。它是路径覆盖机制，不是操作系统沙箱。

只做前端开发可运行 `pnpm dev:renderer`，但浏览器不能提供真实 Tauri IPC 或原生终端。打包、Windows / Linux 依赖与测试隔离方式见[贡献指南](CONTRIBUTING.md)，Ghostty 构建见[终端开发文档](scripts/ghostty/README.md)。

## 文档与参与贡献

- [文档导航](docs/README.md)：上手指南、模型路由示例与设计资料。
- [贡献指南](CONTRIBUTING.md)：开发环境、架构、验证命令与 PR 约定。文档修正、翻译和可复现的 Bug 报告同样欢迎。
- [获取帮助](SUPPORT.md) · [报告 Bug](https://github.com/GoatGit/phi/issues/new?template=bug_report.yml) · [提出建议](https://github.com/GoatGit/phi/issues/new?template=feature_request.yml)。
- [更新日志](CHANGELOG.md) · [发布记录](https://github.com/GoatGit/phi/releases)。
- 参与社区请遵守[行为准则](CODE_OF_CONDUCT.md)；安全漏洞请通过[私密渠道](SECURITY.md#reporting-a-vulnerability--报告漏洞)报告。

<a id="faq"></a>

## 常见问题

**需要购买 PHI 的模型服务吗？** 你使用自己配置的供应商与凭据，相关费用和服务条款由供应商决定。PHI 不提供免费模型额度。

**可以把任意模型用于任意工具吗？** 网关能够转换部分协议，但工具调用、图片、推理和上下文限制仍取决于目标模型与适配器。请先用一个小任务验证。

**已有的 CLI 配置会受影响吗？** 配置管理和网关接入可能写入工具的配置文件。先备份，再逐个工具启用；具体模式见贡献指南。旧 `~/.cc-switch/` 数据不会自动迁移。

**为什么源码里还有 CC Switch？** PHI 从 [CC Switch](https://github.com/farion1231/cc-switch) 的一次性快照独立发展而来，快照自报版本为 v4.0.8，此后不回合并上游。历史资料和版权归属保留原名，详见 [Fork 基线](FORK-BASELINE.md)。

## 许可与致谢

PHI 使用 [MIT 许可证](LICENSE)，保留上游 CC Switch 作者 Jason Young 的版权声明，并感谢 PHI 的所有贡献者。

macOS 内嵌终端基于 [Ghostty](scripts/ghostty/README.md)，其 [MIT 许可证](scripts/ghostty/GHOSTTY-LICENSE)与依赖许可随打包资源保留。各第三方组件仍遵循各自的许可证。
