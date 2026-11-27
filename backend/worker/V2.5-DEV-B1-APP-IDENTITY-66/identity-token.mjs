const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const DEVICE_RE = /^[A-Za-z0-9_-]{8,80}$/;
const MAX_TTL_SECONDS = 23 * 60 * 60;

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function base64UrlToBytes(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid base64url");
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(base64);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}
function encodeJson(value) {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}
function decodeJson(value) {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(value)));
}

export function createIdentityTokenAdapter({
  secret,
  cryptoImpl = globalThis.crypto,
  now = () => Date.now(),
  ttlSeconds = 60 * 60,
} = {}) {
  const secretValid = typeof secret === "string" &&
    new TextEncoder().encode(secret).byteLength >= 32;
  const ttlValid = Number.isInteger(ttlSeconds) && ttlSeconds > 0 && ttlSeconds <= MAX_TTL_SECONDS;
  let keyPromise;

  async function key() {
    if (!secretValid || !cryptoImpl?.subtle) throw new Error("identity secret unavailable");
    if (!keyPromise) keyPromise = cryptoImpl.subtle.importKey(
      "raw", new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"],
    );
    return keyPromise;
  }

  return Object.freeze({
    async issue({ bindingId, adminUserId, deviceId }) {
      if (!secretValid || !ttlValid || !ID_RE.test(bindingId || "") ||
          !ID_RE.test(adminUserId || "") || !DEVICE_RE.test(deviceId || "")) return null;
      try {
        const issuedAt = Math.floor(now() / 1000);
        const claims = {
          v: 1, bindingId, adminUserId, deviceId,
          issuedAt, expiresAt: issuedAt + ttlSeconds,
        };
        const payload = encodeJson(claims);
        const signature = await cryptoImpl.subtle.sign(
          "HMAC", await key(), new TextEncoder().encode(payload),
        );
        return payload + "." + bytesToBase64Url(new Uint8Array(signature));
      } catch {
        return null;
      }
    },

    async verify({ token, deviceId }) {
      if (!secretValid || !ttlValid || typeof token !== "string" ||
          token.length > 2048 || !DEVICE_RE.test(deviceId || "")) return null;
      try {
        const parts = token.split(".");
        if (parts.length !== 2) return null;
        const [payload, signature] = parts;
        const valid = await cryptoImpl.subtle.verify(
          "HMAC", await key(), base64UrlToBytes(signature),
          new TextEncoder().encode(payload),
        );
        if (!valid) return null;
        const claims = decodeJson(payload);
        const current = Math.floor(now() / 1000);
        if (!claims || claims.v !== 1 ||
            !ID_RE.test(claims.bindingId || "") ||
            !ID_RE.test(claims.adminUserId || "") ||
            claims.deviceId !== deviceId ||
            !Number.isInteger(claims.issuedAt) ||
            !Number.isInteger(claims.expiresAt) ||
            claims.issuedAt > current + 60 ||
            claims.expiresAt <= current ||
            claims.expiresAt <= claims.issuedAt ||
            claims.expiresAt - claims.issuedAt > MAX_TTL_SECONDS) return null;
        return Object.freeze({
          bindingId: claims.bindingId,
          adminUserId: claims.adminUserId,
          deviceId: claims.deviceId,
          issuedAt: claims.issuedAt,
          expiresAt: claims.expiresAt,
        });
      } catch {
        return null;
      }
    },
  });
}
