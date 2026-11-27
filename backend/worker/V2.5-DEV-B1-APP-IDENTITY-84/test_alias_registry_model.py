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
        with ThreadPoolExecutor(max_workers=12) as pool:
            ids=list(pool.map(work,range(12)))
        self.assertEqual(len(set(ids)),1)
        self.assertEqual(len(r.dimension_aliases),2)

    def test_02_k1_only_first_seen_during_overlap_fails_closed(self):
        with self.assertRaises(IncompleteKeyCoverage):
            AliasRegistry().resolve_dimension("device",{"K1":"fp1"})

    def test_03_k2_only_first_seen_during_overlap_fails_closed(self):
        with self.assertRaises(IncompleteKeyCoverage):
            AliasRegistry().resolve_dimension("device",{"K2":"fp2"})

    def test_04_aliases_resolving_to_two_dimension_ids_conflict(self):
        r=AliasRegistry()
        r.dimension_aliases[("K1","device","a")]="dim-A"
        r.dimension_aliases[("K2","device","b")]="dim-B"
        with self.assertRaises(IntegrityConflict):
            r.resolve_dimension("device",{"K1":"a","K2":"b"})

    def test_05_alias_cannot_be_reassigned(self):
        r=AliasRegistry()
        r.dimension_aliases[("K1","device","a")]="dim-A"
        r.dimension_aliases[("K2","device","c")]="dim-C"
        with self.assertRaises(IntegrityConflict):
            r.resolve_dimension("device",{"K1":"a","K2":"c"})

    def test_06_exact_event_retry_is_idempotent(self):
        r=AliasRegistry()
        a=r.admit_event("e1","read","device",fps(),10,"w1","allow")
        b=r.admit_event("e1","read","device",fps(),10,"w1","allow")
        self.assertEqual(a,b); self.assertEqual(len(r.events),1)

    def test_07_same_event_id_different_action_conflicts(self):
        r=AliasRegistry(); r.admit_event("e1","read","device",fps(),10,"w1","allow")
        with self.assertRaises(IntegrityConflict):
            r.admit_event("e1","write","device",fps(),10,"w1","allow")

    def test_08_same_event_id_different_dimension_conflicts(self):
        r=AliasRegistry(); r.admit_event("e1","read","device",fps(),10,"w1","allow")
        with self.assertRaises(IntegrityConflict):
            r.admit_event("e1","read","device",fps("other1","other2"),10,"w1","allow")

    def test_09_event_union_deduplicates_two_key_aliases(self):
        r=AliasRegistry(); r.admit_event("e1","read","device",fps(),10,"w1","allow")
        count,ids=r.count_union({("K1","device"):"fp-k1-A",("K2","device"):"fp-k2-A"})
        self.assertEqual((count,ids),(1,{"e1"}))

    def test_10_missing_new_key_alias_blocks_coverage(self):
        r=AliasRegistry(); r.admit_event("e1","read","device",fps(),10,"w1","allow")
        r.event_aliases.pop(("e1","K2","device")); r.mark_backfilled("e1")
        self.assertFalse(r.verify_backfill_coverage({"e1"},"K2",True,True))

    def test_11_partial_backfill_blocks_retirement(self):
        r=AliasRegistry()
        r.admit_event("e1","read","device",fps(),10,"w1","allow")
        r.admit_event("e2","read","device",fps("a2","b2"),11,"w1","allow")
        r.mark_backfilled("e1")
        self.assertFalse(r.verify_backfill_coverage({"e1","e2"},"K2",True,True))

    def test_12_retry_or_rollback_horizon_blocks_coverage(self):
        r=AliasRegistry(); r.admit_event("e1","read","device",fps(),10,"w1","allow"); r.mark_backfilled("e1")
        self.assertFalse(r.verify_backfill_coverage({"e1"},"K2",False,True))
        self.assertFalse(r.verify_backfill_coverage({"e1"},"K2",True,False))

    def test_13_cleanup_horizon_blocks_key_retirement(self):
        r=AliasRegistry(); r.admit_event("e1","read","device",fps(),10,"w1","allow"); r.mark_backfilled("e1")
        with self.assertRaises(UnsafeRetirement):
            r.retire_key("K1","K2",{"e1"},True,True,False)

    def test_14_key_retirement_after_all_proofs(self):
        r=AliasRegistry(); r.admit_event("e1","read","device",fps(),10,"w1","allow"); r.mark_backfilled("e1")
        self.assertEqual(r.retire_key("K1","K2",{"e1"},True,True,True),("K2",))

    def test_15_cleanup_inside_active_window_is_blocked(self):
        r=AliasRegistry(); r.admit_event("e1","read","device",fps(),10,"w1","allow")
        self.assertFalse(r.cleanup_event("e1",True,True,False,True))
        self.assertIn("e1",r.events)

    def test_16_cleanup_requires_retry_and_backfill(self):
        r=AliasRegistry(); r.admit_event("e1","read","device",fps(),10,"w1","allow")
        self.assertFalse(r.cleanup_event("e1",True,False,True,True))
        self.assertFalse(r.cleanup_event("e1",True,True,True,False))
        self.assertTrue(r.cleanup_event("e1",True,True,True,True))

    def test_17_rollback_cannot_silently_use_retired_key(self):
        r=AliasRegistry(); r.admit_event("e1","read","device",fps(),10,"w1","allow"); r.mark_backfilled("e1")
        r.retire_key("K1","K2",{"e1"},True,True,True)
        with self.assertRaises(IncompleteKeyCoverage):
            r.resolve_dimension("device",fps())

    def test_18_version_alias_not_in_logical_event_tuple(self):
        r=AliasRegistry(); event=r.admit_event("e1","read","device",fps(),10,"w1","allow")
        self.assertEqual(event.dimension_id,r.dimension_aliases[("K1","device","fp-k1-A")])
        self.assertEqual(event.dimension_id,r.dimension_aliases[("K2","device","fp-k2-A")])

    def test_19_new_event_ids_union_not_sum(self):
        r=AliasRegistry()
        r.admit_event("e1","read","device",fps("a1","b1"),10,"w1","allow")
        r.admit_event("e2","read","device",fps("a2","b2"),11,"w1","allow")
        count,ids=r.count_union({("K1","device"):"a1",("K2","device"):"b2"})
        self.assertEqual((count,ids),(2,{"e1","e2"}))

    def test_20_same_fingerprint_collision_maps_to_single_dimension(self):
        r=AliasRegistry()
        first=r.resolve_dimension("device",{"K1":"same","K2":"same2"})
        second=r.resolve_dimension("device",{"K1":"same","K2":"other"})
        self.assertEqual(first,second)

if __name__=="__main__": unittest.main()
