const HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

function reply(status, body) {
  return new Response(JSON.stringify(body), { status, headers: HEADERS });
}

export function createCardGroupAdminHandler({ service, resolveSession }) {
  if (!service || typeof service.get !== "function" ||
      typeof service.replace !== "function" ||
      typeof resolveSession !== "function") {
    throw new TypeError("CARD_GROUP_ADMIN_HANDLER_DEPENDENCIES_REQUIRED");
  }

  return async function handle(request) {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/api\/user\/app-cards\/([A-Za-z0-9_-]{1,128})\/groups$/);
    if (!match || !["GET", "PUT"].includes(request.method)) {
      return reply(404, { ok: false, code: "NOT_FOUND" });
    }
    let session;
    try { session = await resolveSession(request); }
    catch { return reply(401, { ok: false, code: "UNAUTHENTICATED" }); }
    if (!session || !/^[A-Za-z0-9_-]{1,128}$/.test(session.effectiveId || "") ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(session.actorId || "") ||
        typeof session.requestId !== "string" || !session.requestId) {
      return reply(401, { ok: false, code: "UNAUTHENTICATED" });
    }

    const cardId = match[1];
    const delegated = session.actorId !== session.effectiveId;
    const scopeId = session.scopeId || session.session?.scopeId || null;
    if (request.method === "GET") {
      if (delegated && !["read", "operate", "manage"].includes(session.scope)) {
        return reply(403, { ok: false, code: "SCOPE_INSUFFICIENT" });
      }
      const result = await service.get({ adminId: session.effectiveId, cardId });
      return reply(result.ok ? 200 : result.status || 403, result);
    }

    let body;
    try {
      const raw = await request.text();
      if (new TextEncoder().encode(raw).byteLength > 16_384) {
        return reply(413, { ok: false, code: "REQUEST_TOO_LARGE" });
      }
      body = JSON.parse(raw);
    } catch {
      return reply(400, { ok: false, code: "INVALID_JSON" });
    }
    if (!body || !Array.isArray(body.groupIds)) {
      return reply(400, { ok: false, code: "INVALID_GROUP_IDS" });
    }
    if (delegated && (!["operate", "manage"].includes(session.scope) ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(scopeId || ""))) {
      return reply(403, { ok: false, code: "SCOPE_INSUFFICIENT" });
    }
    const idempotencyKey = request.headers.get("idempotency-key")?.trim() || "";
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
      return reply(400, { ok: false, code: "IDEMPOTENCY_KEY_REQUIRED" });
    }
    const result = await service.replace({
      adminId: session.effectiveId,
      actorId: session.actorId,
      scope: session.scope || null,
      scopeId,
      isSuperAdmin: session.isSuperAdmin === true,
      idempotencyKey,
      requestId: session.requestId,
      cardId,
      groupIds: body.groupIds,
    });
    return reply(result.ok ? 200 : result.status || 403, result);
  };
}
