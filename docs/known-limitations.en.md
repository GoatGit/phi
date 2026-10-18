# Known limitations / 已知限制

This page lists known, expected limitations in the current PHI release. It does not replace the [security policy](../SECURITY.md) or issue tracking: report reproducible bugs through [GitHub Issues](https://github.com/GoatGit/phi/issues/new/choose), and security vulnerabilities through the [private channel](../SECURITY.md#reporting-a-vulnerability--报告漏洞).

Applies to v1.0.0 and the current release process. This page will be updated when a limitation is resolved.

## Installer signing

- **macOS**: installers are signed with a Developer ID Application certificate and notarized by Apple. The app inside the DMG and the updater archive passes Gatekeeper verification.
- **Windows**: the `.msi` and `Portable.zip` packages are **not Authenticode-signed** and do **not** use Azure Trusted Signing. Windows cannot verify the publisher identity, so SmartScreen may warn about an "Unknown publisher" or show "Windows protected your PC". This does **not** mean Windows has classified the package as malware, but it does mean you should verify the download source before running it.
- **Linux**: the `.AppImage`, `.deb`, and `.rpm` packages have **no distro- or vendor-level GPG signature**. The `.sig` files in a release are Tauri updater signatures: they verify update archive integrity and version, not operating-system package provenance.

Download packages only from the [official Releases](https://github.com/GoatGit/phi/releases/latest). If the filename, version, download source, or system warning does not match the release notes, stop and report it through an issue.

## Real-device installation coverage

- Release packages are built by CI on macOS, Windows, and Linux.
- macOS: the installer's signature, notarization, and Gatekeeper result have been verified. The embedded Ghostty terminal is currently macOS-only.
- Windows and Linux: the installers have **not** yet completed an "install → first launch → send one model request" check on real devices. A successful CI build and valid package structure do **not** mean installation has been verified on that platform.
- If you hit an install, launch, or first-request problem on Windows or Linux, include your OS version, CPU architecture, package filename, and error message in an issue.

## Updates

- "Check for updates" opens GitHub Releases. PHI does not currently download or install updates automatically.
- Windows may show the same SmartScreen warning during a manual update.
- The macOS updater archive (`.tar.gz`) is verified by the Tauri updater signature. On Windows and Linux, the updater `.sig` files also prove archive integrity only; they do not prove OS-level publisher identity.

## Platform differences

- The embedded Ghostty terminal currently supports macOS only. CLI launching on other platforms depends on platform integration.
- The local gateway converts supported protocols, but tool use, images, reasoning, and context limits still depend on the upstream model and adapter.
- The UI supports Simplified Chinese, Traditional Chinese, English, and Japanese. Docs are primarily Chinese and English, with Japanese versions for some guides; some screenshots and third-party terminology still retain upstream content.

## What happens next

- When a Windows code-signing certificate or Azure Trusted Signing is available, Windows packages will get Authenticode signatures and this page will be updated.
- When real-device Windows and Linux installation checks are added to the release process, the verification scope will be updated.
- Until then, release notes will not describe a successful CI build as completed multi-platform installation verification.

---

[中文版本](known-limitations.md)
