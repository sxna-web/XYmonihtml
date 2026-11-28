from __future__ import annotations

import copy
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from schema_manifest import ManifestError, TARGET_TABLES, compare_manifests, manifest_from_snapshot


def sample_snapshot():
    tables = {}
    objects = []
    for table in TARGET_TABLES:
        tables[table] = {
            "columns": [[0, "id", "TEXT", 1, None, 1],
                        [1, "state", "TEXT", 1, "'active'", 0]],
            "index_details": [{
                "name": "idx_" + table + "_owner",
                "list_row": [0, "idx_" + table + "_owner", 1, "c", 0],
                "columns": [[0, 0, "id", 0, "BINARY", 1]],
                "sql": "CREATE UNIQUE INDEX idx_" + table + "_owner ON " + table + "(id)",
            }],
            "foreign_keys": [[0, 0, "owners", "owner_id", "id", "NO ACTION", "RESTRICT", "NONE"]],
        }
        objects.append(["table", table, table, "CREATE TABLE " + table + "(id TEXT)"])
        objects.append(["index", "idx_" + table + "_owner", table,
                        "CREATE UNIQUE INDEX idx_" + table + "_owner ON " + table + "(id)"])
    return {"objects": objects, "tables": tables}


class SchemaManifestTests(unittest.TestCase):
    def test_01_builds_environment_scoped_manifest(self):
        manifest = manifest_from_snapshot(sample_snapshot(), "staging")
        self.assertEqual(manifest["environment"], "staging")
        self.assertEqual(manifest["format_version"], 1)
        self.assertEqual(manifest["tables"]["app_cards"]["status"], "PRESENT")
        self.assertEqual(len(manifest["scope"]), 7)
        self.assertEqual(len(manifest["manifest_sha256"]), 64)

    def test_02_missing_candidate_tables_are_explicitly_absent(self):
        snapshot = sample_snapshot()
        del snapshot["tables"]["app_card_group_mappings"]
        manifest = manifest_from_snapshot(snapshot, "production")
        self.assertEqual(manifest["tables"]["app_card_group_mappings"], {"status": "ABSENT"})

    def test_03_compare_equal_staging_and_production_manifests(self):
        snap = sample_snapshot()
        a = manifest_from_snapshot(snap, "staging")
        b = manifest_from_snapshot(snap, "production")
        result = compare_manifests(a, b)
        self.assertEqual(result["comparison"], "MATCH")
        self.assertTrue(all(x["status"] == "MATCH" for x in result["table_results"].values()))

    def test_04_detects_missing_table(self):
        snap = sample_snapshot()
        a = manifest_from_snapshot(snap, "staging")
        del snap["tables"]["app_card_group_mappings"]
        b = manifest_from_snapshot(snap, "production")
        result = compare_manifests(a, b)
        self.assertEqual(result["table_results"]["app_card_group_mappings"]["status"], "PRESENCE_MISMATCH")

    def test_05_detects_column_constraint_difference(self):
        a_snap, b_snap = sample_snapshot(), sample_snapshot()
        b_snap["tables"]["app_cards"]["columns"][1][3] = 0
        result = compare_manifests(
            manifest_from_snapshot(a_snap, "staging"),
            manifest_from_snapshot(b_snap, "production"),
        )
        self.assertEqual(result["table_results"]["app_cards"]["differences"], ["columns"])

    def test_06_detects_index_key_order_and_uniqueness_difference(self):
        a_snap, b_snap = sample_snapshot(), sample_snapshot()
        b_snap["tables"]["app_cards"]["index_details"][0]["columns"][0][2] = "state"
        result = compare_manifests(
            manifest_from_snapshot(a_snap, "staging"),
            manifest_from_snapshot(b_snap, "production"),
        )
        self.assertIn("indexes", result["table_results"]["app_cards"]["differences"])

    def test_07_detects_foreign_key_action_difference(self):
        a_snap, b_snap = sample_snapshot(), sample_snapshot()
        b_snap["tables"]["app_cards"]["foreign_keys"][0][6] = "CASCADE"
        result = compare_manifests(
            manifest_from_snapshot(a_snap, "staging"),
            manifest_from_snapshot(b_snap, "production"),
        )
        self.assertIn("foreign_keys", result["table_results"]["app_cards"]["differences"])

    def test_08_manifest_hashes_default_literals_without_echoing_them(self):
        snap = sample_snapshot()
        snap["tables"]["app_cards"]["columns"][1][4] = "'DO_NOT_ECHO_SECRET_LITERAL'"
        manifest = manifest_from_snapshot(snap, "staging")
        self.assertNotIn("DO_NOT_ECHO_SECRET_LITERAL", str(manifest))
        self.assertIn("default_sha256", str(manifest))

    def test_09_trigger_definition_is_hashed_not_echoed(self):
        snap = sample_snapshot()
        snap["objects"].append(["trigger", "trg_sensitive", "app_cards",
                                "CREATE TRIGGER trg_sensitive BEGIN SELECT 'DO_NOT_ECHO_TRIGGER_LITERAL'; END"])
        manifest = manifest_from_snapshot(snap, "staging")
        self.assertNotIn("DO_NOT_ECHO_TRIGGER_LITERAL", str(manifest))
        self.assertTrue(any(x["type"] == "trigger" for x in manifest["tables"]["app_cards"]["objects"]))

    def test_10_rejects_unknown_environment(self):
        with self.assertRaises(ManifestError):
            manifest_from_snapshot(sample_snapshot(), "prod")

    def test_11_rejects_incomplete_column_metadata(self):
        snap = sample_snapshot()
        snap["tables"]["app_cards"]["columns"] = [[0, "id"]]
        with self.assertRaises(ManifestError):
            manifest_from_snapshot(snap, "staging")

    def test_12_rejects_mismatched_scopes(self):
        a = manifest_from_snapshot(sample_snapshot(), "staging")
        b = copy.deepcopy(a)
        del b["tables"]["app_cards"]
        with self.assertRaises(ManifestError):
            compare_manifests(a, b)

    def test_13_stable_output_ignores_environment_in_structural_table_comparison(self):
        snap = sample_snapshot()
        a = manifest_from_snapshot(snap, "staging")
        b = manifest_from_snapshot(snap, "production")
        self.assertEqual(compare_manifests(a, b)["comparison"], "MATCH")


if __name__ == "__main__":
    unittest.main()
