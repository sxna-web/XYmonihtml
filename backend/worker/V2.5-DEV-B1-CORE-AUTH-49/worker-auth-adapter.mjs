import { classifyVip, decideActionAccess } from "../V2.5-DEV-B1-CORE-AUTH-47/authorization.mjs";

function actionFor(path, method) {
  const p = path.split("/").filter(Boolean);
  if (p[0] !== "api" || p[1] !== "user") return null;
  if (p[2] === "app-groups") {
    if (p.length === 3 && method === "POST") return "create";
    if (p.length === 4 && method === "PUT") return "update";
    if (p.length === 4 && method === "DELETE") return "delete_history";
    if (p.length === 5 && p[4] === "sources" && method === "POST") return "associate";
    // Removing a source association is still a configuration mutation, not historical-data deletion.
    if (p.length === 6 && p[4] === "sources" && method === "DELETE") return "associate";
    if (p.length === 5 && p[4] === "members" && method === "POST") return "associate";
  }
  if (p[2] === "app-links") {
    if (p.length === 3 && method === "POST") return "create";
    if (p.length === 4 && method === "DELETE") return "delete_history";
  }
  if (p[2] === "app-cards") {
    // Protocol66 card-group replacement is a configuration association, not historical deletion.
    if (p.length === 5 && p[4] === "groups" && method === "PUT") return "associate";
    if (p.length === 3 && method === "POST") return "generate";
    if (p.length === 4 && method === "DELETE") return "disable";
    if (p.length === 5 && p[4] === "disable" && method === "POST") return "disable";
  }
  return null;
}

function sqliteTimeToIso(value) {
  if (typeof value !== "string") return value;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)) return value.replace(" ", "T") + "Z";
  return value;
}

/**
 * Uses only server-resolved ctx from resolveSession. No request-body identity/role/VIP fields are read.
 * The returned formalCutoff must be applied in the final DELETE predicate, together with owner.
 */
export async function authorizeAppManagementRequest({ db, path, method, ctx, now = new Date().toISOString() }) {
  const action = actionFor(path, method);
  if (!action) return null;
  if (!ctx || ctx.legacy || !ctx.actorId || !ctx.effectiveId) {
    return { allowed: false, code: "UNAUTHENTICATED", action };
  }

  let resourceOwned = true;
  let resourceCreatedAt;
  let resourceId;
  let resourceTable;
  const parts = path.split("/").filter(Boolean);
  if (action === "delete_history") {
    resourceId = parts[3];
    resourceTable = parts[2] === "app-groups" ? "app_groups" : "app_links";
    try {
      const row = await db.prepare(
        `SELECT id, created_at FROM ${resourceTable} WHERE id = ? AND admin_user_id = ?`,
      ).bind(resourceId, ctx.effectiveId).first();
      resourceOwned = !!row;
      resourceCreatedAt = sqliteTimeToIso(row?.created_at);
    } catch {
      return { allowed: false, code: "RESOURCE_CHECK_UNAVAILABLE", action };
    }
  }

  let activations;
  try {
    const result = await db.prepare(
      "SELECT kind, starts_at, ends_at FROM admin_vip_activations WHERE user_id = ? ORDER BY starts_at, ends_at",
    ).bind(ctx.effectiveId).all();
    activations = result?.results;
    if (!Array.isArray(activations)) activations = { unavailable: true };
  } catch {
    activations = { unavailable: true };
  }

  const vip = classifyVip(activations, now);
  const decision = decideActionAccess({
    actorId: ctx.actorId,
    effectiveId: ctx.effectiveId,
    isSuperAdmin: ctx.isSuper === true,
    scope: ctx.scope || null,
    action,
    vipActivations: activations,
    now,
    resourceOwned,
    resourceCreatedAt,
  });
  return {
    ...decision,
    action,
    vipState: decision.vipState || vip.state,
    formalCutoff: vip.state === "expired_formal" ? vip.formalCutoff : null,
    resourceId: resourceId || null,
    resourceTable: resourceTable || null,
  };
}

export { actionFor as _actionForTest };
