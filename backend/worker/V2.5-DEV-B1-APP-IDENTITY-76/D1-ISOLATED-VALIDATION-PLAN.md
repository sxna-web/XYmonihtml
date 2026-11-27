# APP v2 Identity — disposable D1 validation admission package (Batch 76)

- Version: `V2.5-DEV-B1-APP-IDENTITY-76`
- Date: 2026-11-27
- Status: D1 validation plan + machine-readable matrix + offline structure CI only; no D1 access, no SQL execution, no migration; `D1_NOT_TESTED / APP_PENDING / NOT_DEPLOYABLE`.

## 1. Purpose and safety boundary

This batch turns Batches 70–75 into a concrete D1 validation plan. It does not connect to Cloudflare, inspect any database, create tables, run SQL, change bindings, create a migration, modify Worker/HTML/APK/Room/Secrets, or deploy.

The only permitted future D1 target is a dedicated disposable database whose exact database name, database ID, Worker/service and binding target are confirmed by the user, with separate explicit approval for read-only inspection and disposable writes. A label such as staging/test/preview is not proof of isolation. `starjump-staging` is not accepted as a substitute. Production is prohibited.

No database ID, account ID, binding name, token or secret is included in this package.

## 2. Current platform facts checked against Cloudflare docs

1. D1 `batch()` accepts prepared statements, executes them sequentially/non-concurrently, and treats the sequence as a transaction; a statement error aborts/rolls back the batch. Results are returned in input order. This does **not** mean a successful zero-row UPDATE/INSERT-SELECT automatically errors or rolls back. See [D1 Database API](https://developers.cloudflare.com/d1/worker-api/d1-database/).
2. D1 result objects expose `success`, `meta`, and results where applicable. `meta.changes` must be interpreted separately from `success`; RETURNING shape and changes must be observed on the target runtime. See [D1 return objects](https://developers.cloudflare.com/d1/worker-api/return-object/).
3. D1 database instances are single-threaded and queue concurrent requests; overload can occur when the queue fills. Thus tests must originate from separate Worker requests/isolates but interpret database writes as serialized at the D1 database. This is not a claim of simultaneous SQL execution. See [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).
4. A Promise.race timeout does not cancel a D1 write; the write may still commit after the caller stops waiting. Timeout is `outcome-unknown`, and retries must reuse immutable operation/event/resource IDs and resolve via owner-scoped reads. See [Debug D1](https://developers.cloudflare.com/d1/observability/debug-d1/).
5. Query cost review must capture rows read/written and duration; Cloudflare exposes query insights and recommends inspecting query plans/indexes for expensive queries. See [Find slow and expensive queries](https://developers.cloudflare.com/d1/observability/find-expensive-queries/).

## 3. Admission gates — all mandatory

| Gate | Required evidence | Current status |
|---|---|---|
| Dedicated disposable D1 | Exact DB name + database ID confirmed by user | NOT PROVIDED |
| Exact binding target | Worker binding name and target DB ID match | NOT PROVIDED |
| Isolation | No production data/routes/credentials/shared binding | NOT VERIFIED |
| User approval | Separate approval for read-only inspection and disposable writes | NOT GRANTED |
| Worker/service target | Exact non-production service/version identified | NOT PROVIDED |
| Baseline snapshot | Redacted schema + migration ledger + counts captured | NOT CAPTURED |
| Reset/recovery | Disposable fixture recreation and cleanup plan verified | NOT VERIFIED |
| Cleanup ownership | Only this run's synthetic IDs can be removed | NOT VERIFIED |

**Stop rule:** if any gate is missing, inconsistent, or ambiguous, do not connect and do not run any SQL. Do not guess account, database, binding, service, or environment.

## 4. Test execution phases after admission

### Phase A — identity and read-only baseline

- Confirm exact database ID from the intended binding and user-approved environment record.
- Capture redacted `sqlite_master` objects, table columns, indexes, foreign keys, user_version and migration ledger.
- Record schema object counts and table row counts only; never export business rows, card codes, subscription URLs, tokens or device identifiers.
- Save a fingerprint of the schema snapshot and a redacted evidence bundle.
- If the target contains unexpected production-like tables/data or shared bindings, stop and discard the test plan.

### Phase B — disposable capability probes

Only after explicit disposable-write approval:
- Test CHECK true and CHECK false independently.
- Test a false CHECK assertion as the last statement of a batch preceded by a synthetic write; verify the preceding write is absent.
- Test scalar EXISTS inside INSERT-SELECT/CASE expressions and exact audit envelope comparison.
- Test prepared binding with text, integer, NULL, Unicode, quotes, delimiters and JSON strings.
- Record batch result vector ordering, `success`, `meta.changes`, rows_read, rows_written and RETURNING results.
- Verify zero-row success separately from SQL error rollback.
- Verify unique conflict classification separately from unrelated SQL errors.

### Phase C — identity operation semantics

Use synthetic owners/resources only:
- Owner-scoped operation receipt: owner A can read its own receipt; owner B and missing owner produce indistinguishable results.
- Binding create: same owner/device/key competing requests yield one binding and one creation audit; different key thumbprints conflict without overwrite.
- Revoke: same expected generation race yields one CAS transition and one matching audit.
- Rotation: same expected version race yields one version increment and one matching audit.
- Missing/mismatched required audit must fail the final assertion and roll back all earlier state writes in that same batch.
- Response dropped after commit: retry exact immutable IDs; no second mutation/audit.

### Phase D — durable limiter semantics

- Race multiple distinct event IDs from separate requests/isolates; admitted count must not exceed each configured *test-only* dimension limit.
- Same event ID + identical complete tuple is one logical admission; changed action/bucket/fingerprint is a conflict.
- Missing required dimensions fail closed; optional dimensions must be explicitly marked not applicable.
- Shared NAT: measure network-bucket effects separately from device/admin buckets; do not choose production thresholds from a synthetic fixture.
- Clock forward/backward tests, exact window boundaries and multi-dimensional Retry-After.
- Cleanup races: only rows strictly beyond approved retention and no longer needed by any active window/retry allowance may be removed.
- HMAC key rotation must not split active windows into separate buckets. Test versioned overlap/dual lookup behavior before selecting a production key-rotation policy.

### Phase E — query plan, cost and exit

- Run `EXPLAIN QUERY PLAN` on each limiter query against the disposable fixture.
- Capture D1 result metadata and, where available, D1 Insights: query duration, rows read, rows written, errors, overloads.
- Verify expected indexes are used; inspect any full scan and excessive read amplification.
- Capture final synthetic row counts; delete only the exact IDs generated by the test run; verify no test artifacts remain.
- Preserve redacted evidence and record every case as PASS/FAIL/BLOCKED with actual observed result.

## 5. Machine-readable matrix

- `d1_validation_matrix.json`: 26 test cases, unique IDs D1-001 through D1-026.
- `validate_d1_validation_matrix.py`: offline structural validator. It does not import Cloudflare SDKs, access network, read credentials or execute SQL.
- Workflow `.github/workflows/worker-app-identity76-matrix.yml`: validates only matrix completeness/safety structure.

The JSON is an executable test specification/data contract, not a D1 runner. No SQL is executed by this batch.

## 6. Required evidence for every future D1 case

Record:
- case ID and test run ID;
- approved environment fingerprint (never secrets);
- Worker/service version and binding-to-database match;
- UTC timestamps and request correlation IDs;
- exact synthetic input tuple;
- redacted prepared statement identity and bind-type list (never sensitive values);
- ordered D1 result vector with success/changes/rows_read/rows_written and RETURNING row counts;
- expected versus actual state and audit row counts;
- error classification and whether the batch rolled back;
- cleanup IDs and zero-artifact confirmation.

## 7. Semantic gaps that remain open

1. The CHECK assertion candidate must be proven on D1, especially scalar EXISTS expression, constraint error shape and full batch rollback.
2. Do not assume every `RETURNING` statement reports `meta.changes` identically; verify actual D1 runtime. If unstable, use a scoped read after the batch while preserving atomic assertion inside the batch.
3. D1 single-threaded execution does not eliminate the need for multi-request race tests: test the application-level one-winner invariant, queue/overload behavior and retry classification.
4. Limiter thresholds, windows, timestamp precision, skew margin, retention duration and shared-NAT policy remain unapproved. Do not hard-code them.
5. HMAC bucket-key rotation overlap and old-key retirement must preserve active-window matching; no key is created or changed in this batch.
6. Audit/receipt retention and legal hold are not confirmed. Never include audit or operation receipts in transient cleanup.
7. Share-code rotation effects on bindings, sessions, challenges and free-group grants remain unconfirmed.
8. APP 6.00.48 source and third-party restrictions remain unaudited; no Android compatibility claim.

## 8. Rollback and non-goals

This batch adds only versioned documentation, JSON test vectors, an offline validator and a GitHub Actions workflow. Rollback is to stop referencing this batch directory/workflow or revert its commits. No database object or business data is changed.

No D1 connection, SQL, migration, Worker/API/HTML/APK/Room/Secret/config change, production/staging operation or deployment occurred.

Status: `D1_NOT_TESTED / APP_PENDING / NOT_DEPLOYABLE`.
