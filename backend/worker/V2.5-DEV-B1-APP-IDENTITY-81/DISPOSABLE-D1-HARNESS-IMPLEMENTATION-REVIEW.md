# Disposable D1 harness implementation review — Batch 81

- Version: `V2.5-DEV-B1-APP-IDENTITY-81`
- Status: `DESIGN_ONLY / DEFAULT_DISABLED / NO_CREDENTIALS / NO_NETWORK / NO_D1_EXECUTION`
- This is a review blueprint, not an executable D1 client or migration.

## 1. Non-negotiable default

The harness must not import Cloudflare bindings, discover credentials, read environment secrets, open network connections, infer a database, or run SQL in ordinary CI. Default invocation is a refusal:

- no `--enable-disposable-d1`: exit before loading any D1 client;
- missing exact database name, database ID, service/Worker identity, binding name, approval references or run ID: refuse;
- any production-like name, known production binding, mismatch or unknown state: refuse;
- no implicit `starjump-db` or `starjump-staging` fallback.

The harness implementation is not authorized by this design document.

## 2. Separate capabilities and approvals

| Capability | Required explicit approval | Allowed work |
|---|---|---|
| identity-read | exact environment + DB ID + binding + non-production proof | schema/migration snapshot, metadata and before-counts |
| synthetic-write | separate approval referencing the same run ID | create only synthetic rows under this run namespace |
| cleanup | separate approval after write ledger review | delete only exact IDs recorded by this run's immutable ledger |

Approval for one capability never implies another. An unknown write result is `OUTCOME_UNKNOWN`; stop, preserve evidence and reconcile using the same run ID and IDs. Never mint replacement IDs to bypass ambiguity.

## 3. Preflight sequence

1. Parse a signed-off, immutable run manifest; reject unknown keys and duplicate IDs.
2. Verify exact environment name, D1 database ID and service identity against an independently obtained allow-list, not a successful SQL query.
3. Verify exact Worker binding maps to that database ID through an independent configuration/metadata evidence path.
4. Verify dedicated isolation and no production traffic/data; if this cannot be proven, stop.
5. Verify three separate approval references and their scopes/expiry.
6. Verify no credential is present in source, command output or CI artifact; credentials, if ever introduced in a separately authorized implementation, must be runtime-injected and never echoed.
7. Capture schema, indexes, foreign keys, migration ledger and before-counts read-only; compare to the reviewed expected schema capability manifest.
8. Create a unique run namespace and append-only ledger before the first write.
9. Execute one case at a time; after every statement capture result vector and perform owner/run-scoped readback.
10. Stop on unexpected result shape, statement order, rows changed, foreign row, missing assertion, timeout, schema drift or residual artifact.

## 4. Run namespace and data ownership

Every synthetic object must be tagged with an opaque `test_run_id` or linked through a run ledger entry. Each ledger entry contains only:

- run_id, case_id, synthetic object type and opaque generated object ID;
- operation/statement ID and exact SQL SHA-256;
- creation timestamp, expected owner scope, result classification;
- cleanup eligibility state and cleanup approval reference.

Never store bind values, card codes, tokens, nonce contents, device proofs, raw IP/device identifiers, subscription URLs, secrets or real user data. If a schema cannot safely namespace synthetic rows, do not write to it; require a dedicated disposable schema/database.

## 5. Statement evidence vector

For each statement capture:

- statement ID, exact SQL hash, placeholder count and ordinal-to-semantic-name map;
- bind storage class/source/nullability metadata only (never values);
- result index, success, meta.changes, rows_read, rows_written, returned row count;
- expected/actual state vector, receipt count/exact-match boolean, audit count/exact-match boolean;
- rollback readback, run ledger IDs, before/after/residual counts;
- runtime version, UTC timestamp, redacted diagnostic code.

A successful SQL result alone is never a passing case.

## 6. Cleanup and rollback

- Cleanup is a distinct, manually approved phase, never automatic in a finally block.
- Candidate deletion IDs come exclusively from this run's append-only ledger; never build a broad predicate from user input.
- Before each deletion, verify run ID, object type, exact ID, expected owner and cleanup eligibility.
- Delete in bounded batches, then read back every exact ID and compare before/after counts.
- Any unledgered row, owner mismatch, or residual unexpected row stops cleanup.
- Preserve operation receipts, audit events and binding history unless the approved test schema explicitly tags synthetic records and the cleanup plan includes those exact IDs.
- A failed/ambiguous cleanup remains unresolved; do not report clean.

## 7. Offline CI profile

The only currently permitted CI profile is static validation:

- no network permissions;
- no D1 SDK/client dependency;
- no secrets;
- no SQL execution;
- validate the manifest schema, approval separation, fail-closed defaults, run namespace, evidence fields and ledger-only cleanup rules.

A future isolated-D1 workflow must be a separate manual workflow, disabled by default, with environment protection and an explicit approval gate. It must not share credentials with ordinary CI.

## 8. Exit criteria before implementation

All U80-01..08 decisions required by the operation being implemented are resolved; actual schema snapshot is approved; exact environment identity and binding mapping are proven; statement manifests and SQL hashes are reviewed; the D1-001..034 cases have explicit expected state vectors; rollback/cleanup are approved; APP source compatibility is known. Otherwise adapter remains unimplemented and feature flag OFF.
