# V2.5 APP links/cards handler tests — Batch 50

**Status: Node.js Worker.fetch + mock D1 tests passed; no production D1 or Cloudflare runtime validation; NOT DEPLOYABLE.**

The tests import the immutable batch 49 Worker revision:
`../V2.5-DEV-B1-CORE-AUTH-49/Worker.js`

Run:
```bash
node --experimental-default-type=module --test backend/worker/V2.5-DEV-B1-CORE-AUTH-50/app-links-cards-handler.test.mjs
```

Coverage:
- APP links create/delete authorization and owner/cutoff SQL
- APP cards generate/soft-disable authorization and owner predicates
- L1, active trial, expired formal, direct super-admin, assist session, activation query failure
- Mock D1 batch writes and business-table write assertions

This is handler-level Node testing with a mock D1 binding. It is not Cloudflare Workers runtime testing or real D1 integration. No Worker business code, D1 schema/data, Secrets, HTML, or production environment was changed.
