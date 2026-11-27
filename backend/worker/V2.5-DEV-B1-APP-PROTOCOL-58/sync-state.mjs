/**
 * Generation / tombstone / acknowledgement / lease primitives.
 * Pure functions only; persistence and Android scheduling are out of scope.
 */
const HARD_MAX_LEASE_SECONDS = 23 * 60 * 60;

export function nextGeneration(currentGeneration) {
  if (!Number.isSafeInteger(currentGeneration) || currentGeneration < 0) return { ok: false, code: "INVALID_CURRENT_GENERATION" };
  if (currentGeneration >= Number.MAX_SAFE_INTEGER) return { ok: false, code: "GENERATION_EXHAUSTED" };
  return { ok: true, generation: currentGeneration + 1 };
}

export function acceptGeneration({ currentGeneration, incomingGeneration }) {
  if (!Number.isSafeInteger(currentGeneration) || currentGeneration < 0 ||
      !Number.isSafeInteger(incomingGeneration) || incomingGeneration < 1) return { accepted: false, code: "INVALID_GENERATION" };
  if (incomingGeneration <= currentGeneration) return { accepted: false, code: "STALE_OR_DUPLICATE_GENERATION" };
  return { accepted: true, generation: incomingGeneration };
}

export function createTombstone({ eventId, entitlementId, groupId, generation, reason, createdAt }) {
  if (![eventId, entitlementId, groupId, reason].every(v => typeof v === "string" && v.length > 0) ||
      !Number.isSafeInteger(generation) || generation < 1 || !Number.isFinite(Date.parse(createdAt || ""))) {
    return { ok: false, code: "INVALID_TOMBSTONE" };
  }
  return { ok: true, event: { eventId, entitlementId, groupId, generation, type: "REVOKE_GROUP", reason, createdAt } };
}

export function applyTombstone({ localGeneration = 0, event, localState = "ACTIVE" }) {
  if (!event || event.type !== "REVOKE_GROUP" || !Number.isSafeInteger(event.generation) ||
      event.generation < 1 || typeof event.eventId !== "string" || typeof event.groupId !== "string") {
    return { applied: false, code: "INVALID_SYNC_EVENT", state: localState, generation: localGeneration };
  }
  if (event.generation <= localGeneration) {
    return { applied: false, idempotent: true, code: "STALE_OR_DUPLICATE_EVENT", state: localState, generation: localGeneration };
  }
  return { applied: true, state: "REVOKED", generation: event.generation, stopUsingGroupImmediately: true, deleteLocalGroupNodes: true, ackRequired: true, eventId: event.eventId };
}

export function acceptAcknowledgement({ expectedEvent, ack, currentGeneration }) {
  if (!expectedEvent || !ack || typeof expectedEvent.eventId !== "string" ||
      typeof ack.eventId !== "string" || typeof expectedEvent.entitlementId !== "string" ||
      typeof expectedEvent.groupId !== "string") return { accepted: false, code: "INVALID_ACK" };
  if (ack.eventId !== expectedEvent.eventId || ack.entitlementId !== expectedEvent.entitlementId ||
      ack.groupId !== expectedEvent.groupId || ack.generation !== expectedEvent.generation) {
    return { accepted: false, code: "ACK_SCOPE_MISMATCH" };
  }
  if (!Number.isSafeInteger(currentGeneration) || currentGeneration < expectedEvent.generation) {
    return { accepted: false, code: "ACK_GENERATION_NOT_CURRENT" };
  }
  if (!["applied", "removed", "failed"].includes(ack.result)) return { accepted: false, code: "INVALID_ACK_RESULT" };
  if (ack.result !== "removed" && expectedEvent.type === "REVOKE_GROUP") return { accepted: false, code: "TOMBSTONE_REQUIRES_REMOVED_ACK" };
  return { accepted: true, result: ack.result, generation: ack.generation };
}

export function isLeaseValid({ leaseExpiresAt, serverNow }) {
  const expiry = Date.parse(leaseExpiresAt || "");
  const now = Date.parse(serverNow || "");
  if (!Number.isFinite(expiry) || !Number.isFinite(now)) return { valid: false, code: "LEASE_TIME_INVALID", failClosed: true };
  if (expiry <= now) return { valid: false, code: "LEASE_EXPIRED", failClosed: true };
  return { valid: true, expiresAt: new Date(expiry).toISOString() };
}

export function issueLease({ serverNow, requestedTtlSeconds, maxTtlSeconds = HARD_MAX_LEASE_SECONDS }) {
  const now = Date.parse(serverNow || "");
  if (!Number.isFinite(now) || !Number.isSafeInteger(requestedTtlSeconds) || requestedTtlSeconds < 1 ||
      !Number.isSafeInteger(maxTtlSeconds) || maxTtlSeconds < 1) return { ok: false, code: "INVALID_LEASE_INPUT" };
  const ttl = Math.min(requestedTtlSeconds, maxTtlSeconds, HARD_MAX_LEASE_SECONDS);
  return { ok: true, ttlSeconds: ttl, leaseExpiresAt: new Date(now + ttl * 1000).toISOString() };
}
