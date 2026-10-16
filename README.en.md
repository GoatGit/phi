<div align="center">

<img src="docs/logo/phi-app-icon.png" alt="PHI icon" width="96" />

# PHI

**Local-first AI agent gateway & configuration manager for desktop**

Freely use every model — connect, switch, aggregate, and observe, with all data staying on your machine.

[![CI](https://github.com/GoatGit/phi/actions/workflows/ci.yml/badge.svg)](https://github.com/GoatGit/phi/actions/workflows/ci.yml)
[![GitHub Releases](https://img.shields.io/badge/download-Releases-blue)](https://github.com/GoatGit/phi/releases/latest)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)](#-download)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

[简体中文](README.md) · English · [Website](https://phi.semibot.ai)

</div>

---

Built with Tauri 2, Rust, React, and TypeScript, PHI brings model providers, credentials, MCP servers, skills, and prompts for multiple AI coding tools (Claude Code, Codex, Gemini CLI, and more) into a single local desktop app, with a built-in local gateway for protocol conversion, model aggregation, and failover.

> **Local-first**: there is no project-operated cloud backend. Configuration and usage data live in `~/.phi/` on your machine.

## ✨ Features

- **Multi-agent configuration management** — centrally manage providers and model configs for Claude Code, Claude Desktop, Codex, Gemini CLI, Grok Build, ZCode, and more; a coexist mode is available for CLIs such as OpenCode, OpenClaw, Hermes, Pi, and MiniMax Code (their config files are never taken over).
- **Local gateway** — an in-process HTTP proxy offering cross-protocol conversion (Claude / Codex / Gemini formats), multi-provider model aggregation, failover, and circuit breaking, so any model can be reused across tools after a single setup.
- **MCP / Skills / Prompts** — manage MCP servers, skills, and prompts in one place and sync them into each tool's project configuration.
- **Session & usage analytics** — sessions / tokens / cost / cache-hit / active-time summaries, daily trends, weekday×hour heatmaps, context-level curves, and auto-compaction threshold tuning.
- **Embedded terminal** — launch CLI apps in a native Ghostty terminal inside the app (macOS 13+).
- **Credential safety** — subscription OAuth tokens are stored in the system Keychain; the security model is public and auditable, see [SECURITY.md](SECURITY.md).

<!-- TODO (required before launch): replace with real PHI 1.0 screenshots.
The images in assets/screenshots/ are inherited from upstream CC Switch and show the old branding — never use them directly.
Suggested shots: provider management home + usage analytics page (zh / en), saved under docs/images/screenshots/.
<p align="center">
  <img src="docs/images/screenshots/main-en.png" alt="PHI main window" width="800" />
</p>
-->

## 📥 Download

Grab the installer for your platform from [GitHub Releases](https://github.com/GoatGit/phi/releases/latest):

| Platform | Architectures | Packages |
|---|---|---|
| macOS 12+ (embedded terminal needs 13+) | Apple Silicon / Intel (universal) | `.app` (packaged as `.dmg` / `.app.tar.gz`) |
| Windows 10 / 11 | x64 / ARM64 | `.msi` / `.exe` installers and portable build |
| Linux | x64 / ARM64 | `.AppImage` / `.deb` / `.rpm` |

- "Check for updates" inside the app points to GitHub Releases.
- If macOS Gatekeeper blocks the first launch, right-click the app and choose "Open", or allow it under "System Settings → Privacy & Security".

## 🛠 Build from source (macOS)

Requires Node.js, pnpm, Rust, Python 3.12+, and Xcode Command Line Tools:

```sh
export PATH="/opt/homebrew/bin:$PATH"
pnpm install --frozen-lockfile
python3 scripts/build_ghostty.py   # first build of the embedded terminal SDK (downloads pinned Ghostty sources and Zig)
pnpm typecheck
pnpm tauri build --debug --bundles app
```

Output: `src-tauri/target/debug/bundle/macos/PHI.app`. See [scripts/ghostty/README.md](scripts/ghostty/README.md) for the Ghostty SDK, offline resources, and native checks; see [CONTRIBUTING.md](CONTRIBUTING.md) for Linux / Windows development setup.

Local debug launch (uses an isolated test home inside the workspace so `~/.phi/` stays untouched):

```sh
open -n --env "PHI_TEST_HOME=$PWD/tmp/phi-local-home" "src-tauri/target/debug/bundle/macos/PHI.app"
```

> `tmp/` is a local dev/test home (it contains real request data); it is ignored by `.gitignore` and must not be committed.

## 📚 Documentation

| Document | Contents |
|---|---|
| [Product & technical design](docs/V1/README.md) | V1 overall design and per-module deep dives (Chinese) |
| [Contributing guide](CONTRIBUTING.md) | Dev environment, testing, PR guidelines |
| [Changelog](CHANGELOG.md) | Notable changes per release |
| [Fork baseline](FORK-BASELINE.md) | Relationship with upstream CC Switch and verification status |
| [Embedded terminal build](scripts/ghostty/README.md) | Ghostty SDK build and offline resources |
| [Website](https://phi.semibot.ai) | Product landing page |

## ❓ FAQ

<details>
<summary><b>What is the relationship between PHI and CC Switch?</b></summary>

PHI started from a one-time source snapshot of [CC Switch](https://github.com/farion1231/cc-switch) v4.0.8 (MIT, © Jason Young) and is developed independently; upstream code is not merged afterwards. The MIT license and the original copyright notice are preserved. See [FORK-BASELINE.md](FORK-BASELINE.md) for details and verification status, and [CHANGELOG.md](CHANGELOG.md) for version-level changes.

</details>

<details>
<summary><b>Where is my data stored? Will old CC Switch / cc-switch data be migrated?</b></summary>

Configuration and the SQLite database live in `~/.phi/` (database file `phi.db`). Data in the old `.cc-switch/` directory is <b>not</b> migrated automatically.

</details>

<details>
<summary><b>Which platforms are supported?</b></summary>

macOS 12+ (universal binary; the embedded terminal needs macOS 13+), Windows 10/11 (x64 / ARM64), and Linux (x64 / ARM64, AppImage / deb / rpm).

</details>

<details>
<summary><b>How do I update?</b></summary>

"Check for updates" inside the app points to PHI's [GitHub Releases](https://github.com/GoatGit/phi/releases/latest); an independently signed auto-update channel is not yet enabled.

</details>

<details>
<summary><b>Are my API keys safe?</b></summary>

PHI is a local app: configuration stays in an on-device SQLite database and never passes through project-run servers; subscription OAuth tokens go into the system Keychain. See [SECURITY.md](SECURITY.md) for the full threat model and how to report vulnerabilities.

</details>

## 🤝 Contributing

Issues and PRs are welcome! Please read the [contributing guide](CONTRIBUTING.md) first; use the [issue templates](https://github.com/GoatGit/phi/issues/new/choose) or [Discussions](https://github.com/GoatGit/phi/discussions) for questions.

- 🐛 [Report a bug](https://github.com/GoatGit/phi/issues/new?template=bug_report.yml)
- 💡 [Suggest a feature](https://github.com/GoatGit/phi/issues/new?template=feature_request.yml)
- 🔒 Please do not publicly post security vulnerabilities — see the [security policy](SECURITY.md)
- 📜 Please follow the [Code of Conduct](CODE_OF_CONDUCT.md); if you need help, start with [SUPPORT.md](SUPPORT.md)

## 📄 License

[MIT](LICENSE) © Jason Young (upstream CC Switch) and PHI contributors.

PHI is developed independently from a one-time snapshot of CC Switch v4.0.8. See [FORK-BASELINE.md](FORK-BASELINE.md) for provenance, verification status, and build notes. Historical designs and upstream release notes keep the original project name to accurately record their origin.
