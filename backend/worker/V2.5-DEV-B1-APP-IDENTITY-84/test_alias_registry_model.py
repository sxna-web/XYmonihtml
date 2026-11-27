import unittest
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from alias_registry_model import AliasRegistry, IntegrityConflict, IncompleteKeyCoverage, UnsafeRetirement

def fps(a="fp-k1-A",b="fp-k2-A"): return {"K1":a,"K2":b}

class AliasRegistryConcurrencyTests(unittest.TestCase):
    def test_01_same_dimension_concurrent_dual_alias_resolve(self):
        r=AliasRegistry(); barrier=Barrier(12)
        def work(_):
            barrier.wait()
            return r.resolve_dimension("device",fps())
        with ThreadPoolExecutor(max_workers=12) as pool: ids=list(pool.map(work,range(12)))
        self.assertEqual(len(set(ids)),1); self.assertEqual(len(r.dimension_aliases),2)

    def test_02_k1_only_first_seen_during_overlap_fails_closed(self):
        with self.assertRaises(IncompleteKeyCoverage): AliasRegistry().resolve_dimension("device",{"K1":"fp1"})

    def test_03_k2_only_first_seen_during_overlap_fails_closed(self):
        with self.assertRaises(IncompleteKeyCoverage): AliasRegistry().resolve_dimension("device",{"K2":"fp2"})

    def test_04_aliases_resolving_to_two_dimension_ids_conflict(self):
        r=AliasRegistry(); r.dimension_aliases[("K1","device","a")]="dim-A"; r.dimension_aliases[("K2","device","b")]="dim-B"
        with self.assertRaises(IntegrityConflict): r.resolve_dimension("device",{"K1":"a","K2":"b"})

    def test_05_alias_cannot_be_reassigned(self):
        r=AliasRegistry(); r.dimension_aliases[("K1","device","a")]="dim-A"; r.dimension_aliases[("K2","device","c")]="dim-C"
        with self.assertRaises(IntegrityConflict): r.resolve_dimension("device",{"K1":"a","K2":"c"})

    def test_06_exact_event_retry_is_idempotent(self):
        r=AliasRegistry(); a=r.admit_event("e1","read","device",fps(),10,"w1","allow"); b=r.admit_event("e1","read","device",fps(),10,"w1","allow")
        self.assertEqual(a,b); self.assertEqual(len(r.events),1)

    def test_07_same_event_id_different_action_conflicts_without_partial_alias_write(self):
        r=AliasRegistry(); r.admit_event("e1","read","device",fps(),10,"w1","allow")
        before=dict(r.dimension_aliases)
        with self.assertRaises(IntegrityConflict): r.admit_event("e1","write","device",fps("new1","new2"),10,"w1","allow")
        self.assertEqual(r.dimension_aliases,before)

    def test_08_same_event_id_different_dimension_conflicts(self):
        r=AliasRegistry(); r.admit_event("e1","read","device",fps(),10,"w1","allow")
        with self.assertRaises(IntegrityConflict): r.admit_event("e1","read","device",fps("other1","other2"),10,"w1","allow")

    def test_09_event_union_deduplicates_two_key_aliases(self):
        r=AliasRegistry(); r.admit_event("e1","read","device",fps(),10,"w1","allow")
        self.assertEqual(r.count_union({("K1","device"):"fp-k1-A",("K2","device"):"fp-k2-A"}),(1,{"e1"}))

    def test_10_legacy_k1_history_is_bridged_to_k2_alias(self):
        r=AliasRegistry()
        r.import_legacy_event("old","read","device","K1","old-fp","dim-old",10,"w1","allow")
        r.backfill_event("old",{"K1":"old-fp","K2":"new-fp"})
        self.assertEqual(r.event_aliases[("old","K2","device")],"new-fp")
        self.assertEqual(r.dimension_aliases[("K2","device","new-fp")],"dim-old")

    def test_11_backfill_cannot_split_dimension_identity(self):
        r=AliasRegistry()
        r.import_legacy_event("old","read","device","K1","old-fp","dim-old",10,"w1","allow")
        with self.assertRaises(IntegrityConflict): r.backfill_event("old",{"K1":"old-fp","K2":"new-fp"})
        # If K2 alias was previously claimed by a different dimension, it is a hard conflict.
        r.dimension_aliases[("K2","device","new-fp")]="dim-other"
        with self.assertRaises(IntegrityConflict): r.backfill_event("old",{"K1":"old-fp","K2":"new-fp"})

    def test_12_partial_backfill_blocks_retirement(self):
        r=AliasRegistry()
        r.import_legacy_event("e1","read","device","K1","old-1","dim-1",10,"w","allow")
        r.import_legacy_event("e2","read","device","K1","old-2","dim-2",11,"w","allow")
        r.backfill_event("e1",{"K1":"old-1","K2":"new-1"})
        self.assertFalse(r.verify_backfill_coverage({"e1","e2"},"K2",True,True))

    def test_13_high_water_snapshot_and_late_event_catchup(self):
        r=AliasRegistry()
        r.import_legacy_event("e1","read","device","K1","old-1","dim-1",10,"w","allow")
        checkpoint=r.begin_backfill()
        self.assertEqual(checkpoint,1)
        r.backfill_event("e1",{"K1":"old-1","K2":"new-1"})
        r.import_legacy_event("e2","read","device","K1","old-2","dim-2",11,"w","allow")
        required=r.required_backfill_ids()
        self.assertEqual(required,{"e1","e2"})
        self.assertFalse(r.verify_backfill_coverage(required,"K2",True,True))
        r.backfill_event("e2",{"K1":"old-2","K2":"new-2"})
        self.assertTrue(r.verify_backfill_coverage(required,"K2",True,True))

    def test_14_late_retry_after_backfill_invalidates_coverage_until_repaired(self):
        r=AliasRegistry()
        r.import_legacy_event("e1","read","device","K1","old-1","dim-1",10,"w","allow")
        r.begin_backfill(); r.backfill_event("e1",{"K1":"old-1","K2":"new-1"})
        # A delayed old-version retry adds a new event after the snapshot.
        r.import_legacy_event("late","read","device","K1","old-late","dim-late",12,"w","allow")
        required=r.required_backfill_ids()
        self.assertFalse(r.verify_backfill_coverage(required,"K2",True,True))
        r.backfill_event("late",{"K1":"old-late","K2":"new-late"})
        self.assertTrue(r.verify_backfill_coverage(required,"K2",True,True))

    def test_15_retry_or_rollback_horizon_blocks_coverage(self):
        r=AliasRegistry(); r.import_legacy_event("e1","read","device","K1","old","dim",10,"w","allow")
        r.backfill_event("e1",{"K1":"old","K2":"new"})
        self.assertFalse(r.verify_backfill_coverage({"e1"},"K2",False,True))
        self.assertFalse(r.verify_backfill_coverage({"e1"},"K2",True,False))

    def test_16_cleanup_horizon_blocks_key_retirement(self):
        r=AliasRegistry(); r.import_legacy_event("e1","read","device","K1","old","dim",10,"w","allow")
        r.backfill_event("e1",{"K1":"old","K2":"new"})
        with self.assertRaises(UnsafeRetirement): r.retire_key("K1","K2",{"e1"},True,True,False)

    def test_17_key_retirement_after_all_proofs(self):
        r=AliasRegistry(); r.import_legacy_event("e1","read","device","K1","old","dim",10,"w","allow")
        r.backfill_event("e1",{"K1":"old","K2":"new"})
        self.assertEqual(r.retire_key("K1","K2",{"e1"},True,True,True),("K2",))

    def test_18_cleanup_inside_active_window_is_blocked(self):
        r=AliasRegistry(); r.admit_event("e1","read","device",fps(),10,"w","allow")
        self.assertFalse(r.cleanup_event("e1",True,True,False,True)); self.assertIn("e1",r.events)

    def test_19_cleanup_requires_retry_and_backfill(self):
        r=AliasRegistry(); r.admit_event("e1","read","device",fps(),10,"w","allow")
        self.assertFalse(r.cleanup_event("e1",True,False,True,True))
        self.assertFalse(r.cleanup_event("e1",True,True,True,False))
        self.assertTrue(r.cleanup_event("e1",True,True,True,True))

    def test_20_version_alias_not_part_of_logical_event_tuple(self):
        r=AliasRegistry(); event=r.admit_event("e1","read","device",fps(),10,"w","allow")
        self.assertEqual(event.dimension_id,r.dimension_aliases[("K1","device","fp-k1-A")])
        self.assertEqual(event.dimension_id,r.dimension_aliases[("K2","device","fp-k2-A")])

if __name__=="__main__": unittest.main()
