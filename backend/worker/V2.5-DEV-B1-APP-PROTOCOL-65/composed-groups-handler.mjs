import { COMPOSED_GROUP_LIMITS } from "./composed-group-service.mjs";

const HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

function reply(status, body) {
  return new Response(JSON.stringify(body), { status, headers: HEADERS });
}

export function createComposedGroupsHandler({ composeGroups }) {
  if (typeof composeGroups !== "function") throw new TypeError("Missing composeGroups dependency");

  return async function handle(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/api/app/v2/groups/composed" || request.method !== "POST") {
      return reply(404, { ok: false, code: "NOT_FOUND" });
    }
    const deviceId = request.headers.get("x-app-device-id") || "";
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(deviceId)) {
      return reply(401, { ok: false, code: "DEVICE_ID_REQUIRED" });
    }

    let raw;
    try {
      raw = await request.text();
    } catch {
      return reply(400, { ok: false, code: "INVALID_REQUEST_BODY" });
    }
    if (new TextEncoder().encode(raw).byteLength > COMPOSED_GROUP_LIMITS.maxRequestBytes) {
      return reply(413, { ok: false, code: "REQUEST_TOO_LARGE" });
    }

    let body;
    try { body = JSON.parse(raw); }
    catch { return reply(400, { ok: false, code: "INVALID_JSON" }); }
    if (!body || !Array.isArray(body.credentials) ||
        body.credentials.length < 1 ||
        body.credentials.length > COMPOSED_GROUP_LIMITS.maxEntitlements) {
      return reply(400, { ok: false, code: "INVALID_CREDENTIALS" });
    }

    let result;
    try {
      result = await composeGroups({ deviceId, credentials: body.credentials });
    } catch {
      return reply(503, { ok: false, code: "GROUP_COMPOSITION_UNAVAILABLE" });
    }
    if (!result || result.ok !== true || !Array.isArray(result.groups)) {
      return reply(403, { ok: false, code: result?.code || "GROUP_COMPOSITION_DENIED" });
    }
    return reply(200, {
      ok: true,
      groups: result.groups,
      entitlementCount: result.entitlementCount,
    });
  };
}
