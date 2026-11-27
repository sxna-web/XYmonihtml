/**
 * Exact APP entitlement resolver (isolated DEV helper).
 * It never chooses "latest" and never trusts admin_user_id from the request.
 * D1 column names are limited to those already observed in the versioned Worker source.
 */
export async function resolveAppEntitlement({
  db, entitlementId, deviceId, token, verifyToken, now = new Date().toISOString(),
}) {
  if (!db || typeof db.prepare !== "function" || typeof verifyToken !== "function") {
    return { ok: false, code: "AUTH_UNAVAILABLE" };
  }
  if (typeof entitlementId !== "string" || !/^[A-Za-z0-9_-]{8,100}$/.test(entitlementId)) {
    return { ok: false, code: "BAD_ENTITLEMENT_ID" };
  }
  if (typeof deviceId !== "string" || !/^[A-Za-z0-9_-]{8,80}$/.test(deviceId)) {
    return { ok: false, code: "BAD_DEVICE_ID" };
  }
  if (typeof token !== "string" || token.length < 16 || token.length > 512) {
    return { ok: false, code: "BAD_TOKEN" };
  }

  let row;
  try {
    row = await db.prepare(
      "SELECT id, admin_user_id, device_id, expires_at, status FROM app_entitlements WHERE id = ? AND device_id = ? LIMIT 1",
    ).bind(entitlementId, deviceId).first();
  } catch {
    return { ok: false, code: "ENTITLEMENT_STORE_UNAVAILABLE" };
  }
  if (!row) return { ok: false, code: "ENTITLEMENT_NOT_FOUND" };
  if (row.id !== entitlementId || row.device_id !== deviceId || typeof row.admin_user_id !== "string" || !row.admin_user_id) {
    return { ok: false, code: "ENTITLEMENT_BINDING_MISMATCH" };
  }
  if (row.status !== "active") return { ok: false, code: "ENTITLEMENT_INACTIVE" };

  const expiry = Date.parse(String(row.expires_at || "").replace(" ", "T") + (String(row.expires_at || "").includes("Z") || /[+-]\d\d:\d\d$/.test(String(row.expires_at || "")) ? "" : "Z"));
  const current = Date.parse(now);
  if (!Number.isFinite(expiry) || !Number.isFinite(current)) return { ok: false, code: "ENTITLEMENT_TIME_INVALID" };
  if (expiry <= current) return { ok: false, code: "ENTITLEMENT_EXPIRED" };

  let valid = false;
  try { valid = await verifyToken(row.id, row.device_id, token) === true; } catch { valid = false; }
  if (!valid) return { ok: false, code: "BAD_TOKEN" };

  return {
    ok: true,
    entitlement: {
      id: row.id,
      admin_user_id: row.admin_user_id,
      device_id: row.device_id,
      expires_at: row.expires_at,
    },
  };
}
