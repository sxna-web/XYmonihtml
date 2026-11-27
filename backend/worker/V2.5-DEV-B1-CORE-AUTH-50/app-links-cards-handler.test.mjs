import test from "node:test";
import assert from "node:assert/strict";
import worker from "../V2.5-DEV-B1-CORE-AUTH-49/Worker.js";

const now = "2026-11-27T12:00:00.000Z";
const activeTrial = [{kind:"trial",starts_at:"2026-11-20T00:00:00Z",ends_at:"2026-11-28T00:00:00Z"}];
const expiredTrial = [{kind:"trial",starts_at:"2026-11-01T00:00:00Z",ends_at:"2026-11-02T00:00:00Z"}];
const expiredFormal = [{kind:"formal",starts_at:"2026-10-01T00:00:00Z",ends_at:"2026-11-01T00:00:00Z"}];

function mockDb({role="user",actingAs=null,scope="manage",activations=[],activationFailure=false,
  link={id:"l1",created_at:"2026-10-20 00:00:00"},card={id:"c1",status:"normal",activated_at:null,used_at:null}}={}) {
  const writes=[];
  const sessionRow={
    id:"session-1",user_id:role==="super_admin"?"root":"u1",acting_as_user_id:actingAs,
    scope_id:actingAs?"scope-1":null,expires_at:"2099-01-01 00:00:00",revoked_at:null,
    u_id:role==="super_admin"?"root":"u1",username:"tester",role,status:"active",display_name:"Tester",
  };
  const db={
    writes,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            sql,args,
            async first() {
              if(sql.includes("FROM user_sessions s"))return sessionRow;
              if(sql.includes("SELECT 1 AS ok WHERE datetime(?)"))return{ok:1};
              if(sql.includes("FROM admin_user_scopes"))return actingAs?{scope}:null;
              if(sql.includes("SELECT links_enabled, max_links"))return null;
              if(sql.includes("SELECT COUNT(*) AS n FROM app_links"))return{n:0};
              if(sql.includes("SELECT COUNT(*) AS n FROM app_cards")&&sql.includes("status='normal'"))return{n:0};
              if(sql.includes("SELECT COUNT(*) AS n FROM app_cards"))return{n:0};
              if(sql.includes("FROM app_links WHERE id = ? AND admin_user_id = ?"))return link;
              if(sql.includes("FROM app_cards WHERE id = ? AND admin_user_id = ?"))return card;
              return null;
            },
            async all() {
              if(sql.includes("FROM admin_vip_activations")) {
                if(activationFailure)throw new Error("activation store unavailable");
                return{results:activations};
              }
              return{results:[]};
            },
            async run() {writes.push({sql,args});return{meta:{changes:1}};},
          };
        },
      };
    },
    async batch(stmts) {
      for(const st of stmts) writes.push({sql:st.sql,args:st.args});
      return stmts.map(()=>({success:true,meta:{changes:1}}));
    },
  };
  return db;
}
function businessWrites(db){return db.writes.filter(x=>/^(INSERT INTO app_links|DELETE FROM app_links|INSERT INTO app_cards|UPDATE app_cards|DELETE FROM app_cards)/i.test(x.sql.trim()));}
async function call(db,{path,method,body}){
  const req=new Request("https://worker.test"+path,{method,headers:{"Authorization":"Bearer test-session","Content-Type":"application/json"},...(method==="GET"||method==="DELETE"?{}:{body:JSON.stringify(body??{})})});
  const res=await worker.fetch(req,{DB:db,SESSION_PEPPER:"test-pepper"});
  return{res,json:await res.json()};
}

test("L1 cannot create APP links",async()=>{const db=mockDb();const{res,json}=await call(db,{path:"/api/user/app-links",method:"POST",body:{title:"Portal",url:"https://example.com"}});assert.equal(res.status,403);assert.equal(json.code,"VIP_REQUIRED");assert.equal(businessWrites(db).length,0)});
test("active trial can create APP link",async()=>{const db=mockDb({activations:activeTrial});const{res,json}=await call(db,{path:"/api/user/app-links",method:"POST",body:{title:"Portal",url:"https://example.com"}});assert.equal(res.status,201);assert.equal(json.ok,true);assert.equal(businessWrites(db).filter(x=>x.sql.startsWith("INSERT INTO app_links")).length,1)});
test("formal-expiry history delete for APP link uses owner and cutoff SQL",async()=>{const db=mockDb({activations:expiredFormal});const{res,json}=await call(db,{path:"/api/user/app-links/l1",method:"DELETE"});assert.equal(res.status,200);assert.equal(json.ok,true);const del=businessWrites(db).find(x=>x.sql.startsWith("DELETE FROM app_links"));assert.ok(del);assert.match(del.sql,/admin_user_id = \?/);assert.match(del.sql,/datetime\(created_at\) <= datetime\(\?\)/);assert.deepEqual(del.args,["l1","u1","2026-11-01T00:00:00.000Z"])});
test("cross-owner APP link delete is rejected before business write",async()=>{const db=mockDb({activations:activeTrial,link:null});const{res,json}=await call(db,{path:"/api/user/app-links/l1",method:"DELETE"});assert.equal(res.status,403);assert.equal(json.code,"RESOURCE_NOT_OWNED");assert.equal(businessWrites(db).length,0)});
test("L1 cannot generate APP cards",async()=>{const db=mockDb();const{res,json}=await call(db,{path:"/api/user/app-cards",method:"POST",body:{count:1,days:30}});assert.equal(res.status,403);assert.equal(json.code,"VIP_REQUIRED");assert.equal(businessWrites(db).length,0)});
test("active trial can generate APP cards through D1 batch",async()=>{const db=mockDb({activations:activeTrial});const{res,json}=await call(db,{path:"/api/user/app-cards",method:"POST",body:{count:1,days:30}});assert.equal(res.status,201);assert.equal(json.ok,true);assert.equal(businessWrites(db).filter(x=>x.sql.startsWith("INSERT INTO app_cards")).length,1)});
test("active trial can soft-disable an owned APP card",async()=>{const db=mockDb({activations:activeTrial});const{res,json}=await call(db,{path:"/api/user/app-cards/c1",method:"DELETE"});assert.equal(res.status,200);assert.equal(json.ok,true);const upd=businessWrites(db).find(x=>x.sql.startsWith("UPDATE app_cards"));assert.ok(upd);assert.match(upd.sql,/admin_user_id = \?/);});
test("expired formal VIP cannot disable an APP card",async()=>{const db=mockDb({activations:expiredFormal});const{res,json}=await call(db,{path:"/api/user/app-cards/c1/disable",method:"POST",body:{reason:"test"}});assert.equal(res.status,403);assert.equal(json.code,"VIP_REQUIRED");assert.equal(businessWrites(db).length,0)});
test("cross-owner APP card disable is rejected by owner lookup",async()=>{const db=mockDb({activations:activeTrial,card:null});const{res,json}=await call(db,{path:"/api/user/app-cards/c1/disable",method:"POST",body:{reason:"test"}});assert.equal(res.status,404);assert.equal(businessWrites(db).length,0)});
test("activation query failure blocks APP link creation",async()=>{const db=mockDb({activationFailure:true});const{res,json}=await call(db,{path:"/api/user/app-links",method:"POST",body:{title:"Portal",url:"https://example.com"}});assert.equal(res.status,403);assert.equal(json.code,"VIP_STATUS_UNAVAILABLE");assert.equal(businessWrites(db).length,0)});
test("direct super-admin session can generate APP cards",async()=>{const db=mockDb({role:"super_admin"});const{res,json}=await call(db,{path:"/api/user/app-cards",method:"POST",body:{count:1,days:30}});assert.equal(res.status,201);assert.equal(json.ok,true);assert.equal(businessWrites(db).length,1)});
test("assist manage scope does not grant target user APP-link rights without VIP",async()=>{const db=mockDb({role:"super_admin",actingAs:"u1",scope:"manage"});const{res,json}=await call(db,{path:"/api/user/app-links",method:"POST",body:{title:"Portal",url:"https://example.com"}});assert.equal(res.status,403);assert.equal(json.code,"VIP_REQUIRED");assert.equal(businessWrites(db).length,0)});
