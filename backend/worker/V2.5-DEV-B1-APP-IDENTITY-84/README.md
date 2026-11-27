# APP v2 Identity — Batch 84

- Batch: V2.5-DEV-B1-APP-IDENTITY-84
- Date: 2026-11-28
- Status: MODEL_AND_MANIFESTS_IMPLEMENTED / OFFLINE_REFERENCE_CHECKS_PASS_17_OF_17 / REPOSITORY_SUITE_NOT_RUN / ACTIONS_NOT_VERIFIED / D1_NOT_TESTED / NOT_DEPLOYABLE

## Files
- alias_registry_model.py / test_alias_registry_model.py: in-memory atomicity reference model and concurrency/adversarial tests. Synthetic IDs only; no HMAC cryptography, SQL or D1.
- identity_adapter-statement-manifest.json, limiter_adapter-statement-manifest.json, disposable_harness-statement-manifest.json: separate design-only manifest skeletons. SQL text/hash/placeholders/binds intentionally absent.
- statement-manifest.schema.json: common JSON Schema contract.
- manifest_validator.py / test_manifest_validator.py: static manifest boundary checks.

Run locally from this directory:
python -m unittest -v test_alias_registry_model test_manifest_validator

## Test evidence boundary

17 local reference checks were executed in this session (8 alias/concurrency/backfill scenarios and 9 manifest-boundary scenarios), all passed. The checked-in unittest files were not executed from the repository runtime; GitHub Actions status is not verified. These checks do not prove D1 transaction semantics, HMAC cryptography or production behavior.

## Critical model rule
During a multi-key overlap, a dimension mapping must be resolved with aliases for every active key version in one atomic operation. K1-only or K2-only first-seen requests are rejected. The model simulates atomicity with a process lock; this is not proof of D1 transaction/index behavior. Production must enforce equivalent uniqueness and all-or-nothing semantics with separately reviewed SQL in an authorized disposable environment.

No raw dimensions or actual fingerprints are included. No production key, threshold, retention period or SQL is selected. No D1/Worker/APK/Room/Secrets/Cloudflare changes or deployment occurred.
