/**
 * Query contract fragments for isolated review only.
 * These are not executable migrations and are not bound to production D1.
 */
export const CARD_GROUPS_SQL = `
SELECT g.id, g.admin_user_id, g.mode, g.enabled
FROM app_card_groups AS cg
JOIN app_cards AS c ON c.id = cg.card_id
JOIN app_groups AS g ON g.id = cg.group_id
WHERE cg.card_id = ?
  AND c.admin_user_id = ?
  AND g.admin_user_id = c.admin_user_id
  AND g.mode = 'card'
  AND g.enabled = 1
`;

export const FREE_GROUPS_SQL = `
SELECT g.id, g.admin_user_id, g.mode, g.enabled
FROM app_groups AS g
JOIN admin_app_perms AS p ON p.admin_user_id = g.admin_user_id
WHERE g.admin_user_id = ?
  AND g.mode = 'free'
  AND g.enabled = 1
  AND p.free_group_enabled = 1
  AND EXISTS (
    SELECT 1 FROM app_free_grants AS fg
    WHERE fg.admin_user_id = g.admin_user_id
      AND fg.device_id = ?
  )
`;

/**
 * Trusted adapter must bind both allowed group IDs and the entitlement owner.
 * Empty allowlists intentionally produce no query, never an admin-wide query.
 */
export function buildNodeScopePredicate({ allowedGroupIds, entitlementAdminUserId }) {
  if (!Array.isArray(allowedGroupIds) || allowedGroupIds.length === 0 ||
      allowedGroupIds.some(id => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) ||
      typeof entitlementAdminUserId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(entitlementAdminUserId)) {
    return { ok: false, code: "EMPTY_OR_INVALID_GROUP_SCOPE" };
  }
  return {
    ok: true,
    sql: `g.id IN (${allowedGroupIds.map(() => "?").join(",")}) AND g.admin_user_id = ? AND g.enabled = 1 AND s.admin_user_id = g.admin_user_id AND s.enabled = 1 AND s.approval_status = 'approved'`,
    bindings: [...allowedGroupIds, entitlementAdminUserId],
  };
}
