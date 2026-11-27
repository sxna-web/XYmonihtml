import { composeEntitlementGroups } from "../V2.5-DEV-B1-APP-PROTOCOL-60/group-composition.mjs";

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const DEVICE_RE = /^[A-Za-z0-9_-]{8,80}$/;
const TOKEN_RE = /^[A-Za-z0-9._~-]{16,512}$/;
const MAX_ENTITLEMENTS = 20;

function fail(code) {
  return { ok: false, code, groups: [] };
}

function validGroup(group, adminUserId, mode) {
  return !!group &&
    ID_RE.test(group.id || "") &&
    group.adminUserId === adminUserId &&
    group.mode === mode &&
    group.enabled === true &&
    typeof group.name === "string" &&
    group.name.trim().length > 0;
}

function uniqueGroupRows(rows, adminUserId, mode) {
  if (!Array.isArray(rows)) return false;
  const seen = new Set();
  for (const group of rows) {
    if (!validGroup(group, adminUserId, mode) || seen.has(group.id)) return false;
    seen.add(group.id);
  }
  return true;
}

function validateLoadedScope(loaded, entitlement) {
  if (!loaded || loaded.ok !== true ||
      !uniqueGroupRows(loaded.cardGroups, entitlement.admin_user_id, "card") ||
      !uniqueGroupRows(loaded.freeGroups, entitlement.admin_user_id, "free") ||
      !Array.isArray(loaded.allowedGroupIds) ||
      loaded.allowedGroupIds.some(id => !ID_RE.test(id || "")) ||
      new Set(loaded.allowedGroupIds).size !== loaded.allowedGroupIds.length) {
    return false;
  }
  const expected = new Set([
    ...loaded.cardGroups.map(group => group.id),
    ...loaded.freeGroups.map(group => group.id),
  ]);
  return expected.size === loaded.allowedGroupIds.length &&
    loaded.allowedGroupIds.every(id => expected.has(id));
}

/**
 * Every credential is independently resolved by exact entitlement ID + same device ID.
 * The service never queries "latest entitlement" and fails the entire composition if
 * any supplied credential or group scope is invalid.
 */
export function createComposedEntitlementGroupService({
  resolveEntitlement,
  classifyEntitlement,
  loadGroupsForEntitlement,
  loadCardSerialLabel,
}) {
  for (const [name, fn] of Object.entries({
    resolveEntitlement, classifyEntitlement, loadGroupsForEntitlement, loadCardSerialLabel,
  })) {
    if (typeof fn !== "function") throw new TypeError(`Missing service dependency: ${name}`);
  }

  return async function composeForDevice({ deviceId, credentials }) {
    if (!DEVICE_RE.test(deviceId || "") ||
        !Array.isArray(credentials) ||
        credentials.length < 1 ||
        credentials.length > MAX_ENTITLEMENTS) return fail("COMPOSITION_INPUT_INVALID");

    const seen = new Set();
    const entitlements = [];
    const groupsByEntitlement = [];

    for (const credential of credentials) {
      if (!credential || !ID_RE.test(credential.entitlementId || "") ||
          !TOKEN_RE.test(credential.token || "") || seen.has(credential.entitlementId)) {
        return fail("DUPLICATE_OR_INVALID_CREDENTIAL");
      }
      seen.add(credential.entitlementId);

      let resolved;
      try {
        resolved = await resolveEntitlement({
          entitlementId: credential.entitlementId,
          deviceId,
          token: credential.token,
        });
      } catch {
        return fail("ENTITLEMENT_RESOLUTION_UNAVAILABLE");
      }
      const entitlement = resolved?.entitlement;
      if (!resolved || resolved.ok !== true || !entitlement ||
          entitlement.id !== credential.entitlementId ||
          entitlement.device_id !== deviceId ||
          !ID_RE.test(entitlement.admin_user_id || "")) {
        return fail(resolved?.code || "ENTITLEMENT_SCOPE_DENIED");
      }

      let classification;
      try {
        classification = await classifyEntitlement(entitlement);
      } catch {
        return fail("ENTITLEMENT_CLASSIFICATION_UNAVAILABLE");
      }
      if (!classification || !["CARD", "IDENTITY"].includes(classification.kind) ||
          (classification.kind === "CARD" && (!ID_RE.test(classification.cardId || "") ||
            (entitlement.card_id != null && classification.cardId !== entitlement.card_id))) ||
          (classification.kind === "IDENTITY" &&
            (classification.cardId != null || entitlement.card_id != null))) {
        return fail("ENTITLEMENT_CLASSIFICATION_INVALID");
      }
      const scopedEntitlement = {
        ...entitlement,
        kind: classification.kind,
        card_id: classification.cardId ?? null,
      };

      let loaded;
      try {
        loaded = await loadGroupsForEntitlement(scopedEntitlement);
      } catch {
        return fail("GROUP_SCOPE_UNAVAILABLE");
      }
      if (!validateLoadedScope(loaded, entitlement)) {
        return fail(loaded?.code || "GROUP_SCOPE_MISMATCH");
      }

      let cardSerialLabel = null;
      if (classification.kind === "CARD") {
        try {
          cardSerialLabel = await loadCardSerialLabel(scopedEntitlement);
        } catch {
          return fail("CARD_SERIAL_LABEL_UNAVAILABLE");
        }
        if (typeof cardSerialLabel !== "string" || !cardSerialLabel.trim()) {
          return fail("CARD_SERIAL_LABEL_UNAVAILABLE");
        }
      }

      entitlements.push({
        id: entitlement.id,
        adminUserId: entitlement.admin_user_id,
        kind: classification.kind,
        ...(classification.kind === "CARD" ? {
          cardId: classification.cardId,
          cardSerialLabel: cardSerialLabel.trim(),
        } : {}),
      });
      groupsByEntitlement.push({
        entitlementId: entitlement.id,
        cardGroups: loaded.cardGroups,
        freeGroups: loaded.freeGroups,
      });
    }

    const composed = composeEntitlementGroups({ entitlements, groupsByEntitlement });
    if (!composed.ok) return fail(composed.code);
    return {
      ok: true,
      groups: composed.groups,
      entitlementCount: entitlements.length,
      deviceId,
    };
  };
}

export const COMPOSED_GROUP_LIMITS = Object.freeze({
  maxEntitlements: MAX_ENTITLEMENTS,
  maxRequestBytes: 32768,
});
