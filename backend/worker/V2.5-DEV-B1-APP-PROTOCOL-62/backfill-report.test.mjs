import test from "node:test";
import assert from "node:assert/strict";
import { buildBackfillDryRunReport } from "./backfill-report.mjs";

const now="2026-11-27T10:00:00Z";
const row=(cardId,deviceKey,entitlementId,extra={})=>({cardId,deviceKey,entitlementId,state:"ACTIVE",expiresAt:"2026-12-01T00:00:00Z",...extra});

test("report counts source rows, active candidates and deduplicated slots",()=>{
  const r=buildBackfillDryRunReport({now,limits:{c1:2},rows:[row("c1","opaque-1","e1"),row("c1","opaque-1","e2"),row("c1","opaque-2","e3")]});
  assert.equal(r.status,"READY_FOR_SCHEMA_REVIEW");
  assert.deepEqual(r.summary,{scannedRows:3,activeCandidateRows:3,deduplicatedRows:1,plannedSlots:2,conflictCount:0,conflictCounts:{}});
});
test("over-capacity report preserves existing rows and blocks new reservations",()=>{
  const r=buildBackfillDryRunReport({now,limits:{c1:1},rows:[row("c1","opaque-1","e1"),row("c1","opaque-2","e2")]});
  assert.equal(r.cards[0].overCapacity,true); assert.equal(r.cards[0].newReservationsAllowed,false);
});
test("conflict report exposes reasons but never device keys or entitlement ids",()=>{
  const secretDevice="device-key-private-123";
  const r=buildBackfillDryRunReport({now,rows:[row("c1",secretDevice,"entitlement-secret",{expiresAt:"bad-time"}),row("c1",null,"entitlement-2")]});
  const serialized=JSON.stringify(r);
  assert.equal(r.status,"REVIEW_REQUIRED");
  assert.ok(!serialized.includes(secretDevice));
  assert.ok(!serialized.includes("entitlement-secret"));
  assert.ok(r.conflicts.every(c=>Object.keys(c).sort().join(",")==="conflictNumber,reason"));
});
test("unknown state is a conflict and cannot be silently classified",()=>{
  const r=buildBackfillDryRunReport({now,rows:[row("c1","opaque-1","e1",{state:"PENDING"})]});
  assert.equal(r.ok,false); assert.equal(r.summary.conflictCounts.ENTITLEMENT_STATE_UNKNOWN,1);
});
test("report always states schema is unverified and no SQL or migration ran",()=>{
  const r=buildBackfillDryRunReport({now,rows:[]});
  assert.equal(r.schemaStatus,"UNVERIFIED"); assert.equal(r.sqlExecuted,false); assert.equal(r.migrationCreated,false); assert.equal(r.approvalRequired,true);
});
