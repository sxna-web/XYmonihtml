# APP v2 slot lifecycle — Batch 61

- Version: V2.5-DEV-B1-APP-PROTOCOL-61
- Date: 2026-11-27
- Status: isolated policy helper and tests; not integrated; not deployable.

## Scope

- Adds a pure slot backfill planner over normalized legacy entitlement rows.
- Deduplicates by (cardId, deviceKey), while the same device on different cards remains separate.
- Reports missing keys, unknown states and invalid expiry data instead of guessing.
- Grandfathers all existing device rows when legacy count exceeds the new card limit and blocks new reservations for that card.
- Models expiry/revocation as a held slot until a separately approved, audited release.
- Card renewal and VIP expiry/restoration do not silently create or release slots.
- Release requests remain capacity-consuming until an approver, reason and timestamped action are supplied.

## Client protocol comparison: readable 6.00.47 source only

- Room `proxy_groups` uses local numeric `id`; `ProxyEntity` belongs to a group through `groupId`.
- No entitlementId/adminId/cardId/generation/lease/cursor/ack dimensions were found in the inspected Room entities.
- `GroupManager.deleteGroup` deletes local group and its local proxy rows; this is a local user action, not proof of remote entitlement revocation.
- `GroupUpdater.finishUpdate` clears in-memory update/progress flags and notifies listeners; it is not a remote cleanup acknowledgement.
- `SagerDatabase` is Room version 7 and currently calls `fallbackToDestructiveMigration()`; adding entitlement tables/columns without replacing that migration strategy risks destructive local database reset.
- Therefore 6.00.47 is a structural reference only. It does not demonstrate the proposed v2 protocol. 6.00.48 remains unaudited and APP_PENDING.

## Data model proposal only

A future server slot record should use a unique key (card_id, device_key), opaque device key, lifecycle status, created/released timestamps, release reason, approver and audit event reference. Do not store raw IMEI/hardware serial. Do not create a production migration from this proposal.

## Required integration checks before implementation

1. Confirm actual legacy D1 card/entitlement states and exact expiry semantics.
2. Produce a read-only backfill conflict report on a verified isolated D1.
3. Confirm whether card expiry/revocation should hold capacity or permit automatic release.
4. Confirm who can approve device release: card owner VIP admin, super-admin, or both.
5. Audit 6.00.48 source and third-party restrictions.
6. Replace destructive Room fallback with explicit non-destructive migrations before adding APP v2 local entities.
7. Implement online tombstone cleanup and local lease enforcement; add Room transaction tests and device offline tests.

## Run

```sh
node --test backend/worker/V2.5-DEV-B1-APP-PROTOCOL-61/slot-lifecycle.test.mjs
```

No D1, Worker, HTML, APK, Secrets or deployment changes were made.
