# HMAC limiter overlap — union/dedupe index and migration proof plan（Batch 80）

- Status: design only; no key, threshold, retention duration, SQL or migration selected.
- Core requirement: one logical admission history across every accepted HMAC key version.

## 1. Logical event model

For each admission, define an immutable logical tuple:
`event_id, action, dimension_type, dimension_fingerprint, occurred_at, policy_window_id, decision`.

The HMAC key version is a representation/version attribute, not a new logical event. During overlap, the same logical event may have multiple version-specific fingerprints. The system must:
- treat the same event_id + same complete logical tuple as one event;
- treat same event_id + changed action/dimension/fingerprint/time semantics as integrity conflict;
- count distinct event IDs across all accepted key versions together;
- avoid summing raw bucket counts (double-write duplicates) and avoid max(bucket count) (split-history undercount).

Raw IP/device/admin identifiers and HMAC secrets never enter the event ledger or evidence output.

## 2. Candidate storage/index strategies — evaluate, do not choose yet

| Strategy | Advantages | Risks / proof needed |
|---|---|---|
| A. Canonical logical event ledger + versioned fingerprint aliases | Event ID is counted once; query can join aliases to canonical logical event | Atomic insert of logical event + aliases; unique event ID; cleanup must retain aliases and canonical row together |
| B. Dual-write all accepted versions + union by event_id | Simple overlap mental model; preserves old/new lookups | D1 query/aggregation shape, index use, duplicate resolution and atomic multi-version write must be measured |
| C. Explicit migration to one authoritative new fingerprint namespace | Can simplify post-cutover queries | Backfill completeness, dual-read/write coverage, cursor checkpoint, no-gap cutover and rollback window proof required |

No strategy is approved by this document. A later implementation proposal must select one after schema snapshot, D1 query plan and workload evidence.

## 3. Required uniqueness and index hypotheses

These are logical index requirements, not executable DDL:

1. Unique immutable logical event identity: `event_id`.
2. Exact tuple consistency for repeated event_id; changed tuple must fail closed.
3. Lookup path for each active dimension: `dimension_type + dimension_fingerprint + occurred_at` (and action/policy window where applicable).
4. Version coverage lookup: `key_version + dimension_type + dimension_fingerprint + occurred_at`.
5. Cleanup path: `retain_until` plus a strict run/partition scope; cleanup must also retain event_id dedupe evidence until its full retry horizon.
6. If alias table is used, unique `(event_id, key_version, dimension_type)` and lookup indexes matching the chosen query plan.

Exact column order, covering columns, partial indexes, collation and index count remain unknown until D1 schema and EXPLAIN evidence exist.

## 4. Cross-version coverage proof

Before a key version becomes primary:
- enumerate all accepted versions and their activation/retirement boundaries;
- prove each logical event admitted during overlap is represented in the canonical ledger or every version required by the chosen strategy;
- prove same event_id maps to identical immutable tuple across versions;
- prove backfill cursor covers the complete eligible history with no gaps/duplicates;
- record high-water mark, row counts and per-partition reconciliation;
- run concurrent admission during migration and verify one logical decision;
- prove rollback to prior key version does not lose history or reopen already-consumed quota;
- do not retire old-key read coverage until all active windows, retry/idempotency horizons, cleanup retention and approved rollback horizon have elapsed.

No production time windows or thresholds are chosen.

## 5. Query-plan and cost evidence

For each relevant query shape and synthetic data distribution, record:
- EXPLAIN QUERY PLAN output (redacted schema names if needed);
- index selected and whether a table scan occurs;
- rows read/written, result cardinality and execution duration;
- split history (events only in K1, only in K2, and duplicated in both);
- skewed/high-cardinality and shared-NAT-like synthetic buckets;
- cleanup/admission concurrency and post-cleanup residual counts;
- query behavior before, during and after cutover.

Do not set a hard production cost threshold in this design phase. Compare measured cost against actual service limits and user-approved policy later.

## 6. Cleanup safety invariant

A limiter event/alias is removable only if:
- its retention deadline is strictly earlier than trusted server time;
- it is outside every active admission window;
- it is outside every event-id retry/idempotency horizon;
- it is not required to prove cross-version coverage or resolve an ambiguous commit;
- deleting it cannot make a concurrent admission undercount.

Cleanup and admission need one proven serialized/atomic boundary, or a watermark/partition protocol whose no-gap behavior is independently tested. Never clean audit events or operation receipts as limiter garbage.

## 7. Required D1 cases

Use D1-017..026 plus D1-032..034 in `D1-EVIDENCE-MAP.md`. Required adversarial vectors:
- old-only event + new-only event;
- same event duplicated old/new;
- same event ID with changed tuple;
- version enabled mid-window;
- partial backfill and interrupted backfill;
- concurrent admission at migration high-water mark;
- cleanup racing a retry after commit;
- old version retirement followed by rollback attempt.

All tests require the separately approved disposable D1. No SQL or migration is supplied here.
