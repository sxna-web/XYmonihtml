import test from "node:test";
import assert from "node:assert/strict";
import { createComposedEntitlementGroupService } from "./composed-group-service.mjs";
import { createComposedGroupsHandler } from "./composed-groups-handler.mjs";

const DEVICE = "device_12345678";
const A = { id:"ent_A", device_id:DEVICE, admin_user_id:"admin_A", kind:"CARD", card_id:"card_A" };
const B = { id:"ent_B", device_id:DEVICE, admin_user_id:"admin_A", kind:"CARD", card_id:"card_B" };
const C = { id:"ent_C", device_id:DEVICE, admin_user_id:"admin_C", kind:"CARD", card_id:"card_C" };
const ID = { id:"ent_ID", device_id:DEVICE, admin_user_id:"admin_A", kind:"IDENTITY", card_id:null };
const cardGroup=(id,name="香港节点",adminUserId="admin_A")=>({id,name,adminUserId,mode:"card",enabled:true});
const freeA={id:"free_A",name:"免费线路",adminUserId:"admin_A",mode:"free",enabled:true};
const freeC={id:"free_C",name:"免费线路",adminUserId:"admin_C",mode:"free",enabled:true};
const credentials=(...ents)=>ents.map(ent=>({entitlementId:ent.id,token:"token-value-123456789"}));

function setup({ entitlements=[A,B], scopes={}, serials={}, resolveError, groupError, serialError }={}) {
  const resolveCalls=[];const loadCalls=[];const serialCalls=[];
  const service=createComposedEntitlementGroupService({
    resolveEntitlement:async args=>{
      resolveCalls.push(args);
      if(resolveError) throw Error("resolver unavailable");
      return {ok:true,entitlement:entitlements.find(e=>e.id===args.entitlementId && e.device_id===args.deviceId) || null};
    },
    classifyEntitlement:async ent=>({kind:ent.kind,cardId:ent.card_id ?? null}),
    loadGroupsForEntitlement:async ent=>{
      loadCalls.push(ent.id);
      if(groupError) throw Error("loader unavailable");
      return scopes[ent.id] || {ok:true,allowedGroupIds:[],cardGroups:[],freeGroups:[]};
    },
    loadCardSerialLabel:async ent=>{
      serialCalls.push(ent.id);
      if(serialError) throw Error("serial unavailable");
      return serials[ent.id] || `序列号-${ent.card_id.slice(-1)}`;
    },
  });
  return {service,resolveCalls,loadCalls,serialCalls};
}

test("same-admin multi-card preserves card groups and deduplicates one free group",async()=>{
 const {service}=setup({scopes:{
  ent_A:{ok:true,allowedGroupIds:["ga","free_A"],cardGroups:[cardGroup("ga")],freeGroups:[freeA]},
  ent_B:{ok:true,allowedGroupIds:["gb","free_A"],cardGroups:[cardGroup("gb")],freeGroups:[freeA]},
 }});
 const r=await service({deviceId:DEVICE,credentials:credentials(A,B)});
 assert.equal(r.ok,true);assert.equal(r.groups.filter(g=>g.origin==="CARD").length,2);
 assert.equal(r.groups.filter(g=>g.origin==="FREE").length,1);
});

test("same-name card groups append their own card serial labels",async()=>{
 const {service}=setup({scopes:{
  ent_A:{ok:true,allowedGroupIds:["ga"],cardGroups:[cardGroup("ga")],freeGroups:[]},
  ent_B:{ok:true,allowedGroupIds:["gb"],cardGroups:[cardGroup("gb")],freeGroups:[]},
 },serials:{ent_A:"1 序列号",ent_B:"2 序列号"}});
 const r=await service({deviceId:DEVICE,credentials:credentials(A,B)});
 assert.deepEqual(r.groups.map(g=>g.displayName).sort(),["香港节点（1 序列号）","香港节点（2 序列号）"]);
});

test("different admins keep their free groups isolated",async()=>{
 const {service}=setup({entitlements:[A,C],scopes:{
  ent_A:{ok:true,allowedGroupIds:["free_A"],cardGroups:[],freeGroups:[freeA]},
  ent_C:{ok:true,allowedGroupIds:["free_C"],cardGroups:[],freeGroups:[freeC]},
 }});
 const r=await service({deviceId:DEVICE,credentials:credentials(A,C)});
 assert.equal(r.ok,true);assert.equal(r.groups.filter(g=>g.origin==="FREE").length,2);
 assert.deepEqual(new Set(r.groups.map(g=>g.adminUserId)),new Set(["admin_A","admin_C"]));
});

test("identity entitlement contributes free groups but never card groups",async()=>{
 const {service}=setup({entitlements:[ID],scopes:{
  ent_ID:{ok:true,allowedGroupIds:["free_A"],cardGroups:[],freeGroups:[freeA]},
 }});
 const r=await service({deviceId:DEVICE,credentials:credentials(ID)});
 assert.equal(r.ok,true);assert.equal(r.groups.length,1);assert.equal(r.groups[0].origin,"FREE");
});

test("empty card groups remain empty and do not widen to all admin groups",async()=>{
 const {service}=setup({entitlements:[A],scopes:{ent_A:{ok:true,allowedGroupIds:[],cardGroups:[],freeGroups:[]}}});
 const r=await service({deviceId:DEVICE,credentials:credentials(A)});
 assert.equal(r.ok,true);assert.deepEqual(r.groups,[]);
});

test("every entitlement credential is independently resolved by exact ID and same device",async()=>{
 const {service,resolveCalls}=setup();
 await service({deviceId:DEVICE,credentials:credentials(A,B)});
 assert.deepEqual(resolveCalls.map(x=>x.entitlementId),["ent_A","ent_B"]);
 assert.ok(resolveCalls.every(x=>x.deviceId===DEVICE && x.token==="token-value-123456789"));
});

test("one invalid entitlement rejects entire composed response",async()=>{
 const {service}=setup();
 const r=await service({deviceId:DEVICE,credentials:[...credentials(A,B),{entitlementId:"ent_fake",token:"token-value-123456789"}]});
 assert.equal(r.ok,false);assert.equal(r.code,"ENTITLEMENT_SCOPE_DENIED");
});

test("duplicate entitlement credentials fail before resolver",async()=>{
 const {service,resolveCalls}=setup();
 const r=await service({deviceId:DEVICE,credentials:credentials(A,A)});
 assert.equal(r.ok,false);assert.equal(r.code,"DUPLICATE_OR_INVALID_CREDENTIAL");assert.equal(resolveCalls.length,1);
});

test("all credentials must belong to the same device",async()=>{
 const {service}=setup({entitlements:[A,{...B,device_id:"device_other_123"}]});
 const r=await service({deviceId:DEVICE,credentials:credentials(A,{...B,device_id:"device_other_123"})});
 assert.equal(r.ok,false);assert.equal(r.code,"ENTITLEMENT_SCOPE_DENIED");
});

test("missing server-side entitlement classifier fails closed at service creation",()=>{
 assert.throws(()=>createComposedEntitlementGroupService({
  resolveEntitlement:async()=>({ok:false}),
  loadGroupsForEntitlement:async()=>({ok:true,allowedGroupIds:[],cardGroups:[],freeGroups:[]}),
  loadCardSerialLabel:async()=>"1 序列号",
 }),/classifyEntitlement/);
});

test("invalid server-side entitlement classification fails closed",async()=>{
 const service=createComposedEntitlementGroupService({
  resolveEntitlement:async()=>({ok:true,entitlement:A}),
  classifyEntitlement:async()=>({kind:"UNKNOWN"}),
  loadGroupsForEntitlement:async()=>({ok:true,allowedGroupIds:[],cardGroups:[],freeGroups:[]}),
  loadCardSerialLabel:async()=>"1 序列号",
 });
 assert.equal((await service({deviceId:DEVICE,credentials:credentials(A)})).code,"ENTITLEMENT_CLASSIFICATION_INVALID");
});

test("server-side classifier cannot rebind a card entitlement to another card",async()=>{
 const service=createComposedEntitlementGroupService({
  resolveEntitlement:async()=>({ok:true,entitlement:A}),
  classifyEntitlement:async()=>({kind:"CARD",cardId:"card_other"}),
  loadGroupsForEntitlement:async()=>({ok:true,allowedGroupIds:[],cardGroups:[],freeGroups:[]}),
  loadCardSerialLabel:async()=>"1 序列号",
 });
 assert.equal((await service({deviceId:DEVICE,credentials:credentials(A)})).code,"ENTITLEMENT_CLASSIFICATION_INVALID");
});

test("resolver outage fails closed",async()=>{
 const {service}=setup({resolveError:true});
 assert.equal((await service({deviceId:DEVICE,credentials:credentials(A)})).code,"ENTITLEMENT_RESOLUTION_UNAVAILABLE");
});

test("group loader outage fails closed",async()=>{
 const {service}=setup({groupError:true});
 assert.equal((await service({deviceId:DEVICE,credentials:credentials(A)})).code,"GROUP_SCOPE_UNAVAILABLE");
});

test("card serial label outage fails closed",async()=>{
 const {service}=setup({serialError:true});
 assert.equal((await service({deviceId:DEVICE,credentials:credentials(A)})).code,"CARD_SERIAL_LABEL_UNAVAILABLE");
});

test("card group owned by another admin is rejected",async()=>{
 const {service}=setup({scopes:{ent_A:{ok:true,allowedGroupIds:["ga"],cardGroups:[cardGroup("ga","bad","admin_B")],freeGroups:[]}}});
 assert.equal((await service({deviceId:DEVICE,credentials:credentials(A)})).code,"GROUP_SCOPE_MISMATCH");
});

test("free group wrong owner or mode is rejected",async()=>{
 const {service}=setup({scopes:{ent_A:{ok:true,allowedGroupIds:["free_A"],cardGroups:[],freeGroups:[{...freeA,mode:"card"}]}}});
 assert.equal((await service({deviceId:DEVICE,credentials:credentials(A)})).code,"GROUP_SCOPE_MISMATCH");
});

test("duplicate group IDs within one card scope fail closed",async()=>{
 const {service}=setup({scopes:{ent_A:{ok:true,allowedGroupIds:["ga"],cardGroups:[cardGroup("ga"),cardGroup("ga")],freeGroups:[]}}});
 assert.equal((await service({deviceId:DEVICE,credentials:credentials(A)})).code,"GROUP_SCOPE_MISMATCH");
});

test("allowlist must exactly equal loaded card and free group IDs",async()=>{
 const {service}=setup({scopes:{ent_A:{ok:true,allowedGroupIds:["ga","foreign"],cardGroups:[cardGroup("ga")],freeGroups:[]}}});
 assert.equal((await service({deviceId:DEVICE,credentials:credentials(A)})).code,"GROUP_SCOPE_MISMATCH");
});

test("same-name groups belonging to different admins are not serial-decorated",async()=>{
 const {service}=setup({entitlements:[A,C],scopes:{
  ent_A:{ok:true,allowedGroupIds:["ga"],cardGroups:[cardGroup("ga")],freeGroups:[]},
  ent_C:{ok:true,allowedGroupIds:["gc"],cardGroups:[cardGroup("gc","香港节点","admin_C")],freeGroups:[]},
 }});
 const r=await service({deviceId:DEVICE,credentials:credentials(A,C)});
 assert.deepEqual(r.groups.map(g=>g.displayName),["香港节点","香港节点"]);
});

test("end-to-end composed handler authenticates each entitlement and deduplicates free groups",async()=>{
 const {service,resolveCalls}=setup({scopes:{
  ent_A:{ok:true,allowedGroupIds:["ga","free_A"],cardGroups:[cardGroup("ga")],freeGroups:[freeA]},
  ent_B:{ok:true,allowedGroupIds:["gb","free_A"],cardGroups:[cardGroup("gb")],freeGroups:[freeA]},
 },serials:{ent_A:"1 序列号",ent_B:"2 序列号"}});
 const handler=createComposedGroupsHandler({composeGroups:service});
 const res=await handler(new Request("https://unit.test/api/app/v2/groups/composed",{method:"POST",headers:{"x-app-device-id":DEVICE},body:JSON.stringify({credentials:credentials(A,B)})}));
 const body=await res.json();
 assert.equal(res.status,200);
 assert.equal(resolveCalls.length,2);
 assert.equal(body.groups.filter(g=>g.origin==="CARD").length,2);
 assert.equal(body.groups.filter(g=>g.origin==="FREE").length,1);
 assert.deepEqual(body.groups.filter(g=>g.origin==="CARD").map(g=>g.displayName).sort(),["香港节点（1 序列号）","香港节点（2 序列号）"]);
});

test("handler accepts composed POST and returns no-store response",async()=>{
 const handler=createComposedGroupsHandler({composeGroups:async({deviceId,credentials:creds})=>({ok:true,groups:[{id:"ga",displayName:"香港节点（1 序列号）"}],entitlementCount:creds.length,deviceId})});
 const res=await handler(new Request("https://unit.test/api/app/v2/groups/composed",{method:"POST",headers:{"x-app-device-id":DEVICE,"content-type":"application/json"},body:JSON.stringify({credentials:credentials(A,B)})}));
 assert.equal(res.status,200);assert.equal(res.headers.get("cache-control"),"no-store");assert.equal((await res.json()).groups.length,1);
});

test("handler rejects wrong method and missing device ID",async()=>{
 const handler=createComposedGroupsHandler({composeGroups:async()=>({ok:true,groups:[]})});
 assert.equal((await handler(new Request("https://unit.test/api/app/v2/groups/composed"))).status,404);
 assert.equal((await handler(new Request("https://unit.test/api/app/v2/groups/composed",{method:"POST",body:"{}"}))).status,401);
});

test("handler rejects malformed, oversized and excessive credential payloads",async()=>{
 const handler=createComposedGroupsHandler({composeGroups:async()=>({ok:true,groups:[]})});
 const mk=body=>new Request("https://unit.test/api/app/v2/groups/composed",{method:"POST",headers:{"x-app-device-id":DEVICE},body});
 assert.equal((await handler(mk("{"))).status,400);
 assert.equal((await handler(mk("x".repeat(32769)))).status,413);
 assert.equal((await handler(mk(JSON.stringify({credentials:Array.from({length:21},(_,i)=>({entitlementId:"ent_"+i,token:"token-value-123456789"}))})))).status,400);
});

test("handler does not leak dependency exceptions",async()=>{
 const handler=createComposedGroupsHandler({composeGroups:async()=>{throw Error("secret SQL detail");}});
 const res=await handler(new Request("https://unit.test/api/app/v2/groups/composed",{method:"POST",headers:{"x-app-device-id":DEVICE},body:JSON.stringify({credentials:credentials(A)})}));
 assert.equal(res.status,503);assert.equal((await res.text()).includes("secret SQL detail"),false);
});
