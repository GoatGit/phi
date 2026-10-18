# 已知限制 / Known limitations

本页记录 PHI 当前发布版本中已知、可预期但尚未解决的限制。它不替代[安全策略](../SECURITY.md)或 Issue 跟踪：可复现的 Bug 请提交 [Issue](https://github.com/GoatGit/phi/issues/new/choose)，安全漏洞请通过[私密渠道](../SECURITY.md#reporting-a-vulnerability--报告漏洞)报告。

适用范围：v1.0.0 及当前发布流程。相关限制解除后，本页会同步更新。

## 安装包签名

- **macOS**：安装包已使用 Developer ID Application 签名并完成 Apple 公证，DMG 与更新包内的 App 均通过 Gatekeeper 校验。
- **Windows**：`.msi` 与 `Portable.zip` 目前没有 Authenticode 签名，也未接入 Azure Trusted Signing。Windows 无法通过系统验证发布者身份，SmartScreen 可能提示「未知发布者」或「Windows 已保护你的电脑」。这**不等于**系统已判定安装包为恶意软件，但意味着你不应跳过对下载来源的核对。
- **Linux**：`.AppImage`、`.deb` 与 `.rpm` 没有发行版或厂商级 GPG 签名。Release 中的 `.sig` 是 Tauri 更新包签名，只用于更新包的完整性与版本校验，不能替代系统包签名或仓库来源验证。

请只从[官方 Releases](https://github.com/GoatGit/phi/releases/latest)下载安装包。如果文件名、版本、下载来源或系统提示与发布说明不符，请先停止安装，再通过 Issue 反馈。

## 真机安装验证范围

- 发布包由 CI 在 macOS、Windows 与 Linux 上构建。
- macOS 安装包已核验签名、公证与 Gatekeeper 结果；内嵌 Ghostty 终端目前仅在 macOS 提供。
- Windows 与 Linux 安装包尚未在真实设备上完成「安装 → 首次启动 → 发起一次模型请求」的完整验证。CI 构建成功和安装包结构检查通过，**不等于**已在对应平台完成安装验证。
- 如果你在 Windows 或 Linux 上遇到安装、启动或首次请求问题，请附上系统版本、CPU 架构、安装包文件名和错误信息提交 Issue。

## 更新方式

- 应用内「检查更新」只打开 GitHub Releases，当前不会自动下载或安装更新。
- Windows 安装包在手动更新时同样可能触发 SmartScreen 提示。
- macOS 更新包（`.tar.gz`）由 Tauri 更新器签名校验；Windows 与 Linux 的更新包 `.sig` 也只能证明更新包完整性，不证明操作系统级的发布者身份。

## 平台功能差异

- 内嵌 Ghostty 终端目前仅支持 macOS；其他平台的 CLI 启动取决于平台集成。
- 本地网关可以转换部分协议，但工具调用、图片、推理与上下文能力仍受上游模型和适配器限制。
- 界面支持简体中文、繁体中文、英文和日文；文档以中英文为主，部分指南提供日文，且部分截图和第三方术语仍沿用上游内容。

## 后续处理

- 获得可用的 Windows 代码签名证书或 Azure Trusted Signing 后，会为 Windows 安装包启用 Authenticode 签名，并更新本页。
- 在发布流程中加入 Windows 与 Linux 真机安装检查后，会更新验证范围。
- 在此之前，Release 说明不会把「CI 构建成功」表述为「已通过多平台安装验证」。

---

[English version](known-limitations.en.md)
