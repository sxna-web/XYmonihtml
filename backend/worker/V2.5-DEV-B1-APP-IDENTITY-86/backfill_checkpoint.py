"""Durable backfill checkpoint reference state machine (synthetic/offline only).

This is an executable contract oracle, not a D1 adapter or production migration.
It models lease fencing, snapshot/catch-up cursors, atomic page receipts, and
reconciliation after an unknown commit outcome. No database or network access.
"""
from dataclasses import dataclass, field
from enum import Enum
from hashlib import sha256
import json


class CheckpointError(Exception):
    pass


class LeaseBusy(CheckpointError):
    pass


class StaleFence(CheckpointError):
    pass


class ContractDrift(CheckpointError):
    pass


class CursorConflict(CheckpointError):
    pass


class PageConflict(CheckpointError):
    pass


class OutcomeUnknown(CheckpointError):
    pass


class State(str, Enum):
    SNAPSHOT_SCAN = "SNAPSHOT_SCAN"
    CATCH_UP = "CATCH_UP"
    COMPLETE = "COMPLETE"


def _cursor(value):
    if not isinstance(value, (tuple, list)) or not value:
        raise ValueError("cursor must be a non-empty composite tuple")
    if any(not isinstance(x, str) or not x for x in value):
        raise ValueError("cursor components must be non-empty strings")
    return tuple(value)


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def page_identity(snapshot_id, start, end, checksum):
    material = {"snapshot": snapshot_id, "start": list(start),
                "end": list(end), "checksum": checksum}
    return sha256(_canonical(material).encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class Lease:
    owner: str
    lease_epoch: int
    fencing_token: int
    expires_at: int


@dataclass(frozen=True)
class PageReceipt:
    page_id: str
    checksum: str
    start_cursor: tuple
    end_cursor: tuple
    row_count: int
    writer_epoch: int
    active_key_set_epoch: str


@dataclass
class BackfillCheckpoint:
    migration_id: str
    source_snapshot_id: str
    snapshot_consistency_token: str
    snapshot_high_water: tuple
    writer_epoch: int
    active_key_set_epoch: str
    expected_key_versions: tuple
    coverage_total: int
    state: State = State.SNAPSHOT_SCAN
    last_committed_cursor: tuple = ("",)
    catch_up_watermark: tuple = ("",)
    catch_up_cursor: tuple = ("",)
    lease_epoch: int = 0
    fencing_token: int = 0
    lease_owner: str | None = None
    lease_expires_at: int = 0
    attempt: int = 0
    outcome_unknown: bool = False
    unknown_page_id: str | None = None
    last_error_class: str | None = None
    receipts: dict = field(default_factory=dict)
    alias_receipt_count: int = 0


class BackfillLedger:
    """In-memory reference model; RLock/database concurrency is intentionally absent."""

    def __init__(self, *, migration_id, source_snapshot_id,
                 snapshot_consistency_token, snapshot_high_water,
                 writer_epoch, active_key_set_epoch, expected_key_versions,
                 coverage_total):
        versions = tuple(expected_key_versions)
        if not migration_id or not source_snapshot_id or not snapshot_consistency_token:
            raise ValueError("immutable migration and snapshot identity required")
        if not versions or len(set(versions)) != len(versions):
            raise ValueError("expected key versions must be unique and non-empty")
        if not isinstance(writer_epoch, int) or writer_epoch < 1:
            raise ValueError("writer_epoch must be a positive integer")
        if not active_key_set_epoch or not isinstance(coverage_total, int) or coverage_total < 0:
            raise ValueError("active key epoch and non-negative coverage_total required")
        high = _cursor(snapshot_high_water)
        self.checkpoint = BackfillCheckpoint(
            migration_id=migration_id,
            source_snapshot_id=source_snapshot_id,
            snapshot_consistency_token=snapshot_consistency_token,
            snapshot_high_water=high,
            writer_epoch=writer_epoch,
            active_key_set_epoch=active_key_set_epoch,
            expected_key_versions=versions,
            coverage_total=coverage_total,
            last_committed_cursor=tuple("" for _ in high),
            catch_up_watermark=tuple("" for _ in high),
            catch_up_cursor=tuple("" for _ in high),
        )

    def claim(self, owner, now, lease_seconds):
        cp = self.checkpoint
        if not owner or not isinstance(now, int) or not isinstance(lease_seconds, int) or lease_seconds <= 0:
            raise ValueError("valid owner, time and positive lease duration required")
        if cp.state == State.COMPLETE:
            raise CheckpointError("completed checkpoint cannot be claimed")
        if cp.lease_owner is not None and cp.lease_expires_at > now:
            raise LeaseBusy("checkpoint lease is still active")
        cp.lease_epoch += 1
        cp.fencing_token += 1
        cp.lease_owner = owner
        cp.lease_expires_at = now + lease_seconds
        cp.attempt += 1
        return Lease(owner, cp.lease_epoch, cp.fencing_token, cp.lease_expires_at)

    def renew(self, lease, now, lease_seconds):
        cp = self.checkpoint
        self._assert_fence(lease, now)
        if not isinstance(lease_seconds, int) or lease_seconds <= 0:
            raise ValueError("positive lease duration required")
        cp.lease_expires_at = now + lease_seconds
        return Lease(lease.owner, cp.lease_epoch, cp.fencing_token, cp.lease_expires_at)

    def _assert_fence(self, lease, now):
        cp = self.checkpoint
        if (not isinstance(lease, Lease) or cp.lease_owner != lease.owner or
            cp.lease_epoch != lease.lease_epoch or cp.fencing_token != lease.fencing_token or
            cp.lease_expires_at <= now):
            raise StaleFence("lease owner/epoch/fencing token is stale or expired")

    def _assert_writer_contract(self, writer_epoch, active_key_set_epoch, key_versions):
        cp = self.checkpoint
        if writer_epoch != cp.writer_epoch or active_key_set_epoch != cp.active_key_set_epoch:
            raise ContractDrift("writer epoch or active key-set epoch changed")
        if tuple(key_versions) != cp.expected_key_versions:
            raise ContractDrift("active key versions differ from checkpoint contract")

    def set_catch_up_watermark(self, lease, now, watermark):
        cp = self.checkpoint
        self._assert_fence(lease, now)
        value = _cursor(watermark)
        if len(value) != len(cp.snapshot_high_water) or value < cp.catch_up_watermark:
            raise CursorConflict("catch-up watermark must be monotonic and same-shaped")
        cp.catch_up_watermark = value

    def commit_snapshot_page(self, lease, now, *, start_cursor, end_cursor,
                             checksum, row_count, writer_epoch,
                             active_key_set_epoch, key_versions,
                             simulate_unknown_after_commit=False):
        cp = self.checkpoint
        self._assert_fence(lease, now)
        self._assert_writer_contract(writer_epoch, active_key_set_epoch, key_versions)
        if cp.state != State.SNAPSHOT_SCAN or cp.outcome_unknown:
            raise CheckpointError("snapshot scan is not currently writable")
        start, end = _cursor(start_cursor), _cursor(end_cursor)
        if len(start) != len(cp.snapshot_high_water) or len(end) != len(cp.snapshot_high_water):
            raise CursorConflict("cursor shape differs from snapshot high-water")
        if start != cp.last_committed_cursor or end <= start or end > cp.snapshot_high_water:
            raise CursorConflict("page cursor must advance exactly from committed cursor and stay within high-water")
        if not isinstance(checksum, str) or len(checksum) != 64 or any(c not in "0123456789abcdef" for c in checksum):
            raise ValueError("page checksum must be lowercase SHA-256 hex")
        if not isinstance(row_count, int) or row_count < 0:
            raise ValueError("row_count must be non-negative")
        pid = page_identity(cp.source_snapshot_id, start, end, checksum)
        receipt = PageReceipt(pid, checksum, start, end, row_count,
                              writer_epoch, active_key_set_epoch)
        old = cp.receipts.get(pid)
        if old is not None:
            if old != receipt:
                raise PageConflict("same page identity has different receipt")
            return "IDEMPOTENT_REPLAY"
        # The receipt, alias-write count and cursor represent one atomic commit unit.
        cp.receipts[pid] = receipt
        cp.alias_receipt_count += row_count
        cp.last_committed_cursor = end
        if simulate_unknown_after_commit:
            cp.outcome_unknown = True
            cp.unknown_page_id = pid
            cp.last_error_class = "COMMIT_OUTCOME_UNKNOWN"
            raise OutcomeUnknown("commit applied in model; caller must reconcile before continuing")
        return "COMMITTED"

    def mark_outcome_unknown(self, page_id):
        cp = self.checkpoint
        if cp.outcome_unknown and cp.unknown_page_id != page_id:
            raise PageConflict("another unknown page is already pending")
        cp.outcome_unknown = True
        cp.unknown_page_id = page_id
        cp.last_error_class = "COMMIT_OUTCOME_UNKNOWN"

    def reconcile_unknown(self):
        cp = self.checkpoint
        if not cp.outcome_unknown or not cp.unknown_page_id:
            raise CheckpointError("no unknown outcome to reconcile")
        receipt = cp.receipts.get(cp.unknown_page_id)
        cp.outcome_unknown = False
        cp.unknown_page_id = None
        cp.last_error_class = None
        return "COMMITTED" if receipt is not None else "NOT_COMMITTED"

    def begin_catch_up(self, lease, now):
        cp = self.checkpoint
        self._assert_fence(lease, now)
        if cp.outcome_unknown or cp.state != State.SNAPSHOT_SCAN:
            raise CheckpointError("snapshot scan cannot transition yet")
        if cp.last_committed_cursor != cp.snapshot_high_water:
            raise CursorConflict("snapshot high-water has not been reached")
        cp.state = State.CATCH_UP
        cp.catch_up_cursor = cp.catch_up_watermark
        return cp.state.value

    def advance_catch_up(self, lease, now, *, expected_cursor, next_cursor,
                         writer_epoch, active_key_set_epoch, key_versions):
        cp = self.checkpoint
        self._assert_fence(lease, now)
        self._assert_writer_contract(writer_epoch, active_key_set_epoch, key_versions)
        if cp.state != State.CATCH_UP or cp.outcome_unknown:
            raise CheckpointError("catch-up is not writable")
        expected, nxt = _cursor(expected_cursor), _cursor(next_cursor)
        if expected != cp.catch_up_cursor or nxt <= expected or nxt > cp.catch_up_watermark:
            raise CursorConflict("catch-up cursor must advance monotonically up to watermark")
        cp.catch_up_cursor = nxt

    def complete(self, lease, now):
        cp = self.checkpoint
        self._assert_fence(lease, now)
        if cp.state != State.CATCH_UP or cp.outcome_unknown:
            raise CheckpointError("checkpoint is not ready to complete")
        if cp.catch_up_cursor != cp.catch_up_watermark:
            raise CursorConflict("catch-up cursor has not reached watermark")
        cp.state = State.COMPLETE
        cp.lease_owner = None
        cp.lease_expires_at = 0
        return cp.state.value
