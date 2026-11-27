import { resolveAppEntitlement } from "../V2.5-DEV-B1-APP-TOKEN-52/entitlement-resolver.mjs";

function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const aa = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  let diff = aa.length ^ bb.length;
  const length = Math.max(aa.length, bb.length);
  for (let i = 0; i < length; i++) diff |= (aa[i] || 0) ^ (bb[i] || 0);
  return diff === 0;
}

export async function createEntitlementTokenVerifier(secret) {
  if (typeof secret !== "string" || secret.length < 32) return null;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return async (entitlementId, deviceId, token) => {
    if (typeof token !== "string") return false;
    const signature = await crypto.subtle.sign(
      "HMAC", key, new TextEncoder().encode(`${entitlementId}|${deviceId}`),
    );
    return constantTimeEqual(token, toBase64Url(new Uint8Array(signature)));
  };
}

/**
 * Isolated adapter: APP entitlement bearer is NOT a user Session token.
 * Uses dedicated APP_ENTITLEMENT_SECRET only; no SESSION_PEPPER/fixed fallback.
 */
export function createEntitlementTokenAdapter({ db, env, now }) {
  const secret = env?.APP_ENTITLEMENT_SECRET;
  if (typeof secret !== "string" || secret.length < 32) {
    return async () => ({ ok: false, code: "ENTITLEMENT_SECRET_UNAVAILABLE" });
  }
  return async ({ entitlementId, deviceId, token }) => {
    let verifyToken;
    try { verifyToken = await createEntitlementTokenVerifier(secret); }
    catch { return { ok: false, code: "TOKEN_VERIFIER_UNAVAILABLE" }; }
    if (!verifyToken) return { ok: false, code: "ENTITLEMENT_SECRET_UNAVAILABLE" };
    return resolveAppEntitlement({ db, entitlementId, deviceId, token, verifyToken, ...(now ? { now } : {}) });
  };
}

export { constantTimeEqual };
