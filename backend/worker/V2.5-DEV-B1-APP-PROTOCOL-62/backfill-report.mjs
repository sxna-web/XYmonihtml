import { planSlotBackfill } from "../V2.5-DEV-B1-APP-PROTOCOL-61/slot-lifecycle.mjs";

/**
 * Builds a redacted, deterministic dry-run report from normalized rows.
 * It never connects to D1, executes SQL, or treats caller-supplied schema
 * assertions as proof of a real database environment.
 */
export function buildBackfillDryRunReport({ rows, limits = {}, now }) {
  const plan = planSlotBackfill({ entitlements: rows, limits, now });
  if (!plan || !Array.isArray(rows)) {
    return { ok: false, status: "INPUT_INVALID", schemaStatus: "UNVERIFIED", sqlExecuted: false, migrationCreated: false };
  }
  const activeCandidateRows = rows.filter(row =>
    row && row.state === "ACTIVE" &&
    typeof row.cardId === "string" && row.cardId.trim() &&
    typeof row.deviceKey === "string" && row.deviceKey.trim() &&
    Number.isFinite(Date.parse(row.expiresAt)) && Date.parse(row.expiresAt) > Date.parse(now)
  ).length;
  const conflictCounts = {};
  for (const conflict of plan.conflicts) conflictCounts[conflict.reason] = (conflictCounts[conflict.reason] || 0) + 1;
  return {
    ok: plan.ok,
    status: plan.ok ? "READY_FOR_SCHEMA_REVIEW" : "REVIEW_REQUIRED",
    schemaStatus: "UNVERIFIED",
    sqlExecuted: false,
    migrationCreated: false,
    approvalRequired: true,
    summary: {
      scannedRows: rows.length,
      activeCandidateRows,
      deduplicatedRows: Math.max(0, activeCandidateRows - plan.slots.length),
      plannedSlots: plan.slots.length,
      conflictCount: plan.conflicts.length,
      conflictCounts
    },
    cards: plan.cards.map(card => ({
      cardRef: card.cardId,
      existingDeviceCount: card.existingDeviceCount,
      configuredLimit: card.configuredLimit,
      overCapacity: card.overCapacity,
      newReservationsAllowed: card.newReservationsAllowed
    })),
    conflicts: plan.conflicts.map((conflict, index) => ({
      conflictNumber: index + 1,
      reason: conflict.reason
    }))
  };
}
