import test from "node:test";
import assert from "node:assert/strict";
import { composeEntitlementGroups } from "./group-composition.mjs";
import { createEntitlementGroupLoader } from "./group-loader.mjs";
import { reserveCardDeviceSlot, RESERVE_CARD_DEVICE_SQL } from "./device-slot-adapter.mjs";
import { createAppV2ReadHandler } from "../V2.5-DEV-B1-APP-PROTOCOL-58/app-v2-handler.mjs";
import { applyTombstone, acceptAcknowledgement, isLeaseValid } from "../V2.5-DEV-B1-APP-PROTOCOL-58/sync-state.mjs";

const cardA={id:"ent_A",adminUserId:"admin_A",kind:"CARD",cardId:"card_A",cardSerialLabel:"序列号-001"};
const cardB={id:"ent_B",adminUserId:"admin_A",kind:"CARD",cardId:"card_B",cardSerialLabel:"序列号-002"};
const cardGroup=(id,name="香港节点")=>({id,name,adminUserId:"admin_A",mode:"card",enabled:true});
const freeGroup={id:"free_A",name:"免费线路",adminUserId:"admin_A",mode:"free",enabled:true};

test("same admin multi-card keeps each card group and deduplicates admin free group",()=>{
 const r=composeEntitlementGroups({entitlements:[cardA,cardB],groupsByEntitlement:[
  {entitlementId:"ent_A",cardGroups:[cardGroup("ga")],freeGroups:[freeGroup]},
  {entitlementId:"ent_B",cardGroups:[cardGroup("gb")],freeGroups:[freeGroup]},
 ]});
 assert.equal(r.ok,true);assert.equal(r.groups.filter(g=>g.origin==="CARD").length,2);
 assert.equal(r.groups.filter(g=>g.origin==="FREE").length,1);
});

test("same-name card groups are both labelled with their own card serial",()=>{
 const r=composeEntitlementGroups({entitlements:[cardA,cardB],groupsByEntitlement:[
  {entitlementId:"ent_A",cardGroups:[cardGroup("ga")],freeGroups:[]},
  {entitlementId:"ent_B",cardGroups:[cardGroup("gb")],freeGroups:[]},
 ]});
 assert.deepEqual(r.groups.map(g=>g.displayName).sort(),["香港节点（序列号-001）","香港节点（序列号-002）"]);
});

test("different admins retain one independent free group each",()=>{
 const entC={id:"ent_C",adminUserId:"admin_C",kind:"CARD",cardId:"card_C",cardSerialLabel:"序列号-003"};
 const freeC={...freeGroup,id:"free_C",adminUserId:"admin_C"};
 const r=composeEntitlementGroups({entitlements:[cardA,cardB,entC],groupsByEntitlement:[
  {entitlementId:"ent_A",cardGroups:[],freeGroups:[freeGroup]},
  {entitlementId:"ent_B",cardGroups:[],freeGroups:[freeGroup]},
  {entitlementId:"ent_C",cardGroups:[],freeGroups:[freeC]},
 ]});
 assert.equal(r.groups.filter(g=>g.origin==="FREE").length,2);
});

test("malicious cross-admin or wrong-mode group row fails closed",()=>{
 const r=composeEntitlementGroups({entitlements:[cardA],groupsByEntitlement:[
  {entitlementId:"ent_A",cardGroups:[{...cardGroup("bad"),adminUserId:"admin_B"}],freeGroups:[]},
 ]});
 assert.equal(r.ok,false);assert.equal(r.code,"CARD_GROUP_SCOPE_MISMATCH");
});

test("identity entitlement cannot inject card groups",()=>{
 const identity={id:"ent_I",adminUserId:"admin_A",kind:"IDENTITY"};
 const r=composeEntitlementGroups({entitlements:[identity],groupsByEntitlement:[
  {entitlementId:"ent_I",cardGroups:[cardGroup("bad")],freeGroups:[]},
 ]});
 assert.equal(r.code,"IDENTITY_CARD_GROUP_FORBIDDEN");
});

test("loader checks card/admin mapping and returns empty card mapping without widening",async()=>{
 const loader=createEntitlementGroupLoader({
  loadCardMappings:async()=>[],loadGroups:async()=>[cardGroup("cg"),freeGroup],
  hasFreeGrant:async()=>false,isFreeEnabled:async()=>true,
 });
 const r=await loader({id:"ent_A",admin_user_id:"admin_A",device_id:"device_A",kind:"CARD",card_id:"card_A"});
 assert.equal(r.ok,true);assert.deepEqual(r.allowedGroupIds,[]);assert.deepEqual(r.cardGroups,[]);assert.deepEqual(r.freeGroups,[]);
});

test("loader rejects mismatched card, card-owner, or group-owner mapping",async()=>{
 const loader=createEntitlementGroupLoader({
  loadCardMappings:async()=>[{cardId:"card_A",groupId:"cg",cardAdminUserId:"admin_B",groupAdminUserId:"admin_A"}],
  loadGroups:async()=>[cardGroup("cg")],hasFreeGrant:async()=>false,isFreeEnabled:async()=>false,
 });
 const r=await loader({id:"ent_A",admin_user_id:"admin_A",device_id:"device_A",kind:"CARD",card_id:"card_A"});
 assert.equal(r.ok,false);assert.equal(r.code,"CARD_GROUP_OWNER_MISMATCH");
});

test("loader fails closed on adapter outage",async()=>{
 const loader=createEntitlementGroupLoader({loadCardMappings:async()=>{throw Error("offline")},loadGroups:async()=>[],hasFreeGrant:async()=>false,isFreeEnabled:async()=>false});
 const r=await loader({id:"ent_A",admin_user_id:"admin_A",device_id:"device_A",kind:"CARD",card_id:"card_A"});
 assert.equal(r.ok,false);assert.equal(r.code,"GROUP_DATA_UNAVAILABLE");
});

test("atomic reservation SQL is one conditional insert with uniqueness idempotency",()=>{
 assert.ok(RESERVE_CARD_DEVICE_SQL.includes("SELECT ?, ?, ?"));
 assert.ok(RESERVE_CARD_DEVICE_SQL.includes("COUNT(*) FROM app_card_device_slots WHERE card_id = ?"));
 assert.ok(RESERVE_CARD_DEVICE_SQL.includes("ON CONFLICT(card_id, device_id) DO NOTHING"));
 assert.ok(RESERVE_CARD_DEVICE_SQL.includes("RETURNING"));
});

test("reservation adapter binds card, device, timestamp, card, limit in exact order",async()=>{
 const calls=[];const db={prepare(sql){return {bind(...args){calls.push({sql,args});return {first:async()=>({card_id:args[0],device_id:args[1],created_at:args[2]})}}}}};
 const r=await reserveCardDeviceSlot(db,{cardId:"card_A",deviceId:"device_A",maxDevices:2,now:"2026-11-27T12:00:00Z"});
 assert.equal(r.ok,true);assert.deepEqual(calls[0].args,["card_A","device_A","2026-11-27T12:00:00Z","card_A",2]);
});

test("reservation adapter distinguishes existing device idempotency from full card",async()=>{
 let count=0;const db={prepare(){return {bind(){return {first:async()=>++count===1?null:{card_id:"card_A",device_id:"device_A"}}}}}};
 const r=await reserveCardDeviceSlot(db,{cardId:"card_A",deviceId:"device_A",maxDevices:1,now:"2026-11-27T12:00:00Z"});
 assert.equal(r.ok,true);assert.equal(r.idempotent,true);
});

test("handler rejects forged entitlement and cross-device binding",async()=>{
 const handler=createAppV2ReadHandler({resolveSession:async()=>({ok:true,deviceId:"device_A"}),resolveEntitlement:async()=>({ok:true,entitlement:{id:"entitlement_A",device_id:"device_B",admin_user_id:"admin_A"}}),loadGroups:async()=>({ok:true,allowedGroupIds:[],groups:[]}),loadNodes:async()=>({ok:true,nodes:[]})});
 const res=await handler(new Request("https://x.test/api/app/v2/entitlements/entitlement_A/groups",{headers:{authorization:"Bearer 0123456789abcdef"}}));
 assert.equal(res.status,403);
});

test("handler rejects malicious group row instead of leaking it",async()=>{
 const handler=createAppV2ReadHandler({resolveSession:async()=>({ok:true,deviceId:"device_A"}),resolveEntitlement:async()=>({ok:true,entitlement:{id:"entitlement_A",device_id:"device_A",admin_user_id:"admin_A"}}),loadGroups:async()=>({ok:true,allowedGroupIds:["group_A"],groups:[{id:"group_B",adminUserId:"admin_A",mode:"card",enabled:true}]}),loadNodes:async()=>({ok:true,nodes:[]})});
 const res=await handler(new Request("https://x.test/api/app/v2/entitlements/entitlement_A/groups",{headers:{authorization:"Bearer 0123456789abcdef"}}));
 assert.equal(res.status,403);
});

test("out-of-order acknowledgement cannot acknowledge a newer generation event",()=>{
 const event={eventId:"evt_new",entitlementId:"ent_A",groupId:"group_A",generation:8,type:"REVOKE_GROUP"};
 const ack={...event,generation:7,result:"removed"};
 assert.equal(acceptAcknowledgement({expectedEvent:event,ack,currentGeneration:8}).code,"ACK_SCOPE_MISMATCH");
});

test("tombstone duplicate is idempotent and stale event cannot restore a group",()=>{
 const event={eventId:"evt_8",entitlementId:"ent_A",groupId:"group_A",generation:8,type:"REVOKE_GROUP"};
 assert.equal(applyTombstone({localGeneration:8,event}).idempotent,true);
 assert.equal(applyTombstone({localGeneration:9,event}).idempotent,true);
});

test("lease expires at exact boundary and malformed time fails closed",()=>{
 assert.equal(isLeaseValid({leaseExpiresAt:"2026-11-27T12:00:00Z",serverNow:"2026-11-27T12:00:00Z"}).code,"LEASE_EXPIRED");
 assert.equal(isLeaseValid({leaseExpiresAt:"not-a-date",serverNow:"2026-11-27T11:00:00Z"}).failClosed,true);
});
