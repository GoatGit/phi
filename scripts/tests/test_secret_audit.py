import importlib.util
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("audit", Path(__file__).parents[1] / "audit_no_plaintext_secrets.py")
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


class SecretAuditTests(unittest.TestCase):
    def test_unprefixed_credentials_in_json_toml_profiles_settings_and_urls(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "fixture.db"
            conn = sqlite3.connect(path)
            conn.executescript("CREATE TABLE providers(settings_config TEXT, meta TEXT); CREATE TABLE profiles(payload TEXT); CREATE TABLE settings(key TEXT,value TEXT); CREATE TABLE gateway_supplier_secrets(api_key TEXT);")
            secret = "e2b179cd-f8e5-4134-b6a9-random-fixture"
            conn.execute("INSERT INTO providers VALUES(?,?)", (json.dumps({"env": {"ANTHROPIC_API_KEY": secret}, "config": f'[model_providers.custom]\nexperimental_bearer_token = "{secret}"'}), '{}'))
            conn.execute("INSERT INTO profiles VALUES(?)", (json.dumps({"auth": {"refresh_token": secret}}),))
            conn.execute("INSERT INTO settings VALUES(?,?)", ("proxy_api_key", secret))
            conn.execute("INSERT INTO settings VALUES(?,?)", ("proxy_url", "https://user:secret@example.invalid"))
            conn.execute("INSERT INTO gateway_supplier_secrets VALUES(?)", (secret,))
            conn.commit(); conn.close()
            scanner = audit.Auditor(); scanner.database(path)
            codes = [f["code"] for f in scanner.findings]
            self.assertEqual(codes.count("plaintext_credential"), 5)
            self.assertIn("credential_in_url", codes)
            self.assertNotIn(secret, json.dumps(scanner.findings))

    def test_missing_references_and_opaque_snapshots_are_not_false_success(self):
        scanner = audit.Auditor({"valid-id"})
        scanner.walk({"api_key": {"secret_ref": "valid-id"}}, "fixture")
        self.assertEqual(scanner.findings, [])
        scanner.walk({"api_key": {"secret_ref": "missing-id"}}, "fixture")
        self.assertEqual(scanner.findings[0]["code"], "missing_secret_reference")
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/"fixture.db"; conn=sqlite3.connect(path)
            conn.execute("CREATE TABLE proxy_live_backup(original_config BLOB)")
            conn.execute("INSERT INTO proxy_live_backup VALUES(?)", (b'compressed-or-encrypted-unknown',))
            conn.commit();conn.close();scanner.database(path)
            self.assertIn("snapshot_encryption_unverified", [f["code"] for f in scanner.findings])

    def test_canary_spanning_chunks_is_found_without_printing_it(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/"synthetic.log"
            secret=b"no-prefix-synthetic-credential"
            path.write_bytes(b'x'*(1024*1024-8)+secret+b'tail')
            scanner=audit.Auditor();scanner.canaries([path],[secret])
            self.assertEqual(len(scanner.findings),1)
            self.assertNotIn(secret.decode(),json.dumps(scanner.findings))

    def test_audit_does_not_create_a_missing_database_and_hides_secret_keys(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/"missing.db";scanner=audit.Auditor();scanner.database(path)
            self.assertFalse(path.exists())
            self.assertEqual(scanner.findings[0]["code"],"database_unreadable")
        scanner=audit.Auditor();scanner.walk({"private-name-api-key":"private-value"},"fixture")
        report=json.dumps(scanner.findings)
        self.assertNotIn("private-name",report);self.assertNotIn("private-value",report)


if __name__ == "__main__":
    unittest.main()
