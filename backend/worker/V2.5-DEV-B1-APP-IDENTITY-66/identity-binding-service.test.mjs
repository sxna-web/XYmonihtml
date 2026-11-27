import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { createIdentityTokenAdapter } from "./identity-token.mjs";
import {
  createIdentityBindingService,
  mergeIdentityFreeGroupsWithCardComposition,
} from "./identity-binding-service.mjs";

const DEVICE_A = "device_A_123456";
const DEVICE_B = "device_B_123456";
const SECRET = "identity-secret-for-isolated-tests-32chars-minimum";
const NOW = 1_800_000_000_000;
const CODE_A = "ABCD2345";
const CODE_B = "EFGH6789";
const group=(id,adminUserId,name="免费线路")=>({id,adminUserId,name,mode:"free",enabled:true});

function harness() {
  const codes = new Map([
    [CODE_A,{adminUserId:"admin_A",codeVersion:1,active:true}],
    [CODE_B,{adminUserId:"admin_B",codeVersion:4,active:true}],
  ]);
  const eligibility = new Map([
    ["admin_A",{accountActive:true,activeVipAdmin:true,freeGroupEnabled:true,adminDisplayName:"管理员甲"}],
    ["admin_B",{accountActive:true,activeVipAdmin:true,freeGroupEnabled:true,adminDisplayName:"管理员乙"}],
  ]);
  const bindings = new Map();
  const rateCalls=[];const challengeCalls=[];const createCalls=[];const groupCalls=[];
  const tokenAdapter=createIdentityTokenAdapter({secret:SECRET,cryptoImpl:webcrypto,now:()=>NOW,ttlSeconds:3600});
  const service=createIdentityBindingService({
    lookupShareCode:async code=>codes.get(code) || null,
    checkAdminEligibility:async adminId=>eligibility.get(adminId) || null,
    consumeRateLimit:async args=>{rateCalls.push(args);return {ok:true};},
    verifyAndConsumeChallenge:async args=>{
      challengeCalls.push(args);
      if(args.proof==="valid-device-proof-123456") return {ok:true,deviceKeyThumbprint:"key_thumbprint_01"};
      return {ok:false};
    },
    verifyDeviceRequestProof:async args=>args.deviceKeyThumbprint==="key_thumbprint_01" &&
      args.requestNonce==="nonce_123456" && args.proof==="valid-device-proof-123456",
    getOrCreateBinding:async input=>{
      createCalls.push(input);
      const key=input.adminUserId+"|"+input.deviceId;
      let row=bindings.get(key);
      if(!row){
        row={bindingId:"binding_"+(bindings.size+1),...input,status:"active"};
        bindings.set(key,row);
      }
      return row;
    },
    loadBinding:async id=>[...bindings.values()].find(x=>x.bindingId===id) || null,
    loadFreeGroups:async adminId=>{
      groupCalls.push(adminId);
      return adminId==="admin_A"?[group("free_A","admin_A")]:adminId==="admin_B"?[group("free_B","admin_B")]:[];
    },
    identityTokenAdapter: tokenAdapter,
    now:()=>NOW,
  });
  return {service,codes,eligibility,bindings,rateCalls,challengeCalls,createCalls,groupCalls,tokenAdapter};
}
async function bind(h,code=CODE_A,deviceId=DEVICE_A,challengeId="challenge_0001"){
  return h.service.bind({shareCode:code,deviceId,challengeId,proof:"valid-device-proof-123456",rateLimitKey:"rate-key-device"});
}

test("public discovery reveals no admin ID, binding credential, or node data",async()=>{
 const h=harness();
 const r=await h.service.discover({shareCode:CODE_A.toLowerCase(),deviceId:DEVICE_A,rateLimitKey:"ip-key"});
 assert.equal(r.ok,true);
 assert.deepEqual(r.discovery,{adminDisplayName:"管理员甲",freeGroupAvailable:true});
 assert.equal(Object.hasOwn(r.discovery,"adminUserId"),false);
 assert.equal(Object.hasOwn(r.discovery,"token"),false);
 assert.equal(Object.hasOwn(r,"groups"),false);
});

test("unknown, revoked, and ineligible share codes return one generic result",async()=>{
 const h=harness();
 h.codes.set("JKLM2345",{adminUserId:"admin_A",codeVersion:2,active:false});
 h.eligibility.set("admin_B",{accountActive:true,activeVipAdmin:false,freeGroupEnabled:true});
 for(const code of ["ZZZZ9999","JKLM2345",CODE_B]){
  const r=await h.service.discover({shareCode:code,deviceId:DEVICE_A,rateLimitKey:"ip-key"});
  assert.deepEqual(r,{ok:false,code:"IDENTITY_NOT_AVAILABLE"});
 }
});

test("share code lookup and binding are rate limited before database lookup",async()=>{
 const h=harness();
 h.service= createIdentityBindingService({
  lookupShareCode:async()=>{throw Error("should not query");},
  checkAdminEligibility:async()=>null,
  consumeRateLimit:async()=>({ok:false}),
  verifyAndConsumeChallenge:async()=>({ok:false}),
  getOrCreateBinding:async()=>null,loadBinding:async()=>null,loadFreeGroups:async()=>[],
  identityTokenAdapter:h.tokenAdapter,
 });
 assert.equal((await h.service.discover({shareCode:CODE_A,deviceId:DEVICE_A,rateLimitKey:"ip"})).code,"RATE_LIMITED");
 assert.equal((await h.service.bind({shareCode:CODE_A,deviceId:DEVICE_A,challengeId:"challenge_01",proof:"valid-device-proof-123456",rateLimitKey:"ip"})).code,"RATE_LIMITED");
});

test("binding requires a valid single-use device proof challenge",async()=>{
 const h=harness();
 const r=await h.service.bind({shareCode:CODE_A,deviceId:DEVICE_A,challengeId:"challenge_0001",proof:"invalid-device-proof-000",rateLimitKey:"rate"});
 assert.equal(r.code,"IDENTITY_DEVICE_PROOF_INVALID");
 assert.equal(h.createCalls.length,0);
});

test("same admin and device binding is idempotent",async()=>{
 const h=harness();
 const first=await bind(h);
 const second=await bind(h,CODE_A,DEVICE_A,"challenge_0002");
 assert.equal(first.ok,true);assert.equal(second.ok,true);
 assert.equal(first.bindingId,second.bindingId);
 assert.equal(h.bindings.size,1);
});

test("one device can bind different administrators without merging their identity scopes",async()=>{
 const h=harness();
 const a=await bind(h,CODE_A,DEVICE_A,"challenge_0001");
 const b=await bind(h,CODE_B,DEVICE_A,"challenge_0002");
 assert.equal(a.ok,true);assert.equal(b.ok,true);
 const result=await h.service.resolveManyAndLoadFreeGroups({credentials:[{token:a.token,requestNonce:"nonce_123456",proof:"valid-device-proof-123456"},{token:b.token,requestNonce:"nonce_123456",proof:"valid-device-proof-123456"}],deviceId:DEVICE_A,rateLimitKey:"resolve"});
 assert.equal(result.ok,true);
 assert.deepEqual(result.groups.map(g=>g.adminUserId).sort(),["admin_A","admin_B"]);
 assert.deepEqual(new Set(h.groupCalls),new Set(["admin_A","admin_B"]));
});

test("duplicate identity credentials load the same admin free groups only once",async()=>{
 const h=harness();
 const a=await bind(h);
 const b=await bind(h,CODE_A,DEVICE_A,"challenge_0002");
 const result=await h.service.resolveManyAndLoadFreeGroups({credentials:[{token:a.token,requestNonce:"nonce_123456",proof:"valid-device-proof-123456"},{token:b.token,requestNonce:"nonce_123456",proof:"valid-device-proof-123456"}],deviceId:DEVICE_A,rateLimitKey:"resolve"});
 assert.equal(result.ok,true);
 assert.equal(result.groups.length,1);
 assert.equal(h.groupCalls.filter(x=>x==="admin_A").length,1);
});

test("disabled free group or expired VIP immediately blocks discovery and existing identity reads",async()=>{
 const h=harness();
 const issued=await bind(h);
 h.eligibility.set("admin_A",{accountActive:true,activeVipAdmin:true,freeGroupEnabled:false});
 assert.equal((await h.service.discover({shareCode:CODE_A,deviceId:DEVICE_A,rateLimitKey:"discover"})).code,"IDENTITY_NOT_AVAILABLE");
 assert.equal((await h.service.resolveCredential({token:issued.token,deviceId:DEVICE_A,requestNonce:"nonce_123456",proof:"valid-device-proof-123456"})).code,"IDENTITY_FREE_GROUP_NOT_AUTHORIZED");
});

test("inactive or non-VIP admin cannot bind even if share code exists",async()=>{
 const h=harness();
 h.eligibility.set("admin_A",{accountActive:true,activeVipAdmin:false,freeGroupEnabled:true});
 assert.equal((await bind(h)).code,"IDENTITY_NOT_AVAILABLE");
 assert.equal(h.bindings.size,0);
});

test("rotated share code blocks old code for new binds but does not silently erase existing binding",async()=>{
 const h=harness();
 const old=await bind(h);
 h.codes.set(CODE_A,{adminUserId:"admin_A",codeVersion:2,active:false});
 h.codes.set("QWER2345",{adminUserId:"admin_A",codeVersion:2,active:true});
 assert.equal((await bind(h,CODE_A,DEVICE_A,"challenge_0002")).code,"IDENTITY_NOT_AVAILABLE");
 const existing=await h.service.resolveCredential({token:old.token,deviceId:DEVICE_A});
 assert.equal(existing.ok,true);
 const fresh=await bind(h,"QWER2345",DEVICE_A,"challenge_0003");
 assert.equal(fresh.ok,true);
 assert.equal(fresh.bindingId,old.bindingId);
});

test("revoked binding cannot be used even when the share code remains active",async()=>{
 const h=harness();
 const issued=await bind(h);
 const row=[...h.bindings.values()][0];row.status="revoked";
 assert.equal((await h.service.resolveCredential({token:issued.token,deviceId:DEVICE_A,requestNonce:"nonce_123456",proof:"valid-device-proof-123456"})).code,"IDENTITY_BINDING_REVOKED_OR_MISMATCHED");
});

test("credential cannot be replayed on a different device",async()=>{
 const h=harness();
 const issued=await bind(h);
 assert.equal((await h.service.resolveCredential({token:issued.token,deviceId:DEVICE_B,requestNonce:"nonce_123456",proof:"valid-device-proof-123456"})).code,"IDENTITY_CREDENTIAL_INVALID");
});

test("client-supplied admin ID cannot change the signed identity context",async()=>{
 const h=harness();
 const issued=await bind(h);
 const result=await h.service.resolveCredential({token:issued.token,deviceId:DEVICE_A,adminUserId:"admin_B",requestNonce:"nonce_123456",proof:"valid-device-proof-123456"});
 assert.equal(result.ok,true);
 assert.equal(result.context.adminUserId,"admin_A");
});

test("identity credential cannot be used to impersonate another admin",async()=>{
 const h=harness();
 const issued=await bind(h);
 const claims=await h.tokenAdapter.verify({token:issued.token,deviceId:DEVICE_A});
 const forged=await h.tokenAdapter.issue({bindingId:claims.bindingId,adminUserId:"admin_B",deviceId:DEVICE_A});
 assert.equal((await h.service.resolveCredential({token:forged,deviceId:DEVICE_A,requestNonce:"nonce_123456",proof:"valid-device-proof-123456"})).code,"IDENTITY_BINDING_REVOKED_OR_MISMATCHED");
});

test("group loader must return only enabled free groups owned by exact admin",async()=>{
 const h=harness();
 const issued=await bind(h);
 h.service=createIdentityBindingService({
  lookupShareCode:async code=>h.codes.get(code)||null,
  checkAdminEligibility:async id=>h.eligibility.get(id)||null,
  consumeRateLimit:async()=>true,
  verifyAndConsumeChallenge:async()=>({ok:true,deviceKeyThumbprint:"key_thumbprint_01"}),
  getOrCreateBinding:async input=>{const row=[...h.bindings.values()][0];return row||{bindingId:"binding_x",...input,status:"active"};},
  loadBinding:async id=>[...h.bindings.values()].find(x=>x.bindingId===id)||null,
  loadFreeGroups:async()=>[group("bad","admin_B","越权组")],
  identityTokenAdapter:h.tokenAdapter,
 });
 assert.equal((await h.service.resolveManyAndLoadFreeGroups({credentials:[{token:issued.token}],deviceId:DEVICE_A})).code,"IDENTITY_GROUP_SCOPE_MISMATCH");
});

test("free groups are merged with card groups by admin plus group ID only",()=>{
 const result=mergeIdentityFreeGroupsWithCardComposition({
  cardComposition:{ok:true,groups:[
   {id:"card_A",name:"香港节点",adminUserId:"admin_A",mode:"card",enabled:true,origin:"CARD",displayName:"香港节点（1 序列号）"},
   {id:"free_A",name:"免费线路",adminUserId:"admin_A",mode:"free",enabled:true,origin:"FREE",displayName:"免费线路"},
  ]},
  identityFreeGroups:[
   group("free_A","admin_A"),
   group("free_B","admin_B","免费线路"),
  ].map(g=>({...g,origin:"FREE"})),
 });
 assert.equal(result.ok,true);
 assert.equal(result.groups.length,3);
 assert.equal(result.groups.filter(g=>g.origin==="FREE"&&g.adminUserId==="admin_A").length,1);
 assert.equal(result.groups.filter(g=>g.origin==="FREE"&&g.adminUserId==="admin_B").length,1);
 assert.equal(result.groups.filter(g=>g.origin==="CARD").length,1);
});

test("same admin same group ID with conflicting name fails closed",()=>{
 const result=mergeIdentityFreeGroupsWithCardComposition({
  cardComposition:{ok:true,groups:[{id:"free_A",name:"免费线路",adminUserId:"admin_A",mode:"free",enabled:true,origin:"FREE"}]},
  identityFreeGroups:[{...group("free_A","admin_A","伪造名称"),origin:"FREE"}],
 });
 assert.equal(result.code,"IDENTITY_GROUP_ID_COLLISION");
});

test("token adapter uses separate identity secret and fails closed without it",async()=>{
 const missing=createIdentityTokenAdapter({secret:"",cryptoImpl:webcrypto,now:()=>NOW});
 assert.equal(await missing.issue({bindingId:"binding_1",adminUserId:"admin_A",deviceId:DEVICE_A}),null);
 assert.equal(await missing.verify({token:"bad.token",deviceId:DEVICE_A}),null);
});

test("identity token expires and rejects tampering",async()=>{
 const h=harness();
 const issued=await bind(h);
 assert.equal((await h.tokenAdapter.verify({token:issued.token,deviceId:DEVICE_A})).adminUserId,"admin_A");
 const tampered=issued.token.slice(0,-1)+(issued.token.endsWith("A")?"B":"A");
 assert.equal(await h.tokenAdapter.verify({token:tampered,deviceId:DEVICE_A}),null);
 let clock=NOW;
 const expiring=createIdentityTokenAdapter({secret:SECRET,cryptoImpl:webcrypto,now:()=>clock,ttlSeconds:60});
 const token=await expiring.issue({bindingId:"binding_exp",adminUserId:"admin_A",deviceId:DEVICE_A,deviceKeyThumbprint:"key_thumbprint_01"});
 clock+=61000;
 assert.equal(await expiring.verify({token,deviceId:DEVICE_A}),null);
});

test("share code version is bound into challenge validation",async()=>{
 const h=harness();
 await bind(h);
 assert.equal(h.challengeCalls[0].codeVersion,1);
 assert.equal(h.challengeCalls[0].adminUserId,"admin_A");
});

test("D1-style binding or eligibility errors fail closed",async()=>{
 const h=harness();
 const issued=await bind(h);
 h.service=createIdentityBindingService({
  lookupShareCode:async()=>{throw Error("db unavailable");},
  checkAdminEligibility:async()=>{throw Error("db unavailable");},
  consumeRateLimit:async()=>true,
  verifyAndConsumeChallenge:async()=>({ok:true,deviceKeyThumbprint:"key_thumbprint_01"}),
  getOrCreateBinding:async()=>{throw Error("db unavailable");},
  loadBinding:async()=>{throw Error("db unavailable");},
  loadFreeGroups:async()=>{throw Error("db unavailable");},
  identityTokenAdapter:h.tokenAdapter,
 });
 assert.equal((await h.service.discover({shareCode:CODE_A,deviceId:DEVICE_A,rateLimitKey:"x"})).code,"IDENTITY_NOT_AVAILABLE");
 assert.equal((await h.service.resolveCredential({token:issued.token,deviceId:DEVICE_A,requestNonce:"nonce_123456",proof:"valid-device-proof-123456"})).code,"IDENTITY_BINDING_UNAVAILABLE");
});

test("identity credential batch rejects partial invalid credential",async()=>{
 const h=harness();
 const issued=await bind(h);
 const result=await h.service.resolveManyAndLoadFreeGroups({credentials:[{token:issued.token},{token:"invalid"}],deviceId:DEVICE_A});
 assert.equal(result.code,"IDENTITY_CREDENTIAL_INVALID");
 assert.equal(h.groupCalls.length,0);
});
