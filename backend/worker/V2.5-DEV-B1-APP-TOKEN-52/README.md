# V2.5 APP exact entitlement resolver — Batch 52

**Status: isolated helper implemented; Node tests added; NOT integrated into the production Worker and NOT DEPLOYABLE.**

Run:
```bash
node --test backend/worker/V2.5-DEV-B1-APP-TOKEN-52/entitlement-resolver.test.mjs
```

The resolver requires an explicit entitlement ID, device ID, and token. It performs a parameterized lookup constrained by both entitlement ID and device ID, checks active status and expiry, and delegates token verification to a supplied server-side verifier. It never chooses the newest entitlement and never accepts a client-supplied administrator identity.

The helper uses only columns already observed in the versioned Worker source: `id`, `admin_user_id`, `device_id`, `expires_at`, and `status`. This is not proof of the production D1 schema.

No existing APP endpoint is wired to this helper yet. Existing APP protocol compatibility (including query-token behavior and whether APK stores entitlement IDs) remains unverified until APK source is inspected. Free-grant, public share-code, status, and node-group scope bypasses remain open in the existing Worker and must not be considered fixed.

No D1 schema/data, Worker/HTML, Secrets, APK, Cloudflare environment, or production deployment was changed.
