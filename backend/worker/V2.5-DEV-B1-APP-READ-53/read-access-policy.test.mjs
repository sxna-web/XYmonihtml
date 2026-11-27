import test from "node:test";
import assert from "node:assert/strict";
import { authorizeAppRead, isWithinEntitlementScope } from "./read-access-policy.mjs";

const NOW="2026-11-27T12:00:00Z";
const A={id:"entitlement_A123",admin_user_id:"admin_A",device_id:"device_12345678",expires_at:"2026-12-01 00:00:00",status:"active"};
const B={id:"entitlement_B456",admin_user_id:"admin_B",device_id:"device_12345678",expires_at:"2026-12-02 00:00:00",status:"active"};
function db(rows=[A,B],fail=false){return {prepare(sql){return {bind(...args){return {first:async()=>{if(fail)throw Error("D1");return rows.find(r=>r.id===args[0]&&r.device_id===args[1])||null;}}}}}}}
const verify=(id,dev,token="valid_token_123456")=>async(a,b,c)=>a===id&&b===dev&&c===token;
for(const endpoint of ["status","groups","links","nodes"]){
 test(endpoint+" rejects missing token",async()=>{
  const r=await authorizeAppRead({endpoint,db:db(),entitlementId:A.id,deviceId:A.device_id,token:"",verifyToken:verify(A.id,A.device_id),now:NOW});
  assert.equal(r.allowed,false);assert.equal(r.code,"BAD_TOKEN");
 });
 test(endpoint+" rejects invalid token",async()=>{
  const r=await authorizeAppRead({endpoint,db:db(),entitlementId:A.id,deviceId:A.device_id,token:"wrong_token_123456",verifyToken:verify(A.id,A.device_id),now:NOW});
  assert.equal(r.allowed,false);assert.equal(r.code,"BAD_TOKEN");
 });
}
test("older entitlement A is independently authorized",async()=>{
 const r=await authorizeAppRead({endpoint:"nodes",db:db(),entitlementId:A.id,deviceId:A.device_id,token:"valid_token_123456",verifyToken:verify(A.id,A.device_id),now:NOW});
 assert.equal(r.allowed,true);assert.equal(r.adminUserId,"admin_A");
});
test("newer entitlement B is independently authorized",async()=>{
 const r=await authorizeAppRead({endpoint:"groups",db:db(),entitlementId:B.id,deviceId:B.device_id,token:"valid_token_123456",verifyToken:verify(B.id,B.device_id),now:NOW});
 assert.equal(r.allowed,true);assert.equal(r.adminUserId,"admin_B");
});
test("A token cannot access B entitlement",async()=>{
 const r=await authorizeAppRead({endpoint:"links",db:db(),entitlementId:B.id,deviceId:B.device_id,token:"valid_token_123456",verifyToken:verify(A.id,A.device_id),now:NOW});
 assert.equal(r.allowed,false);assert.equal(r.code,"BAD_TOKEN");
});
test("wrong device cannot access entitlement",async()=>{
 const r=await authorizeAppRead({endpoint:"status",db:db(),entitlementId:A.id,deviceId:"device_other_123",token:"valid_token_123456",verifyToken:verify(A.id,A.device_id),now:NOW});
 assert.equal(r.allowed,false);assert.equal(r.code,"ENTITLEMENT_NOT_FOUND");
});
test("expired entitlement is rejected",async()=>{
 const r=await authorizeAppRead({endpoint:"nodes",db:db([{...A,expires_at:"2026-11-27 11:00:00"}]),entitlementId:A.id,deviceId:A.device_id,token:"valid_token_123456",verifyToken:verify(A.id,A.device_id),now:NOW});
 assert.equal(r.allowed,false);assert.equal(r.code,"ENTITLEMENT_EXPIRED");
});
test("revoked/inactive entitlement is rejected",async()=>{
 const r=await authorizeAppRead({endpoint:"groups",db:db([{...A,status:"revoked"}]),entitlementId:A.id,deviceId:A.device_id,token:"valid_token_123456",verifyToken:verify(A.id,A.device_id),now:NOW});
 assert.equal(r.allowed,false);assert.equal(r.code,"ENTITLEMENT_INACTIVE");
});
test("D1 errors fail closed",async()=>{
 const r=await authorizeAppRead({endpoint:"links",db:db([],true),entitlementId:A.id,deviceId:A.device_id,token:"valid_token_123456",verifyToken:verify(A.id,A.device_id),now:NOW});
 assert.equal(r.allowed,false);assert.equal(r.code,"ENTITLEMENT_STORE_UNAVAILABLE");
});
test("free share-code resolution is binding-only, never node authorization",async()=>{
 const r=await authorizeAppRead({endpoint:"free",shareCodeResolvedAdminId:"admin_A"});
 assert.equal(r.allowed,true);assert.equal(r.action,"BIND_ADMIN_ONLY");assert.equal(r.mayReadNodes,false);assert.equal(r.mayReadGroups,false);
});
test("free endpoint without resolved administrator is rejected",async()=>{
 const r=await authorizeAppRead({endpoint:"free"});
 assert.equal(r.allowed,false);assert.equal(r.code,"FREE_BINDING_NOT_FOUND");
});
test("unknown endpoint is rejected",async()=>{
 const r=await authorizeAppRead({endpoint:"debug",db:db()});
 assert.equal(r.allowed,false);assert.equal(r.code,"UNKNOWN_READ_ENDPOINT");
});
test("administrator A cannot read administrator B rows",()=>{
 assert.equal(isWithinEntitlementScope({rowAdminUserId:"admin_B",entitlementAdminUserId:"admin_A"}),false);
});
test("group outside entitlement allowed group IDs is rejected",()=>{
 assert.equal(isWithinEntitlementScope({rowAdminUserId:"admin_A",entitlementAdminUserId:"admin_A",groupId:"group_B",allowedGroupIds:["group_A"]}),false);
});
test("group in entitlement allowed group IDs is accepted",()=>{
 assert.equal(isWithinEntitlementScope({rowAdminUserId:"admin_A",entitlementAdminUserId:"admin_A",groupId:"group_A",allowedGroupIds:["group_A"]}),true);
});
test("group access with no scope list fails closed",()=>{
 assert.equal(isWithinEntitlementScope({rowAdminUserId:"admin_A",entitlementAdminUserId:"admin_A",groupId:"group_A"}),false);
});
test("row ownership mismatch is rejected even if group ID matches",()=>{
 assert.equal(isWithinEntitlementScope({rowAdminUserId:"admin_B",entitlementAdminUserId:"admin_A",groupId:"group_A",allowedGroupIds:["group_A"]}),false);
});
