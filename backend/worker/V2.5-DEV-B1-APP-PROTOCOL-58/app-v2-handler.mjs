/**
 * Isolated APP v2 read-handler scaffold.
 * All data access is injected; this module cannot reach production D1 by itself.
 */
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

function response(status, body) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

export function createAppV2ReadHandler({ resolveSession, resolveEntitlement, loadGroups, loadNodes }) {
  for (const [name, fn] of Object.entries({ resolveSession, resolveEntitlement, loadGroups, loadNodes })) {
    if (typeof fn !== "function") throw new TypeError(`Missing handler dependency: ${name}`);
  }

  return async function handle(request) {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/api\/app\/v2\/entitlements\/([A-Za-z0-9_-]{8,100})\/(groups|nodes)$/);
    if (request.method !== "GET" || !match) return response(404, { ok: false, code: "NOT_FOUND" });

    const entitlementId = match[1];
    const resource = match[2];
    const authorization = request.headers.get("authorization") || "";
    if (!/^Bearer [A-Za-z0-9._~-]{16,512}$/.test(authorization)) {
      return response(401, { ok: false, code: "AUTH_REQUIRED" });
    }

    let session;
    try { session = await resolveSession(authorization.slice(7), request); }
    catch { return response(503, { ok: false, code: "SESSION_UNAVAILABLE" }); }
    if (!session || session.ok !== true || typeof session.deviceId !== "string") {
      return response(401, { ok: false, code: "INVALID_SESSION" });
    }

    let resolved;
    try { resolved = await resolveEntitlement({ entitlementId, deviceId: session.deviceId, token: authorization.slice(7) }); }
    catch { return response(503, { ok: false, code: "ENTITLEMENT_UNAVAILABLE" }); }
    const ent = resolved?.entitlement;
    if (!resolved || resolved.ok !== true || !ent ||
        ent.id !== entitlementId || ent.device_id !== session.deviceId) {
      return response(403, { ok: false, code: resolved?.code || "ENTITLEMENT_BINDING_MISMATCH" });
    }

    let scope;
    try { scope = await loadGroups(ent); }
    catch { return response(503, { ok: false, code: "GROUP_SCOPE_UNAVAILABLE" }); }
    if (!scope || scope.ok !== true || !Array.isArray(scope.allowedGroupIds) ||
        scope.allowedGroupIds.some(id => typeof id !== "string")) {
      return response(403, { ok: false, code: scope?.code || "GROUP_SCOPE_DENIED" });
    }

    if (resource === "groups") {
      if (!Array.isArray(scope.groups) || scope.groups.some(g =>
        !g || g.adminUserId !== ent.admin_user_id || !scope.allowedGroupIds.includes(g.id) ||
        g.enabled !== true || !["card", "free"].includes(g.mode))) {
        return response(403, { ok: false, code: "GROUP_SCOPE_MISMATCH" });
      }
      return response(200, { ok: true, entitlementId, groups: scope.groups, generation: scope.generation });
    }

    if (scope.allowedGroupIds.length === 0) {
      return response(200, { ok: true, entitlementId, nodes: [], generation: scope.generation });
    }
    let nodes;
    try { nodes = await loadNodes({ entitlement: ent, allowedGroupIds: scope.allowedGroupIds }); }
    catch { return response(503, { ok: false, code: "NODE_READ_UNAVAILABLE" }); }
    if (!nodes || nodes.ok !== true || !Array.isArray(nodes.nodes) ||
        nodes.nodes.some(node => !node || node.adminUserId !== ent.admin_user_id ||
          !scope.allowedGroupIds.includes(node.groupId))) {
      return response(403, { ok: false, code: nodes?.code || "NODE_SCOPE_MISMATCH" });
    }
    return response(200, { ok: true, entitlementId, nodes: nodes.nodes, generation: scope.generation });
  };
}
