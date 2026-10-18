<div align="center">

<img src="docs/logo/phi-app-icon.png" alt="PHI" width="96" />

# PHI

**One desktop app for your AI coding tools, models, and local gateway.**

Run CLIs inside PHI, switch models, and see your sessions and usage.

[![CI](https://github.com/GoatGit/phi/actions/workflows/ci.yml/badge.svg)](https://github.com/GoatGit/phi/actions/workflows/ci.yml)
[![Download](https://img.shields.io/badge/download-Releases-blue)](https://github.com/GoatGit/phi/releases/latest)
[![Platforms](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)](#download)
[![MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

[简体中文](README.md) · English

[Download](https://github.com/GoatGit/phi/releases/latest) · [Get started](docs/getting-started.en.md) · [Docs](docs/README.md) · [Website](https://phi.semibot.ai/en/) · [Report an issue](https://github.com/GoatGit/phi/issues/new/choose)

</div>

## Why PHI

When you use Claude Code, Codex, and Gemini CLI together, each tool has its own provider settings, model names, and session history. Switching models can mean configuring everything again.

PHI brings that work into one place: add a provider, choose a model for a tool, launch the CLI, then inspect requests and usage. Keep the coding tools you know, and let PHI manage their connections.

- **Run CLIs inside PHI**: on macOS, a native Ghostty terminal lets you work in app tabs instead of switching between terminal windows.
- **Manage providers and models together**: configure tools including Claude Code, Claude Desktop, Codex, Gemini CLI, Grok Build, and ZCode. Integration modes vary by tool.
- **Reuse models across tools**: the local gateway provides protocol conversion, model aggregation, failover, and circuit breaking. Cross-protocol calls remain subject to upstream model capabilities.
- **Manage MCP servers, skills, and prompts**: sync them using each tool's supported integration.
- **Understand sessions and usage**: browse sessions and track tokens, estimated cost, cache hits, and trends. Your provider's bill remains authoritative.

Built with **Tauri 2 + Rust + React + TypeScript**. The UI supports Simplified Chinese, Traditional Chinese, English, and Japanese. The embedded Ghostty terminal currently supports macOS only; CLI launching on other platforms depends on platform integration.

## What local-first means

PHI stores configuration and usage data locally in `~/.phi/` by default, without requiring a PHI cloud account. **Model requests still go to the providers you configure.** Update checks, skill downloads, and remote sync you enable also contact their respective services.

Local storage does not imply encrypted storage. API keys, OAuth data, exports, and backups may contain sensitive information; storage varies by integration. PHI can also write CLI configuration files in response to your actions. Back up existing configurations before connecting tools. See the [security policy](SECURITY.md) for the trust boundaries.

<a id="download"></a>

## Download

Choose a package for your system and architecture from [GitHub Releases](https://github.com/GoatGit/phi/releases/latest). The Assets section of each release is the source of truth for available packages.

| System | Architectures | Installation |
| --- | --- | --- |
| macOS 13+ | Apple Silicon / Intel, universal binary | Open the `.dmg` and drag into Applications, or use the `.zip` |
| Windows 10 / 11 | x64 / ARM64 | `.msi` installer or `Portable.zip` |
| Linux | x64 / ARM64 | `.AppImage`, `.deb`, or `.rpm` |

Windows packages are not Authenticode-signed yet, so SmartScreen may warn about an unknown publisher. See [known limitations](docs/known-limitations.en.md) for signing status and real-device verification scope.

"Check for updates" opens GitHub Releases; in-app automatic installation is currently disabled. If macOS reports an unexpected signature or source warning, verify the download source and release notes, then report the issue.

## Your first request

1. Install PHI. In the Apps page, confirm the CLI you want to use is installed and runs correctly.
2. Add a provider endpoint and credentials, or use a login method supported by that integration.
3. Choose a provider and model for the tool. Enable the local gateway if you need protocol conversion or multi-provider routing.
4. Launch the tool, send a small request, and check its session and usage.

See the [getting started guide](docs/getting-started.en.md). To use other models with Codex, start with the examples for [DeepSeek](docs/guides/codex-deepseek-routing-guide-en.md), [Kimi](docs/guides/codex-kimi-routing-guide-en.md), or [Claude](docs/guides/codex-claude-routing-guide-en.md).

## Run from source

You need Node.js (see `.node-version`), pnpm (see `package.json`), Rust (see `rust-toolchain.toml`), and the [Tauri 2 platform prerequisites](https://v2.tauri.app/start/prerequisites/). macOS also needs Python 3.12+ and Xcode Command Line Tools.

```sh
git clone https://github.com/GoatGit/phi.git
cd phi
corepack enable
pnpm install --frozen-lockfile

# macOS only: build the embedded terminal SDK before the first launch
python3 scripts/build_ghostty.py

pnpm dev
```

`pnpm dev` launches the desktop app using your local configuration. To isolate development data, set `PHI_TEST_HOME` to a test directory inside the workspace first; on macOS / Linux, for example, run `export PHI_TEST_HOME="$PWD/tmp/phi-dev-home"`. This overrides paths; it is not an operating-system sandbox.

For frontend work alone, use `pnpm dev:renderer`; a browser cannot provide real Tauri IPC or the native terminal. See [CONTRIBUTING.md](CONTRIBUTING.md) for packaging, Windows / Linux dependencies, and test isolation, and the [terminal development guide](scripts/ghostty/README.md) for Ghostty builds.

## Documentation and contributions

- [Documentation index](docs/README.md): setup guides, model routing examples, and design references.
- [Contributing guide](CONTRIBUTING.md): development environment, architecture, checks, and PR conventions. Documentation fixes, translations, and reproducible bug reports are welcome too.
- [Get help](SUPPORT.md) · [Report a bug](https://github.com/GoatGit/phi/issues/new?template=bug_report.yml) · [Suggest a feature](https://github.com/GoatGit/phi/issues/new?template=feature_request.yml).
- [Changelog](CHANGELOG.md) · [Releases](https://github.com/GoatGit/phi/releases).
- Follow the [Code of Conduct](CODE_OF_CONDUCT.md). Report security vulnerabilities [privately](SECURITY.md#reporting-a-vulnerability--报告漏洞).

<a id="faq"></a>

## FAQ

**Do I need to buy model access from PHI?** You use your own providers and credentials, subject to their pricing and terms. PHI does not supply free model credits.

**Can any model work with any tool?** The gateway converts supported protocols, but tools, images, reasoning, and context limits still depend on the target model and adapter. Validate with a small task first.

**Will my existing CLI configurations change?** Configuration management and gateway integration can write tool configuration files. Back them up and enable one tool at a time. See the contributing guide for integration modes. Old `~/.cc-switch/` data is not automatically migrated.

**Why is CC Switch still mentioned in the source?** PHI is developed independently from a one-time snapshot of [CC Switch](https://github.com/farion1231/cc-switch), whose package version was v4.0.8. Upstream code is not merged back. Historical materials and copyright notices retain their original names. See the [fork baseline](FORK-BASELINE.md).

## License and acknowledgments

PHI is [MIT licensed](LICENSE), preserving the copyright notice of upstream CC Switch author Jason Young. Thank you to everyone contributing to PHI.

The macOS terminal uses [Ghostty](scripts/ghostty/README.md). Its [MIT license](scripts/ghostty/GHOSTTY-LICENSE) and dependency notices are retained in the packaged resources. Third-party components remain subject to their respective licenses.
