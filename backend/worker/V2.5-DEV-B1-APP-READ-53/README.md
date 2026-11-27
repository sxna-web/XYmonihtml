# APP read access policy — Batch 53

Status: isolated policy helper and unit tests only. It is NOT connected to the Worker read handlers and is NOT deployable.

The helper reuses Batch 52 exact entitlement resolution for status/groups/links/nodes. The free share-code path is explicitly classified as binding/discovery only; it cannot authorize node/group payload reads. A second scope predicate requires both entitlement administrator ownership and, for group-scoped rows, membership in an explicitly supplied allowedGroupIds list.

Important: current Worker source does not establish a verified entitlement-to-group relation suitable for this predicate. Therefore this batch does not invent a SQL join or modify any handler query. Existing read endpoints remain vulnerable until a later source/schema-backed integration is implemented.

Run:
```bash
node --test backend/worker/V2.5-DEV-B1-APP-READ-53/read-access-policy.test.mjs
```
