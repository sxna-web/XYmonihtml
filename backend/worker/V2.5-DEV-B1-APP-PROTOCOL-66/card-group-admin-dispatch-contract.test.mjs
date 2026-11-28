import test from "node:test";
import assert from "node:assert/strict";
import { dispatchCardGroupAdminContract } from "./card-group-admin-dispatch-contract.mjs";

function harness() {
  const calls={handler:0,resolver:0,cors:0,fail:0,receivedContext:null,receivedRequest:null};
  const request=new Request("https://worker.test/api/user/app-cards/card-1/groups",{method:"PUT"});
  const ctxWithReq={actorId:"admin-1",effectiveId:"admin-1",requestId:"req-1",scope:null,session:{scopeId:null}};
  const withCors=response=>{calls.cors++;return new Response(response.body,{status:response.status,headers:{...Object.fromEntries(response.headers),"access-control-allow-origin":"https://admin.test"}});};
  const fail=(message,status,extra)=>{calls.fail++;return new Response(JSON.stringify({ok:false,message,...extra}),{status,headers:{"content-type":"application/json"}});};
  const handler=async(req,resolveSession)=>{
    calls.handler++;calls.receivedRequest=req;
    calls.receivedContext=await resolveSession(req);calls.resolver++;
    return new Response(JSON.stringify({ok:true}),{status:200});
  };
  return {calls,request,ctxWithReq,withCors,fail,handler};
}

test("authorization denial returns CORS-wrapped 403 without invoking handler or session resolver",async()=>{
  const h=harness();
  const response=await dispatchCardGroupAdminContract({...h,appAuthorization:{allowed:false,code:"VIP_EXPIRED",vipState:"expired_formal"}});
  assert.equal(response.status,403);
  assert.equal(response.headers.get("access-control-allow-origin"),"https://admin.test");
  assert.deepEqual(h.calls,{handler:0,resolver:0,cors:1,fail:1,receivedContext:null,receivedRequest:null});
  assert.deepEqual(await response.json(),{ok:false,message:"当前身份或会员状态无权执行此操作",code:"VIP_EXPIRED",vip_state:"expired_formal"});
});

test("authorized dispatch reuses the exact prevalidated ctxWithReq and wraps handler response once",async()=>{
  const h=harness();
  const response=await dispatchCardGroupAdminContract({...h,appAuthorization:{allowed:true,action:"associate"}});
  assert.equal(response.status,200);
  assert.equal(response.headers.get("access-control-allow-origin"),"https://admin.test");
  assert.equal(h.calls.handler,1);
  assert.equal(h.calls.resolver,1);
  assert.strictEqual(h.calls.receivedContext,h.ctxWithReq);
  assert.strictEqual(h.calls.receivedRequest,h.request);
  assert.equal(h.calls.cors,1);
  assert.equal(h.calls.fail,0);
});

test("missing session is rejected before handler and receives CORS",async()=>{
  const h=harness();
  const response=await dispatchCardGroupAdminContract({...h,ctxWithReq:null,appAuthorization:null});
  assert.equal(response.status,401);
  assert.equal(response.headers.get("access-control-allow-origin"),"https://admin.test");
  assert.equal(h.calls.handler,0);
  assert.equal(h.calls.cors,1);
  assert.equal(h.calls.fail,1);
});

test("handler errors propagate to the Worker boundary rather than being disguised as success",async()=>{
  const h=harness();
  h.handler=async()=>{h.calls.handler++;throw new Error("candidate handler failure");};
  await assert.rejects(
    dispatchCardGroupAdminContract({...h,appAuthorization:{allowed:true}}),
    /candidate handler failure/,
  );
  assert.equal(h.calls.cors,0);
  assert.equal(h.calls.fail,0);
});


import { readFileSync } from "node:fs";
const workerSource = readFileSync(new URL("../V2.5-DEV-B1-CORE-AUTH-49/Worker.js", import.meta.url), "utf8");

test("real Worker APP-card route remains behind session, scope and APP authorization gates",()=>{
  const userGate = workerSource.indexOf("if (isUserApi(url.pathname)) {");
  const scopeGate = workerSource.indexOf("const scopeDenied = requireScope(ctxWithReq, needScope);", userGate);
  const appGate = workerSource.indexOf("const appAuthorization = await authorizeAppManagementRequest({", scopeGate);
  const appDenied = workerSource.indexOf("if (appAuthorization && !appAuthorization.allowed)", appGate);
  const appContext = workerSource.indexOf("if (appAuthorization) ctxWithReq.appAuthorization = appAuthorization;", appDenied);
  const legacyCardFallback = workerSource.indexOf('if (url.pathname.startsWith("/api/user/app-cards"))', appContext);
  assert.ok(userGate >= 0 && scopeGate > userGate && appGate > scopeGate && appDenied > appGate && appContext > appDenied && legacyCardFallback > appContext,
    "APP card-group dispatch insertion point must remain after all existing gates and before legacy card route");
  assert.match(workerSource.slice(legacyCardFallback, legacyCardFallback + 240), /userAppCardsRoute\(req, env, url, ctxWithReq\)/);
});

test("real Worker outer exception boundary converts handler throws to CORS-wrapped failure responses",()=>{
  const boundary = workerSource.lastIndexOf("    } catch (e) {");
  const tail = workerSource.slice(boundary, boundary + 1800);
  assert.ok(boundary >= 0, "Worker request dispatcher catch boundary must exist");
  assert.match(tail, /GUEST_KEY_REQUIRED/);
  assert.match(tail, /ASSERTION_FAILED/);
  assert.match(tail, /return withCors\(fail\("服务器处理失败，请检查 Worker 日志", 500\)\)/);
  assert.match(tail, /return withCors\(json\(/);
});

test("real Worker dispatcher wraps each route response at the route boundary",()=>{
  const userGate = workerSource.indexOf("if (isUserApi(url.pathname)) {");
  const appRoute = workerSource.indexOf('if (url.pathname.startsWith("/api/user/app-cards"))', userGate);
  const fallback = workerSource.slice(appRoute, appRoute + 240);
  assert.match(fallback, /return withCors\(await userAppCardsRoute/);
  assert.match(workerSource.slice(userGate, appRoute), /authorizeAppManagementRequest/);
});


import { createCardGroupAdminHandler } from "./card-group-admin-handler.mjs";

test("dispatcher composes the real Protocol66 handler with the already-resolved Worker context",async()=>{
  const h=harness();
  h.request=new Request("https://worker.test/api/user/app-cards/card-1/groups",{method:"GET"});
  let serviceArgs=null;
  const service={
    get:async args=>{serviceArgs=args;return {ok:true,cardId:"card-1",groupIds:["group-1"]};},
    replace:async()=>{throw new Error("GET must not call replace");},
  };
  const adapter=(request,resolveSession)=>{
    const actualHandler=createCardGroupAdminHandler({service,resolveSession});
    return actualHandler(request);
  };
  const response=await dispatchCardGroupAdminContract({...h,handler:adapter,appAuthorization:{allowed:true}});
  assert.equal(response.status,200);
  assert.equal(response.headers.get("access-control-allow-origin"),"https://admin.test");
  assert.deepEqual(await response.json(),{ok:true,cardId:"card-1",groupIds:["group-1"]});
  assert.deepEqual(serviceArgs,{adminId:"admin-1",cardId:"card-1"});
  assert.equal(h.calls.cors,1);
  assert.equal(h.calls.fail,0);
});

test("real Protocol66 handler failures propagate through dispatcher for Worker outer error mapping",async()=>{
  const h=harness();
  h.request=new Request("https://worker.test/api/user/app-cards/card-1/groups",{method:"GET"});
  const service={get:async()=>{throw new Error("protocol66 service failure");},replace:async()=>({ok:true})};
  const adapter=(request,resolveSession)=>createCardGroupAdminHandler({service,resolveSession})(request);
  await assert.rejects(
    dispatchCardGroupAdminContract({...h,handler:adapter,appAuthorization:{allowed:true}}),
    /protocol66 service failure/,
  );
  assert.equal(h.calls.cors,0);
  assert.equal(h.calls.fail,0);
});


test("request identity mismatch is rejected before the handler can use a different request",async()=>{
  const h=harness();
  h.handler=async(_request,resolveSession)=>{
    h.calls.handler++;
    return resolveSession(new Request("https://worker.test/api/user/app-cards/other-card/groups",{method:"GET"}));
  };
  await assert.rejects(
    dispatchCardGroupAdminContract({...h,appAuthorization:{allowed:true}}),
    /REQUEST_CONTEXT_MISMATCH/,
  );
  assert.equal(h.calls.handler,1);
  assert.equal(h.calls.resolver,0);
  assert.equal(h.calls.cors,0);
  assert.equal(h.calls.fail,0);
});

test("APP authorization denial with the real Protocol66 handler never reaches its service",async()=>{
  const h=harness();
  let serviceCalls=0;
  const service={get:async()=>{serviceCalls++;return {ok:true};},replace:async()=>{serviceCalls++;return {ok:true};}};
  const handler=(request,resolveSession)=>createCardGroupAdminHandler({service,resolveSession})(request);
  const response=await dispatchCardGroupAdminContract({...h,handler,appAuthorization:{allowed:false,code:"VIP_EXPIRED"}});
  assert.equal(response.status,403);
  assert.equal(serviceCalls,0);
  assert.equal(h.calls.cors,1);
});

test("real Worker scope denial returns before APP authorization and before APP-card route dispatch",()=>{
  const userGate=workerSource.indexOf("if (isUserApi(url.pathname)) {");
  const scopeCheck=workerSource.indexOf("const scopeDenied = requireScope(ctxWithReq, needScope);",userGate);
  const scopeReturn=workerSource.indexOf("if (scopeDenied) {",scopeCheck);
  const appGate=workerSource.indexOf("const appAuthorization = await authorizeAppManagementRequest({",scopeReturn);
  const appRoute=workerSource.indexOf('if (url.pathname.startsWith("/api/user/app-cards"))',appGate);
  assert.ok(userGate>=0 && scopeCheck>userGate && scopeReturn>scopeCheck && appGate>scopeReturn && appRoute>appGate);
  const deniedBlock=workerSource.slice(scopeReturn,appGate);
  assert.match(deniedBlock,/return withCors\(scopeDenied\)/);
  assert.match(deniedBlock,/auditDenied\(env\.DB, ctxWithReq, "scope\.denied"/);
  assert.doesNotMatch(deniedBlock,/authorizeAppManagementRequest|userAppCardsRoute/);
});
