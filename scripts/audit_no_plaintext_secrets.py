#!/usr/bin/env python3
"""Audit an explicitly selected PHI fixture/copy. Never print credential values.

Structural inspection finds unprefixed credentials in known stores; synthetic
canaries additionally find leaked bytes in database pages, WAL, backups and logs.
This does not prove that an encryption implementation is correct or erase data.
No default path points at a user's live credentials.
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

try:
    import tomllib
except ImportError:
    tomllib = None


SECRET_FIELDS = {
    "apikey", "authtoken", "accesstoken", "refreshtoken", "idtoken", "clientsecret",
    "password", "authorization", "xapikey", "xgoogapikey", "xphitoken",
    "experimentalbearertoken", "oauthtoken", "bearertoken", "secretaccesskey",
    "anthropicauthtoken", "anthropicapikey", "openaiapikey", "apitoken", "sessiontoken", "token", "secret",
    "geminiapikey", "googleapikey", "xaiapikey", "awsbearertokenbedrock",
    "awssecretaccesskey", "awssessiontoken", "proxyapikey", "gatewaytoken",
}
SNAPSHOT_COLUMNS = {
    "proxy_live_backup": {"original_config"},
    "config_versions": {"content"},
    "config_operations": {"manifest", "payload"},
}
JSON_COLUMNS = {
    "providers": {"settings_config", "meta"},
    "profiles": {"payload"},
    "settings": {"value"},
    "gateway_catalog": {"payload"},
}


def normalized(key: str) -> str:
    return re.sub(r"[^a-z0-9]", "", key.lower())


def sensitive(key: str) -> bool:
    value = normalized(key)
    return value in SECRET_FIELDS or value.endswith(("apikey", "accesstoken", "refreshtoken", "clientsecret"))


class Auditor:
    def __init__(self, references: set[str] | None = None):
        self.references = references or set()
        self.findings: list[dict[str, str]] = []
        self.rows = 0
        self.canary_files = 0

    def flag(self, location: str, code: str) -> None:
        self.findings.append({"location": location, "code": code})

    def credential(self, value, location: str) -> None:
        if value is None or value == "":
            return
        if isinstance(value, dict) and set(value) == {"secret_ref"}:
            reference = value["secret_ref"]
            if not isinstance(reference, str) or reference not in self.references:
                self.flag(location, "missing_secret_reference")
        else:
            self.flag(location, "plaintext_credential")

    def walk(self, value, location: str) -> None:
        if isinstance(value, dict):
            for index, (key, child) in enumerate(value.items()):
                # Keys and row identifiers can themselves contain secrets. Export positions only.
                child_location = f"{location}.field[{index}]"
                if key == "secret_ref":
                    if not isinstance(child, str) or child not in self.references:
                        self.flag(child_location, "missing_secret_reference")
                elif sensitive(key):
                    self.credential(child, child_location)
                elif key in {"config", "settings", "auth"} and isinstance(child, str) and child.strip():
                    self.document(child, child_location)
                else:
                    self.walk(child, child_location)
        elif isinstance(value, list):
            for index, child in enumerate(value):
                self.walk(child, f"{location}[{index}]")
        elif isinstance(value, str):
            if value.startswith(("http://", "https://", "socks5://")):
                try:
                    parsed = urlsplit(value)
                    if parsed.username or parsed.password or any(
                        sensitive(k) or k.lower() in {"key", "token", "secret"}
                        for k, _ in parse_qsl(parsed.query)
                    ):
                        self.flag(location, "credential_in_url")
                except ValueError:
                    self.flag(location, "invalid_url")

    def document(self, value: str, location: str) -> None:
        try:
            parsed = json.loads(value)
        except (ValueError, TypeError):
            try:
                if tomllib is None:
                    raise ValueError("TOML parser unavailable")
                parsed = tomllib.loads(value)
            except (ValueError, TypeError):
                self.flag(location, "unparsed_configuration")
                return
        self.walk(parsed, location)

    def database(self, path: Path) -> None:
        try:
            conn = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
            conn.execute("PRAGMA query_only=ON")
            tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if not {"providers", "settings"}.issubset(tables):
                self.flag("database", "incomplete_phi_schema")
            for table in sorted(tables & (set(JSON_COLUMNS) | set(SNAPSHOT_COLUMNS) | {"gateway_supplier_secrets"})):
                # Table identifiers are selected only from the fixed lists above.
                cursor = conn.execute(f'SELECT * FROM "{table}"')
                names = [c[0] for c in cursor.description]
                for row_number, row in enumerate(cursor, 1):
                    self.rows += 1
                    data = dict(zip(names, row))
                    for column, value in data.items():
                        location = f"{table}.row[{row_number}].column[{names.index(column)}]"
                        if value is None or value == "":
                            continue
                        if table == "gateway_supplier_secrets" and column == "api_key":
                            self.credential(value, location)
                        elif column in SNAPSHOT_COLUMNS.get(table, set()):
                            # Encryption must be verified by the eventual vault implementation.
                            # An opaque blob or compressed JSON alone is not evidence of encryption.
                            self.flag(location, "snapshot_encryption_unverified")
                        elif column in JSON_COLUMNS.get(table, set()):
                            if table == "settings":
                                setting_key = str(data.get("key", ""))
                                if sensitive(setting_key):
                                    self.credential(value, location)
                                    continue
                                if isinstance(value, str) and not value.lstrip().startswith(("{", "[")):
                                    self.walk(value, location)
                                    continue
                            if isinstance(value, str):
                                self.document(value, location)
                            else:
                                self.flag(location, "unparsed_configuration")
            conn.close()
        except (sqlite3.Error, OSError):
            self.flag("database", "database_unreadable")

    def canaries(self, paths: list[Path], values: list[bytes]) -> None:
        if not values or any(not v for v in values):
            raise ValueError("canaries must be nonempty synthetic strings")
        overlap = max(map(len, values)) - 1
        for index, path in enumerate(paths):
            try:
                self.canary_files += 1
                with path.open("rb") as stream:
                    tail = b""
                    found: set[int] = set()
                    while chunk := stream.read(1024 * 1024):
                        data = tail + chunk
                        found.update(i for i, value in enumerate(values) if value in data)
                        tail = data[-overlap:] if overlap else b""
                    for _ in sorted(found):
                        self.flag(f"artifact[{index}]", "synthetic_credential_bytes_found")
            except OSError:
                self.flag(f"artifact[{index}]", "artifact_unreadable")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path, required=True, help="Synthetic fixture or explicit database copy")
    parser.add_argument("--references-file", type=Path, help="JSON array of verified secret IDs; never secret values")
    parser.add_argument("--canaries-file", type=Path, help="JSON array of synthetic credential strings only")
    parser.add_argument("--artifact", type=Path, action="append", default=[], help="Additional WAL/journal/export/log copy to scan")
    args = parser.parse_args()
    try:
        references = json.loads(args.references_file.read_text()) if args.references_file else []
        if not isinstance(references, list) or not all(isinstance(v, str) for v in references):
            raise ValueError("invalid references")
        auditor = Auditor(set(references))
        auditor.database(args.database)
        if args.canaries_file:
            values = json.loads(args.canaries_file.read_text())
            if not isinstance(values, list) or not all(isinstance(v, str) for v in values):
                raise ValueError("invalid canaries")
            paths = [args.database, *args.artifact]
            for suffix in ["-wal", "-journal"]:
                sidecar = Path(str(args.database) + suffix)
                if sidecar.exists():
                    paths.append(sidecar)
            auditor.canaries(paths, [v.encode() for v in values])
        elif args.artifact:
            raise ValueError("artifact inspection requires synthetic canaries")
        print(json.dumps({"ok": not auditor.findings, "rowsChecked": auditor.rows,
            "canaryFilesChecked": auditor.canary_files, "findings": auditor.findings}, ensure_ascii=False))
        return int(bool(auditor.findings))
    except (OSError, ValueError, TypeError):
        print(json.dumps({"ok": False, "error": "invalid audit input; no credential values are reported"}))
        return 2


if __name__ == "__main__":
    sys.exit(main())
