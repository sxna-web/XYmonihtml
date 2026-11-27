import unittest
from hmac_alias_model import AliasLedger, IntegrityConflict, LogicalEvent

def event(event_id="e1", **changes):
    fields = dict(event_id=event_id, action="catalog.read", dimension_type="device",
                  dimension_ref="opaque-device-A", occurred_at=1000,
                  policy_window_id="window-A", decision="allow")
    fields.update(changes)
    return LogicalEvent(**fields)

class HmacAliasCounterexamples(unittest.TestCase):
    def test_01_same_logical_event_two_versions_counts_once(self):
        ledger = AliasLedger()
        ledger.write(event(), {"K1":"fp-k1-A", "K2":"fp-k2-A"})
        count, ids = ledger.count_union({("K1","device"):"fp-k1-A",("K2","device"):"fp-k2-A"})
        self.assertEqual((count, ids), (1, {"e1"}))

    def test_02_split_history_counts_distinct_events_together(self):
        ledger = AliasLedger()
        ledger.write(event("old"), {"K1":"fp-k1-A"})
        ledger.write(event("new", occurred_at=1001, dimension_ref="opaque-device-B"), {"K2":"fp-k2-B"})
        count, ids = ledger.count_union({("K1","device"):"fp-k1-A",("K2","device"):"fp-k2-B"})
        self.assertEqual((count, ids), (2, {"old","new"}))

    def test_03_same_event_id_changed_logical_tuple_conflicts(self):
        ledger = AliasLedger()
        ledger.write(event(), {"K1":"fp-k1-A"})
        with self.assertRaises(IntegrityConflict):
            ledger.write(event(action="catalog.write"), {"K2":"fp-k2-A"})

    def test_04_same_event_same_version_changed_alias_conflicts(self):
        ledger = AliasLedger()
        ledger.write(event(), {"K1":"fp-k1-A"})
        with self.assertRaises(IntegrityConflict):
            ledger.write(event(), {"K1":"fp-k1-B"})

    def test_05_old_key_retirement_blocked_until_new_alias_coverage_and_retry_close(self):
        ledger = AliasLedger()
        ledger.write(event(), {"K1":"fp-k1-A"})
        self.assertFalse(ledger.retire_allowed("K1","K2",{"e1"},True))
        ledger.write(event(), {"K2":"fp-k2-A"})
        self.assertFalse(ledger.retire_allowed("K1","K2",{"e1"},False))
        self.assertTrue(ledger.retire_allowed("K1","K2",{"e1"},True))

    def test_06_exact_retry_is_idempotent_and_repairs_missing_alias(self):
        ledger = AliasLedger()
        ledger.write(event(), {"K1":"fp-k1-A"})
        ledger.write(event(), {"K1":"fp-k1-A","K2":"fp-k2-A"})
        self.assertEqual(len(ledger.events), 1)
        self.assertEqual(len(ledger.aliases), 2)

    def test_07_many_event_ids_may_share_same_dimension_fingerprint(self):
        ledger = AliasLedger()
        ledger.write(event("e1", occurred_at=1000), {"K1":"same-bucket"})
        ledger.write(event("e2", occurred_at=1001), {"K1":"same-bucket"})
        count, ids = ledger.count_union({("K1","device"):"same-bucket"})
        self.assertEqual((count, ids), (2, {"e1","e2"}))

    def test_08_partial_backfill_cannot_claim_complete_coverage(self):
        ledger = AliasLedger()
        ledger.write(event("e1"), {"K1":"old-1","K2":"new-1"})
        ledger.write(event("e2", occurred_at=1001), {"K1":"old-2"})
        self.assertFalse(ledger.coverage({"e1","e2"},"K2"))

    def test_09_cleanup_requires_all_horizons_and_removes_event_with_all_aliases(self):
        ledger = AliasLedger()
        ledger.write(event(), {"K1":"fp-k1-A","K2":"fp-k2-A"})
        self.assertFalse(ledger.cleanup_event("e1", True, False, True))
        self.assertIn("e1", ledger.events)
        self.assertTrue(ledger.cleanup_event("e1", True, True, True))
        self.assertNotIn("e1", ledger.events)
        self.assertFalse(any(k[0] == "e1" for k in ledger.aliases))

    def test_10_cleanup_preserves_events_inside_active_window(self):
        ledger = AliasLedger()
        ledger.write(event(), {"K1":"fp-k1-A"})
        self.assertFalse(ledger.cleanup_event("e1", True, True, False))
        self.assertIn("e1", ledger.events)

    def test_11_distinct_event_ids_in_both_versions_are_union_not_sum(self):
        ledger = AliasLedger()
        ledger.write(event("e1"), {"K1":"fp1","K2":"fp1-new"})
        ledger.write(event("e2", occurred_at=1001, dimension_ref="opaque-device-B"),
                     {"K1":"fp2","K2":"fp2-new"})
        count, ids = ledger.count_union({("K1","device"):"fp1",("K2","device"):"fp2-new"})
        self.assertEqual(count, 2)
        self.assertEqual(ids, {"e1","e2"})

if __name__ == "__main__":
    unittest.main()
