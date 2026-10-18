# Get started with PHI

[简体中文](getting-started.md) · [Documentation](README.md) · [Overview](../README.en.md)

Connect one tool and one model first. Once a request works, add the rest.

## 1. Install PHI and prepare a CLI

Download a package for your system and architecture from [PHI Releases](https://github.com/GoatGit/phi/releases/latest). The current macOS packaging configuration requires 13+; see release Assets for Windows and Linux packages.

PHI manages and launches CLIs; your chosen provider still supplies model access. Open the Apps page to check the target CLI's installation. If it is missing, use a supported installation action or follow the tool's official installation instructions. Back up existing CLI configuration directories before connecting them.

On macOS, you can run CLIs inside PHI with the Ghostty terminal. Launching on other platforms depends on platform integration.

## 2. Add one provider

In provider management, select a provider type for the target tool and enter its API endpoint, credentials, and model information. Official subscription login and ordinary API keys are different access methods; use the method supported by that integration.

- Use the provider's documented endpoint. Avoid accidentally duplicating paths such as `/v1`.
- Use a model ID the provider actually supports. A display name may differ from its API ID.
- Start with a preset if available, then check the provider's documentation. Services without presets can be configured as custom providers.

## 3. Choose a model for the tool

Select a provider and model for your target tool. Configuration writing and the local gateway are related but distinct operations. Follow the interface to enable local routing when you need protocol conversion, aggregation, or failover.

Enable one tool at a time. Avoid editing the same tool's configuration in another app simultaneously. Protocol conversion cannot add tool calling, image input, or reasoning capabilities that a model does not support.

Examples:

- [DeepSeek in Codex](guides/codex-deepseek-routing-guide-en.md)
- [Kimi in Codex](guides/codex-kimi-routing-guide-en.md)
- [Claude in Codex](guides/codex-claude-routing-guide-en.md)
- [Codex in Claude Code](guides/claude-codex-routing-guide-en.md)

## 4. Verify one request

Launch the CLI and send a small request without sensitive data in a temporary project. Confirm the tool uses the intended model, then inspect sessions and usage in PHI. Usage coverage depends on the integration and request path. Cost displays are estimates; your provider's bill is authoritative.

## Troubleshooting

| Symptom | Check first |
| --- | --- |
| CLI will not launch | Whether Apps detects the installation and the CLI runs in an external terminal |
| 401 / 403 | API key or login state, provider permissions, and model access |
| 404 / unknown model | Endpoint, model ID, and protocol compatibility |
| Connection refused | Whether the local gateway is running, the port is available, and the tool points to the correct endpoint |
| Request succeeds without usage records | Whether the request follows a supported collection path and the tool matches your usage filters |

If the problem persists, use the [bug report template](https://github.com/GoatGit/phi/issues/new?template=bug_report.yml). Include the PHI version, OS and architecture, CLI version, minimal reproduction steps, and redacted errors. Do not attach complete databases, OAuth files, configuration backups, or unchecked logs.

## Data and updates

Configuration and the database live in `~/.phi/` by default (`phi.db` is the database). Settings and portable mode can override the directory. Old `~/.cc-switch/` data is not automatically migrated. Treat API credentials, OAuth files, and backups as sensitive. Local storage does not mean everything is encrypted. Model requests and remote sync send data to the services you configure.

"Check for updates" opens GitHub Releases. Back up your configuration before installing a new package if needed. In-app automatic update installation is currently disabled.

See the [security policy](../SECURITY.md) and [support guide](../SUPPORT.md) for more.
