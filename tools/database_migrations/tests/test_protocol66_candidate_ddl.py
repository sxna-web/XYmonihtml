"""SQLite-only syntax and invariant tests for the review-only Protocol66 DDL.

This suite never connects to Cloudflare D1 and never executes against a real database.
"""
from pathlib import Path
import sqlite3
import unittest


ROOT = Path(__file__).resolve().parents[3]
DDL = ROOT / "docs" / "backend" / "StarJump_V2.5_Protocol66_卡密分组映射与幂等表迁移候选_仅审查不执行_2026-11-28.sql"


def build_db():
    db = sqlite3.connect(":memory:")
    db.executescript("""
      CREATE TABLE app_cards (
        id TEXT PRIMARY KEY, admin_user_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'normal',
        manual_disabled INTEGER NOT NULL DEFAULT 0, expires_at TEXT
      );
      CREATE TABLE app_groups (
        id TEXT PRIMARY KEY, admin_user_id TEXT NOT NULL,
        name TEXT NOT NULL, mode TEXT NOT NULL,
        sort INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE admin_vip_activations (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL,
        starts_at TEXT NOT NULL, ends_at TEXT NOT NULL
      );
      CREATE TABLE admin_audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, actor_user_id TEXT,
        effective_user_id TEXT, action TEXT NOT NULL, target_type TEXT,
        target_id TEXT, request_id TEXT, before_json TEXT, after_json TEXT,
        result TEXT, reason TEXT, detail TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
    """)
    db.executescript(DDL.read_text(encoding="utf-8"))
    return db


class Protocol66CandidateDDLTests(unittest.TestCase):
    def setUp(self):
        self.db = build_db()
        self.db.execute("INSERT INTO app_cards(id,admin_user_id) VALUES('c1','a1')")
        self.db.execute("INSERT INTO app_groups(id,admin_user_id,name,mode) VALUES('g1','a1','Card group','card')")
        self.db.execute("INSERT INTO app_groups(id,admin_user_id,name,mode) VALUES('g2','a1','Free group','free')")
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def add_mapping(self, *, card="c1", admin="a1", group="g1", mapping="m1"):
        self.db.execute(
            "INSERT INTO app_card_group_mappings(id,card_id,admin_user_id,group_id) VALUES(?,?,?,?)",
            (mapping, card, admin, group),
        )
        self.db.commit()

    def test_ddl_creates_two_tables_three_named_indexes_and_eight_triggers(self):
        tables = {r[0] for r in self.db.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        )}
        self.assertTrue({"app_card_group_mappings", "app_card_group_admin_requests"} <= tables)
        indexes = {r[0] for r in self.db.execute(
            "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_autoindex_%'"
        )}
        self.assertTrue({
            "ix_card_group_mappings_admin_card_status",
            "ix_card_group_mappings_group_status",
            "ix_card_group_admin_requests_created",
        } <= indexes)
        triggers = {r[0] for r in self.db.execute(
            "SELECT name FROM sqlite_master WHERE type='trigger'"
        )}
        self.assertEqual(len(triggers), 8)
        self.assertEqual(self.db.execute(
            "PRAGMA foreign_key_list(app_card_group_mappings)"
        ).fetchall(), [])

    def test_mapping_rejects_cross_owner_and_non_card_groups(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.add_mapping(group="g2", mapping="m-free")
        self.db.execute("INSERT INTO app_cards(id,admin_user_id) VALUES('c2','a2')")
        self.db.execute("INSERT INTO app_groups(id,admin_user_id,name,mode) VALUES('g3','a2','Other card','card')")
        self.db.commit()
        with self.assertRaises(sqlite3.IntegrityError):
            self.add_mapping(card="c1", admin="a2", group="g3", mapping="m-cross")

    def test_mapping_history_uses_soft_remove_and_forbids_hard_delete(self):
        self.add_mapping()
        self.db.execute(
            "UPDATE app_card_group_mappings SET status='removed', removed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id='m1'"
        )
        self.db.commit()
        row = self.db.execute(
            "SELECT status, removed_at FROM app_card_group_mappings WHERE id='m1'"
        ).fetchone()
        self.assertEqual(row[0], "removed")
        self.assertIsNotNone(row[1])
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("DELETE FROM app_card_group_mappings WHERE id='m1'")

    def test_card_and_group_hard_delete_or_owner_transfer_are_blocked_by_mapping_history(self):
        self.add_mapping()
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("DELETE FROM app_cards WHERE id='c1'")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("DELETE FROM app_groups WHERE id='g1'")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE app_cards SET admin_user_id='a2' WHERE id='c1'")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE app_groups SET admin_user_id='a2' WHERE id='g1'")

    def test_active_card_mapping_blocks_mode_change_but_removed_history_does_not(self):
        self.add_mapping()
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE app_groups SET mode='free' WHERE id='g1'")
        self.db.execute(
            "UPDATE app_card_group_mappings SET status='removed', removed_at=CURRENT_TIMESTAMP WHERE id='m1'"
        )
        self.db.execute("UPDATE app_groups SET mode='free' WHERE id='g1'")
        self.db.commit()
        self.assertEqual(self.db.execute(
            "SELECT mode FROM app_groups WHERE id='g1'"
        ).fetchone()[0], "free")

    def test_idempotency_scope_is_per_admin_and_digest_is_lowercase_sha256(self):
        self.db.execute(
            "INSERT INTO app_card_group_admin_requests(admin_user_id,idempotency_key,payload_sha256,response_json) VALUES('a1','idem-key-12345678',?,'{}')",
            ("a" * 64,),
        )
        self.db.execute(
            "INSERT INTO app_card_group_admin_requests(admin_user_id,idempotency_key,payload_sha256,response_json) VALUES('a2','idem-key-12345678',?,'{}')",
            ("b" * 64,),
        )
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                "INSERT INTO app_card_group_admin_requests(admin_user_id,idempotency_key,payload_sha256,response_json) VALUES('a1','idem-key-12345678',?,'{}')",
                ("c" * 64,),
            )
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                "INSERT INTO app_card_group_admin_requests(admin_user_id,idempotency_key,payload_sha256,response_json) VALUES('a3','idem-key-22345678',?,'{}')",
                ("A" * 64,),
            )


if __name__ == "__main__":
    unittest.main()
