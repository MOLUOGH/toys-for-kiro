// @ts-check
'use strict';

// Builds the data the dashboard and status bar render, from the Store.

const a = require('./analytics');
const exp = require('./export');
const { contextWindowFor } = require('./estimate');
const { normalizeWorkspacePath } = require('./paths');

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
 * @param {{ store: import('./store').Store, settings: Settings, now?: number, workspaceFolders?: string[], platform?: string }} deps
 */
function buildPayload(msg, { store, settings, now = Date.now(), workspaceFolders = [], platform = process.platform }) {
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
      const folders = new Set(workspaceFolders.map((w) => normalizeWorkspacePath(w, platform)).filter(Boolean));
      const wsById = new Map(
        sessions.map((s) => [s.id, (s.workspaces || []).some((/** @type {string} */ w) => folders.has(normalizeWorkspacePath(w, platform)))]),
      );
      const rows = a.buildSessionList(sessions, all, range).map((r) => ({ ...r, inWorkspace: !!wsById.get(r.id) }));
      return { range, meta, hasWorkspace: folders.size > 0, rows, selected };
    }
    case 'quota': {
      const cycle = a.resolveRange('cycle', { now, quota });
      const rows = loadRows(store, settings, cycle);
      const local = rows.reduce((s, r) => s + r.credits, 0);
      const forecast = a.buildQuotaForecast(quota, cycle, now);
      return { range: cycle, meta, quota, cycle: { ...cycle, localCredits: local, daily: a.buildDaily(rows, cycle, { utc: !!cycle.utc }), forecast } };
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
 * @param {string} [platform]
 */
function findActiveSession(store, workspaceFolders, platform = process.platform) {
  const folders = new Set(workspaceFolders.map((w) => normalizeWorkspacePath(w, platform)).filter(Boolean));
  const sessions = store.listSessions().filter((s) => s.source === 'v1');
  const inWorkspace = sessions.filter((s) => (s.workspaces || []).some((/** @type {string} */ w) => folders.has(normalizeWorkspacePath(w, platform))));
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

/**
 * Assemble data for the status bar across all display modes ('session', 'today', 'cycle').
 * @param {import('./store').Store} store
 * @param {Settings} settings
 * @param {string[]} workspaceFolders
 * @param {number} [now]
 * @param {string} [platform]
 */
function buildStatusData(store, settings, workspaceFolders, now = Date.now(), platform = process.platform) {
  const quota = store.getKv('quota');
  const price = creditPrice(settings, quota);
  const session = findActiveSession(store, workspaceFolders, platform);
  const stats = session ? a.buildSessionStats(session, loadRows(store, settings, { from: 0, to: now + 1, sessionId: session.id }), { price, settings }) : null;
  const todayRange = a.resolveRange('today', { now, quota });
  const todayRows = loadRows(store, settings, todayRange);
  const today = {
    credits: todayRows.reduce((s, r) => s + r.credits, 0),
    requests: todayRows.filter((r) => r.kind === 'main').length,
  };
  const cycleRange = a.resolveRange('cycle', { now, quota });
  const cycleCredits = loadRows(store, settings, cycleRange).reduce((s, r) => s + r.credits, 0);
  return { stats, today, cycleCredits, quota, price, storage: settings.storageMode || 'disk' };
}

/**
 * Build serialized CSV or JSON export content for the chosen target.
 * @param {{ target: 'requests-csv' | 'sessions-csv' | 'daily-csv' | 'report-json', range?: string | null, filters?: any, sessionQuery?: string, sessionWorkspaceOnly?: boolean, unlinkedTitle?: string }} req
 * @param {{ store: import('./store').Store, settings: Settings, now?: number, workspaceFolders?: string[], platform?: string }} deps
 */
function buildExportContent(req, { store, settings, now = Date.now(), workspaceFolders = [], platform = process.platform }) {
  const quota = store.getKv('quota');
  const price = creditPrice(settings, quota);
  const rangeKey = req.target === 'daily-csv' ? 'cycle' : req.range || settings.defaultRange;
  const range = a.resolveRange(rangeKey, { now, quota, earliest: store.earliestTs() });
  let sessions = store.listSessions();
  if (!settings.importLegacySessions) sessions = sessions.filter((s) => s.source !== 'legacy');
  const sessionWorkspaces = new Map(sessions.map((s) => [s.id, s.workspaces?.[0] ?? null]));
  const folders = new Set(workspaceFolders.map((w) => normalizeWorkspacePath(w, platform)).filter(Boolean));
  const inWorkspace = new Set(
    sessions.filter((s) => (s.workspaces || []).some((/** @type {string} */ w) => folders.has(normalizeWorkspacePath(w, platform)))).map((s) => s.id),
  );

  if (req.target === 'requests-csv') {
    const items = exp.buildExportRequests(loadRows(store, settings, range), { price, filters: req.filters || {}, sessionWorkspaces });
    return { ext: 'csv', count: items.length, content: exp.requestsToCsv(items) };
  }
  if (req.target === 'sessions-csv') {
    const allRows = loadRows(store, settings, { from: 0, to: now + 1 });
    const items = exp.buildExportSessions(sessions, allRows, {
      range,
      price,
      settings,
      query: req.sessionQuery || '',
      workspaceOnly: !!(req.sessionWorkspaceOnly && folders.size > 0),
      inWorkspace,
      unlinkedTitle: req.unlinkedTitle,
    });
    return { ext: 'csv', count: items.length, content: exp.sessionsToCsv(items) };
  }
  if (req.target === 'daily-csv') {
    const rows = loadRows(store, settings, range);
    const daily = a.buildDaily(rows, range, { utc: !!range.utc });
    const items = exp.buildExportDaily(daily, { price, utc: !!range.utc });
    return { ext: 'csv', count: items.length, content: exp.dailyToCsv(items) };
  }

  // Full JSON report for the selected range.
  const rangeRows = loadRows(store, settings, range);
  const allRows = loadRows(store, settings, { from: 0, to: now + 1 });
  const overview = a.buildOverview(rangeRows, { range, price });
  const daily = exp.buildExportDaily(a.buildDaily(rangeRows, range, { utc: !!range.utc }), { price, utc: !!range.utc });
  const sessionItems = exp.buildExportSessions(sessions, allRows, { range, price, settings, unlinkedTitle: req.unlinkedTitle });
  const requestItems = exp.buildExportRequests(rangeRows, { price, sessionWorkspaces });
  const cycle = a.resolveRange('cycle', { now, quota });
  const forecast = a.buildQuotaForecast(quota, cycle, now);
  const report = {
    exportedAt: new Date(now).toISOString(),
    range: { key: range.key, fromUtc: new Date(range.from).toISOString(), toUtc: new Date(range.to - 1).toISOString(), resetAt: range.resetAt ?? null },
    priceUsdPerCredit: price,
    contextWindowTokens: settings.contextWindowTokens,
    summary: overview.totals,
    quota: quota ? { ...quota, forecast } : null,
    daily,
    sessions: sessionItems,
    requests: requestItems,
  };
  return { ext: 'json', count: requestItems.length, content: JSON.stringify(report, null, 2) + '\n' };
}

module.exports = { buildPayload, findActiveSession, sessionStats, buildStatusData, buildExportContent, creditPrice, contextWindowFor };
