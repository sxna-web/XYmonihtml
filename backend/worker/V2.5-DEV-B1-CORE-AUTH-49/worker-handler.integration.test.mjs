import test from "node:test";
import assert from "node:assert/strict";
import worker from "./Worker.js";

const now = "2026-11-27T12:00:00.000Z";
const activeTrial = [{kind:"trial",starts_at:"2020-01-01T00:00:00Z",ends_at:"2099-01-01T00:00:00Z"}];
const expiredTrial = [{kind:"trial",starts_at:"2026-11-01T00:00:00Z",ends_at:"2026-11-02T00:00:00Z"}];
const expiredFormal = [{kind:"formal",starts_at:"2026-10-01T00:00:00Z",ends_at:"2026-11-01T00:00:00Z"}];

function mockDb({role="user", actingAs=null, scope="manage", activations=[], activationFailure=false, schemaFailure=false, failCapacityAssertion=false, failCardDeleteAssertion=false, failAppLinkCapacityAssertion=false, failDownloadQuotaAssertion=false, failNodeOwnerAssertion=false,
  resource={id:"g1",admin_user_id:"u1",name:"group",mode:"assigned",created_at:"2026-10-20 00:00:00"}}={}) {
  const writes=[];
  const batches=[];
  const reads=[];
  const sessionRow={
    id:"session-1",user_id:role==="super_admin"?"root":"u1",acting_as_user_id:actingAs,
    scope_id:actingAs?"scope-1":null,expires_at:"2099-01-01 00:00:00",revoked_at:null,
    u_id:role==="super_admin"?"root":"u1",username:"tester",role,status:"active",display_name:"Tester",
  };
  return {
    writes,
    batches,
    reads,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            sql, args,
            async first() {
              if (sql.includes("FROM user_sessions s")) return sessionRow;
              if (sql.includes("SELECT 1 AS ok WHERE datetime(?)")) return {ok:1};
              if (sql.includes("SELECT * FROM admin_user_scopes WHERE id = ?")) return {id:args[0],target_user_id:"u1",scope:"manage",revoked_at:null};
              if (sql.includes("FROM admin_user_scopes")) return actingAs ? {scope} : null;
              if (sql.includes("SELECT COUNT(*) AS n FROM convert_links WHERE group_name = ?")) return {n:2};
              if (sql.includes("SELECT id, group_name FROM convert_links WHERE id = ?")) return {id:args[0],group_name:"Old"};
              if (sql.includes("SELECT id, group_name, revoked_at FROM convert_links WHERE id = ?")) return {id:args[0],group_name:"Old",revoked_at:null};
              if (sql.includes("FROM app_groups WHERE id = ? AND admin_user_id = ?")) return resource;
              if (sql.includes("FROM node_groups WHERE id = ? AND user_id = ?")) return {id:args[0],user_id:args[1],name:"group",sort_order:0,remark:""};
              if (sql.includes("FROM user_manual_nodes WHERE id = ? AND user_id = ?")) return {id:args[0],user_id:args[1],name:"Manual",protocol:"vless",server:"example.test",port:443,tier:"free",enabled:1,remark:""};
              if (sql.includes("FROM node_records WHERE id = ?")) return {id:args[0],source_id:"src1",name:"Node",protocol:"vless",server:"example.test",port:443,tier:"free",enabled:1};
              if (sql.includes("SELECT user_id FROM source_ownership WHERE source_id = ?")) return {user_id:"u1"};
              if (sql.includes("FROM source_ownership WHERE source_id = ? AND user_id = ?")) return {ok:1};
              if (sql.includes("SELECT id, role, status, display_name FROM app_users WHERE id = ?")) return {id:args[0],role:"user",status:"active",display_name:"Tester"};
              if (sql.includes("SELECT id, status FROM app_users WHERE id = ?")) return {id:args[0],status:"active"};
              if (sql.includes("SELECT * FROM subscription_sources WHERE id = ?")) return {id:args[0],name:"Source",url:"https://example.com/sub",tier:"free",enabled:1,priority:100,remark:""};
              if (sql.includes("SELECT id, name, enabled FROM subscription_sources WHERE id = ?")) return {id:args[0],name:"Source",enabled:1};
              if (sql.includes("SELECT id, name FROM subscription_sources WHERE id = ?")) return {id:args[0],name:"Source"};
              if (sql.includes("SELECT status FROM source_approvals WHERE source_id = ?")) return {status:"pending"};
              if (sql.includes("FROM app_users WHERE id = ?")) return {id:args[0]};
              if (sql.includes("FROM app_cards WHERE code = ?")) return {id:"card-1",admin_user_id:"u1",days:30,status:"normal",manual_disabled:0,activated_at:null,used_at:null,expires_at:"2099-01-01 00:00:00"};
              if (sql.includes("FROM app_cards WHERE id = ? AND admin_user_id = ?")) return {id:args[0],status:"normal",activated_at:null,used_at:null};
              if (sql.includes("FROM admin_app_perms WHERE admin_user_id = ?")) return {links_enabled:1,max_links:3,free_group_enabled:1};
              if (sql.includes("COUNT(*) AS n FROM app_links WHERE admin_user_id = ?")) return {n:0};
              if (sql.includes("COUNT(*) AS n FROM download_links")) return {n:0};
              if (sql.includes("FROM download_links WHERE id = ?")) return {id:args[0],scope:"admin",admin_user_id:"u1",title:"Downloads",url:"https://example.test/file.apk"};
              if (sql.includes("FROM app_entitlements WHERE id = ?")) return {id:args[0],admin_user_id:"u1",device_id:"old-device-123456"};
              if (sql.includes("FROM app_links WHERE id = ?")) return {id:args[0],admin_user_id:"u1",title:"Support",url:"https://example.test"};
              if (sql.includes("FROM releases WHERE id = ?")) return {id:args[0],platform:"android",version_code:10,version_name:"1.0.0"};
              if (sql.includes("FROM announcements WHERE id = ?")) return {id:args[0],title:"Notice",scope:"app",active:1};
              if (sql.includes("FROM subscription_sources s JOIN source_ownership")) return {id:"src1"};
              return null;
            },
            async all() {
              reads.push({sql,args});
              if (sql.includes("FROM admin_vip_activations")) {
                if (activationFailure) throw new Error("activation store unavailable");
                return {results:activations};
              }
              if (sql.includes("sqlite_master") && /type\s*=\s*'table'/.test(sql)) {
                return {results:args.map(name=>({name}))};
              }
              if (sql.startsWith("PRAGMA table_info(")) {
                if (schemaFailure) throw new Error("schema metadata unavailable");
                return {results:[
                  {cid:0,name:"id",type:"TEXT",notnull:1,dflt_value:null,pk:1},
                  {cid:1,name:"admin_user_id",type:"TEXT",notnull:1,dflt_value:null,pk:0},
                ]};
              }
              if (sql.startsWith("PRAGMA index_list(")) {
                return {results:[{seq:0,name:"idx_schema_admin",unique:0,origin:"c",partial:0}]};
              }
              if (sql.startsWith("PRAGMA index_info(")) {
                return {results:[{seqno:0,cid:1,name:"admin_user_id"}]};
              }
              if (sql.startsWith("PRAGMA foreign_key_list(")) return {results:[]};
              if (sql.includes("FROM sqlite_master") && sql.includes("type IN ('trigger','view')")) return {results:[]};
              return {results:[]};
            },
            async run() {
              writes.push({sql,args});
              if (failCapacityAssertion && sql.includes("COUNT(*) FROM app_cards")) throw new Error("assert-failed");
              if (failCardDeleteAssertion && sql.includes("activated_at IS NULL AND used_at IS NULL AND status <> 'used'")) throw new Error("assert-failed");
              if (failAppLinkCapacityAssertion && sql.includes("COUNT(*) FROM app_links WHERE admin_user_id = ?")) throw new Error("assert-failed");
              if (failDownloadQuotaAssertion && sql.includes("COUNT(*) FROM download_links WHERE scope = ?")) throw new Error("assert-failed");
              if (failNodeOwnerAssertion && (sql.includes("EXISTS (SELECT 1 FROM user_manual_nodes WHERE id = ? AND user_id = ?)") || sql.includes("EXISTS (SELECT 1 FROM node_records n JOIN source_ownership so ON so.source_id = n.source_id"))) throw new Error("assert-failed");
              return {meta:{changes:1}};
            },
          };
        },
      };
    },
    async batch(statements) {
      batches.push(statements.map(statement => statement.sql || ""));
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  };
}
function businessWrites(db) {
  return db.writes.filter(x => /^(INSERT INTO app_groups|UPDATE app_groups|DELETE FROM app_groups|INSERT OR IGNORE INTO app_group_sources|DELETE FROM app_group_sources|INSERT OR IGNORE INTO app_group_members|DELETE FROM app_group_members|INSERT INTO app_links|DELETE FROM app_links|INSERT INTO app_cards|UPDATE app_cards|INSERT INTO download_links|DELETE FROM download_links|INSERT INTO releases|DELETE FROM releases|INSERT INTO announcements|UPDATE announcements|DELETE FROM announcements|INSERT INTO node_user_metadata|INSERT INTO node_overrides|DELETE FROM node_overrides)/i.test(x.sql.trim()));
}
async function call(db,{path="/api/user/app-groups",method="POST",role="user",body={name:"Test group",mode:"assigned"},
  authorization="Bearer test-session",sessionPepper="test-pepper-test-pepper-test-pepper"}={}) {
  const req=new Request("https://worker.test"+path,{
    method,headers:{"Authorization":authorization,"Content-Type":"application/json"},
    ...(method==="GET"||method==="DELETE"?{}:{body:JSON.stringify(body)}),
  });
  const res=await worker.fetch(req,{DB:db,SESSION_PEPPER:sessionPepper});
  return {res,json:await res.json()};
}

test("schema diagnostics expose APP metadata only to a direct super-admin session",async()=>{
  const db=mockDb({role:"super_admin"});
  const {res,json}=await call(db,{path:"/api/super/schema-status",method:"GET",role:"super_admin"});
  assert.equal(res.status,200);assert.equal(json.ok,true);
  assert.equal(json.data.verification,"TABLE_NAMES_ONLY");
  assert.equal(json.data.app_structure.verification,"OBSERVED_SCHEMA_ONLY");
  assert.equal(json.data.app_structure.baseline_comparison,"NOT_CONFIGURED");
  assert.equal(json.data.app_structure.compatibility_verdict,"NOT_EVALUATED");
  assert.equal(json.data.app_structure.tables.length,9);
  const diagnosticNames=json.data.app_structure.tables.map(table=>table.name);
  assert.ok(diagnosticNames.includes("app_card_group_mappings"));
  assert.ok(diagnosticNames.includes("app_card_group_admin_requests"));
  assert.ok(db.reads.some(x=>x.sql.startsWith("PRAGMA table_info(") && x.sql.includes("app_card_group_mappings")));
  assert.ok(db.reads.some(x=>x.sql.startsWith("PRAGMA table_info(") && x.sql.includes("app_card_group_admin_requests")));
  assert.ok(db.reads.some(x=>x.sql.includes("type IN ('trigger','view')") &&
    x.args.includes("app_card_group_mappings") && x.args.includes("app_card_group_admin_requests")));
  assert.equal(db.reads.some(x=>/SELECT .*response_json|SELECT .*payload_sha256/i.test(x.sql)),false);
  assert.equal(json.data.app_structure.tables[0].columns[1].name,"admin_user_id");
  assert.equal(json.data.app_structure.tables[0].indexes[0].columns[0].name,"admin_user_id");
  assert.equal(businessWrites(db).length,0);
  assert.equal(db.reads.some(x=>x.sql.startsWith("PRAGMA table_info(")),true);
  assert.equal(JSON.stringify(json).includes("redeem_code_value"),false);
});
test("schema diagnostics reject non-super-admin sessions before metadata reads",async()=>{
  const db=mockDb({role:"user"});
  const {res,json}=await call(db,{path:"/api/super/schema-status",method:"GET"});
  assert.equal(res.status,403);assert.equal(json.ok,false);
  assert.equal(db.reads.some(x=>x.sql.startsWith("PRAGMA table_info(")),false);
});
test("schema metadata failures remain PARTIAL_NOT_VERIFIED and never become a pass",async()=>{
  const db=mockDb({role:"super_admin",schemaFailure:true});
  const {res,json}=await call(db,{path:"/api/super/schema-status",method:"GET",role:"super_admin"});
  assert.equal(res.status,200);assert.equal(json.ok,true);
  assert.equal(json.data.app_structure.verification,"PARTIAL_NOT_VERIFIED");
  assert.equal(json.data.app_structure.compatibility_verdict,"NOT_EVALUATED");
  assert.equal(json.data.app_structure.tables[0].verification,"PARTIAL_NOT_VERIFIED");
  assert.equal(json.data.app_structure.tables[0].columns,null);
  assert.equal(businessWrites(db).length,0);
});

test("anonymous conversion requires a per-user guest key",async()=>{
  const db=mockDb();
  const {res,json}=await call(db,{path:"/api/convert/groups",method:"GET",authorization:""});
  assert.equal(res.status,400);assert.equal(json.code,"GUEST_KEY_REQUIRED");
});

test("anonymous conversion accepts a valid guest key",async()=>{
  const db=mockDb();
  const {res,json}=await call(db,{path:"/api/convert/groups?guest_key=guest-key-123456789",method:"GET",authorization:""});
  assert.equal(res.status,200);assert.equal(json.ok,true);
});

test("malformed Authorization cannot downgrade to anonymous",async()=>{
  const db=mockDb();
  const {res,json}=await call(db,{authorization:"Basic invalid"});
  assert.equal(res.status,401);assert.equal(json.code,"INVALID_SESSION");assert.equal(businessWrites(db).length,0);
});

test("short SESSION_PEPPER fails closed before session lookup",async()=>{
  const db=mockDb();
  const {res,json}=await call(db,{sessionPepper:"too-short"});
  assert.equal(res.status,503);assert.equal(json.code,"SECRET_NOT_CONFIGURED");assert.equal(businessWrites(db).length,0);
});

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

test("Worker handler rejects cross-owner group update before business write",async()=>{
  const db=mockDb({activations:activeTrial,resource:null});
  const {res}=await call(db,{path:"/api/user/app-groups/g1",method:"PUT",body:{name:"Hijack",mode:"assigned"}});
  assert.equal(res.status,404);assert.equal(businessWrites(db).length,0);
});

test("Worker handler rejects cross-owner source association before business write",async()=>{
  const db=mockDb({activations:activeTrial,resource:null});
  const {res}=await call(db,{path:"/api/user/app-groups/g1/sources",method:"POST",body:{source_id:"src1"}});
  assert.equal(res.status,404);assert.equal(businessWrites(db).length,0);
});

test("Worker handler associates only through group-owner and source-owner SQL predicates",async()=>{
  const db=mockDb({activations:activeTrial});
  const {res}=await call(db,{path:"/api/user/app-groups/g1/sources",method:"POST",body:{source_id:"src1"}});
  assert.equal(res.status,201);
  const write=businessWrites(db).find(x=>x.sql.includes("app_group_sources"));
  assert.ok(write);assert.match(write.sql,/app_groups WHERE id = \? AND admin_user_id = \?/);assert.match(write.sql,/source_ownership WHERE source_id = \? AND user_id = \?/);
});

test("Worker handler associates APP member only through group-owner SQL predicate",async()=>{
  const db=mockDb({activations:activeTrial});
  const {res}=await call(db,{path:"/api/user/app-groups/g1/members",method:"POST",body:{device_id:"device12345678"}});
  assert.equal(res.status,201);
  const write=businessWrites(db).find(x=>x.sql.includes("app_group_members"));
  assert.ok(write);assert.match(write.sql,/app_groups WHERE id = \? AND admin_user_id = \?/);
});


test("delegated APP group mutation includes the live scope guard in the same D1 batch",async()=>{
  const db=mockDb({role:"super_admin",actingAs:"u1",scope:"manage",activations:activeTrial});
  const {res}=await call(db,{path:"/api/user/app-groups",method:"POST",body:{name:"Scoped",mode:"assigned"}});
  assert.equal(res.status,201);
  assert.ok(db.writes.some(x=>x.sql.includes("FROM admin_user_scopes") && x.sql.includes("revoked_at IS NULL")));
  assert.equal(businessWrites(db).filter(x=>x.sql.startsWith("INSERT INTO app_groups")).length,1);
});

test("expired formal VIP cannot remove an APP group source association as a configuration mutation",async()=>{
  const db=mockDb({activations:expiredFormal});
  const {res,json}=await call(db,{path:"/api/user/app-groups/g1/sources/src1",method:"DELETE"});
  assert.equal(res.status,403);
  assert.equal(json.code,"VIP_REQUIRED");
  assert.equal(businessWrites(db).filter(x=>x.sql.startsWith("DELETE FROM app_group_sources")).length,0);
});

test("APP group source removal checks group ownership in the final SQL and scope batch",async()=>{
  const db=mockDb({role:"super_admin",actingAs:"u1",scope:"manage",activations:activeTrial});
  const {res,json}=await call(db,{path:"/api/user/app-groups/g1/sources/src1",method:"DELETE"});
  assert.equal(res.status,200);
  assert.equal(json.data.removed,true);
  const del=businessWrites(db).find(x=>x.sql.startsWith("DELETE FROM app_group_sources"));
  assert.ok(del);
  assert.match(del.sql,/EXISTS \(SELECT 1 FROM app_groups WHERE id = \? AND admin_user_id = \?\)/);
  assert.ok(db.writes.some(x=>x.sql.includes("FROM admin_user_scopes") && x.sql.includes("revoked_at IS NULL")));
});


test("APP card generation rechecks total and unactivated stock limits inside its batch",async()=>{
  const db=mockDb({activations:activeTrial});
  const {res}=await call(db,{path:"/api/user/app-cards",method:"POST",body:{count:2,days:30}});
  assert.equal(res.status,201);
  const capacityChecks=db.writes.filter(x=>x.sql.includes("COUNT(*) FROM app_cards"));
  assert.equal(capacityChecks.length,2);
  assert.ok(businessWrites(db).some(x=>x.sql.startsWith("INSERT INTO app_cards")));
});

test("APP card generation fails closed when the in-batch capacity assertion detects a concurrent fill",async()=>{
  const db=mockDb({activations:activeTrial,failCapacityAssertion:true});
  const {res,json}=await call(db,{path:"/api/user/app-cards",method:"POST",body:{count:2,days:30}});
  assert.equal(res.status,409);
  assert.equal(json.code,"APP_CARD_CAPACITY_CHANGED");
  assert.equal(businessWrites(db).filter(x=>x.sql.startsWith("INSERT INTO app_cards")).length,0);
});


test("super APP permission update batches admin existence, upsert and audit while preserving omitted free-group setting",async()=>{
  const db=mockDb({role:"super_admin"});
  const {res,json}=await call(db,{path:"/api/super/app-perms/u1",method:"PUT",body:{links_enabled:0,max_links:4}});
  assert.equal(res.status,200);assert.equal(json.ok,true);
  const upsert=db.writes.find(x=>x.sql.includes("INSERT INTO admin_app_perms"));
  assert.ok(upsert);assert.match(upsert.sql,/free_group_enabled=CASE WHEN \? = 1 THEN excluded\.free_group_enabled ELSE admin_app_perms\.free_group_enabled END/);
  assert.equal(upsert.args[4],0);
  assert.ok(db.writes.some(x=>x.sql.includes("FROM app_users WHERE id = ?")));
  assert.ok(db.writes.some(x=>x.sql.includes("INSERT INTO admin_audit_events")));
});

test("super APP entitlement rebind uses compare-and-swap and atomic audit",async()=>{
  const db=mockDb({role:"super_admin"});
  const {res,json}=await call(db,{path:"/api/super/app-entitlements/ent-1/rebind",method:"POST",body:{device_id:"new-device-123456"}});
  assert.equal(res.status,200);assert.equal(json.data.device_id,"new-device-123456");
  const update=db.writes.find(x=>x.sql.startsWith("UPDATE app_entitlements SET device_id"));
  assert.ok(update);assert.match(update.sql,/WHERE id = \? AND device_id = \?/);
  assert.deepEqual(update.args,["new-device-123456","ent-1","old-device-123456"]);
  assert.ok(db.writes.some(x=>x.sql.includes("FROM app_entitlements WHERE id = ? AND device_id = ?")));
  assert.ok(db.writes.some(x=>x.sql.includes("INSERT INTO admin_audit_events")));
});

test("super APP link delete batches final existence check, delete and audit",async()=>{
  const db=mockDb({role:"super_admin"});
  const {res,json}=await call(db,{path:"/api/super/app-links/link-1",method:"DELETE"});
  assert.equal(res.status,200);assert.equal(json.data.deleted,true);
  const del=db.writes.find(x=>x.sql.startsWith("DELETE FROM app_links"));
  assert.ok(del);assert.deepEqual(del.args,["link-1"]);
  assert.ok(db.writes.some(x=>x.sql.includes("INSERT INTO admin_audit_events")));
});


test("APP card redemption commits card, entitlement, free grant and activation event in one batch",async()=>{
  const db=mockDb();
  const {res,json}=await call(db,{path:"/api/app/redeem",method:"POST",body:{code:"ABCD12345678",device_id:"device-12345678"}});
  assert.equal(res.status,201);assert.equal(json.ok,true);
  const batch=db.batches.find(items=>items.some(sql=>sql.includes("INSERT INTO app_entitlements")));
  assert.ok(batch);
  assert.ok(batch.some(sql=>sql.startsWith("UPDATE app_cards SET status='used'")));
  assert.ok(batch.some(sql=>sql.includes("INSERT OR IGNORE INTO app_free_grants")));
  assert.ok(batch.some(sql=>sql.includes("INSERT INTO app_card_events")));
  const update=db.writes.find(x=>x.sql.startsWith("UPDATE app_cards SET status='used'"));
  assert.match(update.sql,/admin_user_id = \? AND days = \?/);
  assert.match(update.sql,/manual_disabled=0/);
  assert.match(update.sql,/datetime\(expires_at\) > datetime\('now'\)/);
});

test("APP card soft-delete rejects a concurrent activation before writing",async()=>{
  const db=mockDb({activations:activeTrial,failCardDeleteAssertion:true});
  const {res,json}=await call(db,{path:"/api/user/app-cards/card-1",method:"DELETE",body:{}});
  assert.equal(res.status,409);assert.equal(json.code,"CARD_STATE_CHANGED");
  assert.equal(businessWrites(db).filter(x=>x.sql.startsWith("UPDATE app_cards")).length,0);
});


test("APP link creation batches quota assertion, insert and audit",async()=>{
  const db=mockDb({activations:activeTrial});
  const {res,json}=await call(db,{path:"/api/user/app-links",method:"POST",body:{title:"Support",url:"https://example.test"}});
  assert.equal(res.status,201);assert.equal(json.ok,true);
  const batch=db.batches.find(items=>items.some(sql=>sql.includes("INSERT INTO app_links")));
  assert.ok(batch);
  assert.ok(batch.some(sql=>sql.includes("COUNT(*) FROM app_links WHERE admin_user_id = ?")));
  assert.ok(batch.some(sql=>sql.includes("INSERT INTO admin_audit_events")));
});

test("APP link creation returns conflict when concurrent request consumes the last slot",async()=>{
  const db=mockDb({activations:activeTrial,failAppLinkCapacityAssertion:true});
  const {res,json}=await call(db,{path:"/api/user/app-links",method:"POST",body:{title:"Support",url:"https://example.test"}});
  assert.equal(res.status,409);assert.equal(json.code,"LINKS_LIMIT_CHANGED");
  assert.equal(businessWrites(db).filter(x=>x.sql.startsWith("INSERT INTO app_links")).length,0);
});


test("user download link creation batches quota assertion, insert and audit",async()=>{
  const db=mockDb();
  const {res,json}=await call(db,{path:"/api/user/downloads",method:"POST",body:{title:"Downloads",url:"https://example.test/file.apk"}});
  assert.equal(res.status,201);assert.equal(json.ok,true);
  const batch=db.batches.find(items=>items.some(sql=>sql.includes("INSERT INTO download_links")));
  assert.ok(batch);
  assert.ok(batch.some(sql=>sql.includes("COUNT(*) FROM download_links WHERE scope = ?")));
  assert.ok(batch.some(sql=>sql.includes("INSERT INTO admin_audit_events")));
});

test("download link creation rejects concurrent quota exhaustion",async()=>{
  const db=mockDb({failDownloadQuotaAssertion:true});
  const {res,json}=await call(db,{path:"/api/user/downloads",method:"POST",body:{title:"Downloads",url:"https://example.test/file.apk"}});
  assert.equal(res.status,409);assert.equal(json.code,"DOWNLOAD_LIMIT_CHANGED");
  assert.equal(businessWrites(db).filter(x=>x.sql.startsWith("INSERT INTO download_links")).length,0);
});

test("user download deletion keeps owner predicate in the final SQL and audit batch",async()=>{
  const db=mockDb();
  const {res,json}=await call(db,{path:"/api/user/downloads/dl-1",method:"DELETE"});
  assert.equal(res.status,200);assert.equal(json.ok,true);
  const del=db.writes.find(x=>x.sql.startsWith("DELETE FROM download_links"));
  assert.ok(del);assert.match(del.sql,/WHERE id = \? AND admin_user_id = \?/);
  assert.deepEqual(del.args,["dl-1","u1"]);
  assert.ok(db.writes.some(x=>x.sql.includes("INSERT INTO admin_audit_events")));
});

test("super download deletion batches existence assertion, delete and audit",async()=>{
  const db=mockDb({role:"super_admin"});
  const {res,json}=await call(db,{path:"/api/super/downloads/dl-1",method:"DELETE"});
  assert.equal(res.status,200);assert.equal(json.data.deleted,true);
  const del=db.writes.find(x=>x.sql.startsWith("DELETE FROM download_links"));
  assert.ok(del);assert.deepEqual(del.args,["dl-1"]);
  assert.ok(db.writes.some(x=>x.sql.includes("INSERT INTO admin_audit_events")));
});


test("super release creation batches insert and audit",async()=>{
  const db=mockDb({role:"super_admin"});
  const {res,json}=await call(db,{path:"/api/super/releases",method:"POST",body:{platform:"android",version_code:10,version_name:"1.0.0",url:"https://example.test/app.apk"}});
  assert.equal(res.status,201);assert.equal(json.ok,true);
  const batch=db.batches.find(items=>items.some(sql=>sql.includes("INSERT INTO releases")));
  assert.ok(batch);assert.ok(batch.some(sql=>sql.includes("INSERT INTO admin_audit_events")));
});

test("super release deletion batches existence assertion, delete and audit",async()=>{
  const db=mockDb({role:"super_admin"});
  const {res,json}=await call(db,{path:"/api/super/releases/rel-1",method:"DELETE"});
  assert.equal(res.status,200);assert.equal(json.ok,true);
  const batch=db.batches.find(items=>items.some(sql=>sql.startsWith("DELETE FROM releases")));
  assert.ok(batch);assert.ok(batch.some(sql=>sql.includes("SELECT CASE WHEN (EXISTS (SELECT 1 FROM releases")));
  assert.ok(batch.some(sql=>sql.includes("INSERT INTO admin_audit_events")));
});

test("super announcement creation batches insert and audit",async()=>{
  const db=mockDb({role:"super_admin"});
  const {res,json}=await call(db,{path:"/api/super/announcements",method:"POST",body:{title:"Notice",scope:"app",body:"Hello"}});
  assert.equal(res.status,201);assert.equal(json.ok,true);
  const batch=db.batches.find(items=>items.some(sql=>sql.includes("INSERT INTO announcements")));
  assert.ok(batch);assert.ok(batch.some(sql=>sql.includes("INSERT INTO admin_audit_events")));
});

test("super announcement toggle batches existence assertion, update and audit",async()=>{
  const db=mockDb({role:"super_admin"});
  const {res,json}=await call(db,{path:"/api/super/announcements/ann-1",method:"PUT",body:{active:false}});
  assert.equal(res.status,200);assert.equal(json.data.active,0);
  const batch=db.batches.find(items=>items.some(sql=>sql.startsWith("UPDATE announcements")));
  assert.ok(batch);assert.ok(batch.some(sql=>sql.includes("INSERT INTO admin_audit_events")));
});

test("super announcement deletion batches existence assertion, delete and audit",async()=>{
  const db=mockDb({role:"super_admin"});
  const {res,json}=await call(db,{path:"/api/super/announcements/ann-1",method:"DELETE"});
  assert.equal(res.status,200);assert.equal(json.ok,true);
  const batch=db.batches.find(items=>items.some(sql=>sql.startsWith("DELETE FROM announcements")));
  assert.ok(batch);assert.ok(batch.some(sql=>sql.includes("INSERT INTO admin_audit_events")));
});


test("node-group member add batches group and node ownership assertions",async()=>{
  const db=mockDb();
  const {res,json}=await call(db,{path:"/api/user/node-groups/g1/members",method:"POST",body:{node_kind:"manual",node_id:"manual123"}});
  assert.equal(res.status,201);assert.equal(json.ok,true);
  const batch=db.batches.find(items=>items.some(sql=>sql.includes("INSERT OR IGNORE INTO node_group_members")));
  assert.ok(batch);
  assert.ok(batch.some(sql=>sql.includes("FROM node_groups WHERE id = ? AND user_id = ?")));
  assert.ok(batch.some(sql=>sql.includes("FROM user_manual_nodes WHERE id = ? AND user_id = ?")));
});

test("node-group member add rejects ownership change before inserting membership",async()=>{
  const db=mockDb({failNodeOwnerAssertion:true});
  const {res,json}=await call(db,{path:"/api/user/node-groups/g1/members",method:"POST",body:{node_kind:"manual",node_id:"manual123"}});
  assert.equal(res.status,409);assert.equal(json.code,"GROUP_MEMBER_STATE_CHANGED");
  assert.equal(businessWrites(db).filter(x=>x.sql.startsWith("INSERT OR IGNORE INTO node_group_members")).length,0);
});

test("manual node metadata update rechecks node ownership in the same batch",async()=>{
  const db=mockDb();
  const {res,json}=await call(db,{path:"/api/user/nodes/manual123/metadata",method:"PUT",body:{remark:"note"}});
  assert.equal(res.status,200);assert.equal(json.ok,true);
  const batch=db.batches.find(items=>items.some(sql=>sql.includes("INSERT INTO node_user_metadata")));
  assert.ok(batch);
  assert.ok(batch.some(sql=>sql.includes("FROM user_manual_nodes WHERE id = ? AND user_id = ?")));
});

test("subscription node override update rechecks source ownership in the same batch",async()=>{
  const db=mockDb();
  const {res,json}=await call(db,{path:"/api/user/nodes/node123/overrides/name",method:"PUT",body:{value:"Changed"}});
  assert.equal(res.status,200);assert.equal(json.ok,true);
  const batch=db.batches.find(items=>items.some(sql=>sql.includes("INSERT INTO node_overrides")));
  assert.ok(batch);
  assert.ok(batch.some(sql=>sql.includes("FROM node_records n JOIN source_ownership so ON so.source_id = n.source_id")));
});

test("subscription node override returns conflict when ownership changes before batch",async()=>{
  const db=mockDb({failNodeOwnerAssertion:true});
  const {res,json}=await call(db,{path:"/api/user/nodes/node123/overrides/name",method:"PUT",body:{value:"Changed"}});
  assert.equal(res.status,409);assert.equal(json.code,"NODE_OWNERSHIP_CHANGED");
  assert.equal(businessWrites(db).filter(x=>x.sql.startsWith("INSERT INTO node_overrides")).length,0);
});


test("subscription node enabled toggle rechecks source ownership in the same batch",async()=>{
  const db=mockDb();
  const {res,json}=await call(db,{path:"/api/user/nodes/node123/enabled",method:"PATCH",body:{enabled:false}});
  assert.equal(res.status,200);assert.equal(json.ok,true);
  const batch=db.batches.find(items=>items.some(sql=>sql.includes("INSERT INTO node_overrides")));
  assert.ok(batch);
  assert.ok(batch.some(sql=>sql.includes("FROM node_records n JOIN source_ownership so ON so.source_id = n.source_id")));
});

test("subscription node enabled toggle rejects ownership change before writing",async()=>{
  const db=mockDb({failNodeOwnerAssertion:true});
  const {res,json}=await call(db,{path:"/api/user/nodes/node123/enabled",method:"PATCH",body:{enabled:false}});
  assert.equal(res.status,409);assert.equal(json.code,"NODE_OWNERSHIP_CHANGED");
  assert.equal(businessWrites(db).filter(x=>x.sql.startsWith("INSERT INTO node_overrides")).length,0);
});


test("super scope grant asserts target user in the same batch as grant and audit",async()=>{
  const db=mockDb({role:"super_admin"});
  const {res,json}=await call(db,{path:"/api/super/users/u1/scopes",method:"POST",body:{scope:"manage",reason:"support",expires_in_hours:24}});
  assert.equal(res.status,201);assert.equal(json.ok,true);
  const batch=db.batches.find(items=>items.some(sql=>sql.includes("INSERT INTO admin_user_scopes")));
  assert.ok(batch);
  assert.ok(batch.some(sql=>sql.includes("FROM app_users WHERE id = ?")));
  assert.ok(batch.some(sql=>sql.includes("INSERT INTO admin_audit_events")));
});

test("super scope revoke batches active-scope assertion, revoke and session invalidation",async()=>{
  const db=mockDb({role:"super_admin"});
  const {res,json}=await call(db,{path:"/api/super/scopes/scope-1",method:"DELETE"});
  assert.equal(res.status,200);assert.equal(json.data.revoked,true);
  const batch=db.batches.find(items=>items.some(sql=>sql.startsWith("UPDATE admin_user_scopes SET revoked_at")));
  assert.ok(batch);
  assert.ok(batch.some(sql=>sql.includes("FROM admin_user_scopes WHERE id = ? AND revoked_at IS NULL")));
  assert.ok(batch.some(sql=>sql.startsWith("UPDATE user_sessions SET revoked_at")));
  assert.ok(batch.some(sql=>sql.includes("INSERT INTO admin_audit_events")));
});

test("super conversion group rename batches final existence check, update and audit",async()=>{
  const db=mockDb({role:"super_admin"});
  const {res,json}=await call(db,{path:"/api/super/convert-groups/rename",method:"POST",body:{from:"Old",to:"New"}});
  assert.equal(res.status,200);assert.equal(json.data.links,1);
  const batch=db.batches.find(items=>items.some(sql=>sql.startsWith("UPDATE convert_links SET group_name")));
  assert.ok(batch);
  assert.ok(batch.some(sql=>sql.includes("FROM convert_links WHERE group_name = ?")));
  assert.ok(batch.some(sql=>sql.includes("INSERT INTO admin_audit_events")));
});


test("super user status/password update rechecks snapshot and batches update, session revocation and audit",async()=>{
  const db=mockDb({role:"super_admin"});
  const {res,json}=await call(db,{path:"/api/super/users/u1",method:"PUT",body:{status:"disabled",password:"new-secure-password"}});
  assert.equal(res.status,200);assert.equal(json.ok,true);
  const batch=db.batches.find(items=>items.some(sql=>sql.startsWith("UPDATE app_users SET status=")));
  assert.ok(batch);
  assert.ok(batch.some(sql=>sql.includes("FROM app_users WHERE id = ? AND role = ? AND status = ?")));
  assert.ok(batch.some(sql=>sql.startsWith("UPDATE user_sessions SET revoked_at")));
  assert.ok(batch.some(sql=>sql.includes("INSERT INTO admin_audit_events")));
  const update=batch.find(sql=>sql.startsWith("UPDATE app_users SET status="));
  assert.match(update,/WHERE id=.*AND role=.*AND status=/);
});

test("super convert-link regroup uses compare-and-swap and atomic audit",async()=>{
  const db=mockDb({role:"super_admin"});
  const {res,json}=await call(db,{path:"/api/super/convert-links/link123/group",method:"PATCH",body:{group:"New"}});
  assert.equal(res.status,200);assert.equal(json.data.group,"New");
  const batch=db.batches.find(items=>items.some(sql=>sql.startsWith("UPDATE convert_links SET group_name = ? WHERE id = ? AND group_name = ?")));
  assert.ok(batch);
  assert.ok(batch.some(sql=>sql.includes("FROM convert_links WHERE id = ? AND group_name = ?")));
  assert.ok(batch.some(sql=>sql.includes("INSERT INTO admin_audit_events")));
});

test("super convert-link revoke rechecks active state in the same batch",async()=>{
  const db=mockDb({role:"super_admin"});
  const {res,json}=await call(db,{path:"/api/super/convert-links/link123/revoke",method:"POST"});
  assert.equal(res.status,200);assert.equal(json.data.revoked,true);
  const batch=db.batches.find(items=>items.some(sql=>sql.startsWith("UPDATE convert_links SET revoked_at")));
  assert.ok(batch);
  assert.ok(batch.some(sql=>sql.includes("FROM convert_links WHERE id = ? AND revoked_at IS NULL")));
  assert.ok(batch.some(sql=>sql.includes("INSERT INTO admin_audit_events")));
});


test("super source approval rechecks prior status and batches decision with audit",async()=>{
  const db=mockDb({role:"super_admin"});
  const {res,json}=await call(db,{path:"/api/super/sources/src123/approve",method:"POST",body:{reason:"checked"}});
  assert.equal(res.status,200);assert.equal(json.data.approval_status,"approved");
  const batch=db.batches.find(items=>items.some(sql=>sql.startsWith("UPDATE source_approvals SET status")));
  assert.ok(batch);
  assert.ok(batch.some(sql=>sql.includes("FROM source_approvals WHERE source_id = ? AND status = ?")));
  assert.ok(batch.some(sql=>sql.startsWith("UPDATE source_approvals SET status") && sql.includes("AND status = ?")));
  assert.ok(batch.some(sql=>sql.includes("INSERT INTO admin_audit_events")));
});

test("super source assignment rechecks source and active target in the ownership batch",async()=>{
  const db=mockDb({role:"super_admin"});
  const {res,json}=await call(db,{path:"/api/super/sources/src123/assign",method:"POST",body:{user_id:"u1"}});
  assert.equal(res.status,200);assert.equal(json.ok,true);
  const batch=db.batches.find(items=>items.some(sql=>sql.includes("INSERT INTO source_ownership")));
  assert.ok(batch);
  assert.ok(batch.some(sql=>sql.includes("FROM subscription_sources WHERE id = ?")));
  assert.ok(batch.some(sql=>sql.includes("FROM app_users WHERE id = ? AND status = 'active'")));
  assert.ok(batch.some(sql=>sql.includes("INSERT INTO admin_audit_events")));
});


test("super source unassignment compare-and-swaps ownership and enabled state atomically",async()=>{
  const db=mockDb({role:"super_admin"});
  const {res,json}=await call(db,{path:"/api/super/sources/src123/assign",method:"DELETE"});
  assert.equal(res.status,200);assert.equal(json.data.owner,null);assert.equal(json.data.enabled,0);
  const batch=db.batches.find(items=>items.some(sql=>sql.startsWith("DELETE FROM source_ownership WHERE source_id = ? AND user_id = ?")));
  assert.ok(batch);
  assert.ok(batch.some(sql=>sql.includes("FROM subscription_sources WHERE id = ? AND enabled = ?")));
  assert.ok(batch.some(sql=>sql.includes("FROM source_ownership WHERE source_id = ? AND user_id = ?")));
  assert.ok(batch.some(sql=>sql.startsWith("UPDATE subscription_sources SET enabled = 0") && sql.includes("AND enabled = ?")));
  assert.ok(batch.some(sql=>sql.includes("INSERT INTO admin_audit_events")));
});


test("manual node update rechecks ownership and checks final UPDATE changes",async()=>{
  const db=mockDb();
  const {res,json}=await call(db,{path:"/api/user/nodes/manual/manual123",method:"PUT",body:{name:"Manual Updated"}});
  assert.equal(res.status,200);assert.equal(json.ok,true);
  const batch=db.batches.find(items=>items.some(sql=>sql.startsWith("UPDATE user_manual_nodes SET name=")));
  assert.ok(batch);
  assert.ok(batch.some(sql=>sql.includes("EXISTS (SELECT 1 FROM user_manual_nodes WHERE id = ? AND user_id = ?)")));
  assert.ok(batch.some(sql=>sql.startsWith("UPDATE user_manual_nodes SET name=") && sql.includes("WHERE id=? AND user_id=?")));
  assert.ok(batch.some(sql=>sql.includes("INSERT INTO admin_audit_events")));
});

test("manual node delete rechecks ownership before deleting node metadata and group members",async()=>{
  const db=mockDb();
  const {res,json}=await call(db,{path:"/api/user/nodes/manual/manual123",method:"DELETE"});
  assert.equal(res.status,200);assert.equal(json.ok,true);
  const batch=db.batches.find(items=>items.some(sql=>sql.startsWith("DELETE FROM user_manual_nodes WHERE id = ? AND user_id = ?")));
  assert.ok(batch);
  assert.ok(batch.some(sql=>sql.includes("EXISTS (SELECT 1 FROM user_manual_nodes WHERE id = ? AND user_id = ?)")));
  assert.ok(batch.some(sql=>sql.startsWith("DELETE FROM node_user_metadata")));
  assert.ok(batch.some(sql=>sql.startsWith("DELETE FROM node_group_members")));
  assert.ok(batch.some(sql=>sql.includes("INSERT INTO admin_audit_events")));
});


test("subscription node enabled toggle checks ownership and final upsert result",async()=>{
  const db=mockDb();
  const {res,json}=await call(db,{path:"/api/user/nodes/sub123/enabled",method:"PATCH",body:{enabled:false}});
  assert.equal(res.status,200);assert.equal(json.ok,true);
  const batch=db.batches.find(items=>items.some(sql=>sql.startsWith("INSERT INTO node_overrides(user_id, node_id, field_name, override_value, updated_by)")));
  assert.ok(batch);
  assert.ok(batch.some(sql=>sql.includes("JOIN source_ownership so ON so.source_id = n.source_id")));
  assert.ok(batch.some(sql=>sql.startsWith("INSERT INTO node_overrides")));
  assert.ok(batch.some(sql=>sql.includes("INSERT INTO admin_audit_events")));
});

test("manual node enabled toggle checks ownership and final UPDATE result",async()=>{
  const db=mockDb();
  const {res,json}=await call(db,{path:"/api/user/nodes/manual/manual123/enabled",method:"PATCH",body:{enabled:false}});
  assert.equal(res.status,200);assert.equal(json.ok,true);
  const batch=db.batches.find(items=>items.some(sql=>sql.startsWith("UPDATE user_manual_nodes SET enabled = ?")));
  assert.ok(batch);
  assert.ok(batch.some(sql=>sql.includes("EXISTS (SELECT 1 FROM user_manual_nodes WHERE id = ? AND user_id = ?)")));
  assert.ok(batch.some(sql=>sql.startsWith("UPDATE user_manual_nodes SET enabled = ?") && sql.includes("WHERE id = ? AND user_id = ?")));
  assert.ok(batch.some(sql=>sql.includes("INSERT INTO admin_audit_events")));
});


test("source enabled mutation checks final UPDATE result in the ownership batch",async()=>{
  const db=mockDb();
  const {res,json}=await call(db,{path:"/api/user/sources/src1/enabled",method:"PATCH",body:{enabled:false}});
  assert.equal(res.status,200);assert.equal(json.ok,true);
  const batch=db.batches.find(items=>items.some(sql=>sql.startsWith("UPDATE subscription_sources SET enabled = ?")));
  assert.ok(batch);
  assert.ok(batch.some(sql=>sql.includes("EXISTS (SELECT 1 FROM source_ownership WHERE source_id = ? AND user_id = ?)")));
  assert.ok(batch.some(sql=>sql.startsWith("UPDATE subscription_sources SET enabled = ?") && sql.includes("source_ownership so")));
  assert.ok(batch.some(sql=>sql.includes("INSERT INTO admin_audit_events")));
});

test("source edit mutation checks final UPDATE result in the ownership batch",async()=>{
  const db=mockDb();
  const {res,json}=await call(db,{path:"/api/user/sources/src1",method:"PUT",body:{name:"Source revised",url:"https://example.com/sub",tier:"free",priority:100,remark:"updated"}});
  assert.equal(res.status,200);assert.equal(json.ok,true);
  const batch=db.batches.find(items=>items.some(sql=>sql.startsWith("UPDATE subscription_sources SET name=")));
  assert.ok(batch);
  assert.ok(batch.some(sql=>sql.includes("EXISTS (SELECT 1 FROM source_ownership WHERE source_id = ? AND user_id = ?)")));
  assert.ok(batch.some(sql=>sql.startsWith("UPDATE subscription_sources SET name=") && sql.includes("source_ownership so")));
  assert.ok(batch.some(sql=>sql.includes("INSERT INTO admin_audit_events")));
});
