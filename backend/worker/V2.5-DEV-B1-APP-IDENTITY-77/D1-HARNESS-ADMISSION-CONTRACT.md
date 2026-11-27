# APP v2 Identity — fail-closed disposable D1 harness admission contract (Batch 77)

- Version: `V2.5-DEV-B1-APP-IDENTITY-77`
- Status: design specification only; no runner, credentials, network access or SQL execution added.

## 1. Default-deny contract

A future D1 harness must be inert unless every gate is explicitly supplied for the current invocation. There is no default database, binding, account, service, environment, credential source or fallback target.

Required explicit inputs:
- `ENABLE_DISPOSABLE_D1_TESTS=true` (default false);
- user-approved environment label exactly recorded as disposable;
- expected database name and exact database ID;
- exact Worker/service and binding name;
- independently verified binding-to-database ID match;
- unique test run ID generated for this invocation;
- explicit read-only approval for baseline inspection;
- separate explicit disposable-write approval;
- explicit cleanup approval for this run's synthetic records.

Missing, malformed, stale, mismatched or ambiguous input means STOP before network access. A name containing "test", "dev" or "staging" is not proof of isolation. `starjump-staging` is not an approved substitute. Production is always rejected, including aliases or a binding that resolves to a production database ID.

## 2. No implicit credentials

- The harness must not read repository files, GitHub Secrets, environment dumps, shell history, local config files, Wrangler config, or generic credential stores to discover credentials.
- Credentials, if ever needed, must be injected by an explicitly authorized operator through the approved runtime's secret mechanism; never print, persist, upload, or include them in evidence.
- Do not accept credentials as command-line arguments.
- No credential value may appear in logs, exception text, test artifacts or GitHub Actions output.
- CI for this package remains offline and must not have D1 credentials or network permissions.

## 3. Environment identity proof

Before any SQL:
1. Verify the explicit target's database ID using an independently trusted control-plane record.
2. Verify the selected Worker/service binding points to that exact database ID.
3. Verify the target is dedicated to this test and contains no production data or shared application traffic.
4. Capture a redacted environment fingerprint: environment label, database ID hash or approved opaque identifier, Worker/service version, binding name, run ID, timestamp and approver reference.
5. If any identity check cannot be independently established, stop. Do not infer database identity from a friendly name or a successful query.

A D1 SQL connection alone must not be treated as proof of environment identity.

## 4. Synthetic namespace and write scope

Every inserted test row must carry a run namespace, directly or through a dedicated synthetic owner/resource key:
- `test_run_id` is immutable and unique per run;
- all synthetic owners, devices, resources, operation IDs, event IDs and audit keys are prefixed/namespaced by that run;
- generated IDs are recorded before dependent writes;
- every query and cleanup statement includes the exact `test_run_id` predicate;
- no cleanup may use broad status/time/table-wide predicates;
- never reuse IDs across runs.

If a candidate schema has no safe run namespace field, do not mutate it; create a disposable fixture schema only after the user approves that schema creation.

## 5. Failure and stop behavior

Fail immediately on:
- any target identity mismatch;
- unexpected schema/table/column/index;
- any production-like data or shared traffic indicator;
- an unexpected unique conflict or SQL error;
- a batch result count/order mismatch;
- a missing required audit/receipt assertion;
- an unknown commit outcome;
- cleanup scope mismatch or non-zero residual artifacts;
- any network, D1 or SQL operation attempted without all approvals.

After an ambiguous timeout, mark the operation outcome unknown. Do not generate new IDs or retry with changed payload. Reuse the exact immutable IDs and payload, perform only the approved owner-scoped resolution read, and stop if resolution remains ambiguous.

## 6. Cleanup contract

- Cleanup is a separate explicit phase and requires its own approval.
- Cleanup IDs must come from this run's generated-ID ledger, not a query that discovers arbitrary rows.
- Delete in dependency order using both exact IDs and `test_run_id`.
- Never delete or mutate audit/operation receipts as transient limiter cleanup.
- Capture before/after counts for this run namespace.
- Require zero remaining synthetic rows before marking the run clean.
- If cleanup fails or scope is uncertain, stop and report residual synthetic IDs (opaque IDs only); never widen cleanup scope.

## 7. Evidence contract

For every case record:
- case ID, run ID, environment fingerprint and approval references;
- exact synthetic input values (only non-sensitive test literals);
- statement identifier/hash and bind type/order list (not secrets);
- ordered D1 result vector, success, changes, rows read/written, RETURNING count;
- expected/actual state, receipt and audit counts;
- error classification, rollback observation and timeout/outcome-unknown classification;
- cleanup ledger and final zero-artifact check;
- runtime version and UTC timestamps.

Never record real card codes, tokens, subscription URLs, device identifiers, IP addresses, user rows, private keys or secret values.

## 8. Explicit non-goals

This contract does not create an executable D1 runner, configure a binding, access Cloudflare, inspect production/staging, execute SQL, create migrations, or authorize any deployment. A future implementation requires a separately reviewed code change and fresh explicit user authorization.
