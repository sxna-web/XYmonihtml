import test from "node:test";
import assert from "node:assert/strict";
import { createCardGroupAdminService } from "./card-group-admin-service.mjs";
import { createCardGroupAdminHandler } from "./card-group-admin-handler.mjs";

function fixture({canRead=true,canWrite=true,cardStatus="normal",manualDisabled=0}={}) {
  const state = {
    card:{id:"card1",admin_user_id:"admin1",status:cardStatus,manual_disabled:manualDisabled,is_expired:false,code:"SECRET-REDEEM"},
    groups:[
      {id:"g1",admin_user_id:"admin1",name:"Tokyo",mode:"card",enabled:true},
      {id:"g2",admin_user_id:"admin1",name:"Osaka",mode:"card",enabled:true},
      {id:"gf",admin_user_id:"admin1",name:"Free",mode:"free",enabled:true},
      {id:"gx",admin_user_id:"admin2",name:"Other owner",mode:"card",enabled:true},
    ],
    mappings:[],
  };
  const events=[];
  let failAtomic=false;
  let commitWriteAllowed=canWrite;
  const committedRequests=new Map();
  const storage={
    async accessForAdmin(adminId) {
      events.push(["access",adminId]);
      return adminId==="admin1"?{canRead,canWrite}:null;
    },
    async loadCardGroupState(adminId,cardId) {
      events.push(["load",adminId,cardId]);
      if(adminId!==state.card.admin_user_id||cardId!==state.card.id)return null;
      return {card:state.card,groups:state.groups.filter(g=>g.admin_user_id===adminId && g.mode==="card"),mappings:state.mappings};
    },
    async replaceCardGroupsAtomically(input) {
      events.push(["atomic",input]);
      if(!commitWriteAllowed)return {ok:false,code:"VIP_READ_ONLY"};
      if(state.card.status!=="normal" && state.card.status!=="used" ||
        state.card.manual_disabled || state.card.is_expired) return {ok:false,code:"CARD_NOT_WRITABLE"};
      if(failAtomic)return {ok:false,code:"DB_BATCH_ABORTED"};
      if(committedRequests.has(input.requestId))return committedRequests.get(input.requestId);
      const selected=state.groups.filter(g=>input.groupIds.includes(g.id));
      if(selected.length!==input.groupIds.length ||
        selected.some(g=>g.admin_user_id!==input.adminId||g.mode!=="card"||!g.enabled)) {
        return {ok:false,code:"CARD_GROUP_WRITE_CONFLICT"};
      }
      const next=selected.map(g=>({
        id:"map-"+g.id,card_id:input.cardId,admin_user_id:input.adminId,
        group_id:g.id,status:"active",
      }));
      // Contract simulation: mapping replacement and audit commit together.
      const before=state.mappings;
      const audit={action:"app_card_groups.replace",actor:input.actorId,
        admin:input.adminId,card:input.cardId,groupIds:[...input.groupIds]};
      state.mappings=next;
      try { events.push(["audit",audit]); }
      catch { state.mappings=before; return {ok:false,code:"AUDIT_FAILED"}; }
      const committed={ok:true,mappings:next};
      committedRequests.set(input.requestId,committed);
      return committed;
    },
    setAtomicFailure(v){failAtomic=v;},
    setCommitWriteAllowed(v){commitWriteAllowed=v;},
    state,events,
  };
  return {storage,service:createCardGroupAdminService({storage})};
}

const scope={adminId:"admin1",actorId:"admin1",requestId:"req-123",cardId:"card1"};

test("GET returns only card groups and never returns redeem code",async()=>{
  const {service}=fixture();
  const r=await service.get(scope);
  assert.equal(r.ok,true);
  assert.deepEqual(r.groups.map(g=>g.id),["g1","g2"]);
  assert.equal(JSON.stringify(r).includes("SECRET-REDEEM"),false);
});

test("expired VIP remains readable but is read-only",async()=>{
  const {service,storage}=fixture({canRead:true,canWrite:false});
  assert.equal((await service.get(scope)).ok,true);
  const r=await service.replace({...scope,groupIds:["g1"]});
  assert.equal(r.code,"VIP_READ_ONLY");
  assert.equal(storage.events.some(e=>e[0]==="atomic"),false);
});

test("cross-admin card cannot be loaded or changed",async()=>{
  const {service}=fixture();
  const r=await service.get({...scope,adminId:"admin2"});
  assert.equal(r.code,"APP_CARD_READ_FORBIDDEN");
});

test("replace rejects duplicate group ids before storage write",async()=>{
  const {service,storage}=fixture();
  const r=await service.replace({...scope,groupIds:["g1","g1"]});
  assert.equal(r.code,"INVALID_GROUP_IDS");
  assert.equal(storage.events.some(e=>e[0]==="atomic"),false);
});

test("replace rejects free or other-admin groups",async()=>{
  const {service,storage}=fixture();
  for(const id of ["gf","gx"]){
    const r=await service.replace({...scope,groupIds:[id]});
    assert.equal(r.ok,false);
    assert.equal(storage.events.some(e=>e[0]==="atomic"),false);
  }
});

test("activated used cards remain configurable while valid",async()=>{
  const {service}=fixture({cardStatus:"used"});
  const r=await service.replace({...scope,groupIds:["g1"]});
  assert.equal(r.ok,true);
});

test("expired cards cannot be changed",async()=>{
  const {service,storage}=fixture();
  storage.state.card.is_expired=true;
  const r=await service.replace({...scope,groupIds:["g1"]});
  assert.equal(r.code,"CARD_NOT_WRITABLE");
  assert.equal(storage.events.some(e=>e[0]==="atomic"),false);
});

test("inactive/manual-disabled cards cannot be changed",async()=>{
  for(const opts of [{cardStatus:"inactive"},{manualDisabled:1}]){
    const {service,storage}=fixture(opts);
    const r=await service.replace({...scope,groupIds:["g1"]});
    assert.equal(r.code,"CARD_NOT_WRITABLE");
    assert.equal(storage.events.some(e=>e[0]==="atomic"),false);
  }
});

test("successful replace delegates atomic mapping plus audit to adapter",async()=>{
  const {service,storage}=fixture();
  const r=await service.replace({...scope,groupIds:["g1","g2"]});
  assert.equal(r.ok,true);
  assert.deepEqual(r.groups.map(g=>g.id),["g1","g2"]);
  const atomic=storage.events.find(e=>e[0]==="atomic");
  const audit=storage.events.find(e=>e[0]==="audit");
  assert.ok(atomic);
  assert.equal(audit[1].action,"app_card_groups.replace");
  assert.equal(audit[1].actor,scope.actorId);
});

test("VIP expiry between preflight and atomic commit is rejected",async()=>{
  const {service,storage}=fixture();
  storage.setCommitWriteAllowed(false);
  const r=await service.replace({...scope,groupIds:["g1"]});
  assert.equal(r.code,"VIP_READ_ONLY");
  assert.equal(r.status,403);
  assert.equal(storage.state.mappings.length,0);
  assert.equal(storage.events.some(e=>e[0]==="audit"),false);
});

test("adapter batch failure leaves mapping and audit unchanged",async()=>{
  const {service,storage}=fixture();
  storage.setAtomicFailure(true);
  const r=await service.replace({...scope,groupIds:["g1"]});
  assert.equal(r.code,"DB_BATCH_ABORTED");
  assert.equal(storage.state.mappings.length,0);
  assert.equal(storage.events.some(e=>e[0]==="audit"),false);
});

test("repeated request id is idempotent and emits one audit",async()=>{
  const {service,storage}=fixture();
  const first=await service.replace({...scope,groupIds:["g1"]});
  const second=await service.replace({...scope,groupIds:["g1"]});
  assert.equal(first.ok,true);
  assert.equal(second.ok,true);
  assert.equal(storage.events.filter(e=>e[0]==="audit").length,1);
  assert.equal(storage.state.mappings.length,1);
});

test("empty replace explicitly clears all card mappings",async()=>{
  const {service,storage}=fixture();
  await service.replace({...scope,groupIds:["g1"]});
  const r=await service.replace({...scope,groupIds:[]});
  assert.equal(r.ok,true);
  assert.deepEqual(r.groups,[]);
  assert.equal(storage.state.mappings.length,0);
});

test("handler authenticates before calling service",async()=>{
  const {service,storage}=fixture();
  const handler=createCardGroupAdminHandler({
    service,
    resolveSession:async()=>null,
  });
  const response=await handler(new Request("https://example.test/api/user/app-cards/card1/groups"));
  assert.equal(response.status,401);
  assert.equal(storage.events.length,0);
});

test("handler PUT uses explicit groupIds replace contract",async()=>{
  const {service}=fixture();
  const handler=createCardGroupAdminHandler({
    service,
    resolveSession:async()=>({effectiveId:"admin1",actorId:"admin1",requestId:"req-123"}),
  });
  const response=await handler(new Request("https://example.test/api/user/app-cards/card1/groups",{
    method:"PUT",headers:{"content-type":"application/json"},
    body:JSON.stringify({groupIds:["g1"]}),
  }));
  const body=await response.json();
  assert.equal(response.status,200);
  assert.deepEqual(body.groups.map(g=>g.id),["g1"]);
});
