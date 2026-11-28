const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_GROUPS_PER_CARD = 100;

function fail(code, status = 400) {
  return { ok: false, status, code };
}

function safeGroup(group) {
  return {
    id: group.id,
    name: group.name,
    mode: group.mode,
    enabled: group.enabled === true || group.enabled === 1,
  };
}

function validCard(card, adminId) {
  return !!card && card.id && card.admin_user_id === adminId &&
    typeof card.status === "string";
}

/**
 * Admin-side contract for one card's card-only group mappings.
 *
 * Storage adapter contract:
 * - accessForAdmin(adminId) -> { canRead:boolean, canWrite:boolean }
 * - loadCardGroupState(adminId, cardId) -> { card, groups, mappings }
 * - replaceCardGroupsAtomically(input) -> { ok:boolean, code?, mappings? }
 *
 * replaceCardGroupsAtomically MUST repeat current admin VIP/experience access,
 * card status/expiry/manual-disable, and card/group owner + mode predicates
 * inside the same D1 batch as mapping changes and audit INSERT. This service
 * is a contract boundary only; it does not implement a D1 adapter or route.
 */
export function createCardGroupAdminService({ storage }) {
  if (!storage || typeof storage.accessForAdmin !== "function" ||
      typeof storage.loadCardGroupState !== "function" ||
      typeof storage.replaceCardGroupsAtomically !== "function") {
    throw new TypeError("CARD_GROUP_STORAGE_ADAPTER_REQUIRED");
  }

  async function loadState(adminId, cardId) {
    if (!ID_RE.test(adminId || "") || !ID_RE.test(cardId || "")) {
      return fail("INVALID_CARD_SCOPE", 400);
    }
    const access = await storage.accessForAdmin(adminId);
    if (!access || access.canRead !== true) return fail("APP_CARD_READ_FORBIDDEN", 403);
    const state = await storage.loadCardGroupState(adminId, cardId);
    if (!state || !validCard(state.card, adminId)) return fail("CARD_NOT_FOUND", 404);
    if (!Array.isArray(state.groups) || !Array.isArray(state.mappings)) {
      return fail("CARD_GROUP_STATE_UNAVAILABLE", 503);
    }
    const groupById = new Map();
    for (const group of state.groups) {
      if (!group || !ID_RE.test(group.id || "") ||
          group.admin_user_id !== adminId || group.mode !== "card" ||
          typeof group.name !== "string" || !group.name.trim() ||
          groupById.has(group.id)) {
        return fail("CARD_GROUP_SCOPE_INVALID", 503);
      }
      groupById.set(group.id, group);
    }
    const mapped = [];
    const seen = new Set();
    for (const mapping of state.mappings) {
      if (!mapping || mapping.admin_user_id !== adminId ||
          mapping.card_id !== cardId || !groupById.has(mapping.group_id) ||
          mapping.status !== "active" || seen.has(mapping.group_id)) {
        return fail("CARD_MAPPING_SCOPE_INVALID", 503);
      }
      seen.add(mapping.group_id);
      mapped.push(safeGroup(groupById.get(mapping.group_id)));
    }
    return {
      ok: true,
      card: {
        id: state.card.id,
        status: state.card.status,
        manual_disabled: state.card.manual_disabled === 1 || state.card.manual_disabled === true,
        is_expired: state.card.is_expired === true || state.card.is_expired === 1,
      },
      groups: [...groupById.values()].map(safeGroup),
      mappings: mapped,
    };
  }

  return Object.freeze({
    async get({ adminId, cardId }) {
      return loadState(adminId, cardId);
    },

    async replace({ adminId, actorId, scope = null, scopeId = null, isSuperAdmin = false, idempotencyKey, requestId, cardId, groupIds }) {
      if (!ID_RE.test(adminId || "") || !ID_RE.test(actorId || "") ||
          !ID_RE.test(cardId || "") ||
          typeof idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey) ||
          typeof requestId !== "string" || !requestId.trim() || requestId.length > 80 || typeof isSuperAdmin !== "boolean") {
        return fail("INVALID_CARD_SCOPE", 400);
      }
      if (actorId !== adminId && (!["operate", "manage"].includes(scope) ||
          !ID_RE.test(scopeId || ""))) {
        return fail("SCOPE_INSUFFICIENT", 403);
      }
      if (!Array.isArray(groupIds) || groupIds.length > MAX_GROUPS_PER_CARD ||
          groupIds.some(id => !ID_RE.test(id || "")) ||
          new Set(groupIds).size !== groupIds.length) {
        return fail("INVALID_GROUP_IDS", 400);
      }
      const access = await storage.accessForAdmin(adminId);
      if (!access || access.canRead !== true) return fail("APP_CARD_READ_FORBIDDEN", 403);
      if (access.canWrite !== true) return fail("VIP_READ_ONLY", 403);

      const state = await loadState(adminId, cardId);
      if (!state.ok) return state;
      if (!["normal", "used"].includes(state.card.status) ||
          state.card.manual_disabled || state.card.is_expired === true) {
        return fail("CARD_NOT_WRITABLE", 409);
      }
      const allowed = new Set(state.groups.filter(g => g.enabled).map(g => g.id));
      if (groupIds.some(id => !allowed.has(id))) return fail("CARD_GROUP_NOT_AVAILABLE", 409);

      // Adapter owns the final CAS/owner/state checks and same-batch audit.
      const result = await storage.replaceCardGroupsAtomically({
        adminId, actorId, scope, scopeId, isSuperAdmin, idempotencyKey, requestId, cardId, groupIds: [...groupIds],
        expectedGroupIds: state.mappings.map(group => group.id),
      });
      if (!result || result.ok !== true || !Array.isArray(result.mappings)) {
        const code = result?.code || "CARD_GROUP_WRITE_CONFLICT";
        return fail(code, code === "VIP_READ_ONLY" ? 403 : 409);
      }
      const output = [];
      const seen = new Set();
      for (const row of result.mappings) {
        if (!row || row.admin_user_id !== adminId || row.card_id !== cardId ||
            typeof row.group_id !== "string" || seen.has(row.group_id) ||
            !allowed.has(row.group_id)) {
          return fail("CARD_GROUP_WRITE_RESULT_INVALID", 503);
        }
        seen.add(row.group_id);
        const group = state.groups.find(g => g.id === row.group_id);
        output.push(safeGroup(group));
      }
      if (seen.size !== groupIds.length || groupIds.some(id => !seen.has(id))) {
        return fail("CARD_GROUP_WRITE_RESULT_INCOMPLETE", 503);
      }
      return { ok: true, cardId, groups: output };
    },
  });
}
