/**
 * Batch 58 isolated APP v2 policy primitives.
 * No D1 access, no production Worker wiring, no secrets.
 */

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function normalizeDeviceLimit({ requestedLimit, actor, vipActive = false }) {
  if (requestedLimit === undefined || requestedLimit === null) {
    return { ok: true, maxDevices: 1, source: "DEFAULT" };
  }
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
    return { ok: false, code: "INVALID_DEVICE_LIMIT" };
  }
  if (actor === "SUPER_ADMIN") {
    return { ok: true, maxDevices: requestedLimit, source: "SUPER_ADMIN" };
  }
  if (actor !== "VIP_ADMIN" || vipActive !== true) {
    return { ok: false, code: "VIP_ADMIN_REQUIRED" };
  }
  if (requestedLimit > 5) {
    return { ok: false, code: "SUPER_ADMIN_REQUIRED" };
  }
  return { ok: true, maxDevices: requestedLimit, source: "VIP_ADMIN" };
}

export function evaluateCardDeviceActivation({ maxDevices = 1, existingDeviceIds = [], requestedDeviceId }) {
  if (!Number.isSafeInteger(maxDevices) || maxDevices < 1) {
    return { allowed: false, code: "INVALID_DEVICE_POLICY" };
  }
  if (typeof requestedDeviceId !== "string" || !ID_RE.test(requestedDeviceId)) {
    return { allowed: false, code: "BAD_DEVICE_ID" };
  }
  if (!Array.isArray(existingDeviceIds) || existingDeviceIds.some(id => typeof id !== "string" || !ID_RE.test(id))) {
    return { allowed: false, code: "INVALID_DEVICE_REGISTRY" };
  }
  const unique = [...new Set(existingDeviceIds)];
  if (unique.includes(requestedDeviceId)) {
    return { allowed: true, idempotent: true, activeDeviceCount: unique.length };
  }
  if (unique.length >= maxDevices) {
    return { allowed: false, code: "CARD_DEVICE_LIMIT_REACHED", activeDeviceCount: unique.length, maxDevices };
  }
  return { allowed: true, idempotent: false, activeDeviceCount: unique.length + 1, maxDevices };
}

/**
 * Computes the only group IDs visible to one entitlement.
 * groups and mappings are already loaded by a trusted server-side adapter.
 * Any malformed ownership or missing required relation fails closed.
 */
export function buildEntitlementGroupAllowlist({
  entitlement,
  groups,
  cardGroupMappings = [],
  freeGrantEligible = false,
  freeGroupEnabled = false,
}) {
  if (!entitlement || !ID_RE.test(entitlement.id || "") || !ID_RE.test(entitlement.adminUserId || "")) {
    return { ok: false, code: "INVALID_ENTITLEMENT_CONTEXT", allowedGroupIds: [] };
  }
  if (!Array.isArray(groups) || !Array.isArray(cardGroupMappings)) {
    return { ok: false, code: "GROUP_DATA_UNAVAILABLE", allowedGroupIds: [] };
  }

  const ownedEnabled = groups.filter(group =>
    group &&
    ID_RE.test(group.id || "") &&
    group.adminUserId === entitlement.adminUserId &&
    group.enabled === true
  );

  const freeIds = new Set();
  if (freeGrantEligible === true && freeGroupEnabled === true) {
    for (const group of ownedEnabled) {
      if (group.mode === "free") freeIds.add(group.id);
    }
  }

  if (entitlement.kind === "IDENTITY") {
    return { ok: true, allowedGroupIds: [...freeIds].sort(), groupTypes: { free: [...freeIds].sort(), card: [] } };
  }
  if (entitlement.kind !== "CARD" || !ID_RE.test(entitlement.cardId || "")) {
    return { ok: false, code: "UNKNOWN_ENTITLEMENT_KIND", allowedGroupIds: [] };
  }

  const groupById = new Map(ownedEnabled.map(group => [group.id, group]));
  const cardIds = new Set();
  for (const mapping of cardGroupMappings) {
    if (!mapping || mapping.cardId !== entitlement.cardId) continue;
    const group = groupById.get(mapping.groupId);
    if (group && group.mode === "card") cardIds.add(group.id);
  }
  const card = [...cardIds].sort();
  const free = [...freeIds].sort();
  return {
    ok: true,
    allowedGroupIds: [...new Set([...card, ...free])].sort(),
    groupTypes: { card, free },
  };
}

export function assertGroupRowsWithinAllowlist({ rows, entitlementAdminUserId, allowedGroupIds }) {
  if (!Array.isArray(rows) || !Array.isArray(allowedGroupIds) || typeof entitlementAdminUserId !== "string") {
    return { ok: false, code: "GROUP_SCOPE_UNAVAILABLE", rows: [] };
  }
  const allowed = new Set(allowedGroupIds);
  const safe = rows.filter(row =>
    row &&
    typeof row.id === "string" &&
    row.adminUserId === entitlementAdminUserId &&
    allowed.has(row.id) &&
    row.enabled === true &&
    (row.mode === "card" || row.mode === "free")
  );
  if (safe.length !== rows.length) {
    return { ok: false, code: "GROUP_SCOPE_MISMATCH", rows: [] };
  }
  return { ok: true, rows: safe };
}
