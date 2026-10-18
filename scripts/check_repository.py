#!/usr/bin/env python3
"""Check PHI's maintained entry points, release metadata, and tracked paths.

Uses only the Python 3.12 standard library. Does not inspect secret contents,
Git history, remote URLs, or Markdown anchors. Historical docs are not crawled.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
import tomllib
from pathlib import Path, PurePosixPath
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parent.parent
DOCUMENTS = (
    "README.md",
    "README.en.md",
    "CONTRIBUTING.md",
    "CODE_OF_CONDUCT.md",
    "SECURITY.md",
    "SUPPORT.md",
    "FORK-BASELINE.md",
    "docs/README.md",
    "docs/getting-started.md",
    "docs/getting-started.en.md",
    "docs/OPEN_SOURCE_CHECKLIST.md",
)
LINK = re.compile(r"!?\[[^\]\n]*\]\(<?([^\s)>]+)>?(?:\s+\"[^\"]*\")?\)")
FENCE = re.compile(r"^\s*(`{3,}|~{3,})")
SENSITIVE_SUFFIXES = {".key", ".p12", ".pfx", ".p8", ".db", ".sqlite", ".sqlite3"}
SENSITIVE_NAMES = {
    "auth.json",
    "codex_oauth_auth.json",
    "copilot_auth.json",
    "id_rsa",
    "id_ed25519",
    "credentials.json",
}


def local_link_errors(root: Path, relative: str) -> list[str]:
    """Check inline local file targets outside fenced code blocks."""
    source = root / relative
    if not source.is_file():
        return [f"Missing document: {relative}"]
    errors: list[str] = []
    fence: str | None = None
    for number, line in enumerate(source.read_text(encoding="utf-8").splitlines(), 1):
        marker = FENCE.match(line)
        if marker:
            value = marker.group(1)
            if fence is None:
                fence = value
            elif value[0] == fence[0] and len(value) >= len(fence):
                fence = None
            continue
        if fence is not None:
            continue
        for match in LINK.finditer(line):
            target = urlsplit(match.group(1))
            if target.scheme or target.netloc or not target.path:
                continue
            path = unquote(target.path)
            destination = (
                root / path.lstrip("/") if path.startswith("/") else source.parent / path
            ).resolve()
            if not destination.is_relative_to(root.resolve()) or not destination.exists():
                errors.append(f"{relative}:{number}: missing local target {path}")
    return errors


def sensitive_path(relative: str) -> bool:
    """Identify common accidental local-data commits by filename only."""
    path = PurePosixPath(relative)
    name = path.name.lower()
    environment_file = name == ".env" or name.startswith(".env.")
    if environment_file and not (name.endswith(".example") or name.endswith(".sample")):
        return True
    return (
        path.suffix.lower() in SENSITIVE_SUFFIXES
        or name in SENSITIVE_NAMES
        or name.endswith((".db-wal", ".db-shm", ".sqlite-wal", ".sqlite-shm"))
        or any(part in {".phi", ".cc-switch", "node_modules"} for part in path.parts)
    )


def metadata_errors(root: Path) -> list[str]:
    package = json.loads((root / "package.json").read_text(encoding="utf-8"))
    tauri = json.loads((root / "src-tauri/tauri.conf.json").read_text(encoding="utf-8"))
    cargo = tomllib.loads((root / "src-tauri/Cargo.toml").read_text(encoding="utf-8"))
    errors: list[str] = []
    versions = (package.get("version"), tauri.get("version"), cargo["package"].get("version"))
    if not versions[0] or len(set(versions)) != 1:
        errors.append("Version mismatch: package.json, tauri.conf.json, Cargo.toml")
    if package.get("license") != "MIT" or not (root / "LICENSE").is_file():
        errors.append("Expected MIT package metadata and a LICENSE file")
    if package.get("private") is not True:
        errors.append("Desktop package must stay private to prevent accidental npm publishing")
    for field in ("repository", "bugs", "homepage"):
        if not package.get(field):
            errors.append(f"Missing package metadata: {field}")
    if not (root / "docs/logo/phi-app-icon.png").is_file():
        errors.append("Missing README app icon")
    return errors


def main() -> int:
    try:
        errors = metadata_errors(ROOT)
        for relative in DOCUMENTS:
            errors.extend(local_link_errors(ROOT, relative))
        result = subprocess.run(
            ["git", "ls-files", "-z"],
            cwd=ROOT,
            check=True,
            capture_output=True,
        )
        tracked = result.stdout.decode("utf-8").split("\0")
        errors.extend(
            f"Potential local data tracked by Git: {path}"
            for path in tracked
            if path and sensitive_path(path)
        )
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        print(f"Repository check could not complete: {type(error).__name__}", file=sys.stderr)
        return 1
    if errors:
        for error in errors:
            print(error, file=sys.stderr)
        return 1
    print(f"Repository quality passed ({len(DOCUMENTS)} documents, metadata, tracked paths).")
    print("Scope: local file targets only; no anchors, remote URLs, secret content or Git history.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
