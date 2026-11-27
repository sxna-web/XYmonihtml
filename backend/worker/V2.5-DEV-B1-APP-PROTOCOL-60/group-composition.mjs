const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** Batch 60 hardened projection of simultaneous entitlement groups. */
export function composeEntitlementGroups({ entitlements, groupsByEntitlement }) {
  if (!Array.isArray(entitlements) || !Array.isArray(groupsByEntitlement)) return fail("GROUP_COMPOSITION_INPUT_INVALID");
  const byEntitlement = new Map();
  for (const item of groupsByEntitlement) {
    if (!item || typeof item.entitlementId !== "string" || byEntitlement.has(item.entitlementId)) return fail("DUPLICATE_OR_INVALID_GROUP_LOADER_RESULT");
    byEntitlement.set(item.entitlementId, item);
  }
  const expectedIds = new Set(entitlements.map(e => e && e.id).filter(v => typeof v === "string"));
  if (byEntitlement.size !== expectedIds.size || [...byEntitlement.keys()].some(id => !expectedIds.has(id))) return fail("UNEXPECTED_GROUP_LOADER_RESULT");
  const cardEntries = [];
  const freeByAdmin = new Map();
  const seenEntitlements = new Set();
  for (const ent of entitlements) {
    if (!ent || !ID_RE.test(ent.id || "") || !ID_RE.test(ent.adminUserId || "") || seenEntitlements.has(ent.id)) return fail("ENTITLEMENT_SCOPE_INVALID");
    seenEntitlements.add(ent.id);
    const loaded = byEntitlement.get(ent.id);
    if (!loaded || !Array.isArray(loaded.cardGroups) || !Array.isArray(loaded.freeGroups)) return fail("ENTITLEMENT_GROUPS_UNAVAILABLE");
    if (ent.kind === "CARD") {
      if (!ID_RE.test(ent.cardId || "") || typeof ent.cardSerialLabel !== "string" || !ent.cardSerialLabel.trim()) return fail("CARD_DISPLAY_ID_REQUIRED");
      const seenCardGroups = new Set();
      for (const group of loaded.cardGroups) {
        if (!isOwnedEnabledGroup(group, ent.adminUserId, "card")) return fail("CARD_GROUP_SCOPE_MISMATCH");
        if (seenCardGroups.has(group.id)) return fail("DUPLICATE_CARD_GROUP_ROW");
        seenCardGroups.add(group.id);
        cardEntries.push(projectGroup(group, { origin: "CARD", entitlementId: ent.id, cardId: ent.cardId, cardSerialLabel: ent.cardSerialLabel.trim() }));
      }
    } else if (ent.kind === "IDENTITY") {
      if (loaded.cardGroups.length !== 0) return fail("IDENTITY_CARD_GROUP_FORBIDDEN");
    } else return fail("UNKNOWN_ENTITLEMENT_KIND");
    for (const group of loaded.freeGroups) {
      if (!isOwnedEnabledGroup(group, ent.adminUserId, "free")) return fail("FREE_GROUP_SCOPE_MISMATCH");
      if (!freeByAdmin.has(ent.adminUserId)) freeByAdmin.set(ent.adminUserId, new Map());
      const adminGroups = freeByAdmin.get(ent.adminUserId);
      const previous = adminGroups.get(group.id);
      if (previous && (previous.name !== group.name.trim() || previous.adminUserId !== group.adminUserId || previous.mode !== group.mode)) return fail("FREE_GROUP_ID_COLLISION");
      adminGroups.set(group.id, projectGroup(group, { origin: "FREE", entitlementId: null, cardId: null, cardSerialLabel: null }));
    }
  }
  const nameCounts = new Map();
  for (const entry of cardEntries) { const key = entry.adminUserId + "\u0000" + entry.name; nameCounts.set(key, (nameCounts.get(key) || 0) + 1); }
  for (const entry of cardEntries) {
    const key = entry.adminUserId + "\u0000" + entry.name;
    if (nameCounts.get(key) > 1) entry.displayName = entry.name + "（" + entry.cardSerialLabel + "）";
  }
  const freeEntries = [...freeByAdmin.values()].flatMap(groups => [...groups.values()]);
  const groups = [...cardEntries, ...freeEntries].sort((a, b) => a.adminUserId.localeCompare(b.adminUserId) || (a.origin === b.origin ? 0 : a.origin === "CARD" ? -1 : 1) || a.displayName.localeCompare(b.displayName) || String(a.entitlementId || "").localeCompare(String(b.entitlementId || "")) || a.id.localeCompare(b.id));
  return { ok: true, groups };
}
function projectGroup(group, extra) { return { id: group.id, name: group.name.trim(), adminUserId: group.adminUserId, mode: group.mode, enabled: true, ...extra, displayName: group.name.trim() }; }
function isOwnedEnabledGroup(group, adminUserId, mode) { return !!group && ID_RE.test(group.id || "") && group.adminUserId === adminUserId && group.mode === mode && group.enabled === true && typeof group.name === "string" && group.name.trim().length > 0; }
function fail(code) { return { ok: false, code, groups: [] }; }