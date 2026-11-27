import { resolveAppEntitlement } from "../V2.5-DEV-B1-APP-TOKEN-52/entitlement-resolver.mjs";

/**
 * Isolated read-access policy. This module does not fetch or return APP data.
 * Public share-code resolution is a bind/discovery action only; it never authorizes node delivery.
 */
export async function authorizeAppRead({
  endpoint, db, entitlementId, deviceId, token, verifyToken, now,
  shareCodeResolvedAdminId = null,
}) {
  const protectedEndpoints = new Set(["status", "groups", "links", "nodes"]);
  if (endpoint === "free") {
    if (typeof shareCodeResolvedAdminId !== "string" || !shareCodeResolvedAdminId) {
      return { allowed: false, code: "FREE_BINDING_NOT_FOUND" };
    }
    return {
      allowed: true,
      action: "BIND_ADMIN_ONLY",
      adminUserId: shareCodeResolvedAdminId,
      mayReadNodes: false,
      mayReadGroups: false,
    };
  }
  if (!protectedEndpoints.has(endpoint)) return { allowed: false, code: "UNKNOWN_READ_ENDPOINT" };

  const resolved = await resolveAppEntitlement({
    db, entitlementId, deviceId, token, verifyToken, now,
  });
  if (!resolved.ok) return { allowed: false, code: resolved.code };

  return {
    allowed: true,
    action: "ENTITLEMENT_READ",
    endpoint,
    entitlementId: resolved.entitlement.id,
    adminUserId: resolved.entitlement.admin_user_id,
    deviceId: resolved.entitlement.device_id,
    // Data handlers must still enforce the endpoint-specific scope below.
    scope: endpoint === "nodes" || endpoint === "groups"
      ? "APP_GROUP_MEMBERSHIP_AND_SOURCE_APPROVAL"
      : endpoint === "links" ? "ENTITLEMENT_ADMIN_ONLY" : "ENTITLEMENT_STATUS_ONLY",
  };
}

/** A final data-scope guard for a row already loaded by a handler. */
export function isWithinEntitlementScope({ rowAdminUserId, entitlementAdminUserId, groupId, allowedGroupIds }) {
  if (typeof rowAdminUserId !== "string" || rowAdminUserId !== entitlementAdminUserId) return false;
  if (groupId === undefined || groupId === null) return true;
  return Array.isArray(allowedGroupIds) && allowedGroupIds.includes(groupId);
}
