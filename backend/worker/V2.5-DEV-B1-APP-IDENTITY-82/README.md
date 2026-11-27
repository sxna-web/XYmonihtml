# APP v2 Identity — Batch 82

Version: `V2.5-DEV-B1-APP-IDENTITY-82`
Date: 2026-11-28
Status: `SOURCE_AUDIT_COMPLETE_FOR_6_00_47 / MATRIX_NEGATIVE_REVIEW_COMPLETE / HMAC_MODEL_TEST_PASS / D1_NOT_TESTED / 6_00_48_SOURCE_PENDING / NOT_DEPLOYABLE`

## Contents

- `APK-6.00.47-CALLER-AUDIT.md`: source-level audit of the Library archive `StarJump-6.00.47-source.zip`, including routes, HTTP callers, deep links, device identity, local storage, backup behavior and current StarJump upstream slots.
- `ADAPTER-MATRIX-NEGATIVE-REVIEW.md`: independent review explaining why the Batch 81 method outline is not yet a statement-level prepared SQL manifest.
- `HMAC-ALIAS-COVERAGE-COUNTEREXAMPLES.md`: 14 adversarial cases for canonical event + key-version aliases, including the logical tuple vs version-specific fingerprint distinction.
- `hmac_alias_model.py` and `test_hmac_alias_model.py`: synthetic model only; no HMAC crypto, D1, SQL, index or production threshold.
- `test_batch82_review.py`: static review integrity checks.
- Workflow: `.github/workflows/worker-app-identity82-review.yml`.

## Main findings

1. The inspected 6.00.47 app source has no direct calls to the legacy Worker APP routes or proposed `/v1/*` identity/catalog routes.
2. The StarJump membership backend specification exists as documentation only. The app currently creates five reserved local groups and downloads a compiled-in upstream feed directly; only slot 01 has a configured source, while slots 02–05 are placeholders.
3. No APP card activation, identity ID binding, entitlement token, device proof, nonce flow or server-authoritative device slot logic was found in this archive.
4. `MainActivity` has generic subscription/profile import deep links, not a StarJump identity callback.
5. Backup is enabled for profile/config databases. Future device-bound credentials must use Keystore-backed non-exportable keys and be excluded from backup.
6. Batch 81 matrix is method-level, not statement-level; limiter/HMAC cases are not fully mapped to their own methods; nonce storage and digest encoding remain unresolved.
7. HMAC candidate A has a critical modeling issue to resolve: key-specific fingerprints differ across versions and cannot be naively compared as one identical logical tuple.

## Evidence boundary

The inspected archive SHA-256 is recorded in the APK audit. This does not prove the installed APK or 6.00.48 source. No APK runtime instrumentation, packet capture, D1, SQL, migration, Worker/HTML/APK/Room/Secrets/Cloudflare configuration change or deployment occurred.
