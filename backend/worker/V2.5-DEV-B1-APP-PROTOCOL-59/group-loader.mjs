import { buildEntitlementGroupAllowlist } from "../V2.5-DEV-B1-APP-PROTOCOL-58/app-v2-policy.mjs";

/**
 * Dependency-injected group loader.
 * Mapping adapters must return cardId, groupId, cardAdminUserId and groupAdminUserId
 * from a joined, owner-checked query. No production schema is assumed here.
 */
export function createEntitlementGroupLoader({ loadCardMappings, loadGroups, hasFreeGrant, isFreeEnabled }) {
  for (const [name, fn] of Object.entries({ loadCardMappings, loadGroups, hasFreeGrant, isFreeEnabled })) {
    if (typeof fn !== "function") throw new TypeError(`Missing group loader dependency: ${name}`);
  }
  return async function loadForEntitlement(entitlement) {
    if (!entitlement || typeof entitlement.id !== "string" || typeof entitlement.admin_user_id !== "string") {
      return { ok: false, code: "INVALID_ENTITLEMENT_CONTEXT", allowedGroupIds: [], cardGroups: [], freeGroups: [] };
    }
    try {
      const [mappings, groups, freeGrantEligible, freeGroupEnabled] = await Promise.all([
        entitlement.kind === "CARD" ? loadCardMappings(entitlement.card_id, entitlement.admin_user_id) : Promise.resolve([]),
        loadGroups(entitlement.admin_user_id),
        hasFreeGrant(entitlement.device_id, entitlement.admin_user_id),
        isFreeEnabled(entitlement.admin_user_id),
      ]);
      if (entitlement.kind === "CARD" && (!Array.isArray(mappings) || mappings.some(m =>
        !m || m.cardId !== entitlement.card_id ||
        m.cardAdminUserId !== entitlement.admin_user_id ||
        m.groupAdminUserId !== entitlement.admin_user_id ||
        typeof m.groupId !== "string"))) {
        return { ok: false, code: "CARD_GROUP_OWNER_MISMATCH", allowedGroupIds: [], cardGroups: [], freeGroups: [] };
      }
      if (!Array.isArray(groups)) {
        return { ok: false, code: "GROUP_DATA_UNAVAILABLE", allowedGroupIds: [], cardGroups: [], freeGroups: [] };
      }
      const policy = buildEntitlementGroupAllowlist({
        entitlement: {
          id: entitlement.id, adminUserId: entitlement.admin_user_id,
          kind: entitlement.kind, cardId: entitlement.card_id,
        },
        groups,
        cardGroupMappings: mappings.map(m => ({ cardId: m.cardId, groupId: m.groupId })),
        freeGrantEligible,
        freeGroupEnabled,
      });
      if (!policy.ok) return { ...policy, cardGroups: [], freeGroups: [] };
      const allowed = new Set(policy.allowedGroupIds);
      const cardIds = new Set(policy.groupTypes.card);
      const cardGroups = groups.filter(g => allowed.has(g.id) && cardIds.has(g.id));
      const freeGroups = groups.filter(g => allowed.has(g.id) && g.mode === "free");
      return { ok: true, allowedGroupIds: policy.allowedGroupIds, cardGroups, freeGroups, groupTypes: policy.groupTypes };
    } catch {
      return { ok: false, code: "GROUP_DATA_UNAVAILABLE", allowedGroupIds: [], cardGroups: [], freeGroups: [] };
    }
  };
}
