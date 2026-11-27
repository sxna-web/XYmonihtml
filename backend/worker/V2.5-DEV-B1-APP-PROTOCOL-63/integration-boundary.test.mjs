import test from "node:test";
import assert from "node:assert/strict";
import { APP_ROUTE_MATRIX, summarizeAppRouteMatrix } from "./integration-boundary.mjs";

test("matrix includes every legacy APP client route observed in Worker dispatch",()=>{
  const paths=new Set(APP_ROUTE_MATRIX.map(x=>x.path));
  for(const path of ["/api/app/redeem","/api/app/status","/api/app/nodes","/api/app/groups","/api/app/links","/api/app/free","/api/app/resolve","/api/app/version","/api/app/download"]) assert.ok(paths.has(path),path);
});
test("matrix includes user and super-admin APP management routes",()=>{
  const paths=new Set(APP_ROUTE_MATRIX.map(x=>x.path));
  for(const path of ["/api/user/app-cards","/api/user/app-groups","/api/user/app-groups/*","/api/user/app-links/*","/api/super/app-groups/*","/api/super/app-entitlements/:id/rebind"]) assert.ok(paths.has(path),path);
});
test("every route has explicit auth selector scope risk and migration policy",()=>{
  assert.equal(summarizeAppRouteMatrix().ok,true);
  for(const row of APP_ROUTE_MATRIX) {
    assert.ok(row.authNow.length>0); assert.ok(row.selectorNow.length>0);
    assert.ok(row.scopeNow.length>0); assert.ok(row.legacyPolicy.length>0);
  }
});
test("critical legacy routes are marked as immediate integration blockers",()=>{
  const critical=APP_ROUTE_MATRIX.filter(x=>x.risk==="CRITICAL");
  assert.ok(critical.length>=5);
  assert.ok(critical.some(x=>x.path==="/api/app/status"));
  assert.ok(critical.some(x=>x.path==="/api/app/free"));
  assert.ok(critical.some(x=>x.path==="/api/user/app-cards"));
});
test("the audit matrix cannot claim production wiring",()=>{
  assert.equal(summarizeAppRouteMatrix().productionWired,false);
});
test("summary risk and priority counts are deterministic",()=>{
  const s=summarizeAppRouteMatrix();
  assert.equal(s.total,16);
  assert.equal(s.risks.CRITICAL,6);
  assert.equal(s.priorities[0],6);
});
