import test from "node:test";
import assert from "node:assert/strict";
import { createAppV2ReadHandler } from "./app-v2-read-handler.mjs";
import { createEntitlementTokenVerifier, createEntitlementTokenAdapter } from "./entitlement-token-adapter.mjs";

const SECRET = "unit-test-secret-that-is-at-least-32-characters";
const ENT_A = { id: "entitlement_A123", admin_user_id: "admin_A", device_id: "device_12345678", expires_at: "2026-12-01T00:00:00Z" };
const ENT_B = { id: "entitlement_B456", admin_user_id: "admin_B", device_id: "device_12345678", expires_at: "2026-12-02T00:00:00Z" };
const GROUP_A = { id: "group_A", adminUserId: "admin_A", enabled: true, mode: "card" };
const GROUP_B = { id: "group_B", adminUserId: "admin_B", enabled: true, mode: "card" };

function mockDb(rows = [ENT_A, ENT_B], fail = false) {
  const calls = [];
  return { calls, prepare(sql) { return { bind(...args) { return { async first() {
    calls.push({ sql, args });
    if (fail) throw new Error("D1 unavailable");
    return rows.find(row => row.id === args[0] && row.device_id === args[1]) || null;
  } }; } }; } };
}
async function tokenFor(ent) {
  const verifier = await createEntitlementTokenVerifier(SECRET);
  // Generate the same HMAC using WebCrypto; test token generation remains isolated.
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name:"HMAC", hash:"SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${ent.id}|${ent.device_id}`));
  let binary = ""; for (const b of new Uint8Array(sig)) binary += String.fromCharCode(b);
  assert.equal(await verifier(ent.id, ent.device_id, btoa(binary).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"")), true);
  return btoa(binary).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
}
function setup({ rows, failDb = false, secret = SECRET, scope, nodes, links, status } = {}) {
  const db = mockDb(rows, failDb);
  const adapter = createEntitlementTokenAdapter({ db, env: { APP_ENTITLEMENT_SECRET: secret }, now: "2026-11-27T12:00:00.000Z" });
  const calls = { groups: [], nodes: [], links: [], status: [] };
  const handler = createAppV2ReadHandler({
    resolveEntitlement: adapter,
    loadGroups: async ent => { calls.groups.push(ent.id); return scope || { ok:true, allowedGroupIds: ent.admin_user_id === "admin_A" ? ["group_A"] : ["group_B"], groups:[ent.admin_user_id === "admin_A" ? GROUP_A : GROUP_B], generation:3 }; },
    loadNodes: async args => { calls.nodes.push(args); return nodes || { ok:true, nodes:[{ id:"node1", adminUserId:args.entitlement.admin_user_id, groupId:args.allowedGroupIds[0] }] }; },
    loadLinks: async args => { calls.links.push(args); return links || { ok:true, links:[{ id:"link1", adminUserId:args.entitlement.admin_user_id, groupId:args.allowedGroupIds[0] }] }; },
    loadStatus: async ent => { calls.status.push(ent.id); return status || { ok:true, data:{ active:true } }; },
  });
  return { db, handler, calls };
}
async function request(handler, ent = ENT_A, token, resource = "groups", extra = {}) {
  const value = token ?? await tokenFor(ent);
  return handler(new Request(`https://unit.test/api/app/v2/entitlements/${ent.id}/${resource}`, {
    method:"GET", headers:{ "x-app-device-id":ent.device_id, authorization:`Bearer ${value}`, ...extra },
  }));
}

test("valid HMAC token authenticates the exact entitlement without Session resolver", async () => {
  const { handler, db, calls } = setup();
  const res = await request(handler);
  assert.equal(res.status,200);
  assert.equal(db.calls[0].args[0],ENT_A.id);
  assert.deepEqual(calls.groups,[ENT_A.id]);
});
test("same device can read two entitlements independently", async () => {
  const { handler } = setup();
  assert.equal((await request(handler,ENT_A)).status,200);
  assert.equal((await request(handler,ENT_B)).status,200);
});
test("A token cannot authenticate B entitlement", async () => {
  const { handler } = setup();
  const token = await tokenFor(ENT_A);
  const res = await request(handler,ENT_B,token);
  assert.equal(res.status,403);
});
test("missing dedicated secret fails closed", async () => {
  const { handler } = setup({ secret: undefined });
  const res = await request(handler);
  assert.equal(res.status,503);
  assert.equal((await res.json()).code,"ENTITLEMENT_SECRET_UNAVAILABLE");
});
test("short dedicated secret fails closed", async () => {
  const { handler } = setup({ secret:"short" });
  assert.equal((await request(handler)).status,503);
});
test("legacy SESSION_PEPPER is never used as a fallback", async () => {
  const db=mockDb();
  const adapter=createEntitlementTokenAdapter({db,env:{SESSION_PEPPER:SECRET},now:"2026-11-27T12:00:00Z"});
  assert.equal((await adapter({entitlementId:ENT_A.id,deviceId:ENT_A.device_id,token:await tokenFor(ENT_A)})).code,"ENTITLEMENT_SECRET_UNAVAILABLE");
});
test("wrong device cannot resolve entitlement", async () => {
  const { handler }=setup();
  const token=await tokenFor(ENT_A);
  const res=await handler(new Request(`https://unit.test/api/app/v2/entitlements/${ENT_A.id}/groups`,{headers:{"x-app-device-id":"device_other_123",authorization:`Bearer ${token}`}}));
  assert.equal(res.status,403);
});
test("missing device header is rejected", async () => {
  const { handler }=setup();
  const token=await tokenFor(ENT_A);
  const res=await handler(new Request(`https://unit.test/api/app/v2/entitlements/${ENT_A.id}/groups`,{headers:{authorization:`Bearer ${token}`}}));
  assert.equal(res.status,401);
});
test("malformed bearer token is rejected before resolver", async () => {
  const { handler, db }=setup();
  const res=await request(handler,ENT_A,"bad","groups");
  assert.equal(res.status,401);assert.equal(db.calls.length,0);
});
test("D1 error fails closed", async () => {
  const { handler }=setup({failDb:true});
  const res=await request(handler);
  assert.equal(res.status,503);
  assert.equal((await res.json()).code,"ENTITLEMENT_STORE_UNAVAILABLE");
});
test("expired entitlement fails closed", async () => {
  const { handler }=setup({rows:[{...ENT_A,expires_at:"2026-11-27T11:59:59Z"}]});
  assert.equal((await request(handler)).status,403);
});
test("inactive entitlement fails closed", async () => {
  const { handler }=setup({rows:[{...ENT_A,status:"revoked"}]});
  assert.equal((await request(handler)).status,403);
});
test("does not accept client adminId as authorization scope", async () => {
  const { handler, calls }=setup();
  const res=await request(handler,ENT_A,undefined,"groups",{"x-admin-id":"admin_B"});
  assert.equal(res.status,200);assert.deepEqual(calls.groups,[ENT_A.id]);
});
test("empty allowlist returns empty nodes without invoking node loader", async () => {
  const { handler, calls }=setup({scope:{ok:true,allowedGroupIds:[],groups:[]}});
  const res=await request(handler,ENT_A,undefined,"nodes");
  assert.equal(res.status,200);assert.deepEqual((await res.json()).nodes,[]);assert.equal(calls.nodes.length,0);
});
test("node outside entitlement group scope is rejected", async () => {
  const { handler }=setup({nodes:{ok:true,nodes:[{id:"foreign",adminUserId:"admin_A",groupId:"group_B"}]}});
  assert.equal((await request(handler,ENT_A,undefined,"nodes")).status,403);
});
test("node owned by another administrator is rejected", async () => {
  const { handler }=setup({nodes:{ok:true,nodes:[{id:"foreign",adminUserId:"admin_B",groupId:"group_A"}]}});
  assert.equal((await request(handler,ENT_A,undefined,"nodes")).status,403);
});
test("group from another administrator is rejected", async () => {
  const { handler }=setup({scope:{ok:true,allowedGroupIds:["group_B"],groups:[GROUP_B]}});
  assert.equal((await request(handler)).status,403);
});
test("duplicate group allowlist fails closed", async () => {
  const { handler }=setup({scope:{ok:true,allowedGroupIds:["group_A","group_A"],groups:[GROUP_A]}});
  assert.equal((await request(handler)).status,403);
});
test("links are constrained to resolved administrator and group scope", async () => {
  const { handler }=setup();
  assert.equal((await request(handler,ENT_A,undefined,"links")).status,200);
});
test("cross-admin link result is rejected", async () => {
  const { handler }=setup({links:{ok:true,links:[{id:"foreign",adminUserId:"admin_B",groupId:"group_A"}]}});
  assert.equal((await request(handler,ENT_A,undefined,"links")).status,403);
});
test("status uses only the resolved entitlement context", async () => {
  const { handler, calls }=setup();
  assert.equal((await request(handler,ENT_A,undefined,"status")).status,200);
  assert.deepEqual(calls.status,[ENT_A.id]);
});
test("status backend error fails closed", async () => {
  const { handler }=setup({status:{ok:false,code:"STATUS_SCOPE_DENIED"}});
  assert.equal((await request(handler,ENT_A,undefined,"status")).status,403);
});
test("unknown path and non-GET methods are rejected", async () => {
  const { handler }=setup();
  const a=await handler(new Request("https://unit.test/api/app/v2/entitlements/entitlement_A123/unknown"));
  const b=await handler(new Request("https://unit.test/api/app/v2/entitlements/entitlement_A123/groups",{method:"POST"}));
  assert.equal(a.status,404);assert.equal(b.status,404);
});
