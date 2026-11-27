/**
 * Read-only APP route integration boundary inventory.
 * This is audit metadata only: it is not imported by the production Worker.
 */
export const APP_ROUTE_MATRIX = Object.freeze([
  { method:"POST", path:"/api/app/redeem", authNow:"card code + client device_id", selectorNow:"card code; creates one entitlement", scopeNow:"card/admin", risk:"HIGH", priority:1, v2Target:"POST /api/app/v2/redeem", legacyPolicy:"Keep legacy response contract during migration; add atomic per-card slot reservation and card-group mapping only after schema/client validation." },
  { method:"GET", path:"/api/app/status", authNow:"device_id only; no token check", selectorNow:"latest entitlement row for device", scopeNow:"device-wide status", risk:"CRITICAL", priority:0, v2Target:"GET /api/app/v2/entitlements/:entitlementId/status", legacyPolicy:"Do not treat legacy status as proof of entitlement. Deprecate only after client migration; new route requires explicit entitlement identity and HMAC token." },
  { method:"GET", path:"/api/app/nodes", authNow:"device_id + query token", selectorNow:"latest active entitlement for device", scopeNow:"all enabled/approved sources owned by selected admin", risk:"CRITICAL", priority:0, v2Target:"GET /api/app/v2/entitlements/:entitlementId/nodes", legacyPolicy:"No silent fallback from v2 to latest entitlement. Enforce exact entitlement and group/source allowlist in v2." },
  { method:"GET", path:"/api/app/groups", authNow:"device_id + query token for card path; device_id/free_grant for no-entitlement path", selectorNow:"latest active entitlement or all device free grants", scopeNow:"legacy public/free/assigned groups; no card_id mapping", risk:"CRITICAL", priority:0, v2Target:"GET /api/app/v2/entitlements/:entitlementId/groups", legacyPolicy:"New contract composes all explicit entitlements; free groups require identity/free entitlement; legacy no-token node delivery remains a migration blocker." },
  { method:"GET", path:"/api/app/links", authNow:"device_id + query token", selectorNow:"latest active entitlement for device", scopeNow:"all enabled links for selected admin", risk:"HIGH", priority:1, v2Target:"GET /api/app/v2/entitlements/:entitlementId/links", legacyPolicy:"Use explicit entitlement resolver; preserve response field names where possible." },
  { method:"GET", path:"/api/app/free", authNow:"public admin id or share code; no device/token", selectorNow:"administrator from query/code", scopeNow:"directly returns free-tier node data", risk:"CRITICAL", priority:0, v2Target:"GET /api/app/v2/identity/:adminId/groups", legacyPolicy:"New share-code resolution may bind/discover admin only; it must not authorize node reads. Stage removal of legacy data response after verified client migration." },
  { method:"GET", path:"/api/app/resolve", authNow:"public share code", selectorNow:"share code -> admin row", scopeNow:"admin identity/name/free permission metadata", risk:"MEDIUM", priority:2, v2Target:"GET /api/app/resolve (restricted discovery contract)", legacyPolicy:"Retain as discovery only; rate-limit, avoid unnecessary identifiers and never treat result as read authorization." },
  { method:"GET", path:"/api/app/version", authNow:"public", selectorNow:"platform/version", scopeNow:"release metadata", risk:"LOW", priority:4, v2Target:"GET /api/app/version", legacyPolicy:"Preserve." },
  { method:"GET", path:"/api/app/download", authNow:"public", selectorNow:"release/download metadata", scopeNow:"download URL", risk:"MEDIUM", priority:3, v2Target:"GET /api/app/download", legacyPolicy:"Preserve after release ownership, integrity and availability checks." },
  { method:"GET", path:"/api/user/app-cards", authNow:"user session + general user scope", selectorNow:"ctx.effectiveId", scopeNow:"own card rows", risk:"HIGH", priority:1, v2Target:"same path with explicit active-VIP action policy", legacyPolicy:"Read-only history can follow existing expiry policy; create/disable/delete actions require valid VIP and exact action-specific entitlement." },
  { method:"POST", path:"/api/user/app-cards", authNow:"user session + general user scope", selectorNow:"ctx.effectiveId", scopeNow:"creates own cards", risk:"CRITICAL", priority:0, v2Target:"same path with VIP gate + device policy", legacyPolicy:"Do not expose creation to registered non-VIP or expired VIP; audit and enforce max_devices server-side." },
  { method:"GET", path:"/api/user/app-groups", authNow:"user session", selectorNow:"ctx.effectiveId", scopeNow:"own groups", risk:"MEDIUM", priority:2, v2Target:"same path plus card mode and group audit", legacyPolicy:"Read allowed by user scope; write operations require active VIP." },
  { method:"POST/PUT/DELETE", path:"/api/user/app-groups/*", authNow:"user session", selectorNow:"ctx.effectiveId for owner checks", scopeNow:"own group and child rows", risk:"CRITICAL", priority:0, v2Target:"same paths with VIP gate, owner-safe transactions and generation", legacyPolicy:"Require active VIP for mutations; preserve read-only access after expiry." },
  { method:"GET/POST/DELETE", path:"/api/user/app-links/*", authNow:"user session", selectorNow:"ctx.effectiveId", scopeNow:"own links", risk:"HIGH", priority:1, v2Target:"same paths with active-VIP action policy", legacyPolicy:"Confirm exact business entitlement for link mutations; enforce valid VIP where share configuration is protected." },
  { method:"GET/POST/PUT/DELETE", path:"/api/super/app-groups/*", authNow:"super-admin session", selectorNow:"explicit admin scope for target", scopeNow:"cross-admin group data", risk:"HIGH", priority:1, v2Target:"same paths with atomic owner/source checks and generation", legacyPolicy:"Keep super-admin boundary; require audit success for sensitive changes." },
  { method:"POST", path:"/api/super/app-entitlements/:id/rebind", authNow:"super-admin session", selectorNow:"entitlement id", scopeNow:"updates entitlement device_id", risk:"HIGH", priority:1, v2Target:"device release/reservation workflow", legacyPolicy:"Do not treat direct rebind as device-slot release; replace only after audited approval and slot model validation." }
]);

export function summarizeAppRouteMatrix(matrix = APP_ROUTE_MATRIX) {
  const risks = { CRITICAL:0, HIGH:0, MEDIUM:0, LOW:0 };
  const priorities = { 0:0, 1:0, 2:0, 3:0, 4:0 };
  for (const row of matrix) {
    if (!row || !row.method || !row.path || !row.authNow || !row.selectorNow ||
        !row.scopeNow || !Object.hasOwn(risks, row.risk) ||
        !Object.hasOwn(priorities, row.priority) || !row.v2Target || !row.legacyPolicy) {
      return { ok:false, code:"MATRIX_ROW_INCOMPLETE" };
    }
    risks[row.risk]++;
    priorities[row.priority]++;
  }
  return { ok:true, total:matrix.length, risks, priorities, productionWired:false };
}
