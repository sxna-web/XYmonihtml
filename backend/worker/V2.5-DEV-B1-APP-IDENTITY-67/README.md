# APP v2 identity durable state machine — Batch 67

- Version: `V2.5-DEV-B1-APP-IDENTITY-67`
- Date: 2026-11-27
- Status: isolated DEV contract + mock concurrency tests; no D1 adapter; no Worker route; not deployable.

## Scope and impact
Only this versioned directory and its dedicated GitHub Actions workflow are added. Batch 66 and earlier files remain unchanged. No Worker, HTML, APK, Room, D1, Secrets, Cloudflare configuration or production data is modified. Rollback is to stop referencing this directory or revert its isolated files.

## State machine contracts
- Bind challenge: pending -> consumed exactly once; consumption checks expiry, device, server-resolved admin, share-code version and enrolled device-key thumbprint in the same atomic operation.
- Request nonce: unique per (binding_id, nonce); atomic insert-if-absent; replay rejected.
- Binding: unique (admin_user_id, device_id); same key repeat is idempotent; different key conflicts; revoked binding never silently reactivates.
- Share-code rotation: compare-and-swap on expected version; exactly one concurrent rotation wins; current version increments monotonically. Existing bindings are not deleted by rotation.
- Cleanup: idempotent expiry of transient challenge/nonce records only; binding and audit history are retained.

## Required future durable adapter
The store methods are deliberately injected:
`insertChallenge`, `consumeChallengeAtomic`, `consumeNonceAtomic`, `upsertBindingAtomic`, `revokeBindingAtomic`, `rotateShareCodeAtomic`, `getCurrentShareCode`, `expireTransientRecords`.

A production D1 implementation must use conditional SQL and uniqueness constraints/transactions; no in-memory Map, Worker isolate lock, or read-then-write sequence is acceptable for atomicity. Multi-Worker concurrency must be enforced by D1 constraints/transactions. The mock uses shared maps to simulate the adapter contract; it does not prove D1 atomicity.

## Proposed logical schema (NOT verified existing D1 schema; NOT a migration)
- challenge: challenge_id PK, device_id, admin_user_id, code_version, device_key_thumbprint, issued_at, expires_at, status, consumed_at.
- request nonce: binding_id + nonce unique, device_id, consumed_at, expires_at.
- binding: binding_id PK, admin_user_id, device_id, device_key_thumbprint, share_code_version, status, created_at, revoked_at, revoke_reason; unique(admin_user_id, device_id).
- share-code version: admin_user_id unique current row, code_digest, code_version, active, rotated_at. Existing observed legacy `admin_share_codes` DDL does not contain these version/revocation fields.
- audit history must be append-only or retained separately; cleanup must not delete it.

These are design fields only. No executable SQL is provided.

## Tests
Final GitHub Actions run will be recorded in the batch report after the workflow executes. Tests cover concurrent single-use challenge, context mismatch, expiry, nonce replay, idempotent binding, cross-admin separation, key mismatch, revocation, owner scope, concurrent code rotation CAS, binding retention on rotation, idempotent cleanup, store failure and invalid proof.

## Security / unresolved
- The store adapter is not implemented against D1. D1_NOT_TESTED.
- Durable rate limiting from batch 66 remains a separate required adapter.
- Challenge signature verification and device public-key registration remain batch 66 injected cryptographic adapters.
- APK 6.00.48 / Android Keystore compatibility remains APP_PENDING.
- Share-code rotation preserving existing bindings is a proposal, not a user-confirmed production policy.
- No migration, SQL, secret change, Worker route registration or deployment.
