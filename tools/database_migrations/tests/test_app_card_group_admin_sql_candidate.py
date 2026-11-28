import sqlite3
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SCHEMA = ROOT / "backend/worker/V2.5-DEV-B1-APP-PROTOCOL-66/fixtures/card-group-admin-candidate-schema.sql"


class AppCardGroupAdminSqlCandidateTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.execute("PRAGMA foreign_keys = ON")
        self.db.executescript(SCHEMA.read_text(encoding="utf-8"))
        self.db.execute("INSERT INTO app_cards(id,admin_user_id,status) VALUES('c1','a1','used')")
        self.db.execute("INSERT INTO app_groups(id,admin_user_id,name,mode,enabled) VALUES('g1','a1','Group 1','card',1)")
        self.db.execute("INSERT INTO app_groups(id,admin_user_id,name,mode,enabled) VALUES('g2','a1','Group 2','card',1)")
        self.db.execute("INSERT INTO app_groups(id,admin_user_id,name,mode,enabled) VALUES('free','a1','Free','free',1)")
        self.db.execute("INSERT INTO app_cards(id,admin_user_id,status) VALUES('c2','a2','normal')")
        self.db.execute("INSERT INTO app_groups(id,admin_user_id,name,mode,enabled) VALUES('foreign','a2','Foreign','card',1)")
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def insert_mapping(self, card="c1", admin="a1", group="g1", status="active"):
        self.db.execute(
            """INSERT INTO app_card_group_mappings
               (id,card_id,admin_user_id,group_id,status,removed_at)
               VALUES(?,?,?,?,?,?)""",
            (f"map-{card}-{group}", card, admin, group, status,
             "2026-11-28T00:00:00Z" if status == "removed" else None),
        )

    def test_same_owner_card_mode_mapping_is_allowed(self):
        self.insert_mapping()
        self.assertEqual(self.db.execute("SELECT count(*) FROM app_card_group_mappings").fetchone()[0], 1)

    def test_cross_owner_card_or_group_is_rejected_by_trigger(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert_mapping(card="c2", admin="a1", group="g1")
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert_mapping(card="c1", admin="a1", group="foreign")

    def test_free_group_cannot_be_bound_as_card_group(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert_mapping(group="free")

    def test_unique_pair_preserves_single_soft_history_row(self):
        self.insert_mapping()
        self.db.execute(
            """UPDATE app_card_group_mappings
               SET status='removed', removed_at=CURRENT_TIMESTAMP
               WHERE card_id='c1' AND group_id='g1'"""
        )
        self.db.execute(
            """INSERT INTO app_card_group_mappings
               (id,card_id,admin_user_id,group_id,status)
               VALUES('map-restored','c1','a1','g1','active')
               ON CONFLICT(card_id,group_id) DO UPDATE SET
                 status='active', removed_at=NULL"""
        )
        rows = self.db.execute(
            "SELECT count(*), max(status), max(removed_at IS NULL) FROM app_card_group_mappings"
        ).fetchone()
        self.assertEqual(rows, (1, "active", 1))

    def test_duplicate_idempotency_key_is_rejected(self):
        values = ("a1", "req-1", "a" * 64, '{"groupIds":["g1"]}')
        self.db.execute(
            """INSERT INTO app_card_group_admin_requests
               (admin_user_id,idempotency_key,payload_sha256,response_json) VALUES(?,?,?,?)""", values
        )
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                """INSERT INTO app_card_group_admin_requests
                   (admin_user_id,idempotency_key,payload_sha256,response_json) VALUES(?,?,?,?)""",
                ("a1", "req-1", "b" * 64, '{"groupIds":["g2"]}'),
            )

    def test_failed_audit_rolls_back_mapping_and_idempotency_together(self):
        self.insert_mapping(group="g1")
        self.db.commit()
        self.db.execute("BEGIN")
        self.db.execute(
            """INSERT INTO app_card_group_admin_requests
               (admin_user_id,idempotency_key,payload_sha256,response_json)
               VALUES('a1','req-atomic',?,?)""", ("c" * 64, '{"groupIds":["g2"]}')
        )
        self.db.execute(
            """UPDATE app_card_group_mappings
               SET status='removed',removed_at=CURRENT_TIMESTAMP
               WHERE card_id='c1' AND admin_user_id='a1' AND status='active'"""
        )
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                """INSERT INTO admin_audit_events
                   (actor_user_id,effective_user_id,action,target_type,target_id,
                    request_id,before_json,after_json,result,reason,detail)
                   VALUES(NULL,'a1','app_card_groups.replace','app_card','c1',
                          'req-atomic','[]','["g2"]','ok','','')"""
            )
        self.db.rollback()
        self.assertEqual(
            self.db.execute("SELECT status FROM app_card_group_mappings").fetchone()[0],
            "active",
        )
        self.assertEqual(
            self.db.execute(
                "SELECT count(*) FROM app_card_group_admin_requests WHERE idempotency_key='req-atomic'"
            ).fetchone()[0], 0
        )

    def test_mapping_history_blocks_parent_owner_transfer(self):
        self.insert_mapping(status="removed")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE app_cards SET admin_user_id='a9' WHERE id='c1'")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE app_groups SET admin_user_id='a9' WHERE id='g1'")

    def test_active_mapping_blocks_group_mode_downgrade(self):
        self.insert_mapping()
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE app_groups SET mode='free' WHERE id='g1'")

    def test_parent_delete_is_restricted(self):
        self.insert_mapping(status="removed")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("DELETE FROM app_cards WHERE id='c1'")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("DELETE FROM app_groups WHERE id='g1'")

    def test_mapping_indexes_match_owner_card_and_group_access_paths(self):
        indexes = {
            row[1] for row in self.db.execute("PRAGMA index_list(app_card_group_mappings)")
        }
        self.assertIn("ix_card_group_mappings_admin_card_status", indexes)
        self.assertIn("ix_card_group_mappings_group_status", indexes)

    def test_mapping_status_and_removed_at_must_be_consistent(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                """INSERT INTO app_card_group_mappings
                   (id,card_id,admin_user_id,group_id,status,removed_at)
                   VALUES('bad-active','c1','a1','g1','active','2026-11-28T00:00:00Z')"""
            )
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                """INSERT INTO app_card_group_mappings
                   (id,card_id,admin_user_id,group_id,status,removed_at)
                   VALUES('bad-removed','c1','a1','g1','removed',NULL)"""
            )

    def test_idempotency_key_is_scoped_by_admin_not_globally_unique(self):
        self.db.execute(
            """INSERT INTO app_card_group_admin_requests
               (admin_user_id,idempotency_key,payload_sha256,response_json)
               VALUES('a1','shared-key-01',?,?)""",
            ("a" * 64, '{"groupIds":["g1"]}'),
        )
        self.db.execute(
            """INSERT INTO app_card_group_admin_requests
               (admin_user_id,idempotency_key,payload_sha256,response_json)
               VALUES('a2','shared-key-01',?,?)""",
            ("b" * 64, '{"groupIds":["g2"]}'),
        )
        self.assertEqual(
            self.db.execute("SELECT COUNT(*) FROM app_card_group_admin_requests").fetchone()[0],
            2,
        )

    def test_schema_has_no_redeem_code_or_token_columns(self):
        columns = {
            row[1] for row in self.db.execute("PRAGMA table_info(app_card_group_mappings)")
        }
        self.assertFalse({"code", "redeem_code", "token", "access_token"} & columns)


if __name__ == "__main__":
    unittest.main()
