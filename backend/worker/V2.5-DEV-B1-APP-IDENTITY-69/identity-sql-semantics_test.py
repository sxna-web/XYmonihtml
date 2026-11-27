"""Batch 69 SQLite semantic fixture only; NOT a Cloudflare D1 adapter or migration."""
import sqlite3
import tempfile
import unittest
from pathlib import Path


DDL = """
PRAGMA foreign_keys=ON;
CREATE TABLE challenges(
 challenge_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, admin_user_id TEXT NOT NULL,
 code_version INTEGER NOT NULL, key_thumbprint TEXT NOT NULL, status TEXT NOT NULL,
 issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER
);
CREATE TABLE nonces(
 binding_id TEXT NOT NULL, nonce TEXT NOT NULL, device_id TEXT NOT NULL,
 consumed_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 PRIMARY KEY(binding_id, nonce)
);
CREATE TABLE bindings(
 binding_id TEXT PRIMARY KEY, admin_user_id TEXT NOT NULL, device_id TEXT NOT NULL,
 key_thumbprint TEXT NOT NULL, share_code_version INTEGER NOT NULL,
 status TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER,
 UNIQUE(admin_user_id, device_id)
);
CREATE TABLE share_codes(
 admin_user_id TEXT PRIMARY KEY, code_digest TEXT NOT NULL UNIQUE,
 code_version INTEGER NOT NULL, active INTEGER NOT NULL, rotated_at INTEGER
);
CREATE TABLE binding_audit(
 audit_id INTEGER PRIMARY KEY, binding_id TEXT NOT NULL, action TEXT NOT NULL,
 occurred_at INTEGER NOT NULL
);
"""


class SqlSemantics(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="starjump-migration-test-")
        self.db = Path(self.tmp.name) / "identity-fixture.sqlite"
        self.conn = sqlite3.connect(self.db, isolation_level=None, timeout=5)
        self.conn.executescript(DDL)

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def test_01_insert_challenge_and_duplicate_conflict(self):
        q = "INSERT INTO challenges VALUES(?,?,?,?,?,?,?,?,NULL)"
        row = ("ch1","device_001","adminA",1,"keyA","pending",100,200)
        self.conn.execute(q,row)
        with self.assertRaises(sqlite3.IntegrityError):
            self.conn.execute(q,row)

    def test_02_challenge_consume_is_conditional_and_single_use(self):
        self.conn.execute("INSERT INTO challenges VALUES(?,?,?,?,?,?,?,?,NULL)",
          ("ch1","device_001","adminA",1,"keyA","pending",100,200))
        sql = """UPDATE challenges SET status='consumed',consumed_at=150
          WHERE challenge_id=? AND status='pending' AND expires_at>?
          AND device_id=? AND admin_user_id=? AND code_version=? AND key_thumbprint=?"""
        cur = self.conn.execute(sql,("ch1",150,"device_001","adminA",1,"keyA"))
        self.assertEqual(cur.rowcount,1)
        cur = self.conn.execute(sql,("ch1",151,"device_001","adminA",1,"keyA"))
        self.assertEqual(cur.rowcount,0)

    def test_03_expired_or_context_mismatch_challenge_not_consumed(self):
        self.conn.execute("INSERT INTO challenges VALUES(?,?,?,?,?,?,?,?,NULL)",
          ("ch1","device_001","adminA",1,"keyA","pending",100,150))
        sql = """UPDATE challenges SET status='consumed',consumed_at=?
          WHERE challenge_id=? AND status='pending' AND expires_at>?
          AND device_id=? AND admin_user_id=? AND code_version=? AND key_thumbprint=?"""
        self.assertEqual(self.conn.execute(sql,(150,"ch1",150,"device_001","adminA",1,"keyA")).rowcount,0)
        self.assertEqual(self.conn.execute(sql,(140,"ch1",140,"device_001","adminB",1,"keyA")).rowcount,0)

    def test_04_nonce_unique_replay_and_expiry_cleanup(self):
        sql="INSERT INTO nonces VALUES(?,?,?,?,?) ON CONFLICT(binding_id,nonce) DO NOTHING"
        self.conn.execute(sql,("b1","n1","device_001",100,150))
        self.conn.execute(sql,("b1","n1","device_001",101,151))
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM nonces").fetchone()[0],1)
        self.conn.execute("DELETE FROM nonces WHERE expires_at<=?",(150,))
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM nonces").fetchone()[0],0)

    def test_05_binding_unique_idempotent_and_key_mismatch_does_not_overwrite(self):
        self.conn.execute("INSERT INTO bindings VALUES(?,?,?,?,?,?,?,NULL)",
          ("b1","adminA","device_001","keyA",1,"active",100))
        self.conn.execute("""INSERT INTO bindings VALUES(?,?,?,?,?,?,?,NULL)
          ON CONFLICT(admin_user_id,device_id) DO NOTHING""",
          ("b2","adminA","device_001","keyA",1,"active",101))
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM bindings").fetchone()[0],1)
        self.conn.execute("""INSERT INTO bindings VALUES(?,?,?,?,?,?,?,NULL)
          ON CONFLICT(admin_user_id,device_id) DO NOTHING""",
          ("b3","adminA","device_001","keyB",1,"active",102))
        self.assertEqual(self.conn.execute("SELECT key_thumbprint FROM bindings").fetchone()[0],"keyA")

    def test_06_revoked_binding_is_not_reactivated_and_owner_scoped(self):
        self.conn.execute("INSERT INTO bindings VALUES(?,?,?,?,?,?,?,NULL)",
          ("b1","adminA","device_001","keyA",1,"active",100))
        self.assertEqual(self.conn.execute("""UPDATE bindings SET status='revoked',revoked_at=200
          WHERE binding_id=? AND admin_user_id=? AND status='active'""",("b1","adminB")).rowcount,0)
        self.assertEqual(self.conn.execute("""UPDATE bindings SET status='revoked',revoked_at=200
          WHERE binding_id=? AND admin_user_id=? AND status='active'""",("b1","adminA")).rowcount,1)
        self.conn.execute("""INSERT INTO bindings VALUES(?,?,?,?,?,?,?,NULL)
          ON CONFLICT(admin_user_id,device_id) DO NOTHING""",
          ("b2","adminA","device_001","keyA",1,"active",201))
        self.assertEqual(self.conn.execute("SELECT status FROM bindings").fetchone()[0],"revoked")

    def test_07_share_code_compare_and_swap_only_one_version_wins(self):
        self.conn.execute("INSERT INTO share_codes VALUES(?,?,?,1,NULL)",("adminA","a"*64,1))
        sql="""UPDATE share_codes SET code_digest=?,code_version=code_version+1,rotated_at=200
          WHERE admin_user_id=? AND active=1 AND code_version=?"""
        self.assertEqual(self.conn.execute(sql,("b"*64,"adminA",1)).rowcount,1)
        self.assertEqual(self.conn.execute(sql,("c"*64,"adminA",1)).rowcount,0)
        row=self.conn.execute("SELECT code_digest,code_version FROM share_codes").fetchone()
        self.assertEqual(row,("b"*64,2))

    def test_08_owner_scoped_current_code_and_no_digest_to_client_contract(self):
        self.conn.execute("INSERT INTO share_codes VALUES(?,?,?,1,NULL)",("adminA","a"*64,1))
        row=self.conn.execute("SELECT admin_user_id,code_version,active FROM share_codes WHERE admin_user_id=? AND active=1",("adminA",)).fetchone()
        self.assertEqual(row,("adminA",1,1))
        self.assertEqual(len(row),3)

    def test_09_cleanup_is_bounded_to_transient_tables(self):
        self.conn.execute("INSERT INTO challenges VALUES(?,?,?,?,?,?,?,?,NULL)",("ch1","device_001","adminA",1,"keyA","pending",1,10))
        self.conn.execute("INSERT INTO nonces VALUES(?,?,?,?,?)",("b1","n1","device_001",1,10))
        self.conn.execute("INSERT INTO bindings VALUES(?,?,?,?,?,?,?,NULL)",("b1","adminA","device_001","keyA",1,"active",1))
        self.conn.execute("INSERT INTO binding_audit VALUES(1,'b1','created',1)")
        self.conn.execute("DELETE FROM challenges WHERE status='pending' AND expires_at<=?",(10,))
        self.conn.execute("DELETE FROM nonces WHERE expires_at<=?",(10,))
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM bindings").fetchone()[0],1)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM binding_audit").fetchone()[0],1)

    def test_10_transaction_batch_rollback_on_statement_failure(self):
        self.conn.execute("INSERT INTO share_codes VALUES(?,?,?,1,NULL)",("adminA","a"*64,1))
        self.conn.execute("BEGIN")
        self.conn.execute("UPDATE share_codes SET code_version=2 WHERE admin_user_id='adminA'")
        with self.assertRaises(sqlite3.IntegrityError):
            self.conn.execute("INSERT INTO share_codes VALUES(?,?,?,1,NULL)",("adminA","b"*64,1))
        self.conn.execute("ROLLBACK")
        self.assertEqual(self.conn.execute("SELECT code_version FROM share_codes").fetchone()[0],1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
