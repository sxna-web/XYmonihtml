/**
 * Pure authorization decision helpers for StarJump V2.5.
 * Not wired into Worker routes yet; caller must authenticate session and verify resource ownership.
 */
const SCOPE_RANK = Object.freeze({ read: 1, operate: 2, manage: 3 });
const ACTIVE_WRITE_ACTIONS = new Set(['create', 'update', 'associate', 'disable', 'generate']);

function parseTime(value) {
  if (typeof value !== 'string' || !value.trim()) return NaN;
  return Date.parse(value);
}

export function classifyVip(activations, now = new Date().toISOString()) {
  if (activations === null || activations === undefined || activations?.unavailable === true) {
    return { state: 'unavailable', active: false, kind: null, formalCutoff: null };
  }
  if (!Array.isArray(activations)) {
    return { state: 'unavailable', active: false, kind: null, formalCutoff: null };
  }
  const nowMs = parseTime(now);
  if (!Number.isFinite(nowMs)) {
    return { state: 'unavailable', active: false, kind: null, formalCutoff: null };
  }
  const normalized = [];
  for (const row of activations) {
    if (!row || !['trial', 'formal'].includes(row.kind)) {
      return { state: 'unavailable', active: false, kind: null, formalCutoff: null };
    }
    const start = parseTime(row.starts_at);
    const end = parseTime(row.ends_at);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      return { state: 'unavailable', active: false, kind: null, formalCutoff: null };
    }
    normalized.push({ kind: row.kind, start, end });
  }
  const activeFormal = normalized.filter(x => x.kind === 'formal' && x.start <= nowMs && x.end > nowMs);
  if (activeFormal.length) {
    return { state: 'active_formal', active: true, kind: 'formal', formalCutoff: null,
      until: new Date(Math.max(...activeFormal.map(x => x.end))).toISOString() };
  }
  const activeTrial = normalized.filter(x => x.kind === 'trial' && x.start <= nowMs && x.end > nowMs);
  if (activeTrial.length) {
    return { state: 'active_trial', active: true, kind: 'trial', formalCutoff: null,
      until: new Date(Math.max(...activeTrial.map(x => x.end))).toISOString() };
  }
  const expiredFormal = normalized.filter(x => x.kind === 'formal' && x.end <= nowMs);
  if (expiredFormal.length) {
    const cutoff = Math.max(...expiredFormal.map(x => x.end));
    return { state: 'expired_formal', active: false, kind: 'formal',
      formalCutoff: new Date(cutoff).toISOString() };
  }
  const expiredTrial = normalized.filter(x => x.kind === 'trial' && x.end <= nowMs);
  if (expiredTrial.length) {
    return { state: 'expired_trial', active: false, kind: 'trial', formalCutoff: null };
  }
  if (normalized.length) return { state: 'pending', active: false, kind: null, formalCutoff: null };
  return { state: 'none', active: false, kind: null, formalCutoff: null };
}

function requiredScope(action) {
  if (action === 'read') return 'read';
  if (action === 'delete_history') return 'manage';
  if (ACTIVE_WRITE_ACTIONS.has(action) || action === 'advanced_filters') return 'operate';
  return null;
}

function scopeAllows(granted, required) {
  return !required || (SCOPE_RANK[granted] || 0) >= (SCOPE_RANK[required] || 99);
}

/**
 * Decide VIP/action gate only. Authentication, ownership, tenant isolation and CSRF are caller responsibilities.
 * Input: {actorId,effectiveId,isSuperAdmin,action,scope,vipActivations,now,resourceOwned,resourceCreatedAt}
 */
export function decideActionAccess(input) {
  const x = input || {};
  if (!x.actorId || !x.effectiveId) return { allowed: false, code: 'UNAUTHENTICATED' };
  const assisting = x.actorId !== x.effectiveId;
  const directSuper = x.isSuperAdmin === true && !assisting;
  const needed = requiredScope(x.action);
  if (directSuper) return { allowed: true, code: 'SUPER_ADMIN', vipState: 'bypassed' };
  if (assisting && !scopeAllows(x.scope, needed)) {
    return { allowed: false, code: 'ASSIST_SCOPE_DENIED', requiredScope: needed };
  }
  if (x.action === 'basic_convert' || x.action === 'read') {
    return { allowed: true, code: 'BASIC_ACCESS' };
  }
  const vip = classifyVip(x.vipActivations, x.now);
  if (vip.state === 'unavailable') return { allowed: false, code: 'VIP_STATUS_UNAVAILABLE', vipState: vip.state };
  if (ACTIVE_WRITE_ACTIONS.has(x.action) || x.action === 'advanced_filters') {
    if (vip.active) return { allowed: true, code: 'ACTIVE_VIP', vipState: vip.state };
    return { allowed: false, code: 'VIP_REQUIRED', vipState: vip.state };
  }
  if (x.action === 'delete_history') {
    if (!x.resourceOwned) return { allowed: false, code: 'RESOURCE_NOT_OWNED', vipState: vip.state };
    if (vip.active) return { allowed: true, code: 'ACTIVE_VIP_HISTORY_DELETE', vipState: vip.state };
    if (vip.state !== 'expired_formal') return { allowed: false, code: 'HISTORY_DELETE_NOT_ALLOWED', vipState: vip.state };
    const created = parseTime(x.resourceCreatedAt);
    const cutoff = parseTime(vip.formalCutoff);
    if (!Number.isFinite(created) || !Number.isFinite(cutoff) || created > cutoff) {
      return { allowed: false, code: 'RESOURCE_AFTER_VIP_EXPIRY', vipState: vip.state };
    }
    return { allowed: true, code: 'EXPIRED_FORMAL_HISTORY_DELETE', vipState: vip.state };
  }
  return { allowed: false, code: 'UNKNOWN_ACTION' };
}
