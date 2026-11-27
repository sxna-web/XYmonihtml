from __future__ import annotations
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import runner
from checksum import sha256_bytes
from schema_diff import fingerprint, schema_snapshot

class MigrationRunnerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="starjump-migration-test-")
        self.db = Path(self.tmp.name) / "fixture.sqlite"

    def tearDown(self):
        self.tmp.cleanup()

    def test_01_rejects_relative_path(self):
        with self.assertRaises(runner.SafetyError):
            runner.validate_local_test_path("./x.db")

    def test_02_rejects_remote_url(self):
        with self.assertRaises(runner.SafetyError):
            runner.validate_local_test_path("https://example/db")

    def test_03_rejects_file_uri(self):
        with self.assertRaises(runner.SafetyError):
            runner.validate_local_test_path("file:/tmp/x.db")

    def test_04_rejects_outside_temp(self):
        with self.assertRaises(runner.SafetyError):
            runner.validate_local_test_path("/var/tmp/ordinary.db")

    def test_05_rejects_production_filename(self):
        with self.assertRaises(runner.SafetyError):
            runner.validate_local_test_path(str(Path(self.tmp.name) / "production.db"))

    def test_06_accepts_dedicated_temp_folder(self):
        self.assertEqual(runner.validate_local_test_path(str(self.db)), self.db.resolve())

    def test_07_rejects_symlink(self):
        target = Path(self.tmp.name) / "real.db"
        target.touch()
        link = Path(self.tmp.name) / "link.db"
        link.symlink_to(target)
        with self.assertRaises(runner.SafetyError):
            runner.validate_local_test_path(str(link))

    def test_08_line_endings_checksum_same(self):
        self.assertEqual(sha256_bytes(b"select 1;\n"), sha256_bytes(b"select 1;\r\n"))

    def test_09_different_sql_checksum_differs(self):
        self.assertNotEqual(sha256_bytes(b"select 1;"), sha256_bytes(b"select 2;"))

    def test_10_migration_list_has_expected_entries(self):
        ids = [m["migration_id"] for m in runner.load_migrations()]
        self.assertEqual(ids, ["CORE-MIG-001", "NTF-001", "NTF-002"])

    def test_11_apply_creates_notification_tables(self):
        result = runner.run_apply_local(str(self.db))
        self.assertEqual(len(result["migrations"]), 3)
        conn = sqlite3.connect(self.db)
        names = {r[0] for r in conn.execute("select name from sqlite_master where type='table'")}
        conn.close()
        self.assertTrue({
            "notification_events", "user_notifications",
            "notification_preferences", "notification_deliveries",
        }.issubset(names))

    def test_12_reapply_is_idempotent(self):
        runner.run_apply_local(str(self.db))
        result = runner.run_apply_local(str(self.db))
        self.assertTrue(all(x["status"] == "already-applied" for x in result["migrations"]))

    def test_13_checksum_drift_stops(self):
        runner.run_apply_local(str(self.db))
        conn = sqlite3.connect(self.db)
        conn.execute("update schema_migrations set checksum='bad' where migration_id='NTF-001'")
        conn.commit()
        conn.close()
        with self.assertRaises(runner.SafetyError):
            runner.run_apply_local(str(self.db))

    def test_14_lease_fields_and_fencing_exist(self):
        runner.run_apply_local(str(self.db))
        conn = sqlite3.connect(self.db)
        cols = {r[1] for r in conn.execute("pragma table_info(notification_events)")}
        conn.close()
        self.assertTrue({
            "processing_execution_id", "lease_expires_at", "fencing_token",
        }.issubset(cols))

    def test_15_processing_requires_lease_identity_and_expiry(self):
        runner.run_apply_local(str(self.db))
        conn = sqlite3.connect(self.db)
        with self.assertRaises(sqlite3.IntegrityError):
            conn.execute(
                "insert into notification_events(id,event_key,event_type,status) "
                "values('e1','k','x','processing')"
            )
        conn.close()

    def test_16_fencing_token_nonnegative(self):
        runner.run_apply_local(str(self.db))
        conn = sqlite3.connect(self.db)
        with self.assertRaises(sqlite3.IntegrityError):
            conn.execute(
                "insert into notification_events(id,event_key,event_type,fencing_token) "
                "values('e1','k','x',-1)"
            )
        conn.close()

    def test_17_claim_reclaim_and_stale_completion_cas(self):
        runner.run_apply_local(str(self.db))
        conn = sqlite3.connect(self.db)
        conn.execute("insert into notification_events(id,event_key,event_type) values('e1','k','x')")
        cur = conn.execute(
            "update notification_events set status='processing', "
            "processing_execution_id='worker-a', lease_expires_at='2000-01-01T00:00:00Z', "
            "fencing_token=fencing_token+1 where id='e1' and status='pending'"
        )
        self.assertEqual(cur.rowcount, 1)
        token_a = conn.execute(
            "select fencing_token from notification_events where id='e1'"
        ).fetchone()[0]
        cur = conn.execute(
            "update notification_events set processing_execution_id='worker-b', "
            "lease_expires_at='2999-01-01T00:00:00Z', fencing_token=fencing_token+1 "
            "where id='e1' and status='processing' "
            "and lease_expires_at < '2026-01-01T00:00:00Z'"
        )
        self.assertEqual(cur.rowcount, 1)
        token_b = conn.execute(
            "select fencing_token from notification_events where id='e1'"
        ).fetchone()[0]
        self.assertGreater(token_b, token_a)
        cur = conn.execute(
            "update notification_events set status='processed' "
            "where id='e1' and status='processing' "
            "and processing_execution_id='worker-a' and fencing_token=?",
            (token_a,),
        )
        self.assertEqual(cur.rowcount, 0)
        conn.close()

    def test_18_schema_fingerprint_stable(self):
        runner.run_apply_local(str(self.db))
        conn = sqlite3.connect(self.db)
        self.assertEqual(fingerprint(conn), fingerprint(conn))
        self.assertIn("notification_events", schema_snapshot(conn)["tables"])
        conn.close()

    def test_19_failed_migration_rolls_back_statement_group(self):
        conn = sqlite3.connect(self.db)
        conn.execute(
            "create table schema_migrations(migration_id text primary key, "
            "checksum text not null, applied_at text not null default current_timestamp)"
        )
        conn.commit()
        fake = {
            "migration_id": "FAIL-001",
            "checksum": "abc",
            "sql": "CREATE TABLE rollback_probe(id INTEGER);\n"
                   "INSERT INTO missing_table VALUES(1);",
        }
        with self.assertRaises(sqlite3.Error):
            runner.apply_one(conn, fake)
        self.assertIsNone(conn.execute(
            "select name from sqlite_master where name='rollback_probe'"
        ).fetchone())
        conn.close()

    def test_20_notification_fk_rejects_orphan(self):
        runner.run_apply_local(str(self.db))
        conn = sqlite3.connect(self.db)
        conn.execute("pragma foreign_keys=on")
        with self.assertRaises(sqlite3.IntegrityError):
            conn.execute(
                "insert into user_notifications(id,event_id,recipient_type,recipient_id,"
                "category,title,summary) values('n','missing','user','u','x','t','s')"
            )
        conn.close()

if __name__ == "__main__":
    unittest.main(verbosity=2)
