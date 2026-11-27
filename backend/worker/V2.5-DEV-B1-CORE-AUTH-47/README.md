# V2.5 Core Authorization Model — Batch 47

**Status: TESTED PURE HELPER / NOT INTEGRATED INTO WORKER / NOT DEPLOYABLE.**

This directory contains an isolated, dependency-free authorization decision model for the next Worker revision. It is not wired into production or the current Worker entrypoint.

## Run tests

```bash
node --test backend/worker/V2.5-DEV-B1-CORE-AUTH-47/authorization.test.mjs
```

## Rules represented

- Active formal VIP takes precedence over an overlapping active trial.
- Active trial and active formal VIP permit the modeled VIP management actions.
- Trial expiry becomes read-only; it does not permit historical deletion.
- Formal VIP expiry permits deletion only of owned history created no later than the latest expired formal activation cutoff; it does not permit create/update/associate/disable/generate.
- VIP status query failure or malformed activation rows fail closed for sensitive operations.
- L0 basic conversion remains available with a server-resolved stable guest identity; advanced filters require active VIP.
- Direct super-admin sessions are independent of VIP.
- Super-admin assist sessions must satisfy both the delegated scope and the effective user's VIP rules.
- Resource ownership, session validity, actor/effective identity, tenant boundaries, request origin/CSRF, and audit persistence must be verified by the Worker caller; this helper does not implement them.

## Integration warning

Before route integration, verify the actual D1 activation columns, timezone formats, duplicate/overlapping activation semantics, and all protected route operations. The current Worker `vipStatus()` only returns MAX(ends_at) and historical booleans; do not feed that summary into this helper. The caller must load the activation rows needed for classification. No D1 migration or production operation is included.
