import test from "node:test";
import assert from "node:assert/strict";
import { planSlotBackfill, transitionSlot, slotCountsTowardLimit } from "./slot-lifecycle.mjs";

const now = "2026-11-27T10:00:00Z";
const row = (cardId, deviceKey, entitlementId, overrides={}) => ({ cardId, deviceKey, entitlementId, state:"ACTIVE", expiresAt:"2026-12-01T00:00:00Z", ...overrides });

test("backfill deduplicates repeated active entitlement rows by card and device", () => {
  const r=planSlotBackfill({now,entitlements:[row("c1","d1","e1"),row("c1","d1","e2"),row("c1","d2","e3")]});
  assert.equal(r.ok,true); assert.equal(r.slots.length,2); assert.equal(r.slots[0].sourceEntitlementIds.length,2);
});
test("backfill never mixes the same device across different cards", () => {
  const r=planSlotBackfill({now,entitlements:[row("c1","d1","e1"),row("c2","d1","e2")]});
  assert.equal(r.slots.length,2); assert.equal(r.cards.length,2);
});
test("over-capacity legacy cards grandfather all existing devices and block new reservations", () => {
  const r=planSlotBackfill({now,limits:{c1:1},entitlements:[row("c1","d1","e1"),row("c1","d2","e2")]});
  assert.equal(r.ok,true); assert.equal(r.cards[0].overCapacity,true); assert.equal(r.cards[0].newReservationsAllowed,false);
  assert.ok(r.slots.every(s=>s.status==="GRANDFATHERED"));
});
test("expired inactive and non-active entitlements do not create new active slots", () => {
  const r=planSlotBackfill({now,entitlements:[row("c1","d1","e1",{expiresAt:"2026-11-27T09:59:59Z"}),row("c1","d2","e2",{state:"INACTIVE"}),row("c1","d3","e3")]});
  assert.equal(r.slots.length,1); assert.equal(r.slots[0].deviceKey,"d3");
});
test("unknown state and missing device key are reported, never guessed", () => {
  const r=planSlotBackfill({now,entitlements:[row("c1","d1","e1",{state:"PENDING"}),row("c1",null,"e2")]});
  assert.equal(r.ok,false); assert.equal(r.conflicts.length,2);
});
test("card renewal and VIP expiry retain the existing slot", () => {
  const slot={cardId:"c1",deviceKey:"d1",status:"ACTIVE"};
  assert.equal(transitionSlot({slot,event:"CARD_RENEWED"}).slot.status,"ACTIVE");
  assert.equal(transitionSlot({slot,event:"ADMIN_VIP_EXPIRED"}).slot.status,"ACTIVE");
});
test("card expiry and revoke hold the slot pending explicit approval", () => {
  const slot={cardId:"c1",deviceKey:"d1",status:"ACTIVE"};
  assert.equal(transitionSlot({slot,event:"CARD_EXPIRED"}).slot.status,"HELD_EXPIRED");
  assert.equal(transitionSlot({slot,event:"CARD_REVOKED"}).slot.status,"HELD_REVOKED");
});
test("device release request does not free capacity before approval", () => {
  const r=transitionSlot({slot:{cardId:"c1",deviceKey:"d1",status:"ACTIVE"},event:"DEVICE_RELEASE_REQUESTED"});
  assert.equal(r.slot.status,"RELEASE_PENDING"); assert.equal(slotCountsTowardLimit(r.slot.status),true);
});
test("release requires an auditable approver and reason", () => {
  const slot={cardId:"c1",deviceKey:"d1",status:"RELEASE_PENDING"};
  assert.equal(transitionSlot({slot,event:"DEVICE_RELEASE_APPROVED"}).code,"RELEASE_APPROVAL_INVALID");
  const r=transitionSlot({slot,event:"DEVICE_RELEASE_APPROVED",approval:{approved:true,approverId:"admin1",reason:"用户换机核验通过",releasedAt:"2026-11-27T11:00:00Z"}});
  assert.equal(r.slot.status,"RELEASED"); assert.equal(r.slot.releasedBy,"admin1"); assert.equal(slotCountsTowardLimit(r.slot.status),false);
});
test("duplicate release is idempotent and unknown events fail closed", () => {
  const slot={cardId:"c1",deviceKey:"d1",status:"RELEASED"};
  assert.equal(transitionSlot({slot,event:"DEVICE_RELEASE_APPROVED"}).code,"ALREADY_RELEASED");
  assert.equal(transitionSlot({slot,event:"FORCE_FREE"}).ok,false);
});
