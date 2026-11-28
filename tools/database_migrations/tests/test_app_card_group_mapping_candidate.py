"""Candidate APP card/group mapping model tests.

This is an isolated SQLite fixture only. It is deliberately NOT a production
migration and is not loaded by tools/database_migrations/runner.py.
"""
from __future__ import annotations
import sqlite3
import unittest
from pathlib import Path

CANDIDATE_SCHEMA_PATH = (
    Path(__file__).resolve().parents[3]
    / "backend/worker/V2.5-DEV-B1-APP-PROTOCOL-66/fixtures/card-group-admin-candidate-schema.sql"
)
CANDIDATE_DDL = CANDIDATE_SCHEMA_PATH.read_text(encoding="utf-8")


def fixture():
    db = sqlite3.connect(":memory:")
    db.execute("PRAGMA foreign_keys=ON")
    db.executescript("""
      CREATE TABLE app_cards (
        id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE,
        admin_user_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'normal'
      );
      CREATE TABLE app_groups (
        id TEXT PRIMARY KEY, admin_user_id TEXT NOT NULL,
        name TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'assigned',
        enabled INTEGER NOT NULL DEFAULT 1
      );
      INSERT INTO app_cards(id,code,admin_user_id) VALUES
        ('c1','REDEEM-SECRET-1','a1'), ('c2','REDEEM-SECRET-2','a2');
      INSERT INTO app_groups(id,admin_user_id,name,mode) VALUES
        ('g1','a1','Private A','card'), ('g2','a2','Private B','card'),
        ('gf','a1','Free A','free'), ('ga','a1','Assigned A','assigned');
    """)
    return db

def install_candidate(db):
    db.executescript(CANDIDATE_DDL)

class AppCardGroupMappingCandidateTests(unittest.TestCase):
    def setUp(self):
        self.db = fixture()
        install_candidate(self.db)

    def tearDown(self):
        self.db.close()

    def insert(self, mapping_id="m1", card="c1", owner="a1", group="g1"):
        self.db.execute(
            """INSERT INTO app_card_group_mappings
               (id,card_id,admin_user_id,group_id)
               VALUES (?,?,?,?)""",
            (mapping_id, card, owner, group),
        )

    def test_01_same_owner_card_group_is_allowed(self):
        self.insert()
        row = self.db.execute(
            "SELECT card_id,admin_user_id,group_id,status FROM app_card_group_mappings"
        ).fetchone()
        self.assertEqual(row, ("c1", "a1", "g1", "active"))

    def test_02_cross_admin_card_is_rejected(self):
        with self.assertRaisesRegex(sqlite3.IntegrityError, "CARD_GROUP_OWNER_OR_MODE_MISMATCH"):
            self.insert(card="c2", owner="a1", group="g1")

    def test_03_cross_admin_group_is_rejected(self):
        with self.assertRaisesRegex(sqlite3.IntegrityError, "CARD_GROUP_OWNER_OR_MODE_MISMATCH"):
            self.insert(card="c1", owner="a1", group="g2")

    def test_04_free_and_assigned_groups_are_not_card_groups(self):
        for group in ("gf", "ga"):
            with self.subTest(group=group):
                with self.assertRaisesRegex(sqlite3.IntegrityError, "CARD_GROUP_SCOPE_MISMATCH"):
                    self.insert(mapping_id="m-" + group, group=group)

    def test_05_duplicate_card_group_mapping_is_rejected(self):
        self.insert()
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert(mapping_id="m2")

    def test_06_soft_remove_preserves_history_and_can_restore(self):
        self.insert()
        self.db.execute("""
          UPDATE app_card_group_mappings
          SET status='removed', removed_at='2026-11-28T00:00:00Z',
              updated_at='2026-11-28T00:00:00Z'
          WHERE id='m1'
        """)
        self.db.execute("""
          UPDATE app_card_group_mappings
          SET status='active', removed_at=NULL,
              updated_at='2026-11-28T01:00:00Z'
          WHERE id='m1'
        """)
        row = self.db.execute(
            "SELECT status,removed_at FROM app_card_group_mappings WHERE id='m1'"
        ).fetchone()
        self.assertEqual(row, ("active", None))
        self.assertEqual(self.db.execute(
            "SELECT COUNT(*) FROM app_card_group_mappings"
        ).fetchone()[0], 1)

    def test_07_active_mapping_blocks_group_mode_downgrade(self):
        self.insert()
        with self.assertRaisesRegex(sqlite3.IntegrityError, "GROUP_HAS_ACTIVE_CARD_MAPPING"):
            self.db.execute("UPDATE app_groups SET mode='free' WHERE id='g1'")

    def test_08_mapping_history_blocks_owner_reassignment(self):
        self.insert()
        with self.assertRaisesRegex(sqlite3.IntegrityError, "CARD_HAS_GROUP_MAPPING_HISTORY"):
            self.db.execute("UPDATE app_cards SET admin_user_id='a2' WHERE id='c1'")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "GROUP_HAS_CARD_MAPPING_HISTORY"):
            self.db.execute("UPDATE app_groups SET admin_user_id='a2' WHERE id='g1'")

    def test_09_parent_delete_is_restricted_not_cascaded(self):
        self.insert()
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("DELETE FROM app_cards WHERE id='c1'")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("DELETE FROM app_groups WHERE id='g1'")

    def test_10_migration_fixture_is_idempotent(self):
        before = self.db.execute(
            "SELECT COUNT(*) FROM sqlite_master WHERE name='app_card_group_mappings'"
        ).fetchone()[0]
        install_candidate(self.db)
        after = self.db.execute(
            "SELECT COUNT(*) FROM sqlite_master WHERE name='app_card_group_mappings'"
        ).fetchone()[0]
        self.assertEqual((before, after), (1, 1))

    def test_11_mapping_schema_never_copies_redeem_code(self):
        columns = {row[1] for row in self.db.execute(
            "PRAGMA table_info(app_card_group_mappings)"
        )}
        self.assertNotIn("code", columns)
        self.assertNotIn("token", columns)
        self.assertNotIn("redeem_code", columns)
        self.assertNotIn("REDEEM-SECRET-1", str(self.db.execute(
            "SELECT * FROM app_card_group_mappings"
        ).fetchall()))

if __name__ == "__main__":
    unittest.main()
