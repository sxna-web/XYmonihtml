import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[3]
DOC=(ROOT/"backend/worker/V2.5-DEV-B1-APP-IDENTITY-83/APP-V2-PROTOCOL-CONTRACT.md").read_text(encoding="utf-8")

class Batch83ContractTests(unittest.TestCase):
    def test_01_five_protocol_domains_present(self):
        for term in ("D1 — Discovery and binding","D2 — Card activation and entitlement","D3 — Entitlement status","D4 — Composed catalog","D5 — Group generation, tombstone and acknowledgement"):
            self.assertIn(term,DOC)

    def test_02_confirmed_multi_card_rules_preserved(self):
        for term in ("include that admin's enabled free group once","Different admins' free groups remain separate","same display name remain separate","zero catalog groups","up to five"):
            self.assertIn(term,DOC)

    def test_03_group_cleanup_lease_cap(self):
        self.assertIn("23 hours",DOC)
        self.assertIn("24-hour cleanup requirement",DOC)

    def test_04_generic_import_links_not_identity(self):
        self.assertIn("sn://subscription",DOC)
        self.assertIn("clash://install-config",DOC)
        self.assertIn("never treated as identity callback",DOC)

    def test_05_keystore_and_backup(self):
        self.assertIn("Android Keystore",DOC)
        self.assertIn("Exclude all reusable auth/session/device credential material from cloud backup",DOC)

    def test_06_statement_manifests_split(self):
        for term in ("Identity adapter","Limiter adapter","Disposable harness"):
            self.assertIn(term,DOC)

    def test_07_hmac_candidate_not_frozen(self):
        self.assertIn("dimension_id",DOC)
        self.assertIn("not implementation-ready",DOC)

    def test_08_user_decisions_remain_blockers(self):
        self.assertIn("U80-01..08 remain unresolved",DOC)
        self.assertIn("feature flag remains OFF",DOC)

    def test_09_no_d1_or_deployment_claim(self):
        self.assertIn("no D1 was connected",DOC.lower())
        self.assertIn("no production deployment occurred",DOC.lower())

if __name__=="__main__":
    unittest.main()
