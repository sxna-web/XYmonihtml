"""Batch 75: disposable SQLite semantics only; synthetic schema, not D1/migration."""
import sqlite3
import unittest

DDL = """
CREATE TABLE bindings(binding_id TEXT PRIMARY KEY, owner TEXT NOT NULL, device TEXT NOT NULL,
 key_thumb TEXT NOT NULL, status TEXT NOT NULL, generation INTEGER NOT NULL, UNIQUE(owner,device));
CREATE TABLE share_codes(owner TEXT PRIMARY KEY, code_record TEXT NOT NULL, version INTEGER NOT NULL, status TEXT NOT NULL);
CREATE TABLE audit(event_key TEXT PRIMARY KEY, event_type TEXT NOT NULL, owner TEXT NOT NULL,
 target TEXT NOT NULL, operation_id TEXT NOT NULL, payload TEXT NOT NULL);
CREATE TABLE operations(operation_id TEXT PRIMARY KEY, owner TEXT NOT NULL, operation_type TEXT NOT NULL,
 request_hash TEXT NOT NULL, result_id TEXT NOT NULL, result_version INTEGER, audit_event_key TEXT NOT NULL,
 audit_assert INTEGER NOT NULL CHECK(audit_assert=1));
CREATE TABLE rate_events(event_id TEXT PRIMARY KEY, action TEXT NOT NULL, network_bucket TEXT NOT NULL,
 device_bucket TEXT, admin_bucket TEXT, occurred_at INTEGER NOT NULL, retain_until INTEGER NOT NULL,
 request_fingerprint TEXT NOT NULL);
CREATE INDEX rate_network_idx ON rate_events(action,network_bucket,occurred_at);
CREATE INDEX rate_device_idx ON rate_events(action,device_bucket,occurred_at);
CREATE INDEX rate_admin_idx ON rate_events(action,admin_bucket,occurred_at);
CREATE INDEX rate_cleanup_idx ON rate_events(retain_until);
"""

class Conflict(Exception): pass
class NotFound(Exception): pass
class RateLimited(Exception):
    def __init__(self, retry_at): self.retry_at = retry_at

def db():
    c=sqlite3.connect(":memory:",isolation_level=None); c.executescript(DDL)
    c.execute("INSERT INTO bindings VALUES('b1','ownerA','deviceA','thumbA','active',3)")
    c.execute("INSERT INTO share_codes VALUES('ownerA','code-row-A',7,'active')")
    return c

def receipt(c,op,owner,kind,request):
    row=c.execute("SELECT owner,operation_type,request_hash,result_id,result_version,audit_event_key FROM operations WHERE operation_id=?",(op,)).fetchone()
    if not row: return None
    if row[0]!=owner: raise NotFound("operation not found")
    if row[1]!=kind or row[2]!=request: raise Conflict("operation id reused with different request")
    return {"kind":"replay","result_id":row[3],"version":row[4],"event_key":row[5]}

def write_audit(c,key,event_type,owner,target,op,payload,mode="normal"):
    if mode=="missing": return
    if mode=="mismatch": payload += "|tampered"
    c.execute("INSERT INTO audit VALUES(?,?,?,?,?,?) ON CONFLICT(event_key) DO NOTHING",
              (key,event_type,owner,target,op,payload))

def audit_exact(c,key,event_type,owner,target,op,payload):
    return c.execute("SELECT 1 FROM audit WHERE event_key=? AND event_type=? AND owner=? AND target=? AND operation_id=? AND payload=?",
                     (key,event_type,owner,target,op,payload)).fetchone() is not None

def create_binding(c,owner="ownerA",op="create-1",request="ownerA|deviceB|thumbB",
                   binding="b2",event="binding.created:b2",audit_mode="normal"):
    c.execute("BEGIN IMMEDIATE")
    try:
        prior=receipt(c,op,owner,"binding.create",request)
        if prior: c.execute("COMMIT"); return prior
        old=c.execute("SELECT binding_id,key_thumb,status FROM bindings WHERE owner=? AND device='deviceB'",(owner,)).fetchone()
        if old:
            if old[1]!="thumbB" or old[2]!="active": raise Conflict("binding conflict")
            raise Conflict("pre-existing binding resolution is outside this fixture")
        c.execute("INSERT INTO bindings VALUES(?,?,'deviceB','thumbB','active',1)",(binding,owner))
        payload=f"{binding}|{owner}|deviceB|thumbB|1|created"
        write_audit(c,event,"binding.created",owner,binding,op,payload,audit_mode)
        ok=int(audit_exact(c,event,"binding.created",owner,binding,op,payload) and
               c.execute("SELECT 1 FROM bindings WHERE binding_id=? AND owner=? AND device='deviceB' AND key_thumb='thumbB' AND status='active' AND generation=1",(binding,owner)).fetchone() is not None)
        c.execute("INSERT INTO operations VALUES(?,?, 'binding.create', ?, ?, NULL, ?, ?)",(op,owner,request,binding,event,ok))
        c.execute("COMMIT"); return {"kind":"created","result_id":binding,"version":None,"event_key":event}
    except Exception:
        if c.in_transaction: c.execute("ROLLBACK")
        raise

def revoke_binding(c,owner="ownerA",op="revoke-1",request="b1|3|admin-request",
                   event="binding.revoked:b1:4",audit_mode="normal"):
    c.execute("BEGIN IMMEDIATE")
    try:
        prior=receipt(c,op,owner,"binding.revoke",request)
        if prior: c.execute("COMMIT"); return prior
        cur=c.execute("UPDATE bindings SET status='revoked',generation=generation+1 WHERE binding_id='b1' AND owner=? AND status='active' AND generation=3",(owner,))
        if cur.rowcount!=1: raise Conflict("binding state conflict")
        payload="b1|ownerA|active|revoked|3|4|admin-request"
        write_audit(c,event,"binding.revoked",owner,"b1",op,payload,audit_mode)
        ok=int(audit_exact(c,event,"binding.revoked",owner,"b1",op,payload) and
               c.execute("SELECT 1 FROM bindings WHERE binding_id='b1' AND owner=? AND status='revoked' AND generation=4",(owner,)).fetchone() is not None)
        c.execute("INSERT INTO operations VALUES(?,?, 'binding.revoke', ?, 'b1', 4, ?, ?)",(op,owner,request,event,ok))
        c.execute("COMMIT"); return {"kind":"revoked","result_id":"b1","version":4,"event_key":event}
    except Exception:
        if c.in_transaction: c.execute("ROLLBACK")
        raise

def rotate_code(c,owner="ownerA",op="rotate-1",request="code-row-A|7|rotate",
                event="share_code.rotated:ownerA:8",audit_mode="normal"):
    c.execute("BEGIN IMMEDIATE")
    try:
        prior=receipt(c,op,owner,"share_code.rotate",request)
        if prior: c.execute("COMMIT"); return prior
        cur=c.execute("UPDATE share_codes SET version=version+1 WHERE owner=? AND code_record='code-row-A' AND status='active' AND version=7",(owner,))
        if cur.rowcount!=1: raise Conflict("share-code version conflict")
        payload="ownerA|code-row-A|7|8|rotate-1"
        write_audit(c,event,"share_code.rotated",owner,"code-row-A",op,payload,audit_mode)
        ok=int(audit_exact(c,event,"share_code.rotated",owner,"code-row-A",op,payload) and
               c.execute("SELECT 1 FROM share_codes WHERE owner=? AND code_record='code-row-A' AND status='active' AND version=8",(owner,)).fetchone() is not None)
        c.execute("INSERT INTO operations VALUES(?,?, 'share_code.rotate', ?, 'code-row-A', 8, ?, ?)",(op,owner,request,event,ok))
        c.execute("COMMIT"); return {"kind":"rotated","result_id":"code-row-A","version":8,"event_key":event}
    except Exception:
        if c.in_transaction: c.execute("ROLLBACK")
        raise

def admit(c,event_id,action="binding.create",network="netA",device="devA",admin="admA",
          now=1000,window=60,limit=3,fingerprint="same-request",required=("network","device","admin")):
    dims={"network":network,"device":device,"admin":admin}
    if any(not dims[d] for d in required): raise ValueError("required limiter dimension missing")
    c.execute("BEGIN IMMEDIATE")
    try:
        prior=c.execute("SELECT action,network_bucket,device_bucket,admin_bucket,request_fingerprint FROM rate_events WHERE event_id=?",(event_id,)).fetchone()
        expected=(action,network,device,admin,fingerprint)
        if prior:
            if prior!=expected: raise Conflict("rate event id reused with different dimensions/payload")
            c.execute("COMMIT"); return {"kind":"replay","admitted":True,"retry_at":None}
        releases=[]
        for dim,value in dims.items():
            if dim not in required: continue
            rows=c.execute(f"SELECT occurred_at FROM rate_events WHERE action=? AND {dim}_bucket=? AND occurred_at>=? AND occurred_at<? ORDER BY occurred_at",
                           (action,value,now-window,now)).fetchall()
            if len(rows)>=limit:
                # Inclusive left edge: integer-second release is oldest + window + 1.
                releases.append(rows[len(rows)-limit][0]+window+1)
        if releases:
            c.execute("ROLLBACK"); raise RateLimited(max(releases))
        c.execute("INSERT INTO rate_events VALUES(?,?,?,?,?,?,?,?)",
                  (event_id,action,network,device,admin,now,now+window,fingerprint))
        c.execute("COMMIT"); return {"kind":"admitted","admitted":True,"retry_at":None}
    except Exception:
        if c.in_transaction: c.execute("ROLLBACK")
        raise

def cleanup(c,now):
    return c.execute("DELETE FROM rate_events WHERE retain_until < ?",(now,)).rowcount

def conflicting_audit_attempt(c):
    c.execute("BEGIN IMMEDIATE")
    try:
        write_audit(c,"binding.created:b2","binding.created","ownerA","b3","create-2","different")
        ok=int(audit_exact(c,"binding.created:b2","binding.created","ownerA","b3","create-2","different"))
        c.execute("INSERT INTO operations VALUES('create-2','ownerA','binding.create','different','b3',NULL,'binding.created:b2',?)",(ok,))
        c.execute("COMMIT")
    except Exception:
        if c.in_transaction: c.execute("ROLLBACK")
        raise

class IdentityOperationTests(unittest.TestCase):
    def setUp(self): self.c=db()
    def tearDown(self): self.c.close()
    def test_01_create_success_receipt_and_audit(self):
        self.assertEqual(create_binding(self.c)["kind"],"created")
        self.assertEqual(self.c.execute("SELECT COUNT(*) FROM audit").fetchone()[0],1)
        self.assertEqual(self.c.execute("SELECT COUNT(*) FROM operations").fetchone()[0],1)
    def test_02_create_missing_audit_rolls_back(self):
        with self.assertRaises(sqlite3.IntegrityError): create_binding(self.c,audit_mode="missing")
        self.assertIsNone(self.c.execute("SELECT 1 FROM bindings WHERE binding_id='b2'").fetchone())
        self.assertEqual(self.c.execute("SELECT COUNT(*) FROM operations").fetchone()[0],0)
    def test_03_create_mismatched_audit_rolls_back(self):
        with self.assertRaises(sqlite3.IntegrityError): create_binding(self.c,audit_mode="mismatch")
        self.assertEqual(self.c.execute("SELECT COUNT(*) FROM bindings WHERE binding_id='b2'").fetchone()[0],0)
    def test_04_revoke_success_increments_once(self):
        self.assertEqual(revoke_binding(self.c)["version"],4)
        self.assertEqual(self.c.execute("SELECT status,generation FROM bindings WHERE binding_id='b1'").fetchone(),("revoked",4))
    def test_05_revoke_missing_audit_rolls_back(self):
        with self.assertRaises(sqlite3.IntegrityError): revoke_binding(self.c,audit_mode="missing")
        self.assertEqual(self.c.execute("SELECT status,generation FROM bindings WHERE binding_id='b1'").fetchone(),("active",3))
        self.assertEqual(self.c.execute("SELECT COUNT(*) FROM operations").fetchone()[0],0)
    def test_06_revoke_mismatched_audit_rolls_back(self):
        with self.assertRaises(sqlite3.IntegrityError): revoke_binding(self.c,audit_mode="mismatch")
        self.assertEqual(self.c.execute("SELECT status,generation FROM bindings WHERE binding_id='b1'").fetchone(),("active",3))
    def test_07_revoke_retry_returns_receipt_without_second_audit(self):
        first=revoke_binding(self.c); retry=revoke_binding(self.c)
        self.assertEqual(retry["kind"],"replay"); self.assertEqual(first["version"],retry["version"])
        self.assertEqual(self.c.execute("SELECT COUNT(*) FROM audit").fetchone()[0],1)
    def test_08_revoke_stale_generation_conflicts(self):
        revoke_binding(self.c)
        with self.assertRaises(Conflict): revoke_binding(self.c,op="revoke-2",request="b1|3|again")
    def test_09_rotation_success_and_exact_audit(self):
        self.assertEqual(rotate_code(self.c)["version"],8)
        self.assertEqual(self.c.execute("SELECT version FROM share_codes").fetchone()[0],8)
    def test_10_rotation_missing_audit_rolls_back(self):
        with self.assertRaises(sqlite3.IntegrityError): rotate_code(self.c,audit_mode="missing")
        self.assertEqual(self.c.execute("SELECT version FROM share_codes").fetchone()[0],7)
        self.assertEqual(self.c.execute("SELECT COUNT(*) FROM operations").fetchone()[0],0)
    def test_11_rotation_mismatched_audit_rolls_back(self):
        with self.assertRaises(sqlite3.IntegrityError): rotate_code(self.c,audit_mode="mismatch")
        self.assertEqual(self.c.execute("SELECT version FROM share_codes").fetchone()[0],7)
    def test_12_rotation_retry_is_idempotent(self):
        rotate_code(self.c); self.assertEqual(rotate_code(self.c)["kind"],"replay")
        self.assertEqual(self.c.execute("SELECT COUNT(*) FROM audit").fetchone()[0],1)
    def test_13_same_event_key_same_payload_is_exact_replay(self):
        create_binding(self.c)
        self.assertTrue(audit_exact(self.c,"binding.created:b2","binding.created","ownerA","b2","create-1","b2|ownerA|deviceB|thumbB|1|created"))
        self.assertEqual(self.c.execute("SELECT COUNT(*) FROM audit WHERE event_key='binding.created:b2'").fetchone()[0],1)
    def test_14_same_event_key_different_payload_fails_assertion_and_rolls_back(self):
        create_binding(self.c); self.c.execute("INSERT INTO bindings VALUES('b3','ownerA','deviceC','thumbC','active',1)")
        with self.assertRaises(sqlite3.IntegrityError): conflicting_audit_attempt(self.c)
        self.assertIsNone(self.c.execute("SELECT 1 FROM operations WHERE operation_id='create-2'").fetchone())
        self.assertEqual(self.c.execute("SELECT target,payload FROM audit WHERE event_key='binding.created:b2'").fetchone(),
                         ("b2","b2|ownerA|deviceB|thumbB|1|created"))
    def test_15_operation_receipt_is_owner_scoped(self):
        create_binding(self.c)
        with self.assertRaises(NotFound): receipt(self.c,"create-1","ownerB","binding.create","ownerA|deviceB|thumbB")
        self.assertEqual(self.c.execute("SELECT COUNT(*) FROM operations").fetchone()[0],1)
    def test_16_same_operation_id_different_payload_conflicts(self):
        create_binding(self.c)
        with self.assertRaises(Conflict): create_binding(self.c,request="ownerA|deviceB|thumbChanged")
    def test_17_limiter_duplicate_event_id_same_payload_replays(self):
        self.assertEqual(admit(self.c,"r1")["kind"],"admitted")
        self.assertEqual(admit(self.c,"r1")["kind"],"replay")
        self.assertEqual(self.c.execute("SELECT COUNT(*) FROM rate_events").fetchone()[0],1)
    def test_18_limiter_duplicate_event_id_different_payload_conflicts(self):
        admit(self.c,"r1")
        with self.assertRaises(Conflict): admit(self.c,"r1",device="devB")
        self.assertEqual(self.c.execute("SELECT COUNT(*) FROM rate_events").fetchone()[0],1)
    def test_19_limiter_rejects_missing_required_dimension(self):
        with self.assertRaises(ValueError): admit(self.c,"r1",device=None)
        self.assertEqual(self.c.execute("SELECT COUNT(*) FROM rate_events").fetchone()[0],0)
    def test_20_limiter_retry_after_uses_latest_release_across_dimensions(self):
        for i,t in enumerate((1000,1010,1020)):
            admit(self.c,f"n{i}",network="netX",device=f"d{i}",admin=f"a{i}",now=t,limit=3)
        for i,t in enumerate((1030,1040,1050)):
            admit(self.c,f"d{i}",network=f"net{i}",device="deviceX",admin=f"x{i}",now=t,limit=3)
        with self.assertRaises(RateLimited) as ctx:
            admit(self.c,"blocked",network="netX",device="deviceX",admin="newAdmin",now=1060,limit=3)
        self.assertEqual(ctx.exception.retry_at,1091)  # max(network 1081, device 1091)
    def test_21_limiter_half_open_window_boundary(self):
        for i,t in enumerate((940,950,960)):
            admit(self.c,f"w{i}",network="netW",device=f"w{i}",admin=f"wa{i}",now=t,limit=3)
        with self.assertRaises(RateLimited): admit(self.c,"w4",network="netW",now=1000,limit=3)
        self.assertEqual(admit(self.c,"w5",network="netW",now=1001,limit=3)["kind"],"admitted")
    def test_22_cleanup_preserves_exact_retention_boundary(self):
        admit(self.c,"clean",now=1000)
        self.assertEqual(cleanup(self.c,1060),0); self.assertEqual(cleanup(self.c,1061),1)
    def test_23_cleanup_does_not_delete_active_window_event(self):
        admit(self.c,"active",now=1000,window=300)
        self.assertEqual(cleanup(self.c,1100),0)
        self.assertEqual(self.c.execute("SELECT COUNT(*) FROM rate_events").fetchone()[0],1)
    def test_24_cleanup_is_idempotent(self):
        admit(self.c,"expired",now=1000)
        self.assertEqual(cleanup(self.c,1061),1); self.assertEqual(cleanup(self.c,1062),0)

if __name__=="__main__": unittest.main(verbosity=2)
