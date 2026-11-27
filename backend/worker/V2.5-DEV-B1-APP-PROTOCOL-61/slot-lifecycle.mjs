const OCCUPYING = new Set(["ACTIVE", "GRANDFATHERED", "HELD_EXPIRED", "HELD_REVOKED", "RELEASE_PENDING"]);

/**
 * Pure planning helper. Input rows must already be normalized from a reviewed
 * legacy schema; this module does not guess D1 column names or execute SQL.
 */
export function planSlotBackfill({ entitlements, limits = {}, now }) {
  if (!Array.isArray(entitlements) || !Number.isFinite(Date.parse(now))) {
    return { ok: false, code: "BACKFILL_INPUT_INVALID", slots: [], conflicts: [], cards: [] };
  }
  const byKey = new Map();
  const conflicts = [];
  for (const row of entitlements) {
    if (!row || typeof row.cardId !== "string" || !row.cardId.trim()) {
      conflicts.push({ reason: "CARD_ID_MISSING" });
      continue;
    }
    if (row.state !== "ACTIVE" && row.state !== "INACTIVE") {
      conflicts.push({ cardId: row.cardId, reason: "ENTITLEMENT_STATE_UNKNOWN" });
      continue;
    }
    if (row.state !== "ACTIVE") continue;
    if (typeof row.deviceKey !== "string" || !row.deviceKey.trim()) {
      conflicts.push({ cardId: row.cardId, reason: "ACTIVE_DEVICE_KEY_MISSING" });
      continue;
    }
    const expiry = Date.parse(row.expiresAt);
    if (!Number.isFinite(expiry)) {
      conflicts.push({ cardId: row.cardId, deviceKey: row.deviceKey, reason: "ACTIVE_EXPIRY_INVALID" });
      continue;
    }
    if (expiry <= Date.parse(now)) continue;
    const key = row.cardId + "\u0000" + row.deviceKey;
    const existing = byKey.get(key);
    if (existing) {
      existing.sourceEntitlementIds.push(String(row.entitlementId || ""));
      continue;
    }
    byKey.set(key, {
      cardId: row.cardId,
      deviceKey: row.deviceKey,
      status: "ACTIVE",
      sourceEntitlementIds: [String(row.entitlementId || "")]
    });
  }
  const counts = new Map();
  for (const slot of byKey.values()) counts.set(slot.cardId, (counts.get(slot.cardId) || 0) + 1);
  const cards = [];
  for (const [cardId, count] of counts) {
    const rawLimit = limits[cardId];
    const limit = Number.isInteger(rawLimit) && rawLimit >= 1 ? rawLimit : 1;
    const overCapacity = count > limit;
    cards.push({ cardId, existingDeviceCount: count, configuredLimit: limit, overCapacity, newReservationsAllowed: !overCapacity });
    if (overCapacity) {
      for (const slot of byKey.values()) if (slot.cardId === cardId) slot.status = "GRANDFATHERED";
    }
  }
  return { ok: conflicts.length === 0, code: conflicts.length ? "BACKFILL_REQUIRES_REVIEW" : "BACKFILL_PLAN_READY", slots: [...byKey.values()], conflicts, cards };
}

export function transitionSlot({ slot, event, approval = null }) {
  if (!slot || typeof slot.cardId !== "string" || typeof slot.deviceKey !== "string") {
    return { ok: false, code: "SLOT_INPUT_INVALID", slot: null };
  }
  const current = slot.status;
  if (!OCCUPYING.has(current) && current !== "RELEASED") {
    return { ok: false, code: "SLOT_STATUS_INVALID", slot };
  }
  if (event === "CARD_RENEWED" || event === "ADMIN_VIP_EXPIRED" || event === "ADMIN_VIP_RESTORED") {
    if (current === "RELEASED") return { ok: false, code: "RELEASED_SLOT_REQUIRES_NEW_APPROVED_RESERVATION", slot };
    return { ok: true, code: "SLOT_RETAINED", slot: { ...slot, status: current } };
  }
  if (event === "CARD_EXPIRED") {
    if (current === "RELEASED") return { ok: true, code: "ALREADY_RELEASED", slot };
    return { ok: true, code: "SLOT_HELD_FOR_REVIEW", slot: { ...slot, status: "HELD_EXPIRED" } };
  }
  if (event === "CARD_REVOKED" || event === "ENTITLEMENT_REVOKED") {
    if (current === "RELEASED") return { ok: true, code: "ALREADY_RELEASED", slot };
    return { ok: true, code: "SLOT_HELD_FOR_REVIEW", slot: { ...slot, status: "HELD_REVOKED" } };
  }
  if (event === "DEVICE_RELEASE_REQUESTED") {
    if (current === "RELEASED") return { ok: true, code: "ALREADY_RELEASED", slot };
    return { ok: true, code: "RELEASE_APPROVAL_REQUIRED", slot: { ...slot, status: "RELEASE_PENDING" } };
  }
  if (event === "DEVICE_RELEASE_APPROVED") {
    if (current === "RELEASED") return { ok: true, code: "ALREADY_RELEASED", slot };
    if (!approval || approval.approved !== true || typeof approval.approverId !== "string" || !approval.approverId.trim() || typeof approval.reason !== "string" || !approval.reason.trim()) {
      return { ok: false, code: "RELEASE_APPROVAL_INVALID", slot };
    }
    return { ok: true, code: "SLOT_RELEASED", slot: { ...slot, status: "RELEASED", releasedAt: approval.releasedAt || null, releaseReason: approval.reason.trim(), releasedBy: approval.approverId.trim() } };
  }
  return { ok: false, code: "SLOT_EVENT_UNSUPPORTED", slot };
}

export function slotCountsTowardLimit(status) {
  return OCCUPYING.has(status);
}
