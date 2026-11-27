import test from "node:test";
import assert from "node:assert/strict";
import worker from "./Worker.js";

const now = "2026-11-27T12:00:00.000Z";
const activeTrial = [{kind:"trial",starts_at:"2026-11-20T00:00:00Z",ends_at:"2026-11-28T00:00:00Z"}];
const expiredTrial = [{kind:"trial",starts_at:"2026-11-01T00:00:00Z",ends_at:"2026-11-02T00:00:00Z"}];
const expiredFormal = [{kind:"formal",starts_at:"2026-10-01T00:00:00Z",ends_at:"2026-11-01T00:00:00Z"}];

function mockDb({role="user", actingAs=null, scope="manage", activations=[], activationFailure=false,
  resource={id:"g1",admin_user_id:"u1",name:"group",mode:"assigned",created_at:"2026-10-20 00:00:00"}}={}) {
  const writes=[];
  const sessionRow={
    id:"session-1",user_id:role==="super_admin"?"root":"u1",acting_as_user_id:actingAs,
    scope_id:actingAs?"scope-1":null,expires_at:"2099-01-01 00:00:00",revoked_at:null,
    u_id:role==="super_admin"?"root":"u1",username:"tester",role,status:"active",display_name:"Tester",
  };
  return {
    writes,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              if (sql.includes("FROM user_sessions s")) return sessionRow;
              if (sql.includes("SELECT 1 AS ok WHERE datetime(?)")) return {ok:1};
              if (sql.includes("FROM admin_user_scopes")) return actingAs ? {scope} : null;
              if (sql.includes("FROM app_groups WHERE id = ? AND admin_user_id = ?")) return resource;
              return null;
            },
            async all() {
              if (sql.includes("FROM admin_vip_activations")) {
                if (activationFailure) throw new Error("activation store unavailable");
                return {results:activations};
              }
              return {results:[]};
            },
            async run() {
              writes.push({sql,args});
              return {meta:{changes:1}};
            },
          };
        },
      };
    },
  };
}
function businessWrites(db) {
  return db.writes.filter(x => /^(INSERT INTO app_groups|UPDATE app_groups|DELETE FROM app_groups|INSERT INTO app_group_sources|DELETE FROM app_group_sources|INSERT INTO app_group_members|DELETE FROM app_group_members|INSERT INTO app_links|DELETE FROM app_links|INSERT INTO app_cards|UPDATE app_cards)/i.test(x.sql.trim()));
}
async function call(db,{path="/api/user/app-groups",method="POST",role="user",body={name:"Test group",mode:"assigned"}}={}) {
  const req=new Request("https://worker.test"+path,{
    method,headers:{"Authorization":"Bearer test-session","Content-Type":"application/json"},
    ...(method==="GET"||method==="DELETE"?{}:{body:JSON.stringify(body)}),
  });
  const res=await worker.fetch(req,{DB:db,SESSION_PEPPER:"test-pepper"});
  return {res,json:await res.json()};
}

test("Worker handler rejects L1 group creation before business write",async()=>{
  const db=mockDb();
  const {res,json}=await call(db);
  assert.equal(res.status,403);assert.equal(json.code,"VIP_REQUIRED");assert.equal(businessWrites(db).length,0);
});

test("Worker handler allows active trial group creation",async()=>{
  const db=mockDb({activations:activeTrial});
  const {res,json}=await call(db);
  assert.equal(res.status,201);assert.equal(json.ok,true);assert.equal(businessWrites(db).filter(x=>x.sql.startsWith("INSERT INTO app_groups")).length,1);
});

test("Worker handler rejects expired trial group deletion before business write",async()=>{
  const db=mockDb({activations:expiredTrial});
  const {res,json}=await call(db,{path:"/api/user/app-groups/g1",method:"DELETE"});
  assert.equal(res.status,403);assert.equal(json.code,"HISTORY_DELETE_NOT_ALLOWED");assert.equal(businessWrites(db).length,0);
});

test("Worker handler allows expired formal deletion only through owner and cutoff SQL",async()=>{
  const db=mockDb({activations:expiredFormal});
  const {res,json}=await call(db,{path:"/api/user/app-groups/g1",method:"DELETE"});
  assert.equal(res.status,200);assert.equal(json.ok,true);
  const del=businessWrites(db).find(x=>x.sql.startsWith("DELETE FROM app_groups"));
  assert.ok(del);assert.match(del.sql,/admin_user_id = \?/);assert.match(del.sql,/datetime\(created_at\) <= datetime\(\?\)/);
  assert.deepEqual(del.args,["g1","u1","2026-11-01T00:00:00.000Z"]);
});

test("Worker handler rejects formal-expiry delete of post-cutoff resource",async()=>{
  const db=mockDb({activations:expiredFormal,resource:{id:"g1",admin_user_id:"u1",created_at:"2026-11-10 00:00:00"}});
  const {res,json}=await call(db,{path:"/api/user/app-groups/g1",method:"DELETE"});
  assert.equal(res.status,403);assert.equal(json.code,"RESOURCE_AFTER_VIP_EXPIRY");assert.equal(businessWrites(db).length,0);
});

test("direct super-admin Worker session creates group without VIP",async()=>{
  const db=mockDb({role:"super_admin"});
  const {res,json}=await call(db);
  assert.equal(res.status,201);assert.equal(json.ok,true);assert.equal(businessWrites(db).length,1);
});

test("assist manage session still cannot create for target without VIP",async()=>{
  const db=mockDb({role:"super_admin",actingAs:"u1",scope:"manage"});
  const {res,json}=await call(db);
  assert.equal(res.status,403);assert.equal(json.code,"VIP_REQUIRED");assert.equal(businessWrites(db).length,0);
});

test("activation query failure fails closed in actual Worker handler",async()=>{
  const db=mockDb({activationFailure:true});
  const {res,json}=await call(db);
  assert.equal(res.status,403);assert.equal(json.code,"VIP_STATUS_UNAVAILABLE");assert.equal(businessWrites(db).length,0);
});
