import test from "node:test";
import assert from "node:assert/strict";
import {
  CARD_GROUP_READ_SQL,
  buildCardGroupReadStatements,
  buildCardGroupReplaceStatements,
  canonicalCardGroupPayload,
} from "./card-group-admin-sql-plan.mjs";

function dbCapture() {
  const calls=[];
  return {
    calls,
    prepare(sql) {
      const item = { sql, binds: [] };
      calls.push(item);
      return { bind(...binds) { item.binds = binds; return item; } };
    },
  };
}

test("read plan scopes card and groups to one admin and never selects redeem code",()=>{
  const db=dbCapture();
  const stmts=buildCardGroupReadStatements(db,{adminId:"admin1",cardId:"card1"});
  assert.equal(stmts.length,3);
  assert.match(db.calls[0].sql,/id = \? AND admin_user_id = \?/);
  assert.match(db.calls[1].sql,/admin_user_id = \? AND mode = 'card'/);
  assert.match(db.calls[2].sql,/admin_user_id = \? AND card_id = \? AND status = 'active'/);
  assert.equal(db.calls.some(x=>/\bcode\b|redeem/i.test(x.sql)),false);
  assert.equal(CARD_GROUP_READ_SQL.card.includes("code"),false);
});

test("replace plan final assertion includes active VIP, card state, owner/mode and CAS",()=>{
  const db=dbCapture();
  const plan=buildCardGroupReplaceStatements(db,{
    adminId:"admin1",actorId:"admin1",idempotencyKey:"idem-key-12345678",requestId:"trace-req-1",cardId:"card1",
    groupIds:["g2","g1"],expectedGroupIds:["old1"],mappingIds:["map-id-1","map-id-2"],
    payloadSha256:"a".repeat(64),beforeJson:'["old1"]',
  });
  assert.ok(plan.length>=7);
  const assertion=db.calls[0];
  assert.match(assertion.sql,/admin_vip_activations/);
  assert.match(assertion.sql,/status IN \('normal','used'\)/);
  assert.match(assertion.sql,/manual_disabled/);
  assert.match(assertion.sql,/expires_at/);
  assert.match(assertion.sql,/mode = 'card'/);
  assert.match(assertion.sql,/group_id = \?/);
  assert.deepEqual(assertion.binds.slice(0,5),["admin1","card1","admin1","admin1","card1"]);
});

test("replace plan uses soft removal, upsert restore and audit in one batch",()=>{
  const db=dbCapture();
  const plan=buildCardGroupReplaceStatements(db,{
    adminId:"admin1",actorId:"admin1",idempotencyKey:"idem-key-12345678",requestId:"trace-req-1",cardId:"card1",
    groupIds:["g1","g2"],expectedGroupIds:[],mappingIds:["map-id-1","map-id-2"],
    payloadSha256:"b".repeat(64),
  });
  const sql=db.calls.map(x=>x.sql).join("\n");
  assert.match(sql,/status = 'removed'/);
  assert.match(sql,/ON CONFLICT\(card_id, group_id\) DO UPDATE/);
  assert.match(sql,/removed_at = NULL/);
  assert.match(sql,/INSERT INTO admin_audit_events/);
  assert.match(sql,/INSERT INTO app_card_group_admin_requests/);
  assert.equal(plan.length,8);
});

test("empty replacement soft-removes every active mapping without empty IN()",()=>{
  const db=dbCapture();
  buildCardGroupReplaceStatements(db,{
    adminId:"admin1",actorId:"admin1",idempotencyKey:"idem-key-22345678",requestId:"trace-req-2",cardId:"card1",
    groupIds:[],expectedGroupIds:["g1"],mappingIds:[],
    payloadSha256:"c".repeat(64),
  });
  const update=db.calls.find(x=>x.sql.startsWith("UPDATE app_card_group_mappings"));
  assert.ok(update);
  assert.doesNotMatch(update.sql,/NOT IN\s*\(\s*\)/);
});

test("duplicate request is guarded by unique insert and changes assertion",()=>{
  const db=dbCapture();
  buildCardGroupReplaceStatements(db,{
    adminId:"admin1",actorId:"admin1",idempotencyKey:"idem-key-32345678",requestId:"trace-req-3",cardId:"card1",
    groupIds:[],expectedGroupIds:[],mappingIds:[],
    payloadSha256:"d".repeat(64),
  });
  assert.match(db.calls[1].sql,/ON CONFLICT\(admin_user_id, request_id\) DO NOTHING/);
  assert.match(db.calls[2].sql,/changes\(\) = 1/);
  assert.equal(db.calls[1].binds[1], "idem-key-32345678");
  const audit = db.calls.find(x => x.sql.startsWith("INSERT INTO admin_audit_events"));
  assert.equal(audit.binds[3], "trace-req-3");
});

test("canonical payload is stable independent of selection order",()=>{
  assert.equal(
    canonicalCardGroupPayload("card1",["g2","g1"]),
    canonicalCardGroupPayload("card1",["g1","g2"]),
  );
});

test("invalid scope, duplicate IDs and malformed digest fail closed",()=>{
  const db=dbCapture();
  assert.throws(()=>buildCardGroupReadStatements(db,{adminId:"",cardId:"card1"}));
  assert.throws(()=>buildCardGroupReplaceStatements(db,{
    adminId:"admin1",actorId:"admin1",idempotencyKey:"idem-invalid-12345678",requestId:"trace-invalid",cardId:"card1",
    groupIds:["g1","g1"],expectedGroupIds:[],mappingIds:["map-1","map-2"],payloadSha256:"a".repeat(64),
  }));
  assert.throws(()=>buildCardGroupReplaceStatements(db,{
    adminId:"admin1",actorId:"admin1",idempotencyKey:"idem-invalid-12345678",requestId:"trace-invalid",cardId:"card1",
    groupIds:[],expectedGroupIds:[],payloadSha256:"not-a-hash",
  }));
});

test("replace SQL plan binds delegated actor and scope for final batch guard", () => {
  const db = {
    prepare: (sql) => ({
      sql,
      binds: [],
      bind(...binds) {
        this.binds = binds;
        return this;
      },
    }),
  };
  const statements = buildCardGroupReplaceStatements(db, {
    adminId: "admin1",
    actorId: "super1",
    scopeId: "scope-1",
    requestId: "req-scope",
    cardId: "card1",
    groupIds: ["g1"],
    expectedGroupIds: [],
    payloadSha256: "a".repeat(64),
  });
  assert.match(statements[0].sql, /admin_user_scopes/);
  assert.ok(statements[0].binds.includes("scope-1"));
  assert.ok(statements[0].binds.includes("super1"));
});
