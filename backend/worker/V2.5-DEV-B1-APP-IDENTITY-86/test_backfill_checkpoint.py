import unittest
from backfill_checkpoint import (
    BackfillLedger, CheckpointError, ContractDrift, CursorConflict,
    LeaseBusy, OutcomeUnknown, StaleFence, State,
)

def ledger():
    return BackfillLedger(
        migration_id="mig-86", source_snapshot_id="snapshot-immutable-1",
        snapshot_consistency_token="consistency-token-1",
        snapshot_high_water=("0009", "z"), writer_epoch=7,
        active_key_set_epoch="keys-epoch-3",
        expected_key_versions=("K1", "K2"), coverage_total=9,
    )

def checksum(char="a"):
    return char * 64

def write_page(book, lease, start, end, char="a", unknown=False):
    return book.commit_snapshot_page(
        lease, 101, start_cursor=start, end_cursor=end, checksum=checksum(char),
        row_count=3, writer_epoch=7, active_key_set_epoch="keys-epoch-3",
        key_versions=("K1", "K2"), simulate_unknown_after_commit=unknown,
    )

class CheckpointTests(unittest.TestCase):
    def test_claim_increments_epoch_and_fence(self):
        b=ledger(); a=b.claim("worker-a",100,10); c=b.claim("worker-b",111,10)
        self.assertEqual((a.lease_epoch,a.fencing_token),(1,1))
        self.assertEqual((c.lease_epoch,c.fencing_token),(2,2))

    def test_live_lease_blocks_second_worker(self):
        b=ledger(); b.claim("worker-a",100,10)
        with self.assertRaises(LeaseBusy): b.claim("worker-b",105,10)

    def test_expired_lease_fences_old_holder(self):
        b=ledger(); a=b.claim("worker-a",100,10); b.claim("worker-b",111,10)
        with self.assertRaises(StaleFence):
            write_page(b,a,("",""),("0001","a"))

    def test_renew_requires_current_unexpired_fence(self):
        b=ledger(); a=b.claim("worker-a",100,10)
        renewed=b.renew(a,105,20)
        self.assertEqual(renewed.expires_at,125)
        with self.assertRaises(StaleFence): b.renew(a,106,20)

    def test_snapshot_page_advances_with_atomic_receipt(self):
        b=ledger(); lease=b.claim("worker-a",100,10)
        self.assertEqual(write_page(b,lease,("",""),("0003","m")),"COMMITTED")
        self.assertEqual(b.checkpoint.last_committed_cursor,("0003","m"))
        self.assertEqual(b.checkpoint.alias_receipt_count,3)
        self.assertEqual(len(b.checkpoint.receipts),1)

    def test_duplicate_page_is_idempotent(self):
        b=ledger(); lease=b.claim("worker-a",100,10)
        write_page(b,lease,("",""),("0003","m"))
        self.assertEqual(write_page(b,lease,("",""),("0003","m")),"IDEMPOTENT_REPLAY")
        self.assertEqual(b.checkpoint.alias_receipt_count,3)

    def test_cursor_must_start_at_committed_position(self):
        b=ledger(); lease=b.claim("worker-a",100,10)
        with self.assertRaises(CursorConflict):
            write_page(b,lease,("0001","a"),("0003","m"))

    def test_cursor_cannot_cross_high_water(self):
        b=ledger(); lease=b.claim("worker-a",100,10)
        with self.assertRaises(CursorConflict):
            write_page(b,lease,("",""),("0010","a"))

    def test_writer_or_key_epoch_drift_fails_closed(self):
        b=ledger(); lease=b.claim("worker-a",100,10)
        with self.assertRaises(ContractDrift):
            b.commit_snapshot_page(lease,101,start_cursor=("",""),end_cursor=("0001","a"),
                checksum=checksum(),row_count=1,writer_epoch=8,
                active_key_set_epoch="keys-epoch-3",key_versions=("K1","K2"))
        with self.assertRaises(ContractDrift):
            b.commit_snapshot_page(lease,101,start_cursor=("",""),end_cursor=("0001","a"),
                checksum=checksum(),row_count=1,writer_epoch=7,
                active_key_set_epoch="keys-epoch-4",key_versions=("K1","K2"))

    def test_missing_key_version_rejected(self):
        b=ledger(); lease=b.claim("worker-a",100,10)
        with self.assertRaises(ContractDrift):
            b.commit_snapshot_page(lease,101,start_cursor=("",""),end_cursor=("0001","a"),
                checksum=checksum(),row_count=1,writer_epoch=7,
                active_key_set_epoch="keys-epoch-3",key_versions=("K1",))

    def test_unknown_commit_outcome_blocks_next_page_until_reconciled(self):
        b=ledger(); lease=b.claim("worker-a",100,10)
        with self.assertRaises(OutcomeUnknown):
            write_page(b,lease,("",""),("0003","m"),unknown=True)
        with self.assertRaises(CheckpointError):
            write_page(b,lease,("0003","m"),("0006","t"),char="b")
        self.assertEqual(b.reconcile_unknown(),"COMMITTED")
        self.assertEqual(write_page(b,lease,("0003","m"),("0006","t"),char="b"),"COMMITTED")

    def test_unknown_without_receipt_reconciles_as_not_committed(self):
        b=ledger(); b.claim("worker-a",100,10)
        b.mark_outcome_unknown("page-not-written")
        self.assertEqual(b.reconcile_unknown(),"NOT_COMMITTED")

    def test_snapshot_to_catchup_requires_high_water(self):
        b=ledger(); lease=b.claim("worker-a",100,10)
        with self.assertRaises(CursorConflict): b.begin_catch_up(lease,101)
        write_page(b,lease,("",""),("0009","z"))
        self.assertEqual(b.begin_catch_up(lease,101),"CATCH_UP")

    def test_catchup_watermark_and_cursor_are_monotonic(self):
        b=ledger(); lease=b.claim("worker-a",100,10)
        write_page(b,lease,("",""),("0009","z"))
        b.set_catch_up_watermark(lease,101,("0012","b"))
        b.begin_catch_up(lease,101)
        with self.assertRaises(CursorConflict):
            b.commit_catch_up_page(lease,101,expected_cursor=("0009","z"),next_cursor=("0013","a"),
                checksum=checksum("b"),row_count=2,writer_epoch=7,
                active_key_set_epoch="keys-epoch-3",key_versions=("K1","K2"))
        b.commit_catch_up_page(lease,101,expected_cursor=("0009","z"),next_cursor=("0012","b"),
            checksum=checksum("c"),row_count=2,writer_epoch=7,
            active_key_set_epoch="keys-epoch-3",key_versions=("K1","K2"))
        self.assertEqual(b.checkpoint.alias_receipt_count,5)
        self.assertEqual(b.complete(lease,101),"COMPLETE")


    def test_catchup_receipt_and_cursor_commit_together_with_unknown_recovery(self):
        b=ledger(); lease=b.claim("worker-a",100,10)
        write_page(b,lease,("",""),("0009","z"))
        b.set_catch_up_watermark(lease,101,("0012","b"))
        b.begin_catch_up(lease,101)
        with self.assertRaises(OutcomeUnknown):
            b.commit_catch_up_page(lease,101,expected_cursor=("0009","z"),next_cursor=("0012","b"),
                checksum=checksum("d"),row_count=1,writer_epoch=7,
                active_key_set_epoch="keys-epoch-3",key_versions=("K1","K2"),
                simulate_unknown_after_commit=True)
        self.assertEqual(b.checkpoint.catch_up_cursor,("0012","b"))
        self.assertEqual(b.checkpoint.alias_receipt_count,4)
        with self.assertRaises(CheckpointError): b.complete(lease,101)
        self.assertEqual(b.reconcile_unknown(),"COMMITTED")
        self.assertEqual(b.commit_catch_up_page(lease,101,expected_cursor=("0009","z"),next_cursor=("0012","b"),
            checksum=checksum("d"),row_count=1,writer_epoch=7,
            active_key_set_epoch="keys-epoch-3",key_versions=("K1","K2")),"IDEMPOTENT_REPLAY")
        self.assertEqual(b.checkpoint.alias_receipt_count,4)
        self.assertEqual(b.complete(lease,101),"COMPLETE")

    def test_watermark_must_not_precede_snapshot_high_water(self):
        b=ledger(); lease=b.claim("worker-a",100,10)
        with self.assertRaises(CursorConflict):
            b.set_catch_up_watermark(lease,101,("0008","z"))

    def test_cursor_components_must_be_canonical_strings(self):
        b=ledger(); lease=b.claim("worker-a",100,10)
        with self.assertRaises(ValueError):
            write_page(b,lease,(0,""),("0001","a"))

    def test_watermark_cannot_move_backwards(self):
        b=ledger(); lease=b.claim("worker-a",100,10)
        b.set_catch_up_watermark(lease,101,("0010","a"))
        with self.assertRaises(CursorConflict):
            b.set_catch_up_watermark(lease,101,("0009","z"))

    def test_completed_checkpoint_cannot_be_reclaimed(self):
        b=ledger(); lease=b.claim("worker-a",100,10)
        write_page(b,lease,("",""),("0009","z"))
        b.set_catch_up_watermark(lease,101,("0009","z"))
        b.begin_catch_up(lease,101)
        b.complete(lease,101)
        with self.assertRaises(CheckpointError): b.claim("worker-b",200,10)

if __name__ == "__main__":
    unittest.main()
