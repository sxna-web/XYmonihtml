import {
  CARD_GROUP_READ_SQL,
  buildCardGroupReadStatements,
  buildCardGroupReplaceStatements,
  canonicalCardGroupPayload,
} from "./card-group-admin-sql-plan.mjs";

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const HASH_RE = /^[a-f0-9]{64}$/;

function rows(result) {
  return Array.isArray(result?.results) ? result.results : [];
}

function activeIds(mappings) {
  return mappings
    .filter(row => row?.status === "active")
    .map(row => row.group_id)
    .sort();
}

function sameIds(a, b) {
  return Array.isArray(a) && Array.isArray(b) &&
    a.length === b.length && [...a].sort().every((id, i) => id === [...b].sort()[i]);
}

function safeMappingRows(adminId, cardId, groupIds) {
  return groupIds.map(group_id => ({
    admin_user_id: adminId,
    card_id: cardId,
    group_id,
    status: "active",
  }));
}

async function sha256Hex(value) {
  if (!globalThis.crypto?.subtle) throw new Error("WEB_CRYPTO_UNAVAILABLE");
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)].map(v => v.toString(16).padStart(2, "0")).join("");
}

/**
 * Isolated D1 adapter harness. It is not wired into the production Worker.
 * resolveAccess must implement the existing VIP/experience read/write policy.
 */
export function createCardGroupD1Adapter({ db, resolveAccess }) {
  if (!db || typeof db.prepare !== "function" || typeof db.batch !== "function" ||
      typeof resolveAccess !== "function") {
    throw new TypeError("CARD_GROUP_D1_ADAPTER_DEPENDENCIES_REQUIRED");
  }

  async function accessForAdmin(adminId) {
    try {
      const access = await resolveAccess(adminId);
      return {
        canRead: access?.canRead === true,
        canWrite: access?.canWrite === true,
      };
    } catch {
      return { canRead: false, canWrite: false };
    }
  }

  async function loadCardGroupState(adminId, cardId) {
    if (!ID_RE.test(adminId || "") || !ID_RE.test(cardId || "")) return null;
    const stmts = buildCardGroupReadStatements(db, { adminId, cardId });
    const [card, groupResult, mappingResult] = await Promise.all([
      stmts[0].first(),
      stmts[1].all(),
      stmts[2].all(),
    ]);
    if (!card || card.id !== cardId || card.admin_user_id !== adminId) return null;
    return {
      card,
      groups: rows(groupResult),
      mappings: rows(mappingResult),
    };
  }

  async function findRequest(adminId, idempotencyKey) {
    return db.prepare(CARD_GROUP_READ_SQL.idempotency)
      .bind(adminId, idempotencyKey).first();
  }

  async function hasActiveDelegatedScope({ adminId, actorId, scope, scopeId }) {
    if (actorId === adminId) return true;
    if (!["operate", "manage"].includes(scope) || !ID_RE.test(scopeId || "")) return false;
    const row = await db.prepare(`SELECT id FROM admin_user_scopes
      WHERE id = ? AND admin_user_id = ? AND target_user_id = ?
        AND scope IN ('operate','manage') AND revoked_at IS NULL
        AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))
      LIMIT 1`).bind(scopeId, adminId, actorId).first();
    return !!row;
  }

  function idempotentResult(adminId, cardId, record, digest) {
    if (!record) return null;
    if (record.payload_sha256 !== digest) {
      return { ok: false, code: "IDEMPOTENCY_CONFLICT" };
    }
    let saved;
    try { saved = JSON.parse(record.response_json); } catch {
      return { ok: false, code: "IDEMPOTENCY_RECORD_INVALID" };
    }
    if (!saved || !Array.isArray(saved.groupIds) ||
        saved.groupIds.length > 100 ||
        saved.groupIds.some(id => !ID_RE.test(id || "")) ||
        new Set(saved.groupIds).size !== saved.groupIds.length) {
      return { ok: false, code: "IDEMPOTENCY_RECORD_INVALID" };
    }
    return {
      ok: true,
      mappings: safeMappingRows(adminId, cardId, saved.groupIds),
      idempotent: true,
    };
  }

  async function classifyBatchFailure(input, originalError) {
    try {
      const prior = await findRequest(input.adminId, input.idempotencyKey);
      if (prior) {
        const replay = idempotentResult(input.adminId, input.cardId, prior, input.payloadSha256);
        if (replay) return replay;
      }
    } catch {
      return { ok: false, code: "IDEMPOTENCY_RECOVERY_UNAVAILABLE" };
    }

    const access = await accessForAdmin(input.adminId);
    if (access.canWrite !== true) return { ok: false, code: "VIP_READ_ONLY" };

    try {
      const state = await loadCardGroupState(input.adminId, input.cardId);
      if (!state) return { ok: false, code: "CARD_NOT_FOUND" };
      const card = state.card;
      if (!["normal", "used"].includes(card.status) ||
          card.manual_disabled === true || card.manual_disabled === 1 ||
          card.is_expired === true || card.is_expired === 1) {
        return { ok: false, code: "CARD_NOT_WRITABLE" };
      }
      if (!sameIds(activeIds(state.mappings), input.expectedGroupIds)) {
        return { ok: false, code: "CARD_MAPPING_CONFLICT" };
      }
      const enabled = new Set(state.groups
        .filter(group => group.admin_user_id === input.adminId &&
          group.mode === "card" && (group.enabled === true || group.enabled === 1))
        .map(group => group.id));
      if (input.groupIds.some(id => !enabled.has(id))) {
        return { ok: false, code: "CARD_GROUP_NOT_AVAILABLE" };
      }
    } catch {
      return { ok: false, code: "CARD_GROUP_STATE_UNAVAILABLE" };
    }
    return {
      ok: false,
      code: originalError?.message === "WEB_CRYPTO_UNAVAILABLE"
        ? "CRYPTO_UNAVAILABLE"
        : "DB_BATCH_ABORTED",
    };
  }

  return Object.freeze({
    accessForAdmin,
    loadCardGroupState,

    async replaceCardGroupsAtomically(input) {
      const {
        adminId, actorId, scope = null, scopeId = null, isSuperAdmin = false, idempotencyKey, requestId, cardId, groupIds, expectedGroupIds,
      } = input || {};
      if (!ID_RE.test(adminId || "") || !ID_RE.test(actorId || "") ||
          !ID_RE.test(cardId || "") ||
          (actorId !== adminId && (!["operate", "manage"].includes(scope) || !ID_RE.test(scopeId || ""))) ||
          (isSuperAdmin && actorId !== adminId) ||
          typeof idempotencyKey !== "string" ||
          !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey) ||
          typeof requestId !== "string" || !requestId.trim() || requestId.length > 80 || typeof isSuperAdmin !== "boolean" ||
          !Array.isArray(groupIds) || !Array.isArray(expectedGroupIds) ||
          groupIds.length > 100 || expectedGroupIds.length > 100 ||
          [...groupIds, ...expectedGroupIds].some(id => !ID_RE.test(id || "")) ||
          new Set(groupIds).size !== groupIds.length ||
          new Set(expectedGroupIds).size !== expectedGroupIds.length) {
        return { ok: false, code: "INVALID_CARD_GROUP_REPLACE" };
      }

      const access = await accessForAdmin(adminId);
      if (!access.canRead) return { ok: false, code: "APP_CARD_READ_FORBIDDEN" };
      if (!access.canWrite) return { ok: false, code: "VIP_READ_ONLY" };
      try {
        if (!await hasActiveDelegatedScope({ adminId, actorId, scope, scopeId })) {
          return { ok: false, code: "SCOPE_INSUFFICIENT" };
        }
      } catch {
        return { ok: false, code: "SCOPE_CHECK_UNAVAILABLE" };
      }

      let payload;
      let digest;
      try {
        payload = canonicalCardGroupPayload(cardId, groupIds);
        digest = await sha256Hex(payload);
      } catch {
        return { ok: false, code: "CRYPTO_UNAVAILABLE" };
      }
      const inputWithDigest = { ...input, payloadSha256: digest };

      let prior;
      try { prior = await findRequest(adminId, idempotencyKey); }
      catch { return { ok: false, code: "IDEMPOTENCY_READ_UNAVAILABLE" }; }
      if (prior) return idempotentResult(adminId, cardId, prior, digest);

      let state;
      try { state = await loadCardGroupState(adminId, cardId); }
      catch { return { ok: false, code: "CARD_GROUP_STATE_UNAVAILABLE" }; }
      if (!state) return { ok: false, code: "CARD_NOT_FOUND" };
      if (!sameIds(activeIds(state.mappings), expectedGroupIds)) {
        return { ok: false, code: "CARD_MAPPING_CONFLICT" };
      }
      const card = state.card;
      if (!["normal", "used"].includes(card.status) ||
          card.manual_disabled === true || card.manual_disabled === 1 ||
          card.is_expired === true || card.is_expired === 1) {
        return { ok: false, code: "CARD_NOT_WRITABLE" };
      }
      const allowed = new Set(state.groups
        .filter(group => group.admin_user_id === adminId &&
          group.mode === "card" && (group.enabled === true || group.enabled === 1))
        .map(group => group.id));
      if (groupIds.some(id => !allowed.has(id))) {
        return { ok: false, code: "CARD_GROUP_NOT_AVAILABLE" };
      }

      const beforeJson = JSON.stringify(activeIds(state.mappings));
      let batch;
      try {
        const mappingIds = groupIds.map(() => {
          if (typeof globalThis.crypto?.randomUUID !== "function") throw new Error("WEB_CRYPTO_UNAVAILABLE");
          return `cgm_${globalThis.crypto.randomUUID().replace(/-/g, "")}`;
        });
        batch = buildCardGroupReplaceStatements(db, {
          ...inputWithDigest,
          scopeId,
          isSuperAdmin,
          expectedGroupIds,
          beforeJson,
          mappingIds,
        });
        const results = await db.batch(batch);
        const last = Array.isArray(results) ? results[results.length - 1] : null;
        const mappingRows = rows(last);
        if (mappingRows.length !== groupIds.length ||
            mappingRows.some(row => row.admin_user_id !== adminId ||
              row.card_id !== cardId || row.status !== "active" ||
              !groupIds.includes(row.group_id))) {
          return { ok: false, code: "CARD_GROUP_WRITE_RESULT_INVALID" };
        }
        return { ok: true, mappings: mappingRows };
      } catch (error) {
        return classifyBatchFailure(inputWithDigest, error);
      }
    },
  });
}
