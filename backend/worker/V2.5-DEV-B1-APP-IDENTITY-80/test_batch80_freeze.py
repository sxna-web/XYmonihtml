"""Batch 80 offline contract-freeze and D1 evidence-map checks.
No network, credentials, SQL execution, D1 or production dependencies.
"""
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
BATCH = ROOT / "backend/worker/V2.5-DEV-B1-APP-IDENTITY-80"
EXT = json.loads((BATCH / "batch80_case_extension.json").read_text(encoding="utf-8"))
BASELINE_MATRIX = json.loads((ROOT / "backend/worker/V2.5-DEV-B1-APP-IDENTITY-76/d1_validation_matrix.json").read_text(encoding="utf-8"))
FREEZE = (BATCH / "ADAPTER-CONTRACT-FREEZE-CHECKLIST.md").read_text(encoding="utf-8")
EVIDENCE = (BATCH / "D1-EVIDENCE-MAP.md").read_text(encoding="utf-8")
HMAC = (BATCH / "HMAC-OVERLAP-INDEX-AND-MIGRATION-PLAN.md").read_text(encoding="utf-8")
LEGACY = (BATCH / "LEGACY-CALLER-COMPATIBILITY-INVENTORY.md").read_text(encoding="utf-8")


class Batch80FreezeTests(unittest.TestCase):
    def test_01_base_matrix_is_spec_only(self):
        self.assertEqual(BASELINE_MATRIX["status"], "SPEC_ONLY_NO_D1_EXECUTION")

    def test_02_base_matrix_production_disabled(self):
        self.assertFalse(BASELINE_MATRIX["safety"]["production_allowed"])

    def test_03_base_matrix_requires_user_approval(self):
        self.assertTrue(BASELINE_MATRIX["safety"]["requires_explicit_user_approval"])

    def test_04_base_matrix_has_26_unique_cases(self):
        ids = [x["id"] for x in BASELINE_MATRIX["cases"]]
        self.assertEqual(len(ids), 26)
        self.assertEqual(len(set(ids)), 26)

    def test_05_extension_has_8_cases(self):
        self.assertEqual(len(EXT["cases"]), 8)

    def test_06_extension_ids_are_027_to_034(self):
        self.assertEqual([x["id"] for x in EXT["cases"]],
                         [f"D1-{n:03d}" for n in range(27, 35)])

    def test_07_all_extension_cases_have_expected_result(self):
        self.assertTrue(all(x.get("expected") for x in EXT["cases"]))

    def test_08_rotation_cases_are_blocked_by_user_decision(self):
        cases = [x for x in EXT["cases"] if x["id"] == "D1-031"]
        self.assertEqual(cases[0]["requires_user_decision"], ["U80-05", "U80-06"])

    def test_09_existing_resolution_audit_policy_is_not_assumed(self):
        self.assertIn("U80-01", FREEZE)
        self.assertIn("only if approved", EXT["cases"][0]["expected"])

    def test_10_actor_mapping_is_unresolved(self):
        self.assertIn("U80-02", FREEZE)
        self.assertIn("actor mapping", FREEZE.lower())

    def test_11_reason_enum_and_nullability_are_unresolved(self):
        self.assertIn("U80-03", FREEZE)
        self.assertIn("reason_code", FREEZE)

    def test_12_payload_allowlist_is_unresolved(self):
        self.assertIn("U80-04", FREEZE)
        self.assertIn("payload allow-list", FREEZE)

    def test_13_rotation_side_effects_are_not_defaulted(self):
        self.assertIn("No implicit revoke, preserve, rebind", FREEZE)

    def test_14_d1_map_keeps_existing_26_cases(self):
        for n in range(1, 27):
            self.assertIn(f"D1-{n:03d}", EVIDENCE)

    def test_15_d1_map_adds_all_8_extensions(self):
        for n in range(27, 35):
            self.assertIn(f"D1-{n:03d}", EVIDENCE)

    def test_16_d1_admission_is_fail_closed(self):
        for phrase in ("exact name and database ID", "Separate explicit approvals",
                       "before further writes", "No default database"):
            self.assertIn(phrase, EVIDENCE)

    def test_17_starjump_staging_is_not_approved_substitute(self):
        self.assertIn("starjump-staging", EVIDENCE)
        self.assertIn("not an automatically approved", EVIDENCE)

    def test_18_hmac_counts_logical_events_by_event_id(self):
        self.assertIn("immutable logical tuple", HMAC)
        self.assertIn("event_id", HMAC)
        self.assertIn("avoid summing raw bucket counts", HMAC)

    def test_19_hmac_plan_has_no_production_threshold(self):
        self.assertIn("no key, threshold, retention duration", HMAC)

    def test_20_hmac_cleanup_preserves_retry_horizon(self):
        self.assertIn("retry/idempotency horizon", HMAC)
        self.assertIn("cannot make a concurrent admission undercount", HMAC)

    def test_21_legacy_routes_are_listed(self):
        for route in ("/api/app/resolve", "/api/app/groups", "/api/app/free",
                      "/api/app/links", "/api/app/redeem", "/api/app/status",
                      "/api/app/nodes", "/api/user/share-code"):
            self.assertIn(route, LEGACY)

    def test_22_v2_isolated_handler_not_claimed_deployed(self):
        self.assertIn("not proof of a deployed v2 endpoint", LEGACY)

    def test_23_apk_caller_inventory_is_marked_incomplete(self):
        self.assertIn("no client call-site inventory can be claimed complete", LEGACY)

    def test_24_no_legacy_route_retirement_is_authorized(self):
        self.assertIn("Do not delete, rename or change semantics", LEGACY)


if __name__ == "__main__":
    unittest.main()
