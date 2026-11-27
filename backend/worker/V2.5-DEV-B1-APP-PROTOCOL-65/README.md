# APP v2 multi-entitlement group composition — Batch 65

- Version: `V2.5-DEV-B1-APP-PROTOCOL-65`
- Date: 2026-11-27
- Status: isolated DEV implementation; CI pending; not wired into existing Worker; not deployable.

## API contract proposal (not registered in production)

`POST /api/app/v2/groups/composed`

Header:
- `X-App-Device-ID: <device-id>`

JSON body:
```json
{
  "credentials": [
    { "entitlementId": "entitlement-id-1", "token": "entitlement-token-1" },
    { "entitlementId": "entitlement-id-2", "token": "entitlement-token-2" }
  ]
}
```

Tokens are placed in the POST body, not the URL or logs. Each credential is independently verified by the exact entitlement resolver against the same device ID. The service rejects duplicate IDs, mixed devices, missing/invalid entitlements and any failed group scope. There is no latest-entitlement fallback. Maximum 20 entitlements and 32 KiB request body.

## Composition rules

- Each CARD entitlement retains only its own card-mapped card groups.
- Each entitlement may contribute free groups only when its injected group loader confirms the grant and admin free-group setting.
- Same administrator free groups are de-duplicated by group ID; different administrators remain isolated.
- Same-name card groups are decorated with their own server-derived serial label, e.g. `香港节点（1 序列号）`; actual redeemable card codes are never returned.
- IDENTITY entitlement may contribute free groups but cannot contribute card groups.
- Empty card group mappings remain empty; no widening to all admin groups.
- Any duplicate, owner/mode mismatch, allowlist mismatch, or loader/resolver failure fails closed for the whole response.

## Integration boundary

The service accepts injected `resolveEntitlement`, `classifyEntitlement`, `loadGroupsForEntitlement`, and `loadCardSerialLabel` dependencies. Classification is a mandatory server-side adapter: it must derive CARD vs IDENTITY from verified server records and must not trust request fields. For CARD, the classified card ID must match the resolved entitlement's card_id whenever present. This is intentionally explicit because the existing observed entitlement schema does not establish a universal `kind` column. The expected group loader is compatible with the Batch 59 dependency-injected loader, while composition reuses Batch 60's hardened projection. The real SQL adapters are not implemented here because the production D1 schema and isolated D1 binding have not been verified.

The batch 64 single-entitlement `groups/nodes/links/status` routes remain unchanged. This new composed endpoint is a separately isolated proposal for the APP multi-card group-list use case. Node reads remain scoped to the exact entitlement and must not use the union of groups from other cards.

## Run

```bash
node --test backend/worker/V2.5-DEV-B1-APP-PROTOCOL-65/composed-group-service.test.mjs
```

## Limits

- No production Worker route registration or feature flag change.
- No D1 SQL/schema/migration, Cloudflare secret, HTML, APK, Room, or deployment changes.
- No real D1 or Android client compatibility test.
- 6.00.48 remains unaudited; APP_PENDING. D1 remains D1_NOT_TESTED.
