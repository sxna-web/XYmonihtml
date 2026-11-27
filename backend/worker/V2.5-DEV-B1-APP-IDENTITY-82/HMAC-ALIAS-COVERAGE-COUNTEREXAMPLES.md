# HMAC canonical-event alias coverage — adversarial counterexamples (Batch 82)

- Status: model and proof review only; no key, production threshold, retention duration, SQL or D1 selected.
- Candidate reviewed: canonical logical event ledger + per-key-version aliases (Batch 81 candidate A).

## 1. Critical tuple distinction

The logical event identity and the key-version alias must be separate concepts.

A key-version fingerprint is derived using a particular HMAC key. The K1 fingerprint and K2 fingerprint for the same logical dimension are expected to differ. Therefore the complete logical tuple used for event replay equality must not naïvely include a version-specific fingerprint as though it were identical across K1 and K2.

Required model separation:
- Immutable logical event fields: event_id, action, dimension_type, event time, policy/window identity, decision and a separately defined dimension-identity consistency proof.
- Version alias: event_id, key_version, dimension_type, HMAC fingerprint and query time attributes.
- Same event_id with a changed logical tuple is integrity conflict.
- Same event_id with an alias fingerprint changed for the same key version is integrity conflict.
- Different key versions may legitimately have different fingerprints for the same logical dimension.

The safe cross-version method for proving dimension identity equality is not frozen in the current proposal. It must be designed without exposing raw IP/device/admin identifiers or using an unapproved permanent key. Until then, candidate A is not implementation-ready.

## 2. Required counterexamples

| Case | Synthetic setup | Required result |
|---|---|---|
| H82-01 | Same event_id, same logical tuple, K1 and K2 aliases | Count once |
| H82-02 | Distinct event IDs split K1-only and K2-only | Count both during overlap |
| H82-03 | Same event_id with changed action/time/window/decision | Integrity conflict |
| H82-04 | Same event_id + same key version + changed fingerprint | Integrity conflict |
| H82-05 | Old-only event missing K2 alias; attempt to retire K1 | Block retirement |
| H82-06 | Partial backfill interrupted before high-water coverage | Keep old read path; no cutover |
| H82-07 | Event admitted while backfill runs after snapshot high-water | Dual-write or catch-up ledger must cover it before cutover |
| H82-08 | Retry after commit with same event_id and same tuple | Return original logical event; do not double count |
| H82-09 | Retry with same event_id but changed tuple | Integrity conflict, not replay |
| H82-10 | Multiple event IDs share the same dimension fingerprint | All distinct event IDs count; fingerprint lookup index must be non-unique |
| H82-11 | Cleanup deletes alias but leaves live canonical event or vice versa | Reject partial cleanup; canonical row and aliases retained/deleted consistently |
| H82-12 | Cleanup races an admission retry still inside its idempotency horizon | Preserve history; no undercount |
| H82-13 | Rollback to K1 after K2-only writes | Block rollback unless K1 alias/history is complete or rebuilt and reconciled |
| H82-14 | K1 read retired while an old client retry can still arrive | Keep K1 coverage until retry/retention/rollback policy closes |

## 3. Candidate A proof obligations

1. Canonical event row uniqueness on immutable event_id.
2. Exact logical tuple replay comparison, with a frozen cross-key dimension-identity consistency mechanism.
3. Alias uniqueness on (event_id, key_version, dimension_type); fingerprint lookup is indexed but non-unique because many events can share a dimension fingerprint.
4. Event row and all required aliases for a live admission are inserted atomically.
5. Alias backfill is idempotent and checkpointed by a monotonic high-water mark.
6. Every backfill page reconciles expected IDs, inserted aliases, duplicate exact aliases and conflicts.
7. Live events after the snapshot high-water are dual-written or captured by a durable change ledger; cutover waits for catch-up to a verified later high-water.
8. Admission queries union event IDs across every still-accepted key version and deduplicate by event_id.
9. Old-key retirement requires complete coverage for all still-relevant canonical events and closure of active windows, retry/idempotency horizon, cleanup retention and approved rollback horizon.
10. Cleanup removes canonical events and all aliases in one proven atomic/serialized unit only after every retention and retry condition is satisfied.
11. Rollback proves the old query path can see all relevant K2-era events; a reverse alias/backfill or retained old alias coverage is required.
12. Integrity conflicts, alias gaps, unknown commit outcomes or incomplete high-water reconciliation fail closed.

## 4. Why a simple maximum or sum fails

- Sum of K1 and K2 counts double-counts events represented in both versions.
- Maximum of K1 and K2 counts undercounts when distinct events are split across versions.
- Correct overlap count is the cardinality of the union of logical event IDs, after exact tuple consistency checks.

## 5. Model test boundary

The companion Python model tests the logical set/alias invariants using synthetic opaque identifiers. It does not implement HMAC, D1, transaction semantics, index plans, rate-limit policy or production retention. Passing it is only a model-level counterexample check.
