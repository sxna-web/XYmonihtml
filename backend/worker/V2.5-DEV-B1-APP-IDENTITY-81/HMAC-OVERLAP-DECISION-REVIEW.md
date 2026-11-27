# HMAC overlap architecture decision review — Batch 81

- Status: comparative decision framework only; no production architecture, key, threshold, retention or DDL selected.
- Core invariant: logical rate-limit event identity is immutable `event_id`; the complete immutable tuple is compared across accepted key versions. Same ID/same tuple counts once; same ID/different tuple is integrity failure; distinct IDs from any accepted version all count.

## 1. Candidate comparison

| Candidate | Correctness model | Advantages | Main risks / proof burden |
|---|---|---|---|
| A. Canonical logical event + per-version aliases | One canonical event row keyed by event_id; version-specific HMAC aliases map to that event | Clear logical identity; dedupe naturally; can query aliases for each active key version; preserves cross-version union | Requires alias relation and transactionally complete alias writes; migration must prove no event lacks an alias for every accepted version; indexes/joins may cost more |
| B. Dual-write each event to every active key version + union by event_id | Duplicate version rows share one event_id; admission unions and deduplicates all accepted versions | Smaller conceptual change if current buckets already versioned; overlap is explicit | Duplicate storage; atomic all-version write required; partial write creates gaps; union query can become expensive; same-ID tuple conflict detection required |
| C. Migrate to one authoritative fingerprint namespace | Backfill all history into one canonical keyed namespace, then switch reads/writes | Simplest steady-state query and cleanup after cutover | Highest cutover proof burden; partial backfill, high-water races, rollback to old key and late retries can undercount; requires complete reconciliation and safe rollback path |

## 2. Provisional engineering preference (not production approval)

Prefer **A as the target model** when the schema can support a canonical immutable event row plus indexed version aliases. It separates logical event identity from key derivation, makes dedupe explicit and supports overlapping versions without treating key buckets as separate events.

B is an acceptable transitional pattern only if all active-version writes are one atomic decision and query plans prove bounded union/dedupe. C is attractive as a later simplification, but should not be the first migration unless full historical backfill, high-water reconciliation, late retry handling and rollback are independently proven.

This is a design preference, not a frozen production selection. Actual schema, query plans, storage cost, D1 concurrency and user-approved retention policy remain unknown.

## 3. Required migration coverage proof

For each key version and each required limiter dimension:
1. Inventory the complete historical event range and earliest/latest timestamps.
2. Record high-water mark and immutable event_id coverage before backfill.
3. Prove every canonical event has exactly one logical tuple and all required aliases for the overlap period.
4. Compare old-only, new-only, duplicated, late-arriving and same-ID/different-tuple cases.
5. Run concurrent admissions at the backfill high-water boundary; no request may be admitted using a partial history.
6. Reconcile counts by event_id union, not sum or max of bucket counts.
7. Verify every query path is covered by indexes using actual query plans and measured rows read/written.
8. Keep old read capability until all accepted retries, retention and rollback windows are closed under an explicitly approved policy.

## 4. Rollback proof

Rollback must restore a read/write mode whose history is complete for every accepted event. It is not enough to point reads back to the old bucket if events were written only under the new key. Required evidence:

- exact write cutoff and last fully reconciled event_id/high-water mark;
- complete reverse mapping or retained old aliases for all events after cutover;
- no unresolved operation IDs or retries that can arrive after rollback;
- old and new query results reconciled by event_id and tuple;
- admission paused or serialized during the mode switch, with no split-brain writer;
- post-rollback synthetic concurrent tests show no undercount and no duplicate count.

## 5. Hard prohibitions in this phase

No production key, Secret, threshold, window, retention duration, index DDL, migration SQL, or key rotation is selected. Do not calculate a numeric production limit from fixtures. D1-032..034 remain unexecuted evidence requirements.
