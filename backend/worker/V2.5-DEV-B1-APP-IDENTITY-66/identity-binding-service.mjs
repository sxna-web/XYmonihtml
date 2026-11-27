const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const DEVICE_RE = /^[A-Za-z0-9_-]{8,80}$/;
const CODE_RE = /^[A-Z0-9]{4,12}$/;
const MAX_IDENTITY_CREDENTIALS = 20;

function fail(code) { return { ok: false, code }; }
function validEligibility(value) {
  return !!value && value.accountActive === true &&
    value.activeVipAdmin === true && value.freeGroupEnabled === true;
}
function validCodeRecord(record) {
  return !!record && record.active === true &&
    ID_RE.test(record.adminUserId || "") &&
    (Number.isSafeInteger(record.codeVersion) && record.codeVersion > 0);
}
function validGroup(group, adminUserId) {
  return !!group && ID_RE.test(group.id || "") &&
    group.adminUserId === adminUserId && group.mode === "free" &&
    group.enabled === true && typeof group.name === "string" && group.name.trim().length > 0;
}

export function createIdentityBindingService({
  lookupShareCode,
  checkAdminEligibility,
  consumeRateLimit,
  verifyAndConsumeChallenge,
  getOrCreateBinding,
  loadBinding,
  loadFreeGroups,
  identityTokenAdapter,
  now = () => Date.now(),
}) {
  const deps = {
    lookupShareCode, checkAdminEligibility, consumeRateLimit,
    verifyAndConsumeChallenge, getOrCreateBinding, loadBinding, loadFreeGroups,
  };
  for (const [name, fn] of Object.entries(deps)) {
    if (typeof fn !== "function") throw new TypeError(`Missing identity service dependency: ${name}`);
  }
  if (!identityTokenAdapter || typeof identityTokenAdapter.issue !== "function" ||
      typeof identityTokenAdapter.verify !== "function") {
    throw new TypeError("Missing identityTokenAdapter");
  }

  async function rateLimit(action, key) {
    try {
      const result = await consumeRateLimit({ action, key });
      return result === true || result?.ok === true;
    } catch {
      return false;
    }
  }

  async function lookupEligibleCode(rawCode) {
    const code = String(rawCode || "").trim().toUpperCase();
    if (!CODE_RE.test(code)) return null;
    let record;
    try { record = await lookupShareCode(code); } catch { return null; }
    if (!validCodeRecord(record)) return null;
    let eligibility;
    try { eligibility = await checkAdminEligibility(record.adminUserId); } catch { return null; }
    if (!validEligibility(eligibility)) return null;
    return { code, record, eligibility };
  }

  async function discover({ shareCode, deviceId, rateLimitKey }) {
    if (!DEVICE_RE.test(deviceId || "") || typeof rateLimitKey !== "string" || !rateLimitKey) {
      return fail("IDENTITY_REQUEST_INVALID");
    }
    if (!(await rateLimit("identity-discover", rateLimitKey))) return fail("RATE_LIMITED");
    const found = await lookupEligibleCode(shareCode);
    if (!found) return fail("IDENTITY_NOT_AVAILABLE");
    return {
      ok: true,
      discovery: {
        adminDisplayName: typeof found.eligibility.adminDisplayName === "string"
          ? found.eligibility.adminDisplayName.slice(0, 80) : "",
        freeGroupAvailable: true,
      },
    };
  }

  async function bind({ shareCode, deviceId, challengeId, proof, rateLimitKey }) {
    if (!DEVICE_RE.test(deviceId || "") || !ID_RE.test(challengeId || "") ||
        typeof proof !== "string" || proof.length < 16 || proof.length > 2048 ||
        typeof rateLimitKey !== "string" || !rateLimitKey) {
      return fail("IDENTITY_REQUEST_INVALID");
    }
    if (!(await rateLimit("identity-bind", rateLimitKey))) return fail("RATE_LIMITED");
    const found = await lookupEligibleCode(shareCode);
    if (!found) return fail("IDENTITY_NOT_AVAILABLE");

    let verified;
    try {
      verified = await verifyAndConsumeChallenge({
        challengeId, proof, deviceId,
        adminUserId: found.record.adminUserId,
        codeVersion: found.record.codeVersion,
      });
    } catch {
      return fail("IDENTITY_PROOF_UNAVAILABLE");
    }
    if (!verified || verified.ok !== true ||
        !ID_RE.test(verified.deviceKeyThumbprint || "")) {
      return fail("IDENTITY_DEVICE_PROOF_INVALID");
    }

    let binding;
    try {
      binding = await getOrCreateBinding({
        adminUserId: found.record.adminUserId,
        deviceId,
        deviceKeyThumbprint: verified.deviceKeyThumbprint,
        shareCodeVersion: found.record.codeVersion,
      });
    } catch {
      return fail("IDENTITY_BINDING_UNAVAILABLE");
    }
    if (!binding || binding.status !== "active" ||
        !ID_RE.test(binding.bindingId || "") ||
        binding.adminUserId !== found.record.adminUserId ||
        binding.deviceId !== deviceId ||
        binding.deviceKeyThumbprint !== verified.deviceKeyThumbprint) {
      return fail("IDENTITY_BINDING_CONFLICT");
    }

    const token = await identityTokenAdapter.issue({
      bindingId: binding.bindingId,
      adminUserId: binding.adminUserId,
      deviceId: binding.deviceId,
    });
    if (typeof token !== "string" || !token) return fail("IDENTITY_TOKEN_ISSUE_FAILED");
    return { ok: true, bindingId: binding.bindingId, token };
  }

  async function resolveCredential({ token, deviceId }) {
    if (!DEVICE_RE.test(deviceId || "") || typeof token !== "string" || !token) {
      return fail("IDENTITY_CREDENTIAL_INVALID");
    }
    let claims;
    try { claims = await identityTokenAdapter.verify({ token, deviceId }); }
    catch { return fail("IDENTITY_CREDENTIAL_INVALID"); }
    if (!claims || !ID_RE.test(claims.bindingId || "") ||
        !ID_RE.test(claims.adminUserId || "") || claims.deviceId !== deviceId) {
      return fail("IDENTITY_CREDENTIAL_INVALID");
    }

    let binding;
    try { binding = await loadBinding(claims.bindingId); }
    catch { return fail("IDENTITY_BINDING_UNAVAILABLE"); }
    if (!binding || binding.status !== "active" ||
        binding.bindingId !== claims.bindingId ||
        binding.adminUserId !== claims.adminUserId ||
        binding.deviceId !== deviceId) return fail("IDENTITY_BINDING_REVOKED_OR_MISMATCHED");

    let eligibility;
    try { eligibility = await checkAdminEligibility(binding.adminUserId); }
    catch { return fail("IDENTITY_ADMIN_STATUS_UNAVAILABLE"); }
    if (!validEligibility(eligibility)) return fail("IDENTITY_FREE_GROUP_NOT_AUTHORIZED");

    return {
      ok: true,
      context: Object.freeze({
        kind: "IDENTITY",
        bindingId: binding.bindingId,
        adminUserId: binding.adminUserId,
        deviceId,
      }),
    };
  }

  async function resolveManyAndLoadFreeGroups({ credentials, deviceId, rateLimitKey }) {
    if (!Array.isArray(credentials) || credentials.length < 1 ||
        credentials.length > MAX_IDENTITY_CREDENTIALS ||
        !DEVICE_RE.test(deviceId || "")) return fail("IDENTITY_CREDENTIALS_INVALID");

    const contexts = [];
    const seenBindings = new Set();
    for (const credential of credentials) {
      if (!credential || typeof credential.token !== "string") return fail("IDENTITY_CREDENTIALS_INVALID");
      if (!(await rateLimit("identity-resolve", rateLimitKey || deviceId))) return fail("RATE_LIMITED");
      const resolved = await resolveCredential({ token: credential.token, deviceId });
      if (!resolved.ok) return resolved;
      if (!seenBindings.has(resolved.context.bindingId)) {
        seenBindings.add(resolved.context.bindingId);
        contexts.push(resolved.context);
      }
    }

    const admins = new Map();
    for (const context of contexts) admins.set(context.adminUserId, context);
    const groups = [];
    const seenGroupIds = new Map();
    for (const [adminUserId] of admins) {
      let rows;
      try { rows = await loadFreeGroups(adminUserId); }
      catch { return fail("IDENTITY_GROUPS_UNAVAILABLE"); }
      if (!Array.isArray(rows)) return fail("IDENTITY_GROUPS_UNAVAILABLE");
      for (const group of rows) {
        if (!validGroup(group, adminUserId)) return fail("IDENTITY_GROUP_SCOPE_MISMATCH");
        const key = adminUserId + "\u0000" + group.id;
        const previous = seenGroupIds.get(key);
        if (previous && (previous.name !== group.name.trim() || previous.mode !== group.mode)) {
          return fail("IDENTITY_GROUP_ID_COLLISION");
        }
        if (!previous) {
          const projected = {
            id: group.id, name: group.name.trim(), displayName: group.name.trim(),
            adminUserId, mode: "free", enabled: true, origin: "FREE",
          };
          seenGroupIds.set(key, projected);
          groups.push(projected);
        }
      }
    }
    return { ok: true, contexts, groups };
  }

  return Object.freeze({ discover, bind, resolveCredential, resolveManyAndLoadFreeGroups });
}

export function mergeIdentityFreeGroupsWithCardComposition({ cardComposition, identityFreeGroups }) {
  if (!cardComposition || cardComposition.ok !== true || !Array.isArray(cardComposition.groups) ||
      !Array.isArray(identityFreeGroups)) return fail("IDENTITY_CARD_COMPOSITION_INVALID");
  const output = cardComposition.groups.map(group => ({ ...group }));
  const freeByKey = new Map();
  for (const group of output) {
    if (group.origin !== "FREE") continue;
    if (!ID_RE.test(group.id || "") || !ID_RE.test(group.adminUserId || "")) {
      return fail("IDENTITY_CARD_COMPOSITION_INVALID");
    }
    const key = group.adminUserId + "\u0000" + group.id;
    freeByKey.set(key, group);
  }
  for (const group of identityFreeGroups) {
    if (!group || group.origin !== "FREE" || !ID_RE.test(group.id || "") ||
        !ID_RE.test(group.adminUserId || "") || group.mode !== "free" ||
        group.enabled !== true || typeof group.name !== "string" || !group.name.trim()) {
      return fail("IDENTITY_CARD_COMPOSITION_INVALID");
    }
    const key = group.adminUserId + "\u0000" + group.id;
    const previous = freeByKey.get(key);
    if (previous) {
      if (previous.name !== group.name.trim()) return fail("IDENTITY_GROUP_ID_COLLISION");
      continue;
    }
    const projected = {
      id: group.id, name: group.name.trim(), adminUserId: group.adminUserId,
      mode: "free", enabled: true, origin: "FREE", displayName: group.name.trim(),
    };
    freeByKey.set(key, projected);
    output.push(projected);
  }
  return { ok: true, groups: output };
}

export const IDENTITY_BINDING_LIMITS = Object.freeze({
  maxCredentials: MAX_IDENTITY_CREDENTIALS,
  identityTokenMaxTtlSeconds: 23 * 60 * 60,
});
