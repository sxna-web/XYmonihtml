"""Batch 82 static review integrity checks; no network, credentials, SQL or D1."""
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
B82 = ROOT / "backend/worker/V2.5-DEV-B1-APP-IDENTITY-82"
B81_MATRIX = json.loads((ROOT / "backend/worker/V2.5-DEV-B1-APP-IDENTITY-81/ADAPTER-STATEMENT-ASSERTION-MATRIX.json").read_text(encoding="utf-8"))
APK = (B82 / "APK-6.00.47-CALLER-AUDIT.md").read_text(encoding="utf-8")
NEGATIVE = (B82 / "ADAPTER-MATRIX-NEGATIVE-REVIEW.md").read_text(encoding="utf-8")
HMAC = (B82 / "HMAC-ALIAS-COVERAGE-COUNTEREXAMPLES.md").read_text(encoding="utf-8")

class Batch82StaticReviewTests(unittest.TestCase):
    def test_01_batch81_matrix_downgraded_to_method_level(self):
        self.assertEqual(B81_MATRIX["review_findings"]["disposition"], "METHOD_LEVEL_OUTLINE_NOT_STATEMENT_LEVEL_MANIFEST")
        self.assertFalse(B81_MATRIX["review_findings"]["sql_statement_manifest_present"])

    def test_02_limiter_and_hmac_cases_are_explicitly_unassigned(self):
        gaps = set(B81_MATRIX["review_findings"]["unassigned_d1_cases"])
        self.assertTrue({"D1-017", "D1-025", "D1-032", "D1-033", "D1-034"}.issubset(gaps))

    def test_03_nonce_and_digest_gaps_are_explicit(self):
        gaps = " ".join(B81_MATRIX["review_findings"]["unresolved_storage_contracts"])
        self.assertIn("nonce", gaps)
        self.assertIn("blob_or_text", gaps)

    def test_04_cleanup_method_is_separated_from_product_adapter(self):
        self.assertIn("expireTransientRecords", NEGATIVE)
        self.assertIn("not an approved production identity-adapter method", NEGATIVE)

    def test_05_sql_lexical_edge_cases_are_covered(self):
        for term in ("single-quoted", "double-quoted", "backtick", "bracket", "line comments", "block comments", "?NNN", ":name", "@name", "$name"):
            self.assertIn(term, NEGATIVE)

    def test_06_apk_archive_identity_is_recorded(self):
        self.assertIn("StarJump-6.00.47-source.zip", APK)
        self.assertIn("5a45da3d6e6e42a6aabf776336fdfff8424af0e9c7d756a8fea17f882459f7ab", APK)
        self.assertIn("6.00.48-source.zip", APK)

    def test_07_legacy_and_v1_identity_routes_not_found_in_apk(self):
        for route in ("/api/app/resolve", "/api/app/groups", "/api/app/free", "/api/app/links",
                      "/api/app/redeem", "/api/app/status", "/api/app/nodes",
                      "/v1/device/bootstrap", "/v1/license/activate", "/v1/catalog/resolve"):
            self.assertIn(route, APK)
        self.assertIn("No direct APP source callsites were found", APK)

    def test_08_static_upstream_slot_gap_is_recorded(self):
        self.assertIn("Only slot 01 has a configured HTTPS upstream", APK)
        self.assertIn("Slots 02–05 are literal placeholders", APK)

    def test_09_device_key_backup caveat(self):
        self.assertIn('android:allowBackup="true"', APK)
        self.assertIn("Android Keystore", APK)

    def test_10_hmac_all_adversarial_cases_are_documented(self):
        for case in (f"H82-{n:02d}" for n in range(1, 15)):
            self.assertIn(case, HMAC)

    def test_11_hmac_key_specific_alias_is_not_logical_tuple(self):
        self.assertIn("K1 fingerprint and K2 fingerprint", HMAC)
        self.assertIn("must not naïvely include a version-specific fingerprint", HMAC)

    def test_12_no_runtime_claims(self):
        self.assertIn("No APK binary was installed or dynamically instrumented", APK)
        self.assertIn("no SQL or D1 execution", NEGATIVE.lower())

if __name__ == "__main__":
    unittest.main()
