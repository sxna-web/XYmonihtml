# APP v2 Identity — Batch 86

Offline synthetic checkpoint state machine. See the batch report for the contract and limitations.

Run: `python -m unittest -v`

## Covered
- Snapshot high-water and composite cursor monotonicity
- Lease expiry, renewal, epoch and fencing-token checks
- Idempotent page receipts
- Atomic model receipt/cursor advancement for snapshot and catch-up pages
- Unknown commit outcome reconciliation
- Writer epoch and active key-set drift rejection
- Catch-up watermark and completion gates

## Verified
- GitHub Actions Run 46125953487 / Job 140920481694: SUCCESS
- Python 3.13.18; 19 tests passed

No D1, SQL, Worker, HMAC, secrets or production access. Passing this model does not prove persistent transaction atomicity or multi-Worker serialization.
