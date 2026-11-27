import test from "node:test";
import assert from "node:assert/strict";
import { resolveAppEntitlement } from "./entitlement-resolver.mjs";

const NOW = "2026-11-27T12:00:00.000Z";
const ROW_A = { id:"entitlement_A123", admin_user_id:"admin_A", device_id:"device_12345678", expires_at:"2026-12-01 00:00:00", status:"active" };
const ROW_B = { id:"entitlement_B456", admin_user_id:"admin_B", device_id:"device_12345678", expires_at:"2026-12-02 00:00:00", status:"active" };

function mockDb(rows=[ROW_A,ROW_B], {fail=false}={}) {
  const calls=[];
  return {
    calls,
    prepare(sql) {
      return { bind(...args) { return { async first() {
        calls.push({sql,args});
        if(fail) throw new Error("D1 unavailable");
        return rows.find(r=>r.id===args[0] && r.device_id===args[1]) || null;
      }}; }};
    },
  };
}
const verify=(expectedId,expectedDevice,expectedToken="token_for_test_123") =>
  async (id,device,token)=>id===expectedId && device===expectedDevice && token===expectedToken;

test("selects exact older entitlement rather than latest entitlement",async()=>{
  const db=mockDb();
  const r=await resolveAppEntitlement({db,entitlementId:ROW_A.id,deviceId:ROW_A.device_id,token:"token_for_test_123",verifyToken:verify(ROW_A.id,ROW_A.device_id),now:NOW});
  assert.equal(r.ok,true);assert.equal(r.entitlement.admin_user_id,"admin_A");
  assert.deepEqual(db.calls[0].args,[ROW_A.id,ROW_A.device_id]);
  assert.doesNotMatch(db.calls[0].sql,/ORDER BY created_at DESC/);
});
test("same device can resolve a second administrator entitlement independently",async()=>{
  const db=mockDb();
  const r=await resolveAppEntitlement({db,entitlementId:ROW_B.id,deviceId:ROW_B.device_id,token:"token_for_test_123",verifyToken:verify(ROW_B.id,ROW_B.device_id),now:NOW});
  assert.equal(r.ok,true);assert.equal(r.entitlement.admin_user_id,"admin_B");
});
test("A token cannot authenticate B entitlement",async()=>{
  const r=await resolveAppEntitlement({db:mockDb(),entitlementId:ROW_B.id,deviceId:ROW_B.device_id,token:"token_for_test_123",verifyToken:verify(ROW_A.id,ROW_A.device_id),now:NOW});
  assert.equal(r.ok,false);assert.equal(r.code,"BAD_TOKEN");
});
test("wrong device cannot select entitlement",async()=>{
  const db=mockDb();
  const r=await resolveAppEntitlement({db,entitlementId:ROW_A.id,deviceId:"device_other_123",token:"token_for_test_123",verifyToken:verify(ROW_A.id,ROW_A.device_id),now:NOW});
  assert.equal(r.ok,false);assert.equal(r.code,"ENTITLEMENT_NOT_FOUND");
});
test("missing entitlement id is rejected before D1 read",async()=>{
  const db=mockDb();const r=await resolveAppEntitlement({db,entitlementId:"",deviceId:ROW_A.device_id,token:"token_for_test_123",verifyToken:verify(ROW_A.id,ROW_A.device_id),now:NOW});
  assert.equal(r.code,"BAD_ENTITLEMENT_ID");assert.equal(db.calls.length,0);
});
test("missing token is rejected before D1 read",async()=>{
  const db=mockDb();const r=await resolveAppEntitlement({db,entitlementId:ROW_A.id,deviceId:ROW_A.device_id,token:"",verifyToken:verify(ROW_A.id,ROW_A.device_id),now:NOW});
  assert.equal(r.code,"BAD_TOKEN");assert.equal(db.calls.length,0);
});
test("inactive entitlement is rejected",async()=>{
  const db=mockDb([{...ROW_A,status:"expired"}]);
  const r=await resolveAppEntitlement({db,entitlementId:ROW_A.id,deviceId:ROW_A.device_id,token:"token_for_test_123",verifyToken:verify(ROW_A.id,ROW_A.device_id),now:NOW});
  assert.equal(r.code,"ENTITLEMENT_INACTIVE");
});
test("expired entitlement is rejected",async()=>{
  const db=mockDb([{...ROW_A,expires_at:"2026-11-27 11:59:59"}]);
  const r=await resolveAppEntitlement({db,entitlementId:ROW_A.id,deviceId:ROW_A.device_id,token:"token_for_test_123",verifyToken:verify(ROW_A.id,ROW_A.device_id),now:NOW});
  assert.equal(r.code,"ENTITLEMENT_EXPIRED");
});
test("invalid expiry fails closed",async()=>{
  const db=mockDb([{...ROW_A,expires_at:"not-a-date"}]);
  const r=await resolveAppEntitlement({db,entitlementId:ROW_A.id,deviceId:ROW_A.device_id,token:"token_for_test_123",verifyToken:verify(ROW_A.id,ROW_A.device_id),now:NOW});
  assert.equal(r.code,"ENTITLEMENT_TIME_INVALID");
});
test("D1 failure fails closed",async()=>{
  const db=mockDb([],{fail:true});
  const r=await resolveAppEntitlement({db,entitlementId:ROW_A.id,deviceId:ROW_A.device_id,token:"token_for_test_123",verifyToken:verify(ROW_A.id,ROW_A.device_id),now:NOW});
  assert.equal(r.code,"ENTITLEMENT_STORE_UNAVAILABLE");
});
test("token verifier exception fails closed",async()=>{
  const r=await resolveAppEntitlement({db:mockDb(),entitlementId:ROW_A.id,deviceId:ROW_A.device_id,token:"token_for_test_123",verifyToken:async()=>{throw Error("bad")},now:NOW});
  assert.equal(r.code,"BAD_TOKEN");
});
test("does not accept client-supplied admin identity",async()=>{
  const r=await resolveAppEntitlement({db:mockDb(),entitlementId:ROW_A.id,deviceId:ROW_A.device_id,token:"token_for_test_123",admin_user_id:"admin_B",verifyToken:verify(ROW_A.id,ROW_A.device_id),now:NOW});
  assert.equal(r.ok,true);assert.equal(r.entitlement.admin_user_id,"admin_A");
});
test("rejects malformed device id before D1 read",async()=>{
  const db=mockDb();const r=await resolveAppEntitlement({db,entitlementId:ROW_A.id,deviceId:"bad device",token:"token_for_test_123",verifyToken:verify(ROW_A.id,ROW_A.device_id),now:NOW});
  assert.equal(r.code,"BAD_DEVICE_ID");assert.equal(db.calls.length,0);
});
test("requires a valid server clock value",async()=>{
  const r=await resolveAppEntitlement({db:mockDb(),entitlementId:ROW_A.id,deviceId:ROW_A.device_id,token:"token_for_test_123",verifyToken:verify(ROW_A.id,ROW_A.device_id),now:"bad-time"});
  assert.equal(r.code,"ENTITLEMENT_TIME_INVALID");
});
