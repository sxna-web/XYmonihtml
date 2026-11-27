import test from "node:test";
import assert from "node:assert/strict";
import { normalizeDeviceLimit, evaluateCardDeviceActivation, buildEntitlementGroupAllowlist, assertGroupRowsWithinAllowlist } from "./app-v2-policy.mjs";
import { nextGeneration, acceptGeneration, createTombstone, applyTombstone, acceptAcknowledgement, isLeaseValid, issueLease } from "./sync-state.mjs";
import { CARD_GROUPS_SQL, FREE_GROUPS_SQL, buildNodeScopePredicate } from "./app-v2-query-contract.mjs";
import { createAppV2ReadHandler } from "./app-v2-handler.mjs";
import { createMockD1 } from "./mock-d1-fixtures.mjs";

test("default card device limit is one", () => assert.deepEqual(normalizeDeviceLimit({}), { ok: true, maxDevices: 1, source: "DEFAULT" }));
test("active VIP admin may set a limit through five", () => assert.equal(normalizeDeviceLimit({ requestedLimit: 5, actor: "VIP_ADMIN", vipActive: true }).maxDevices, 5));
test("inactive VIP admin cannot change device limit", () => assert.equal(normalizeDeviceLimit({ requestedLimit: 2, actor: "VIP_ADMIN", vipActive: false }).code, "VIP_ADMIN_REQUIRED"));
test("VIP admin cannot set more than five", () => assert.equal(normalizeDeviceLimit({ requestedLimit: 6, actor: "VIP_ADMIN", vipActive: true }).code, "SUPER_ADMIN_REQUIRED"));
test("super admin may set more than five", () => assert.equal(normalizeDeviceLimit({ requestedLimit: 8, actor: "SUPER_ADMIN" }).maxDevices, 8));
test("invalid device limit fails closed", () => assert.equal(normalizeDeviceLimit({ requestedLimit: 0, actor: "SUPER_ADMIN" }).code, "INVALID_DEVICE_LIMIT"));
test("same device activation is idempotent", () => assert.equal(evaluateCardDeviceActivation({ maxDevices: 1, existingDeviceIds: ["device_A"], requestedDeviceId: "device_A" }).idempotent, true));
test("second device rejected at default limit", () => assert.equal(evaluateCardDeviceActivation({ maxDevices: 1, existingDeviceIds: ["device_A"], requestedDeviceId: "device_B" }).code, "CARD_DEVICE_LIMIT_REACHED"));
test("second device accepted at admin configured limit", () => assert.equal(evaluateCardDeviceActivation({ maxDevices: 2, existingDeviceIds: ["device_A"], requestedDeviceId: "device_B" }).allowed, true));
test("duplicate existing device IDs do not consume extra slots", () => assert.equal(evaluateCardDeviceActivation({ maxDevices: 2, existingDeviceIds: ["device_A", "device_A"], requestedDeviceId: "device_B" }).allowed, true));
test("identity entitlement receives only eligible free groups", () => {
 const r=buildEntitlementGroupAllowlist({ entitlement:{id:"ent_A",adminUserId:"admin_A",kind:"IDENTITY"}, groups:[{id:"free_A",adminUserId:"admin_A",mode:"free",enabled:true},{id:"card_A",adminUserId:"admin_A",mode:"card",enabled:true},{id:"free_B",adminUserId:"admin_B",mode:"free",enabled:true}], freeGrantEligible:true, freeGroupEnabled:true });
 assert.deepEqual(r.allowedGroupIds, ["free_A"]);
});
test("identity without free grant receives no groups", () => {
 const r=buildEntitlementGroupAllowlist({ entitlement:{id:"ent_A",adminUserId:"admin_A",kind:"IDENTITY"}, groups:[{id:"free_A",adminUserId:"admin_A",mode:"free",enabled:true}], freeGrantEligible:false, freeGroupEnabled:true });
 assert.deepEqual(r.allowedGroupIds, []);
});
test("card entitlement receives mapped card groups plus eligible free groups", () => {
 const r=buildEntitlementGroupAllowlist({ entitlement:{id:"ent_A",adminUserId:"admin_A",cardId:"card_123",kind:"CARD"}, groups:[{id:"card_A",adminUserId:"admin_A",mode:"card",enabled:true},{id:"card_B",adminUserId:"admin_A",mode:"card",enabled:true},{id:"free_A",adminUserId:"admin_A",mode:"free",enabled:true},{id:"public_A",adminUserId:"admin_A",mode:"public",enabled:true},{id:"card_C",adminUserId:"admin_B",mode:"card",enabled:true}], cardGroupMappings:[{cardId:"card_123",groupId:"card_A"},{cardId:"card_other",groupId:"card_B"}], freeGrantEligible:true, freeGroupEnabled:true });
 assert.deepEqual(r.groupTypes, { card:["card_A"], free:["free_A"] });
 assert.deepEqual(r.allowedGroupIds, ["card_A","free_A"]);
});
test("empty card mapping is allowed and does not widen access", () => {
 const r=buildEntitlementGroupAllowlist({ entitlement:{id:"ent_A",adminUserId:"admin_A",cardId:"card_123",kind:"CARD"}, groups:[{id:"card_A",adminUserId:"admin_A",mode:"card",enabled:true},{id:"free_A",adminUserId:"admin_A",mode:"free",enabled:true},{id:"public_A",adminUserId:"admin_A",mode:"public",enabled:true}], cardGroupMappings:[], freeGrantEligible:false, freeGroupEnabled:true });
 assert.deepEqual(r.allowedGroupIds, []);
});
test("group owner mismatch cannot enter allowlist", () => {
 const r=buildEntitlementGroupAllowlist({ entitlement:{id:"ent_A",adminUserId:"admin_A",cardId:"card_123",kind:"CARD"}, groups:[{id:"card_B",adminUserId:"admin_B",mode:"card",enabled:true}], cardGroupMappings:[{cardId:"card_123",groupId:"card_B"}] });
 assert.deepEqual(r.allowedGroupIds, []);
});
test("rows outside allowlist fail the whole response", () => {
 const r=assertGroupRowsWithinAllowlist({ rows:[{id:"group_B",adminUserId:"admin_A",mode:"card",enabled:true}], entitlementAdminUserId:"admin_A", allowedGroupIds:["group_A"] });
 assert.equal(r.ok,false);
});
test("generation increments monotonically", () => assert.deepEqual(nextGeneration(4), {ok:true,generation:5}));
test("generation overflow fails closed", () => assert.equal(nextGeneration(Number.MAX_SAFE_INTEGER).code, "GENERATION_EXHAUSTED"));
test("stale and duplicate generation rejected", () => assert.equal(acceptGeneration({currentGeneration:5,incomingGeneration:5}).accepted, false));
test("new generation accepted", () => assert.equal(acceptGeneration({currentGeneration:5,incomingGeneration:6}).accepted, true));
test("valid tombstone created", () => assert.equal(createTombstone({eventId:"evt_1",entitlementId:"ent_1",groupId:"group_1",generation:2,reason:"deleted",createdAt:"2026-11-27T12:00:00Z"}).ok, true));
test("tombstone immediately revokes local group and requests node deletion", () => {
 const event=createTombstone({eventId:"evt_1",entitlementId:"ent_1",groupId:"group_1",generation:2,reason:"deleted",createdAt:"2026-11-27T12:00:00Z"}).event;
 const r=applyTombstone({localGeneration:1,event});
 assert.equal(r.state,"REVOKED");assert.equal(r.stopUsingGroupImmediately,true);assert.equal(r.deleteLocalGroupNodes,true);
});
test("replayed tombstone is idempotently ignored", () => {
 const event={eventId:"evt_1",groupId:"group_1",generation:2,type:"REVOKE_GROUP"};
 assert.equal(applyTombstone({localGeneration:2,event}).idempotent,true);
});
test("tombstone ack must match exact entitlement group event and generation", () => {
 const event={eventId:"evt_1",entitlementId:"ent_1",groupId:"group_1",generation:2,type:"REVOKE_GROUP"};
 assert.equal(acceptAcknowledgement({expectedEvent:event,ack:{...event,result:"removed"},currentGeneration:2}).accepted,true);
 assert.equal(acceptAcknowledgement({expectedEvent:event,ack:{...event,groupId:"group_2",result:"removed"},currentGeneration:2}).code,"ACK_SCOPE_MISMATCH");
});
test("tombstone cannot be acknowledged as merely applied", () => {
 const event={eventId:"evt_1",entitlementId:"ent_1",groupId:"group_1",generation:2,type:"REVOKE_GROUP"};
 assert.equal(acceptAcknowledgement({expectedEvent:event,ack:{...event,result:"applied"},currentGeneration:2}).code,"TOMBSTONE_REQUIRES_REMOVED_ACK");
});
test("expired lease fails closed", () => assert.equal(isLeaseValid({leaseExpiresAt:"2026-11-27T11:00:00Z",serverNow:"2026-11-27T12:00:00Z"}).failClosed,true));
test("valid lease remains valid", () => assert.equal(isLeaseValid({leaseExpiresAt:"2026-11-28T10:00:00Z",serverNow:"2026-11-27T12:00:00Z"}).valid,true));
test("lease issuance caps TTL below 24 hours", () => {
 const r=issueLease({serverNow:"2026-11-27T12:00:00Z",requestedTtlSeconds:86400});
 assert.equal(r.ttlSeconds,82800);assert.equal(r.leaseExpiresAt,"2026-11-28T11:00:00.000Z");
});
test("card group SQL checks card and group owner match", () => {
 assert.match(CARD_GROUPS_SQL,/c\.admin_user_id = \?/);
 assert.match(CARD_GROUPS_SQL,/g\.admin_user_id = c\.admin_user_id/);
 assert.match(CARD_GROUPS_SQL,/g\.mode = 'card'/);
});
test("free group SQL requires eligible device grant and free permission", () => {
 assert.match(FREE_GROUPS_SQL,/p\.free_group_enabled = 1/);
 assert.match(FREE_GROUPS_SQL,/fg\.admin_user_id = g\.admin_user_id/);
 assert.match(FREE_GROUPS_SQL,/fg\.device_id = \?/);
});
test("node scope query requires explicit group IDs and owner/source checks", () => {
 const r=buildNodeScopePredicate({allowedGroupIds:["group_A","group_B"],entitlementAdminUserId:"admin_A"});
 assert.equal(r.ok,true);assert.match(r.sql,/g\.id IN \(\?,\?\)/);assert.match(r.sql,/g\.admin_user_id = \?/);assert.match(r.sql,/s\.admin_user_id = g\.admin_user_id/);assert.deepEqual(r.bindings,["group_A","group_B","admin_A"]);
});
test("empty node allowlist never creates a broad query", () => assert.equal(buildNodeScopePredicate({allowedGroupIds:[],entitlementAdminUserId:"admin_A"}).ok,false));
test("mock D1 only resolves exact entitlement and device", async () => {
 const db=createMockD1({entitlements:[{id:"ent_A",device_id:"device_A"}]});
 const row=await db.prepare("SELECT * FROM app_entitlements WHERE id = ? AND device_id = ? LIMIT 1").bind("ent_A","device_A").first();
 assert.equal(row.id,"ent_A");assert.deepEqual(db.calls[0].bindings,["ent_A","device_A"]);
});
test("handler rejects query-token style and requires Authorization header", async () => {
 const handler=createAppV2ReadHandler({resolveSession:async()=>({ok:true,deviceId:"device_A"}),resolveEntitlement:async()=>({ok:true,entitlement:{id:"ent_A"}}),loadGroups:async()=>({ok:true,allowedGroupIds:[]}),loadNodes:async()=>({ok:true,nodes:[]})});
 const res=await handler(new Request("https://example.test/api/app/v2/entitlements/entitlement_A/groups?token=leaked_token_value"));
 assert.equal(res.status,401);
});
test("handler returns empty node set for an allowed empty group list", async () => {
 let nodeReads=0;
 const handler=createAppV2ReadHandler({resolveSession:async()=>({ok:true,deviceId:"device_A"}),resolveEntitlement:async()=>({ok:true,entitlement:{id:"entitlement_A",device_id:"device_A",admin_user_id:"admin_A"}}),loadGroups:async()=>({ok:true,allowedGroupIds:[],groups:[]}),loadNodes:async()=>{nodeReads++;return {ok:true,nodes:[]};}});
 const res=await handler(new Request("https://example.test/api/app/v2/entitlements/entitlement_A/nodes",{headers:{authorization:"Bearer 0123456789abcdef"}}));
 assert.equal(res.status,200);assert.equal(nodeReads,0);assert.deepEqual((await res.json()).nodes,[]);
});
test("handler passes explicit allowlist to node adapter", async () => {
 let received;
 const handler=createAppV2ReadHandler({resolveSession:async()=>({ok:true,deviceId:"device_A"}),resolveEntitlement:async()=>({ok:true,entitlement:{id:"entitlement_A",device_id:"device_A",admin_user_id:"admin_A"}}),loadGroups:async()=>({ok:true,allowedGroupIds:["group_A"],generation:3,groups:[]}),loadNodes:async(args)=>{received=args.allowedGroupIds;return {ok:true,nodes:[{id:"node_A",adminUserId:"admin_A",groupId:"group_A"}]};}});
 const res=await handler(new Request("https://example.test/api/app/v2/entitlements/entitlement_A/nodes",{headers:{authorization:"Bearer 0123456789abcdef"}}));
 assert.equal(res.status,200);assert.deepEqual(received,["group_A"]);
});
