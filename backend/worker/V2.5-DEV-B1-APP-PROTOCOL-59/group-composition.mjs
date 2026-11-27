const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Compose simultaneous APP entitlements without crossing administrator scopes.
 * Card groups remain entitlement-scoped; each administrator's free groups appear once.
 * cardSerialLabel is a safe display label, never a redeemable card code.
 */
export function composeEntitlementGroups({ entitlements, groupsByEntitlement }) {
  if (!Array.isArray(entitlements) || !Array.isArray(groupsByEntitlement)) {
    return { ok: false, code: "GROUP_COMPOSITION_INPUT_INVALID", groups: [] };
  }
  const byEntitlement = new Map();
  for (const item of groupsByEntitlement) {
    if (!item || typeof item.entitlementId !== "string" || byEntitlement.has(item.entitlementId)) {
      return { ok: false, code: "DUPLICATE_OR_INVALID_GROUP_LOADER_RESULT", groups: [] };
    }
    byEntitlement.set(item.entitlementId, item);
  }
  const cardEntries = [];
  const freeByAdmin = new Map();
  const seenEntitlements = new Set();

  for (const ent of entitlements) {
    if (!ent || !ID_RE.test(ent.id || "") || !ID_RE.test(ent.adminUserId || "") || seenEntitlements.has(ent.id)) {
      return { ok: false, code: "ENTITLEMENT_SCOPE_INVALID", groups: [] };
    }
    seenEntitlements.add(ent.id);
    const loaded = byEntitlement.get(ent.id);
    if (!loaded || !Array.isArray(loaded.cardGroups) || !Array.isArray(loaded.freeGroups)) {
      return { ok: false, code: "ENTITLEMENT_GROUPS_UNAVAILABLE", groups: [] };
    }

    if (ent.kind === "CARD") {
      if (!ID_RE.test(ent.cardId || "") || typeof ent.cardSerialLabel !== "string" || !ent.cardSerialLabel.trim()) {
        return { ok: false, code: "CARD_DISPLAY_ID_REQUIRED", groups: [] };
      }
      for (const group of loaded.cardGroups) {
        if (!isOwnedEnabledGroup(group, ent.adminUserId, "card")) {
          return { ok: false, code: "CARD_GROUP_SCOPE_MISMATCH", groups: [] };
        }
        cardEntries.push({
          ...group, origin: "CARD", entitlementId: ent.id, cardId: ent.cardId,
          cardSerialLabel: ent.cardSerialLabel.trim(), displayName: group.name,
        });
      }
    } else if (ent.kind === "IDENTITY") {
      if (loaded.cardGroups.length !== 0) return { ok: false, code: "IDENTITY_CARD_GROUP_FORBIDDEN", groups: [] };
    } else {
      return { ok: false, code: "UNKNOWN_ENTITLEMENT_KIND", groups: [] };
    }

    for (const group of loaded.freeGroups) {
      if (!isOwnedEnabledGroup(group, ent.adminUserId, "free")) {
        return { ok: false, code: "FREE_GROUP_SCOPE_MISMATCH", groups: [] };
      }
      if (!freeByAdmin.has(ent.adminUserId)) freeByAdmin.set(ent.adminUserId, new Map());
      const adminGroups = freeByAdmin.get(ent.adminUserId);
      const previous = adminGroups.get(group.id);
      if (previous && (previous.name !== group.name || previous.adminUserId !== group.adminUserId)) {
        return { ok: false, code: "FREE_GROUP_ID_COLLISION", groups: [] };
      }
      adminGroups.set(group.id, {
        ...group, origin: "FREE", entitlementId: null, cardId: null,
        cardSerialLabel: null, displayName: group.name,
      });
    }
  }

  const nameCounts = new Map();
  for (const entry of cardEntries) nameCounts.set(entry.name, (nameCounts.get(entry.name) || 0) + 1);
  for (const entry of cardEntries) {
    if (nameCounts.get(entry.name) > 1) entry.displayName = `${entry.name}（${entry.cardSerialLabel}）`;
  }

  const freeEntries = [...freeByAdmin.values()].flatMap(groups => [...groups.values()]);
  const groups = [...cardEntries, ...freeEntries].sort((a, b) =>
    a.adminUserId.localeCompare(b.adminUserId) ||
    (a.origin === b.origin ? 0 : a.origin === "CARD" ? -1 : 1) ||
    a.displayName.localeCompare(b.displayName) ||
    String(a.entitlementId || "").localeCompare(String(b.entitlementId || "")) ||
    a.id.localeCompare(b.id)
  );
  return { ok: true, groups };
}

function isOwnedEnabledGroup(group, adminUserId, mode) {
  return !!group && ID_RE.test(group.id || "") && group.adminUserId === adminUserId &&
    group.mode === mode && group.enabled === true &&
    typeof group.name === "string" && group.name.trim().length > 0;
}
