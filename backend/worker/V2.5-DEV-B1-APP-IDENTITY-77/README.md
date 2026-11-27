# APP v2 Identity — Batch 77

- Version: `V2.5-DEV-B1-APP-IDENTITY-77`
- Date: 2026-11-27
- Status: static SQL portability review + fail-closed harness design only.
- Final state: `STATIC_REVIEW_COMPLETE / D1_NOT_TESTED / APP_PENDING / NOT_DEPLOYABLE`.

## Files
- `SQL-PORTABILITY-AND-ASSERTION-REVIEW.md`: findings F77-01…F77-09, SQL/CHECK/NULL/receipt/audit/canonicalization review.
- `D1-HARNESS-ADMISSION-CONTRACT.md`: future harness default-deny admission, environment proof, synthetic run namespace, cleanup and evidence contract.
- `validate_batch77_contract.py`: offline structural guard for the harness contract; no network, credentials, D1 or SQL.

## Important findings
- CHECK needs both NOT NULL and CHECK(assertion=1), because NULL passes a CHECK expression.
- Batch 74 existing-binding path and Batch 75 non-null audit_event_key fixture are not yet contract-aligned.
- Payload canonicalization is not frozen; delimiter concatenation is ambiguous.
- Owner-scoped receipt lookup and global operation_id uniqueness need an explicit uniqueness contract.
- DO NOTHING is not proof of exact audit replay; final assertion must compare the complete immutable envelope.

No D1 connection, SQL execution, migration, Worker/HTML/APK/Room/Secret/config change or deployment occurred.
