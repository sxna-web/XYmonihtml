import test from "node:test";
import assert from "node:assert/strict";
import { authorizeAppManagementRequest, _actionForTest } from "./worker-auth-adapter.mjs";

const now = "2026-11-27T12:00:00.000Z";
const trialActive = [{kind:"trial",starts_at:"2026-11-20T00:00:00Z",ends_at:"2026-11-28T00:00:00Z"}];
const trialExpired = [{kind:"trial",starts_at:"2026-11-01T00:00:00Z",ends_at:"2026-11-02T00:00:00Z"}];
const formalActive = [{kind:"formal",starts_at:"2026-11-01T00:00:00Z",ends_at:"2026-12-01T00:00:00Z"}];
const formalExpired = [{kind:"formal",starts_at:"2026-10-01T00:00:00Z",ends_at:"2026-11-01T00:00:00Z"}];

function mockDb({activations=[], resource={id:"g1",created_at:"2026-10-20 00:00:00"}}={}) {
  const calls = { reads: [], writes: 0 };
  return {
    calls,
    prepare(sql) {
      calls.reads.push(sql);
      return {
        bind(...args) {
          return {
            async all() { return {results: activations}; },
            async first() { return sql.includes("admin_vip_activations") ? null : resource; },
            async run() { calls.writes++; return {meta:{changes:1}}; },
          };
        },
      };
    },
  };
}
const user = {actorId:"u1",effectiveId:"u1",isSuper:false,scope:null,legacy:false};

test("maps all supported write operations and leaves GET outside gate",()=>{
  assert.equal(_actionForTest("/api/user/app-groups","GET"),null);
  assert.equal(_actionForTest("/api/user/app-groups","POST"),"create");
  assert.equal(_actionForTest("/api/user/app-groups/g1","PUT"),"update");
  assert.equal(_actionForTest("/api/user/app-groups/g1","DELETE"),"delete_history");
  assert.equal(_actionForTest("/api/user/app-groups/g1/sources","POST"),"associate");
  assert.equal(_actionForTest("/api/user/app-groups/g1/members","POST"),"associate");
  assert.equal(_actionForTest("/api/user/app-links","POST"),"create");
  assert.equal(_actionForTest("/api/user/app-links/l1","DELETE"),"delete_history");
  assert.equal(_actionForTest("/api/user/app-cards","POST"),"generate");
  assert.equal(_actionForTest("/api/user/app-cards/c1","DELETE"),"disable");
  assert.equal(_actionForTest("/api/user/app-cards/c1/disable","POST"),"disable");
});

test("L1/no VIP cannot create and performs no writes",async()=>{
  const db=mockDb();
  const r=await authorizeAppManagementRequest({db,path:"/api/user/app-groups",method:"POST",ctx:user,now});
  assert.equal(r.allowed,false); assert.equal(r.code,"VIP_REQUIRED"); assert.equal(db.calls.writes,0);
});

test("active trial permits association",async()=>{
  const db=mockDb({activations:trialActive});
  const r=await authorizeAppManagementRequest({db,path:"/api/user/app-groups/g1/sources",method:"POST",ctx:user,now});
  assert.equal(r.allowed,true); assert.equal(r.vipState,"active_trial"); assert.equal(db.calls.writes,0);
});

test("expired trial denies delete before any write",async()=>{
  const db=mockDb({activations:trialExpired});
  const r=await authorizeAppManagementRequest({db,path:"/api/user/app-groups/g1",method:"DELETE",ctx:user,now});
  assert.equal(r.allowed,false); assert.equal(db.calls.writes,0);
});

test("active formal permits create",async()=>{
  const db=mockDb({activations:formalActive});
  const r=await authorizeAppManagementRequest({db,path:"/api/user/app-links",method:"POST",ctx:user,now});
  assert.equal(r.allowed,true); assert.equal(db.calls.writes,0);
});

test("expired formal permits owned historical delete and returns cutoff for atomic predicate",async()=>{
  const db=mockDb({activations:formalExpired});
  const r=await authorizeAppManagementRequest({db,path:"/api/user/app-links/l1",method:"DELETE",ctx:user,now});
  assert.equal(r.allowed,true); assert.equal(r.formalCutoff,"2026-11-01T00:00:00.000Z"); assert.equal(db.calls.writes,0);
});

test("expired formal denies resource created after cutoff",async()=>{
  const db=mockDb({activations:formalExpired,resource:{id:"g1",created_at:"2026-11-10 00:00:00"}});
  const r=await authorizeAppManagementRequest({db,path:"/api/user/app-groups/g1",method:"DELETE",ctx:user,now});
  assert.equal(r.allowed,false); assert.equal(db.calls.writes,0);
});

test("direct super-admin session bypasses VIP independently",async()=>{
  const db=mockDb();
  const r=await authorizeAppManagementRequest({db,path:"/api/user/app-cards",method:"POST",ctx:{...user,actorId:"root",effectiveId:"root",isSuper:true},now});
  assert.equal(r.allowed,true); assert.equal(r.code,"SUPER_ADMIN"); assert.equal(db.calls.writes,0);
});

test("assist session requires scope and target VIP",async()=>{
  const db=mockDb({activations:trialActive});
  const r=await authorizeAppManagementRequest({db,path:"/api/user/app-groups",method:"POST",ctx:{...user,actorId:"root",isSuper:true,scope:"read"},now});
  assert.equal(r.allowed,false); assert.equal(r.code,"ASSIST_SCOPE_DENIED"); assert.equal(db.calls.writes,0);
});

test("assist manage scope does not grant target user VIP",async()=>{
  const db=mockDb({activations:[]});
  const r=await authorizeAppManagementRequest({db,path:"/api/user/app-groups",method:"POST",ctx:{...user,actorId:"root",isSuper:true,scope:"manage"},now});
  assert.equal(r.allowed,false); assert.equal(r.code,"VIP_REQUIRED"); assert.equal(db.calls.writes,0);
});

test("VIP query failure fails closed and performs no writes",async()=>{
  const db=mockDb();
  db.prepare=(sql)=>({bind(){return {async all(){throw new Error("D1 unavailable")},async first(){return null},async run(){db.calls.writes++;}}}});
  const r=await authorizeAppManagementRequest({db,path:"/api/user/app-cards",method:"POST",ctx:user,now});
  assert.equal(r.allowed,false); assert.equal(r.code,"VIP_STATUS_UNAVAILABLE"); assert.equal(db.calls.writes,0);
});

test("unowned delete is denied",async()=>{
  const db=mockDb({activations:formalActive,resource:null});
  const r=await authorizeAppManagementRequest({db,path:"/api/user/app-groups/g1",method:"DELETE",ctx:user,now});
  assert.equal(r.allowed,false); assert.equal(r.code,"RESOURCE_NOT_OWNED"); assert.equal(db.calls.writes,0);
});
