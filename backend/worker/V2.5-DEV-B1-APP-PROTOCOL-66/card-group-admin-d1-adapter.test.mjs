import test from "node:test";
import assert from "node:assert/strict";
import { createCardGroupD1Adapter } from "./card-group-admin-d1-adapter.mjs";
import { canonicalCardGroupPayload } from "./card-group-admin-sql-plan.mjs";

async function digest(cardId, groupIds) {
  const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(canonicalCardGroupPayload(cardId,groupIds)));
  return [...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,"0")).join("");
}

function fakeDb() {
  const calls=[];
  const state={
    card:{id:"c1",admin_user_id:"a1",status:"used",manual_disabled:0,is_expired:0,code:"DO_NOT_READ"},
    groups:[
      {id:"g1",admin_user_id:"a1",name:"Group 1",mode:"card",enabled:1},
      {id:"g2",admin_user_id:"a1",name:"Group 2",mode:"card",enabled:1},
      {id:"free",admin_user_id:"a1",name:"Free",mode:"free",enabled:1},
    ],
    mappings:[],
    request:null,
  };
  let batchFailure=null;
  let mutateOnBatchFailure=null;
  const db={
    calls,state,
    prepare(sql){
      return {
        sql,binds:[],
        bind(...binds){this.binds=binds;return this;},
        async first(){
          calls.push({kind:"first",sql,binds:this.binds});
          if(sql.includes("app_card_group_admin_requests"))return state.request;
          if(sql.includes("FROM app_cards"))return state.card;
          return null;
        },
        async all(){
          calls.push({kind:"all",sql,binds:this.binds});
          if(sql.includes("FROM app_groups"))return {results:state.groups.filter(g=>g.mode==="card")};
          if(sql.includes("FROM app_card_group_mappings"))return {results:state.mappings};
          return {results:[]};
        },
      };
    },
    async batch(stmts){
      calls.push({kind:"batch",stmts});
      if(batchFailure){if(mutateOnBatchFailure)mutateOnBatchFailure(state);throw batchFailure;}
      const upserts=stmts.filter(s=>s.sql.startsWith("INSERT INTO app_card_group_mappings"));
      const ids=upserts.map(s=>s.binds[3]);
      state.mappings=ids.map(id=>({id:"map-"+id,card_id:"c1",admin_user_id:"a1",group_id:id,status:"active"}));
      const request=stmts.find(s=>s.sql.startsWith("INSERT INTO app_card_group_admin_requests"));
      state.request={payload_sha256:request.binds[2],response_json:request.binds[3]};
      return [...stmts.map(()=>({success:true,results:[]})),{success:true,results:state.mappings}];
    },
    setBatchFailure(error,mutate=null){batchFailure=error;mutateOnBatchFailure=mutate;},
  };
  return db;
}

const base={adminId:"a1",actorId:"a1",idempotencyKey:"idem-key-12345678",requestId:"trace-req-1",cardId:"c1",groupIds:["g1"],expectedGroupIds:[]};

test("scoped loader reads card, card-mode groups and active mappings without code",async()=>{
  const db=fakeDb();
  const adapter=createCardGroupD1Adapter({db,resolveAccess:async()=>({canRead:true,canWrite:true})});
  const state=await adapter.loadCardGroupState("a1","c1");
  assert.equal(state.card.id,"c1");
  assert.deepEqual(state.groups.map(x=>x.id),["g1","g2"]);
  assert.equal(db.calls.some(x=>/\bcode\b|redeem/i.test(x.sql)),false);
});

test("replace executes prepared D1 batch and returns only safe mapping rows",async()=>{
  const db=fakeDb();
  const adapter=createCardGroupD1Adapter({db,resolveAccess:async()=>({canRead:true,canWrite:true})});
  const r=await adapter.replaceCardGroupsAtomically(base);
  assert.equal(r.ok,true);
  assert.deepEqual(r.mappings.map(x=>x.group_id),["g1"]);
  assert.equal(JSON.stringify(r).includes("DO_NOT_READ"),false);
  const batch=db.calls.find(x=>x.kind==="batch");
  assert.ok(batch);
  assert.ok(batch.stmts.every(x=>typeof x.sql==="string"&&Array.isArray(x.binds)));
});

test("same idempotency key and same digest returns prior response without a second batch",async()=>{
  const db=fakeDb();
  const hash=await digest("c1",["g1"]);
  db.state.request={payload_sha256:hash,response_json:'{"groupIds":["g1"]}'};
  const adapter=createCardGroupD1Adapter({db,resolveAccess:async()=>({canRead:true,canWrite:true})});
  const r=await adapter.replaceCardGroupsAtomically(base);
  assert.equal(r.ok,true);
  assert.equal(r.idempotent,true);
  assert.deepEqual(r.mappings.map(x=>x.group_id),["g1"]);
  assert.equal(db.calls.some(x=>x.kind==="batch"),false);
});

test("same idempotency key with different payload returns conflict",async()=>{
  const db=fakeDb();
  db.state.request={payload_sha256:"f".repeat(64),response_json:'{"groupIds":["g1"]}'};
  const adapter=createCardGroupD1Adapter({db,resolveAccess:async()=>({canRead:true,canWrite:true})});
  const r=await adapter.replaceCardGroupsAtomically(base);
  assert.equal(r.code,"IDEMPOTENCY_CONFLICT");
  assert.equal(db.calls.some(x=>x.kind==="batch"),false);
});

test("expired VIP is read-only and cannot execute batch",async()=>{
  const db=fakeDb();
  const adapter=createCardGroupD1Adapter({db,resolveAccess:async()=>({canRead:true,canWrite:false})});
  const r=await adapter.replaceCardGroupsAtomically(base);
  assert.equal(r.code,"VIP_READ_ONLY");
  assert.equal(db.calls.some(x=>x.kind==="batch"),false);
});

test("stale mapping snapshot fails compare-and-swap before batch",async()=>{
  const db=fakeDb();
  db.state.mappings=[{id:"m1",card_id:"c1",admin_user_id:"a1",group_id:"g2",status:"active"}];
  const adapter=createCardGroupD1Adapter({db,resolveAccess:async()=>({canRead:true,canWrite:true})});
  const r=await adapter.replaceCardGroupsAtomically(base);
  assert.equal(r.code,"CARD_MAPPING_CONFLICT");
  assert.equal(db.calls.some(x=>x.kind==="batch"),false);
});

test("free group cannot be targeted",async()=>{
  const db=fakeDb();
  const adapter=createCardGroupD1Adapter({db,resolveAccess:async()=>({canRead:true,canWrite:true})});
  const r=await adapter.replaceCardGroupsAtomically({...base,groupIds:["free"]});
  assert.equal(r.code,"CARD_GROUP_NOT_AVAILABLE");
  assert.equal(db.calls.some(x=>x.kind==="batch"),false);
});

test("batch failure after VIP expiry maps to read-only and does not report success",async()=>{
  const db=fakeDb();
  db.setBatchFailure(new Error("D1 batch assertion failed"));
  let checks=0;
  const adapter=createCardGroupD1Adapter({
    db,
    resolveAccess:async()=>{checks++;return checks===1?{canRead:true,canWrite:true}:{canRead:true,canWrite:false};},
  });
  const r=await adapter.replaceCardGroupsAtomically(base);
  assert.equal(r.code,"VIP_READ_ONLY");
});

test("batch failure with no committed idempotency row maps to database abort",async()=>{
  const db=fakeDb();
  db.setBatchFailure(new Error("audit insert failed"));
  const adapter=createCardGroupD1Adapter({db,resolveAccess:async()=>({canRead:true,canWrite:true})});
  const r=await adapter.replaceCardGroupsAtomically(base);
  assert.equal(r.code,"DB_BATCH_ABORTED");
});

test("concurrent same idempotency key and same digest is recovered as idempotent",async()=>{
  const db=fakeDb();
  const hash=await digest("c1",["g1"]);
  db.setBatchFailure(new Error("unique request collision"),state=>{
    state.request={payload_sha256:hash,response_json:'{"groupIds":["g1"]}'};
  });
  const adapter=createCardGroupD1Adapter({db,resolveAccess:async()=>({canRead:true,canWrite:true})});
  const r=await adapter.replaceCardGroupsAtomically(base);
  assert.equal(r.ok,true);
  assert.equal(r.idempotent,true);
});

test("concurrent same idempotency key with different digest is rejected",async()=>{
  const db=fakeDb();
  db.setBatchFailure(new Error("unique request collision"),state=>{
    state.request={payload_sha256:"e".repeat(64),response_json:'{"groupIds":["g2"]}'};
  });
  const adapter=createCardGroupD1Adapter({db,resolveAccess:async()=>({canRead:true,canWrite:true})});
  const r=await adapter.replaceCardGroupsAtomically(base);
  assert.equal(r.code,"IDEMPOTENCY_CONFLICT");
});

test("mapping changes between read and failed batch are reported as CAS conflict",async()=>{
  const db=fakeDb();
  db.setBatchFailure(new Error("CAS assertion failed"),state=>{
    state.mappings=[{id:"map-g2",card_id:"c1",admin_user_id:"a1",group_id:"g2",status:"active"}];
  });
  const adapter=createCardGroupD1Adapter({db,resolveAccess:async()=>({canRead:true,canWrite:true})});
  const r=await adapter.replaceCardGroupsAtomically(base);
  assert.equal(r.code,"CARD_MAPPING_CONFLICT");
});

test("card disabled during batch is reported as not writable",async()=>{
  const db=fakeDb();
  db.setBatchFailure(new Error("card state assertion failed"),state=>{
    state.card.manual_disabled=1;
  });
  const adapter=createCardGroupD1Adapter({db,resolveAccess:async()=>({canRead:true,canWrite:true})});
  const r=await adapter.replaceCardGroupsAtomically(base);
  assert.equal(r.code,"CARD_NOT_WRITABLE");
});

test("delegated D1 batch carries final active scope guard",async()=>{
  const db=fakeDb();
  const adapter=createCardGroupD1Adapter({db,resolveAccess:async()=>({canRead:true,canWrite:true})});
  const r=await adapter.replaceCardGroupsAtomically({
    ...base,actorId:"super1",scope:"operate",scopeId:"scope-1",
  });
  assert.equal(r.ok,true);
  const batch=db.calls.find(x=>x.kind==="batch");
  const guard=batch.stmts[0];
  assert.match(guard.sql,/admin_user_scopes/);
  assert.ok(guard.binds.includes("scope-1"));
  assert.ok(guard.binds.includes("super1"));
});
