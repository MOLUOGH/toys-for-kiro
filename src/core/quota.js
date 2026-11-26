// @ts-check
'use strict';

/**
 * @typedef {object} Bonus
 * @property {string} name
 * @property {number | null} used
 * @property {number | null} limit
 * @property {string | null} expiresAt
 * @property {string | null} status
 */

/**
 * @typedef {object} QuotaSnapshot
 * @property {string | null} plan
 * @property {boolean | null} overageEnabled
 * @property {number | null} used
 * @property {number | null} limit
 * @property {string | null} resetAt
 * @property {number | null} overageRate
 * @property {Bonus[]} bonuses
 * @property {number | null} updatedAt
 */

/** @param {unknown} v */
function n(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** @param {unknown} v */
function s(v) {
  return typeof v === 'string' && v ? v : null;
}

/**
 * Read Kiro's cached usage state (refreshed by Kiro every 5 minutes) from state.vscdb.
 * Read-only; returns null if the DB is missing or busy.
 * @param {string} dbPath
 */
function readUsageState(dbPath) {
  /** @type {any} */
  let db = null;
  try {
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare("SELECT value FROM ItemTable WHERE key = 'kiro.kiroAgent'").get();
    if (!row || row.value == null) return null;
    const raw = typeof row.value === 'string' ? row.value : Buffer.from(row.value).toString('utf8');
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v['kiro.resourceNotifications.usageState'] ?? null : null;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

/** @param {any} u @returns {QuotaSnapshot | null} */
function fromUsageState(u) {
  const list = Array.isArray(u?.usageBreakdowns) ? u.usageBreakdowns : [];
  const b = list.find((x) => x?.type === 'CREDIT') ?? list[0];
  if (!b) return null;
  return {
    plan: null,
    overageEnabled: null,
    used: n(b.currentUsage),
    limit: n(b.usageLimit),
    resetAt: s(b.resetDate),
    overageRate: n(b.overageRate),
    bonuses: (Array.isArray(b.bonuses) ? b.bonuses : []).map((x) => ({
      name: s(x?.displayName) ?? 'Bonus',
      used: n(x?.currentUsage),
      limit: n(x?.usageLimit),
      expiresAt: s(x?.expiryDate),
      status: s(x?.status),
    })),
    updatedAt: n(u.timestamp),
  };
}

/**
 * Normalize a GetUsageLimits response from q-client.log. Drops account identifiers.
 * @param {any} o @param {number} ts @returns {QuotaSnapshot | null}
 */
function fromUsageLimitsOutput(o, ts) {
  const list = Array.isArray(o?.usageBreakdownList) ? o.usageBreakdownList : [];
  const b = list.find((x) => x?.resourceType === 'CREDIT') ?? list[0];
  if (!b) return null;
  const status = s(o?.overageConfiguration?.overageStatus);
  return {
    plan: s(o?.subscriptionInfo?.subscriptionTitle),
    overageEnabled: status ? status === 'ENABLED' : null,
    used: n(b.currentUsageWithPrecision) ?? n(b.currentUsage),
    limit: n(b.usageLimitWithPrecision) ?? n(b.usageLimit),
    resetAt: s(b.nextDateReset) ?? s(o?.nextDateReset),
    overageRate: n(b.overageRate),
    bonuses: (Array.isArray(b.bonuses) ? b.bonuses : []).map((x) => ({
      name: s(x?.displayName) ?? 'Bonus',
      used: n(x?.currentUsage),
      limit: n(x?.usageLimit),
      expiresAt: s(x?.expiresAt),
      status: s(x?.status),
    })),
    updatedAt: ts,
  };
}

/**
 * Merge the state.vscdb cache and the latest logged API response: usage numbers
 * come from whichever is newer, plan and overage status from the API response.
 * @param {QuotaSnapshot | null} state
 * @param {QuotaSnapshot | null} client
 * @returns {(QuotaSnapshot & { percent: number | null, source: 'state' | 'log' }) | null}
 */
function mergeQuota(state, client) {
  if (!state && !client) return null;
  const fresh = state && (!client || (state.updatedAt ?? 0) >= (client.updatedAt ?? 0)) ? state : /** @type {QuotaSnapshot} */ (client);
  const other = fresh === state ? client : state;
  const used = fresh.used;
  const limit = fresh.limit;
  return {
    plan: client?.plan ?? null,
    overageEnabled: client?.overageEnabled ?? null,
    used,
    limit,
    percent: used != null && limit ? (used / limit) * 100 : null,
    resetAt: fresh.resetAt ?? other?.resetAt ?? null,
    overageRate: fresh.overageRate ?? other?.overageRate ?? null,
    bonuses: fresh.bonuses.length ? fresh.bonuses : other?.bonuses ?? [],
    updatedAt: fresh.updatedAt,
    source: fresh === state ? 'state' : 'log',
  };
}

module.exports = { readUsageState, fromUsageState, fromUsageLimitsOutput, mergeQuota };
