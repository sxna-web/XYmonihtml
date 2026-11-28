/**
 * Candidate D1 statement plan for Protocol 66.
 * Not imported by Batch 49 Worker. Requires schema review before runtime use.
 */
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const HASH_RE = /^[a-f0-9]{64}$/;

function marks(values) {
  return values.map(() => "?").join(", ");
}

export const CARD_GROUP_READ_SQL = Object.freeze({
  card: `SELECT id, admin_user_id, status, manual_disabled,
      CASE WHEN expires_at IS NOT NULL AND datetime(expires_at) <= datetime('now')
           THEN 1 ELSE 0 END AS is_expired
    FROM app_cards
    WHERE id = ? AND admin_user_id = ?
    LIMIT 1`,
  groups: `SELECT id, admin_user_id, name, mode, enabled
    FROM app_groups
    WHERE admin_user_id = ? AND mode = 'card'
    ORDER BY sort ASC, id ASC`,
  mappings: `SELECT id, card_id, admin_user_id, group_id, status
    FROM app_card_group_mappings
    WHERE admin_user_id = ? AND card_id = ? AND status = 'active'
    ORDER BY created_at ASC, id ASC`,
  idempotency: `SELECT payload_sha256, response_json
    FROM app_card_group_admin_requests
    WHERE admin_user_id = ? AND idempotency_key = ?
    LIMIT 1`,
});

export function buildCardGroupReadStatements(db, { adminId, cardId }) {
  if (!db || typeof db.prepare !== "function" ||
      !ID_RE.test(adminId || "") || !ID_RE.test(cardId || "")) {
    throw new TypeError("INVALID_CARD_GROUP_READ_SCOPE");
  }
  return Object.freeze([
    db.prepare(CARD_GROUP_READ_SQL.card).bind(cardId, adminId),
    db.prepare(CARD_GROUP_READ_SQL.groups).bind(adminId),
    db.prepare(CARD_GROUP_READ_SQL.mappings).bind(adminId, cardId),
  ]);
}

/**
 * Builds a D1 batch. expectedGroupIds is the active group-id CAS snapshot.
 * For delegated writes the final assertion rechecks the live admin scope.
 */
export function buildCardGroupReplaceStatements(db, input) {
  const {
    adminId, actorId, scopeId = null, idempotencyKey, requestId, cardId, groupIds,
    expectedGroupIds, payloadSha256, beforeJson = "[]", mappingIds,
  } = input || {};
  if (!db || typeof db.prepare !== "function" ||
      !ID_RE.test(adminId || "") || !ID_RE.test(actorId || "") ||
      !ID_RE.test(cardId || "") ||
      (actorId !== adminId && !ID_RE.test(scopeId || "")) ||
      typeof idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey) ||
      typeof requestId !== "string" || !requestId.trim() || requestId.length > 80 ||
      !Array.isArray(groupIds) || !Array.isArray(expectedGroupIds) ||
      !Array.isArray(mappingIds) || mappingIds.length !== groupIds.length ||
      mappingIds.some(id => !ID_RE.test(id || "")) ||
      new Set(mappingIds).size !== mappingIds.length ||
      !HASH_RE.test(payloadSha256 || "") ||
      groupIds.length > 100 || expectedGroupIds.length > 100 ||
      [...groupIds, ...expectedGroupIds].some(id => !ID_RE.test(id || "")) ||
      new Set(groupIds).size !== groupIds.length ||
      new Set(expectedGroupIds).size !== expectedGroupIds.length ||
      typeof beforeJson !== "string" || beforeJson.length > 16_384) {
    throw new TypeError("INVALID_CARD_GROUP_REPLACE_PLAN");
  }

  const desired = [...groupIds].sort();
  const expected = [...expectedGroupIds].sort();
  const expectedChecks = expected.map(() =>
    "AND EXISTS (SELECT 1 FROM app_card_group_mappings m WHERE m.admin_user_id = ? AND m.card_id = ? AND m.status = 'active' AND m.group_id = ?)"
  ).join("\n");
  const desiredCountSql = desired.length
    ? `(SELECT COUNT(*) FROM app_groups g WHERE g.admin_user_id = ? AND g.mode = 'card' AND g.enabled = 1 AND g.id IN (${marks(desired)})) = ${desired.length}`
    : "1 = 1";
  const desiredBinds = desired.length ? [adminId, ...desired] : [];

  const assertSql = `SELECT CASE WHEN
      EXISTS (SELECT 1 FROM admin_vip_activations v
        WHERE v.user_id = ? AND datetime(v.starts_at) <= datetime('now')
          AND datetime(v.ends_at) > datetime('now'))
      AND EXISTS (SELECT 1 FROM app_cards c
        WHERE c.id = ? AND c.admin_user_id = ?
          AND c.status IN ('normal','used')
          AND COALESCE(c.manual_disabled,0) = 0
          AND (c.expires_at IS NULL OR datetime(c.expires_at) > datetime('now')))
      AND (SELECT COUNT(*) FROM app_card_group_mappings m
        WHERE m.admin_user_id = ? AND m.card_id = ? AND m.status = 'active') = ${expected.length}
      ${expectedChecks}
      AND ${desiredCountSql}
      AND (? = ? OR EXISTS (SELECT 1 FROM admin_user_scopes s
        WHERE s.id = ? AND s.admin_user_id = ? AND s.target_user_id = ?
          AND s.revoked_at IS NULL
          AND (s.expires_at IS NULL OR datetime(s.expires_at) > datetime('now'))
          AND s.scope IN ('operate','manage')))
    THEN 1 ELSE json_extract('assert-failed', '$') END`;

  const afterJson = JSON.stringify({ groupIds: desired });
  const batch = [
    db.prepare(assertSql).bind(
      adminId, cardId, adminId, adminId, cardId,
      ...expected.flatMap(id => [adminId, cardId, id]),
      ...desiredBinds,
      actorId, adminId, scopeId || "", actorId, adminId,
    ),
    db.prepare(`INSERT INTO app_card_group_admin_requests
      (admin_user_id, idempotency_key, payload_sha256, response_json, created_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(admin_user_id, idempotency_key) DO NOTHING`)
      .bind(adminId, idempotencyKey, payloadSha256, afterJson),
    db.prepare(`SELECT CASE WHEN changes() = 1 THEN 1
      ELSE json_extract('duplicate-request', '$') END`),
    db.prepare(desired.length
      ? `UPDATE app_card_group_mappings
          SET status = 'removed', removed_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
          WHERE admin_user_id = ? AND card_id = ? AND status = 'active'
            AND group_id NOT IN (${marks(desired)})`
      : `UPDATE app_card_group_mappings
          SET status = 'removed', removed_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
          WHERE admin_user_id = ? AND card_id = ? AND status = 'active'`)
      .bind(adminId, cardId, ...desired),
    ...desired.map(groupId => db.prepare(`INSERT INTO app_card_group_mappings
        (id, card_id, admin_user_id, group_id, status, created_at, updated_at, removed_at)
      VALUES (?, ?, ?, ?, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL)
      ON CONFLICT(card_id, group_id) DO UPDATE SET
        admin_user_id = excluded.admin_user_id,
        status = 'active', updated_at = CURRENT_TIMESTAMP, removed_at = NULL
      WHERE app_card_group_mappings.admin_user_id = excluded.admin_user_id`)
      .bind(mappingIds[groupIds.indexOf(groupId)], cardId, adminId, groupId)),
    db.prepare(`INSERT INTO admin_audit_events
      (actor_user_id, effective_user_id, action, target_type, target_id,
       request_id, before_json, after_json, result, reason, detail)
      VALUES (?, ?, 'app_card_groups.replace', 'app_card', ?, ?, ?, ?, 'ok', '', '')`)
      .bind(actorId, adminId, cardId, requestId, beforeJson, afterJson),
    db.prepare(CARD_GROUP_READ_SQL.mappings).bind(adminId, cardId),
  ];

  return Object.freeze(batch);
}

export function canonicalCardGroupPayload(cardId, groupIds) {
  if (!ID_RE.test(cardId || "") || !Array.isArray(groupIds) ||
      groupIds.some(id => !ID_RE.test(id || "")) ||
      new Set(groupIds).size !== groupIds.length) {
    throw new TypeError("INVALID_CARD_GROUP_PAYLOAD");
  }
  return JSON.stringify({ cardId, groupIds: [...groupIds].sort() });
}
