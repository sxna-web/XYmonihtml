"""Batch 74: disposable in-memory SQLite semantics only; not D1 or a migration."""
import sqlite3
import unittest

DDL = """
CREATE TABLE challenges(id TEXT PRIMARY KEY, owner TEXT NOT NULL, device TEXT NOT NULL,
 key TEXT NOT NULL, status TEXT NOT NULL, expires INTEGER NOT NULL,
 consumed_by TEXT);
CREATE TABLE bindings(id TEXT PRIMARY KEY, owner TEXT NOT NULL, device TEXT NOT NULL,
 key TEXT NOT NULL, status TEXT NOT NULL, generation INTEGER NOT NULL,
 created_by TEXT NOT NULL, UNIQUE(owner,device));
CREATE TABLE audit(event_key TEXT PRIMARY KEY, owner TEXT NOT NULL,
 target TEXT NOT NULL, payload TEXT NOT NULL);
CREATE TABLE operations(op_id TEXT PRIMARY KEY, owner TEXT NOT NULL,
 request TEXT NOT NULL, binding_id TEXT NOT NULL, kind TEXT NOT NULL,
 audit_key TEXT, audit_assert INTEGER NOT NULL CHECK(audit_assert=1));
CREATE TABLE codes(owner TEXT PRIMARY KEY, version INTEGER NOT NULL);
CREATE TABLE rate_events(event_id TEXT PRIMARY KEY, action TEXT NOT NULL,
 bucket TEXT NOT NULL, occurred_at INTEGER NOT NULL);
CREATE INDEX rate_idx ON rate_events(action,bucket,occurred_at);
"""

class Conflict(Exception): pass

def setup():
    c=sqlite3.connect(":memory:", isolation_level=None)
    c.executescript(DDL)
    c.execute("INSERT INTO challenges VALUES('ch1','adminA','device_001','keyA','pending',500,NULL)")
    return c

def bind(c, challenge="ch1", device="device_001", key="keyA",
         op="op1", bid="b1", event="binding.created:b1", skip_audit=False,
         fail_binding=False, fail_audit=False):
    request=f"adminA|{device}|{key}|{challenge}"
    payload=f"{bid}|adminA|{device}|{key}|created"
    try:
        c.execute("BEGIN IMMEDIATE")
        prior=c.execute("SELECT request,binding_id FROM operations WHERE op_id=?",(op,)).fetchone()
        if prior:
            c.execute("ROLLBACK")
            if prior[0]!=request: raise Conflict("same operation id, different payload")
            return {"kind":"replay","binding_id":prior[1]}
        cur=c.execute("""UPDATE challenges SET status='consumed',consumed_by=?
          WHERE id=? AND owner='adminA' AND device=? AND key=?
          AND status='pending' AND expires>150""",(op,challenge,device,key))
        if cur.rowcount!=1: raise Conflict("challenge unavailable")
        if fail_binding:
            c.execute("INSERT INTO bindings VALUES('dup','adminA',?,'keyA','active',1,?)",(device,op))
            c.execute("INSERT INTO bindings VALUES('dup','adminA',?,'keyA','active',1,?)",(device,op))
        old=c.execute("SELECT id,key,status FROM bindings WHERE owner='adminA' AND device=?",(device,)).fetchone()
        if old:
            if old[1]!=key or old[2]!="active": raise Conflict("binding mismatch/revoked")
            result_id,kind,audit_key=old[0],"existing",None
        else:
            c.execute("INSERT INTO bindings VALUES(?, 'adminA', ?, ?, 'active',1,?)",(bid,device,key,op))
            result_id,kind,audit_key=bid,"created",event
        if kind=="created" and not skip_audit:
            if fail_audit:
                c.execute("INSERT INTO audit VALUES(?,'adminA',?,?)",(event,bid,payload))
                c.execute("INSERT INTO audit VALUES(?,'adminA',?,?)",(event,bid,payload))
            c.execute("""INSERT INTO audit(event_key,owner,target,payload)
              SELECT ?, 'adminA', id, ? FROM bindings
              WHERE id=? AND owner='adminA' AND created_by=?
              ON CONFLICT(event_key) DO NOTHING""",(event,payload,bid,op))
        audit_ok=1 if kind=="existing" else int(c.execute(
            "SELECT 1 FROM audit WHERE event_key=? AND owner='adminA' AND target=? AND payload=?",
            (event,bid,payload)).fetchone() is not None)
        challenge_ok=int(c.execute(
            "SELECT 1 FROM challenges WHERE id=? AND status='consumed' AND consumed_by=?",
            (challenge,op)).fetchone() is not None)
        binding_ok=int(c.execute(
            "SELECT 1 FROM bindings WHERE id=? AND owner='adminA' AND device=? AND key=? AND status='active'",
            (result_id,device,key)).fetchone() is not None)
        assertion=int(audit_ok and challenge_ok and binding_ok)
        # The CHECK is the in-transaction assertion; failure rolls back all prior writes.
        c.execute("INSERT INTO operations VALUES(?,?,?,?,?,?,?)",
                  (op,"adminA",request,result_id,kind,audit_key,assertion))
        c.execute("COMMIT")
        return {"kind":kind,"binding_id":result_id}
    except Exception:
        if c.in_transaction: c.execute("ROLLBACK")
        raise

class AtomicFixtureTests(unittest.TestCase):
    def setUp(self): self.c=setup()
    def tearDown(self): self.c.close()

    def test_01_success_writes_binding_and_one_audit(self):
        self.assertEqual(bind(self.c)["kind"],"created")
        self.assertEqual(self.c.execute("SELECT COUNT(*) FROM audit").fetchone()[0],1)

    def test_02_binding_sql_error_rolls_challenge_back(self):
        with self.assertRaises(sqlite3.IntegrityError): bind(self.c,fail_binding=True)
        self.assertEqual(self.c.execute("SELECT status FROM challenges").fetchone()[0],"pending")
        self.assertEqual(self.c.execute("SELECT COUNT(*) FROM bindings").fetchone()[0],0)

    def test_03_audit_zero_row_check_rolls_back_everything(self):
        with self.assertRaises(sqlite3.IntegrityError): bind(self.c,skip_audit=True)
        self.assertEqual(self.c.execute("SELECT status FROM challenges").fetchone()[0],"pending")
        self.assertEqual(self.c.execute("SELECT COUNT(*) FROM bindings").fetchone()[0],0)
        self.assertEqual(self.c.execute("SELECT COUNT(*) FROM operations").fetchone()[0],0)

    def test_04_audit_sql_error_rolls_back_everything(self):
        with self.assertRaises(sqlite3.IntegrityError): bind(self.c,fail_audit=True)
        self.assertEqual(self.c.execute("SELECT status FROM challenges").fetchone()[0],"pending")

    def test_05_same_operation_same_payload_replays(self):
        first=bind(self.c); retry=bind(self.c)
        self.assertEqual(first["binding_id"],retry["binding_id"])
        self.assertEqual(retry["kind"],"replay")
        self.assertEqual(self.c.execute("SELECT COUNT(*) FROM audit").fetchone()[0],1)

    def test_06_same_operation_different_payload_conflicts(self):
        bind(self.c)
        with self.assertRaises(Conflict): bind(self.c,key="keyB")
        self.assertEqual(self.c.execute("SELECT COUNT(*) FROM bindings").fetchone()[0],1)

    def test_07_timeout_after_commit_then_retry_resolves(self):
        first=bind(self.c)
        with self.assertRaises(TimeoutError): raise TimeoutError("simulated lost response after commit")
        retry=bind(self.c)
        self.assertEqual(first["binding_id"],retry["binding_id"])
        self.assertEqual(retry["kind"],"replay")
        self.assertEqual(self.c.execute("SELECT COUNT(*) FROM audit").fetchone()[0],1)

    def test_08_existing_same_binding_does_not_emit_created_audit(self):
        self.c.execute("INSERT INTO bindings VALUES('old','adminA','device_001','keyA','active',1,'prior')")
        self.assertEqual(bind(self.c)["kind"],"existing")
        self.assertEqual(self.c.execute("SELECT COUNT(*) FROM audit").fetchone()[0],0)

    def test_09_revoke_generation_cas(self):
        self.c.execute("INSERT INTO bindings VALUES('b','adminA','device_001','keyA','active',4,'old')")
        sql="""UPDATE bindings SET status='revoked',generation=generation+1
          WHERE id='b' AND owner='adminA' AND status='active' AND generation=4"""
        self.assertEqual(self.c.execute(sql).rowcount,1)
        self.assertEqual(self.c.execute(sql).rowcount,0)
        self.assertEqual(self.c.execute("SELECT generation FROM bindings").fetchone()[0],5)

    def test_10_share_code_version_cas(self):
        self.c.execute("INSERT INTO codes VALUES('adminA',7)")
        sql="UPDATE codes SET version=version+1 WHERE owner='adminA' AND version=7"
        self.assertEqual(self.c.execute(sql).rowcount,1)
        self.assertEqual(self.c.execute(sql).rowcount,0)
        self.assertEqual(self.c.execute("SELECT version FROM codes").fetchone()[0],8)

    def test_11_limiter_window_and_retry_after(self):
        self.c.executemany("INSERT INTO rate_events VALUES(?,?,?,?)",
            [("e1","bind","net",1000),("e2","bind","net",1010),
             ("e3","bind","net",1020),("e4","bind","net",1060)])
        now,window=1060,60
        rows=self.c.execute("""SELECT occurred_at FROM rate_events
          WHERE action='bind' AND bucket='net' AND occurred_at>=? AND occurred_at<?
          ORDER BY occurred_at""",(now-window,now)).fetchall()
        self.assertEqual(len(rows),3)  # left edge included; now excluded
        release=rows[1][0]+window
        self.assertEqual(release,1070)
        self.assertEqual(max(1,(release-now+999)//1000),1)

    def test_12_same_event_key_different_payload_rolls_back(self):
        bind(self.c)
        self.c.execute("INSERT INTO challenges VALUES('ch2','adminA','device_002','keyA','pending',500,NULL)")
        with self.assertRaises(sqlite3.IntegrityError):
            bind(self.c,challenge="ch2",device="device_002",op="op2",bid="b2",event="binding.created:b1")
        self.assertEqual(self.c.execute("SELECT status FROM challenges WHERE id='ch2'").fetchone()[0],"pending")
        self.assertEqual(self.c.execute("SELECT COUNT(*) FROM bindings").fetchone()[0],1)

if __name__=="__main__": unittest.main(verbosity=2)
