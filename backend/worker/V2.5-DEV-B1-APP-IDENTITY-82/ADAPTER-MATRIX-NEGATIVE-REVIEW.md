# APP v2 adapter matrix independent negative review — Batch 82

- Status: static review only; no SQL or D1 execution.
- Reviewed input: Batch 81 `ADAPTER-STATEMENT-ASSERTION-MATRIX.json`, Batch 77–80 contracts and Batch 80 `D1-EVIDENCE-MAP.md`.

## 1. Overall disposition

Batch 81 matrix is a useful method-level contract outline, but its name/claims are stronger than the evidence it contains. It is **not yet a statement-level SQL/bind manifest** and must not be used as an implementation-ready prepared-statement specification.

## 2. Findings

### F82-M01 — statement granularity is missing

Each method has one `bind_contract` array, but there are no stable statement IDs, SQL text/hash, positional placeholder ordinals, per-statement bind arrays, result index, or SQL-to-bind lexical mapping. Methods such as `upsertBindingAtomic` combine insert and select contracts, so one flat list cannot prove the exact binding order for each statement.

Required before implementation: one record per actual SQL statement with statement_id, exact SQL SHA-256, placeholder tokenizer version, 1-based ordinal, semantic name, source, storage class, nullability/missing policy and redaction class. No executable SQL is added in this batch.

### F82-M02 — D1 case map does not mean every case is method-mapped

The matrix contains D1-001..034 labels, but:
- D1-017..026 are limiter-specific and are not attached to a limiter admission/read/cleanup method in the eight-method list.
- D1-032..034 are HMAC union, cleanup-vs-union and migration/index coverage cases; they are not method-level adapter cases.
- D1-025 is HMAC key overlap, not covered by the identity methods.

Therefore describe the matrix as a case inventory plus partial method mapping, not complete statement-level coverage. A future limiter adapter contract needs its own methods and statement map.

### F82-M03 — `expireTransientRecords` mixes harness and product responsibilities

Its source is listed as `synthetic_run_ledger`, and its audit says `test_run_ledger_only`. That is disposable harness cleanup, not an approved production identity-adapter method. Remove it from any future production adapter interface; keep harness cleanup in a separate tool with ledger-only exact-ID deletion and independent approval.

### F82-M04 — nonce storage representation is unresolved

`consumeNonceAtomic` currently binds `nonce:text:required`. Batch 72/80 explicitly leave nonce encoding and uniqueness scope unresolved. Do not persist raw nonce or silently select a digest/HMAC format from this outline. Freeze the nonce canonicalization, one-time scope, key versioning and retention contract first; logs/audit must never contain the raw nonce.

### F82-M05 — digest storage class is ambiguous

`rotateShareCodeAtomic` declares `new_digest:blob_or_text:required`. A prepared bind must have one exact storage class and encoding. Select bytes-vs-text, canonical alphabet/encoding and comparison semantics only after the secret-handling contract is reviewed; do not allow the implementation to choose per call.

### F82-M06 — operation and audit fields remain under-specified

No per-statement manifest establishes how owner, actor, target, operation ID, reason, timestamp, canonicalization version and audit payload are sourced/bound. U80-01..08 still block event policy and rotation side effects. Existing and created outcomes must remain distinct.

### F82-M07 — zero-row and batch rollback are design assertions, not verified runtime facts

The matrix correctly identifies zero-row and rollback cases, but no actual D1 result vectors exist. `meta.changes`, `RETURNING`, CHECK NULL behavior, batch statement order and rollback must be proven against the exact approved disposable D1 runtime. SQLite/mock success is not substitute evidence.

### F82-M08 — SQL placeholder lexical handling needs a real tokenizer

A raw question-mark count is insufficient. The future linter must distinguish placeholders from:
- single-quoted strings with doubled quotes;
- double-quoted identifiers/strings with doubled quotes;
- backtick-quoted identifiers;
- bracket-quoted identifiers;
- line comments `-- ...`;
- block comments `/* ... */`;
- positional `?` vs numbered `?NNN`;
- named `:name`, `@name`, `$name` parameters.

If the adapter standard is anonymous positional `?` only, reject numbered/named parameter forms and prove that every remaining placeholder has exactly one bind in textual order. Unterminated quotes/comments and ambiguous SQL must fail closed. A regex-only counter is not acceptable.

### F82-M09 — D1 case IDs need a source-of-truth join

The JSON map descriptions are concise aliases. The normative expected behavior remains Batch 80 `D1-EVIDENCE-MAP.md`; any future changes must preserve its exact expected state vectors and approval gates. Do not derive tests from the short labels alone.

## 3. Required disposition

- Keep adapter implementation blocked.
- Split production identity methods, limiter methods and test-harness cleanup into distinct interfaces.
- Add a true statement manifest only after exact schema and business contracts are approved.
- Keep nonce representation, digest encoding, actor/outcome/reason/payload and rotation effects unresolved where user decisions are missing.
- No D1, SQL, migration, Worker, HTML, APK, Room, Secrets, Cloudflare config or deployment change occurred in this batch.
