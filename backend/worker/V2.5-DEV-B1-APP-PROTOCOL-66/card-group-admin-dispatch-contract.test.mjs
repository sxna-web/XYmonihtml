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
