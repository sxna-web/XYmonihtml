# StarJump APP v2 isolated integration validation — Batch 59

- Version: V2.5-DEV-B1-APP-PROTOCOL-59
- Status: isolated DEV code and local tests; CI pending until workflow completes; not wired into the existing Worker; not deployable.
- Runtime: Node.js 22 and Python 3 SQLite.

## Implemented in this isolated batch

- Multi-card composition: card groups from each active entitlement remain separate.
- Same-admin free groups are deduplicated by admin + group ID, so multiple cards do not repeat the same free group.
- Different admins retain independent free-group scopes.
- Same-name card groups from different cards receive a display suffix using that card's safe serial label, e.g. 香港节点（序列号-001） and 香港节点（序列号-002）.
- Redeemable card codes must never be used as display labels. The future server adapter must provide a non-secret serial/display label.
- Group loader checks card ID, card owner, group owner, group mode, enabled state, entitlement owner, and free-grant eligibility; adapter errors fail closed.
- Device reservation uses one conditional INSERT...SELECT statement and a unique (card_id, device_id) key for idempotency. The SQL parameter order is card ID, device ID, timestamp, card ID, device limit.
- Handler negative cases cover entitlement/device mismatch and malicious group rows; sync tests cover out-of-order acknowledgement and exact lease expiry.

## Isolated device-slot schema model (NOT A MIGRATION)

The local SQLite test creates only this isolated fixture shape:

CREATE TABLE app_card_device_slots (
  card_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (card_id, device_id)
);

The reservation statement checks the per-card count and inserts in one SQLite statement. The local concurrency test launches parallel connections and confirms the configured limit is not exceeded. This is evidence for the SQLite model only; Cloudflare D1 concurrency/runtime behavior still requires a separate isolated D1 test.

Before any future production proposal, the project must decide how existing active entitlements are backfilled into the slot registry and how/when a device slot can be released. This batch deliberately does not define a release policy or migration. No production schema is assumed.

## Run

- Node tests: node --test backend/worker/V2.5-DEV-B1-APP-PROTOCOL-59/group-composition.test.mjs
- SQLite concurrency tests: python -m unittest backend/worker/V2.5-DEV-B1-APP-PROTOCOL-59/device_slots_sqlite_test.py

## Boundaries

- No production D1 binding, schema migration, Worker entrypoint, API route, Secret, HTML, or APK is imported or modified.
- The mapping loader contract requires the adapter to return both card owner and group owner evidence; actual production schema remains unverified.
- This batch does not implement Android persistence, background cleanup, durable tombstone storage, or client acknowledgement transport.
- APP remains APK_PENDING; third-party source/license restrictions and 6.00.48 client protocol are not audited.
