const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

function reply(status, body) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function validGroupScope(scope, entitlement) {
  return !!scope && scope.ok === true &&
    Array.isArray(scope.allowedGroupIds) &&
    scope.allowedGroupIds.every(id => typeof id === "string" && id.length > 0) &&
    new Set(scope.allowedGroupIds).size === scope.allowedGroupIds.length &&
    Array.isArray(scope.groups) &&
    scope.groups.every(group => group &&
      group.adminUserId === entitlement.admin_user_id &&
      scope.allowedGroupIds.includes(group.id) &&
      group.enabled === true && ["card", "free"].includes(group.mode));
}

export function createAppV2ReadHandler({
  resolveEntitlement, loadGroups, loadNodes, loadLinks, loadStatus,
}) {
  const deps = { resolveEntitlement, loadGroups, loadNodes, loadLinks, loadStatus };
  for (const [name, fn] of Object.entries(deps)) {
    if (typeof fn !== "function") throw new TypeError(`Missing handler dependency: ${name}`);
  }

  return async function handle(request) {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/api\/app\/v2\/entitlements\/([A-Za-z0-9_-]{8,100})\/(groups|nodes|links|status)$/);
    if (request.method !== "GET" || !match) return reply(404, { ok: false, code: "NOT_FOUND" });

    const entitlementId = match[1];
    const resource = match[2];
    const deviceId = request.headers.get("x-app-device-id") || "";
    const authorization = request.headers.get("authorization") || "";
    const tokenMatch = authorization.match(/^Bearer ([A-Za-z0-9._~-]{16,512})$/);
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(deviceId) || !tokenMatch) {
      return reply(401, { ok: false, code: "AUTH_REQUIRED" });
    }

    let resolved;
    try {
      resolved = await resolveEntitlement({ entitlementId, deviceId, token: tokenMatch[1] });
    } catch {
      return reply(503, { ok: false, code: "ENTITLEMENT_UNAVAILABLE" });
    }
    const entitlement = resolved?.entitlement;
    if (!resolved || resolved.ok !== true || !entitlement ||
        entitlement.id !== entitlementId || entitlement.device_id !== deviceId ||
        typeof entitlement.admin_user_id !== "string" || !entitlement.admin_user_id) {
      const denied = resolved?.code === "ENTITLEMENT_SECRET_UNAVAILABLE" ||
        resolved?.code === "TOKEN_VERIFIER_UNAVAILABLE" ||
        resolved?.code === "ENTITLEMENT_STORE_UNAVAILABLE";
      return reply(denied ? 503 : 403, {
        ok: false,
        code: resolved?.code || "ENTITLEMENT_BINDING_MISMATCH",
      });
    }

    if (resource === "status") {
      let status;
      try { status = await loadStatus(entitlement); }
      catch { return reply(503, { ok: false, code: "STATUS_READ_UNAVAILABLE" }); }
      if (!status || status.ok !== true || !status.data || typeof status.data !== "object") {
        return reply(403, { ok: false, code: status?.code || "STATUS_SCOPE_DENIED" });
      }
      return reply(200, { ok: true, entitlementId, status: status.data });
    }

    let scope;
    try { scope = await loadGroups(entitlement); }
    catch { return reply(503, { ok: false, code: "GROUP_SCOPE_UNAVAILABLE" }); }
    if (!validGroupScope(scope, entitlement)) {
      return reply(403, { ok: false, code: scope?.code || "GROUP_SCOPE_MISMATCH" });
    }

    if (resource === "groups") {
      return reply(200, {
        ok: true, entitlementId, groups: scope.groups,
        generation: scope.generation ?? null,
      });
    }

    if (resource === "nodes") {
      if (scope.allowedGroupIds.length === 0) {
        return reply(200, { ok: true, entitlementId, nodes: [], generation: scope.generation ?? null });
      }
      let result;
      try {
        result = await loadNodes({ entitlement, allowedGroupIds: [...scope.allowedGroupIds] });
      } catch {
        return reply(503, { ok: false, code: "NODE_READ_UNAVAILABLE" });
      }
      if (!result || result.ok !== true || !Array.isArray(result.nodes) ||
          result.nodes.some(node => !node ||
            node.adminUserId !== entitlement.admin_user_id ||
            !scope.allowedGroupIds.includes(node.groupId))) {
        return reply(403, { ok: false, code: result?.code || "NODE_SCOPE_MISMATCH" });
      }
      return reply(200, {
        ok: true, entitlementId, nodes: result.nodes,
        generation: scope.generation ?? null,
      });
    }

    let result;
    try { result = await loadLinks({ entitlement, allowedGroupIds: [...scope.allowedGroupIds] }); }
    catch { return reply(503, { ok: false, code: "LINK_READ_UNAVAILABLE" }); }
    if (!result || result.ok !== true || !Array.isArray(result.links) ||
        result.links.some(link => !link || link.adminUserId !== entitlement.admin_user_id ||
          (link.groupId != null && !scope.allowedGroupIds.includes(link.groupId)))) {
      return reply(403, { ok: false, code: result?.code || "LINK_SCOPE_MISMATCH" });
    }
    return reply(200, { ok: true, entitlementId, links: result.links });
  };
}
