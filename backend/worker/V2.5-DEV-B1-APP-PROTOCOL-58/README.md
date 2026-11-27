# StarJump APP v2 isolated policy scaffold — Batch 58

- Version: `V2.5-DEV-B1-APP-PROTOCOL-58`
- Status: isolated development scaffold; not wired into the existing Worker; not deployable.
- Runtime target: Node.js 22 for tests; Worker handlers use Web APIs only.

## Scope

This batch provides:
- device limit policy (default one; active VIP admin can set 1–5; super admin can set values above 5);
- idempotent device-count evaluation;
- card/free group allowlist construction, including valid empty card mappings;
- owner and allowlist row guard;
- monotonic generation, tombstone, exact ack and lease primitives;
- SQL query contract fragments for card/free groups and explicit node group scope;
- dependency-injected APP v2 read-handler scaffold;
- deterministic mock D1 fixture and tests.

## Run

```bash
node --test backend/worker/V2.5-DEV-B1-APP-PROTOCOL-58/app-v2-policy.test.mjs
```

## Critical limits

1. No production D1 binding or Worker entrypoint is imported.
2. The SQL snippets are design/test contract fragments, not verified against production schema and not migrations.
3. Device count evaluation is a pure policy decision; production must implement atomic reservation/activation in D1 to prevent concurrent over-allocation.
4. The injected handler dependencies must be implemented by a reviewed server adapter before any integration.
5. Empty card group mapping returns no card groups; it never falls back to public/assigned/admin-wide groups.
6. A 23-hour maximum lease is used as a conservative initial policy, subject to device and clock-behavior validation.
7. This does not implement Android persistence, background scheduling, Room migrations, client acknowledgements, or 24-hour cleanup end-to-end.
8. Do not deploy or attach this scaffold to production.
