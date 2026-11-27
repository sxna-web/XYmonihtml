"""Batch 81 offline readiness contract checks. No network, credentials, SQL or D1."""
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
BATCH = ROOT / "backend/worker/V2.5-DEV-B1-APP-IDENTITY-81"
M = json.loads((BATCH / "ADAPTER-STATEMENT-ASSERTION-MATRIX.json").read_text(encoding="utf-8"))
HARNESS = (BATCH / "DISPOSABLE-D1-HARNESS-IMPLEMENTATION-REVIEW.md").read_text(encoding="utf-8")
HMAC = (BATCH / "HMAC-OVERLAP-DECISION-REVIEW.md").read_text(encoding="utf-8")
CALLERS = (BATCH / "LEGACY-CALLER-SOURCE-REVIEW.md").read_text(encoding="utf-8")

class Batch81ReadinessTests(unittest.TestCase):
    def test_01_spec_only_no_d1(self):
        self.assertEqual(M["status"], "SPEC_ONLY_NO_D1_EXECUTION")
    def test_02_all_eight_adapter_methods_present(self):
        self.assertEqual({x["method"] for x in M["methods"]}, {
            "insertChallenge", "consumeChallengeAtomic", "consumeNonceAtomic",
            "upsertBindingAtomic", "revokeBindingAtomic", "rotateShareCodeAtomic",
            "getCurrentShareCode", "expireTransientRecords"})
    def test_03_each_method_has_source_bind_result_receipt_audit_cases(self):
        for x in M["methods"]:
            for k in ("source", "bind_contract", "result", "receipt", "audit", "cases"):
                self.assertTrue(x.get(k), (x["method"], k))
    def test_04_all_d1_cases_001_to_034_mapped(self):
        self.assertEqual(set(M["d1_case_map"]), {f"D1-{n:03d}" for n in range(1, 35)})
    def test_05_user_decisions_block_composite_paths(self):
        for op in M["composite_contracts"]:
            self.assertTrue(op["blocked_by"], op["operation"])
    def test_06_created_and_existing_are_distinct(self):
        names = {x["operation"] for x in M["composite_contracts"]}
        self.assertIn("create_created", names)
        self.assertIn("create_existing", names)
    def test_07_harness_default_disabled(self):
        for phrase in ("--enable-disposable-d1", "no implicit", "no network permissions",
                       "Cleanup is a distinct", "append-only ledger"):
            self.assertIn(phrase, HARNESS)
    def test_08_separate_approvals(self):
        for phrase in ("identity-read", "synthetic-write", "cleanup"):
            self.assertIn(phrase, HARNESS)
    def test_09_cleanup_is_ledger_only(self):
        self.assertIn("exclusively from this run's append-only ledger", HARNESS)
    def test_10_hmac_candidates_compared(self):
        for phrase in ("A. Canonical logical event", "B. Dual-write", "C. Migrate"):
            self.assertIn(phrase, HMAC)
    def test_11_hmac_logical_event_identity(self):
        self.assertIn("event_id", HMAC)
        self.assertIn("immutable", HMAC)
        self.assertIn("same ID/different tuple", HMAC)
    def test_12_hmac_rollback_proof_present(self):
        self.assertIn("Rollback proof", HMAC)
        self.assertIn("high-water", HMAC)
    def test_13_worker_and_html_callers_recorded(self):
        for route in ("/api/app/resolve", "/api/app/groups", "/api/app/free",
                      "/api/app/links", "/api/app/redeem", "/api/app/status",
                      "/api/app/nodes", "/api/user/share-code",
                      "/api/super/admins/:id/share-code"):
            self.assertIn(route, CALLERS)
    def test_14_apk_gap_is_explicit(self):
        self.assertIn("no complete method/path/header/query/body/response inventory", CALLERS)
    def test_15_legacy_and_v2_are_not_conflated(self):
        self.assertIn("feature flag OFF", CALLERS)
        self.assertIn("does not show the handler registered", CALLERS)

if __name__ == "__main__":
    unittest.main()
