# APP v2 D1 compatibility preparation — Batch 60

- Version: V2.5-DEV-B1-APP-PROTOCOL-60
- Status: isolated review and regression tests; CI pending; not integrated; not deployable.

## This batch

- Reviews batch 59 multi-card composition and device slot model.
- Adds a hardened, versioned group composition helper and regression tests.
- Rejects duplicate entitlement IDs, unexpected loader results and duplicate card-group rows.
- Applies same-name serial suffix only within the same administrator scope.
- Projects only approved group display/ownership fields; does not forward arbitrary database columns.
- Keeps same-admin free groups unique by group ID; different admins remain isolated.
- Rechecks card-slot atomic insert SQL as a local SQLite model only.

## Device-slot schema proposal — design only, not a migration

Candidate extension, subject to actual schema verification and approval:

- Add `max_devices INTEGER NOT NULL DEFAULT 1` to `app_cards`, with a CHECK constraint requiring a positive integer. VIP admin writes 1–5; super-admin may write values above 5.
- Add `app_card_device_slots(card_id, device_key, created_at, released_at, release_reason)`, with primary/unique key `(card_id, device_key)`.
- `device_key` should be an opaque server-issued device identifier or keyed digest, not a raw hardware serial/IMEI.
- A card's slots are independent; the same device using two cards consumes one slot in each card.
- Existing active entitlements must be backfilled without deleting or silently invalidating any current device. If existing active devices exceed the new limit, grandfather existing rows and block new reservations until count is below the limit; report over-capacity for review.
- Expired/revoked entitlement handling and explicit device-release policy remain business decisions. No automatic release is assumed in this batch; release should be an audited server-side action.
- Backfill must be idempotent and produce a conflict report before any production migration.

No actual schema, migration, D1 binding or production database was accessed. This is not a D1 compatibility certification.

## 6.00.48 source audit status

Library listing currently contains 6.00.47 but no 6.00.48 ZIP. GitHub tree confirms `StarJump-6.00.48-source.zip` exists (2,323,467 bytes; blob SHA `2b8b6d105019fb90341c7178438b2d6b0473699f`), but the available GitHub content connector cannot read binary ZIP blobs. The attempted raw binary retrieval was unavailable. Therefore 6.00.48 remains unaudited and APP_PENDING; no license, SDK, endpoint or remote-control claims are made about it.

## Run

- `node --test backend/worker/V2.5-DEV-B1-APP-PROTOCOL-60/group-composition.test.mjs`
- `python backend/worker/V2.5-DEV-B1-APP-PROTOCOL-59/device_slots_sqlite_test.py`

## Boundaries

No existing Worker route, HTML, APK, Secrets, D1 schema, migration or Cloudflare deployment changed.
