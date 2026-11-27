/**
 * Isolated D1/SQLite atomic device reservation contract.
 * Requires a future reviewed schema/migration; it is not wired to production.
 */
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export const RESERVE_CARD_DEVICE_SQL = `
INSERT INTO app_card_device_slots (card_id, device_id, created_at)
SELECT ?, ?, ?
WHERE (SELECT COUNT(*) FROM app_card_device_slots WHERE card_id = ?) < ?
ON CONFLICT(card_id, device_id) DO NOTHING
RETURNING card_id, device_id, created_at
`;

export const FIND_CARD_DEVICE_SQL = `
SELECT card_id, device_id, created_at
FROM app_card_device_slots
WHERE card_id = ? AND device_id = ?
LIMIT 1
`;

export async function reserveCardDeviceSlot(db, { cardId, deviceId, maxDevices = 1, now }) {
  if (!db || typeof db.prepare !== "function" || !ID_RE.test(cardId || "") ||
      !ID_RE.test(deviceId || "") || !Number.isSafeInteger(maxDevices) || maxDevices < 1 ||
      typeof now !== "string" || !Number.isFinite(Date.parse(now))) {
    return { ok: false, code: "INVALID_RESERVATION_INPUT" };
  }
  try {
    const inserted = await db.prepare(RESERVE_CARD_DEVICE_SQL)
      .bind(cardId, deviceId, now, cardId, maxDevices).first();
    if (inserted) return { ok: true, reserved: true, idempotent: false, row: inserted };
    const existing = await db.prepare(FIND_CARD_DEVICE_SQL).bind(cardId, deviceId).first();
    if (existing) return { ok: true, reserved: true, idempotent: true, row: existing };
    return { ok: false, code: "CARD_DEVICE_LIMIT_REACHED" };
  } catch {
    return { ok: false, code: "DEVICE_RESERVATION_UNAVAILABLE" };
  }
}
