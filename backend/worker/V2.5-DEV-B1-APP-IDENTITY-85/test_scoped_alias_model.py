import unittest
from scoped_alias_model import ScopedAliasRegistry, Scope, IntegrityConflict, IncompleteKeyCoverage, ActiveKeySetDrift

def fps(a="a1", b="b1"): return {"K1": a, "K2": b}

class ScopedAliasTests(unittest.TestCase):
    def setUp(self):
        self.r = ScopedAliasRegistry()
        self.a = Scope("tenant-1", "admin-1", "device")
        self.b = Scope("tenant-1", "admin-2", "device")
        self.c = Scope("tenant-1", "admin-1", "ip")

    def test_owner_scope_prevents_alias_merge(self):
        x = self.r.admit(self.a, "e1", "hit", fps(), 1, "w", "allow")
        y = self.r.admit(self.b, "e1", "hit", fps(), 1, "w", "allow")
        self.assertNotEqual(x.dimension_id, y.dimension_id)

    def test_dimension_type_scope_prevents_alias_merge(self):
        x = self.r.admit(self.a, "e1", "hit", fps(), 1, "w", "allow")
        y = self.r.admit(self.c, "e1", "hit", fps(), 1, "w", "allow")
        self.assertNotEqual(x.dimension_id, y.dimension_id)

    def test_tenant_scope_prevents_alias_merge(self):
        other = Scope("tenant-2", "admin-1", "device")
        x = self.r.admit(self.a, "e1", "hit", fps(), 1, "w", "allow")
        y = self.r.admit(other, "e1", "hit", fps(), 1, "w", "allow")
        self.assertNotEqual(x.dimension_id, y.dimension_id)

    def test_event_id_is_owner_scoped_but_tuple_immutable(self):
        self.r.admit(self.a, "same", "hit", fps(), 1, "w", "allow")
        self.r.admit(self.b, "same", "hit", fps(), 1, "w", "allow")
        with self.assertRaises(IntegrityConflict):
            self.r.admit(self.a, "same", "miss", fps(), 1, "w", "allow")

    def test_active_key_set_and_epoch_drift_rejected(self):
        with self.assertRaises(ActiveKeySetDrift):
            self.r.admit(self.a, "e1", "hit", fps(), 1, "w", "allow",
                         versions=("K1",), epoch="cfg-1")
        self.r.set_writer_config(("K1", "K2", "K3"), "cfg-2")
        with self.assertRaises(ActiveKeySetDrift):
            self.r.admit(self.a, "e1", "hit", {"K1":"a","K2":"b"}, 1, "w", "allow",
                         versions=("K1","K2"), epoch="cfg-1")

    def test_missing_active_alias_rejected(self):
        with self.assertRaises(IncompleteKeyCoverage):
            self.r.admit(self.a, "e1", "hit", {"K1":"a"}, 1, "w", "allow")

    def test_split_alias_conflict_has_no_partial_event(self):
        self.r.aliases[("tenant-1","admin-1","device","K1","a1")] = "dim-A"
        self.r.aliases[("tenant-1","admin-1","device","K2","b1")] = "dim-B"
        before = dict(self.r.aliases)
        with self.assertRaises(IntegrityConflict):
            self.r.admit(self.a, "e1", "hit", fps(), 1, "w", "allow")
        self.assertEqual(before, self.r.aliases)
        self.assertEqual({}, self.r.events)

    def test_event_cleanup_keeps_dimension_alias_reserved(self):
        event = self.r.admit(self.a, "e1", "hit", fps(), 1, "w", "allow")
        self.assertFalse(self.r.cleanup_event(self.a, "e1", True, False, True, True))
        self.assertTrue(self.r.cleanup_event(self.a, "e1", True, True, True, True))
        self.assertIn(("tenant-1","admin-1","device","K1","a1"), self.r.aliases)
        self.assertNotIn(("tenant-1","admin-1","e1"), self.r.events)
        self.assertEqual(set(), self.r.references.get(event.dimension_id, set()))

if __name__ == "__main__": unittest.main()
