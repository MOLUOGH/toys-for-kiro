// @ts-check
'use strict';

// Builds the data the dashboard and status bar render, from the Store.

const a = require('./analytics');
const { contextWindowFor } = require('./estimate');

const DEFAULT_PRICE = 0.04;

/**
 * @typedef {object} Settings
 * @property {number} contextWindowTokens
 * @property {Record<string, number>} modelContextWindows
 * @property {number} creditPriceUsd  0 = use the overage rate from the quota API
 * @property {boolean} importLegacySessions
 * @property {string} defaultRange
 * @property {'disk' | 'memory'} [storageMode]
 */

/** @param {Settings} settings @param {any} quota */
function creditPrice(settings, quota) {
  if (settings.creditPriceUsd > 0) return settings.creditPriceUsd;
  return typeof quota?.overageRate === 'number' && quota.overageRate > 0 ? quota.overageRate : DEFAULT_PRICE;
}

/**
 * @param {import('./store').Store} store
 * @param {Settings} settings
 * @param {{ from: number, to: number, sessionId?: string | null }} q
 */
function loadRows(store, settings, q) {
  const { sessionRows, logRows } = store.queryRows(q);
  let rows = a.reconcile(sessionRows, logRows);
  if (!settings.importLegacySessions) rows = rows.filter((r) => r.source !== 'legacy');
  return a.enrichRows(rows, settings);
}

/**
 * @param {{ view: string, range?: string | null, filters?: any, sessionId?: string | null }} msg
 * @param {{ store: import('./store').Store, settings: Settings, now?: number }} deps
 */
function buildPayload(msg, { store, settings, now = Date.now() }) {
  const quota = store.getKv('quota');
  const price = creditPrice(settings, quota);
  const range = a.resolveRange(msg.range || settings.defaultRange, { now, quota, earliest: store.earliestTs() });
  const meta = { price, window: settings.contextWindowTokens, now, storage: settings.storageMode || 'disk' };

  switch (msg.view) {
    case 'requests':
      return { range, meta, ...a.buildRequestList(loadRows(store, settings, range), msg.filters || {}) };
    case 'sessions': {
      let sessions = store.listSessions();
      if (!settings.importLegacySessions) sessions = sessions.filter((s) => s.source !== 'legacy');
      const all = loadRows(store, settings, { from: 0, to: now + 1 });
      const selectedId = msg.sessionId && sessions.some((s) => s.id === msg.sessionId) ? msg.sessionId : null;
      const selected = selectedId
        ? a.buildSessionStats(
            sessions.find((s) => s.id === selectedId),
            all.filter((r) => r.sessionId === selectedId),
            { price, settings },
          )
        : null;
      return { range, meta, rows: a.buildSessionList(sessions, all, range), selected };
    }
    case 'quota': {
      const cycle = a.resolveRange('cycle', { now, quota });
      const rows = loadRows(store, settings, cycle);
      const local = rows.reduce((s, r) => s + r.credits, 0);
      return { range: cycle, meta, quota, cycle: { ...cycle, localCredits: local, daily: a.buildDaily(rows, cycle, { utc: !!cycle.utc }) } };
    }
    case 'overview':
    default:
      return { range, meta, ...a.buildOverview(loadRows(store, settings, range), { range, price }) };
  }
}

/**
 * Session the user is most likely looking at: the most recently active Kiro 1.x
 * session in one of the open workspace folders, else the most recent overall.
 * @param {import('./store').Store} store
 * @param {string[]} workspaceFolders
 */
function findActiveSession(store, workspaceFolders) {
  const norm = (/** @type {string} */ p) => p.replace(/[\\/]+$/, '').toLowerCase();
  const folders = new Set(workspaceFolders.map(norm));
  const sessions = store.listSessions().filter((s) => s.source === 'v1');
  const inWorkspace = sessions.filter((s) => (s.workspaces || []).some((/** @type {string} */ w) => folders.has(norm(w))));
  const pool = inWorkspace.length ? inWorkspace : sessions;
  return pool.reduce((best, s) => (!best || (s.updatedAt ?? 0) > (best.updatedAt ?? 0) ? s : best), null);
}

/**
 * @param {import('./store').Store} store
 * @param {Settings} settings
 * @param {any} session
 * @param {number} [now]
 */
function sessionStats(store, settings, session, now = Date.now()) {
  const quota = store.getKv('quota');
  const price = creditPrice(settings, quota);
  const rows = loadRows(store, settings, { from: 0, to: now + 1, sessionId: session.id });
  return { stats: a.buildSessionStats(session, rows, { price, settings }), quota, price };
}

module.exports = { buildPayload, findActiveSession, sessionStats, creditPrice, contextWindowFor };
