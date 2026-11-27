// @ts-check
'use strict';

// Serializes usage views to RFC 4180 CSV (with UTF-8 BOM for Excel) or JSON.
// Pure functions with no vscode / fs dependencies.

const a = require('./analytics');

const UTF8_BOM = '\uFEFF';

/** @param {unknown} v */
function csvCell(v) {
  if (v == null) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * @param {string[]} headers
 * @param {unknown[][]} rows
 */
function toCsv(headers, rows) {
  const lines = [headers.map(csvCell).join(',')];
  for (const r of rows) lines.push(r.map(csvCell).join(','));
  return UTF8_BOM + lines.join('\r\n') + '\r\n';
}

/** @param {number | null | undefined} ts */
function iso(ts) {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return null;
  return new Date(ts).toISOString();
}

/** @param {number | null | undefined} n @param {number} [d] */
function round(n, d = 6) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

/**
 * Build exportable request rows (no row-count cap).
 * @param {any[]} enrichedRows rows within the selected range
 * @param {{ price: number, filters?: { model?: string, session?: string, outcome?: string }, sessionWorkspaces?: Map<string, string | null> }} ctx
 */
function buildExportRequests(enrichedRows, { price, filters = {}, sessionWorkspaces = new Map() }) {
  const hasFilter = !!(filters.model || filters.session || filters.outcome);
  const filtered = enrichedRows
    .filter((r) => {
      if (hasFilter && r.kind !== 'main') return false;
      if (filters.model && r.modelId !== filters.model) return false;
      if (filters.session && r.sessionId !== filters.session) return false;
      if (filters.outcome && r.outcome !== filters.outcome) return false;
      return true;
    })
    .sort((x, y) => (y.ts ?? 0) - (x.ts ?? 0));

  return filtered.map((r) => {
    const credits = r.creditsKnown || r.kind !== 'main' ? round(r.credits, 6) : null;
    return {
      ts: r.ts ?? null,
      timeUtc: iso(r.ts),
      sessionId: r.sessionId ?? null,
      sessionTitle: r.sessionTitle || null,
      workspace: sessionWorkspaces.get(r.sessionId) ?? null,
      source: r.source || 'v1',
      kind: r.kind || 'main',
      modelId: r.modelId ?? null,
      outcome: r.kind === 'main' ? r.outcome || 'unknown' : 'ok',
      errorType: r.errorType ?? null,
      isRetry: !!r.isRetry,
      isFallback: !!r.isFallback,
      contextPct: round(r.contextPct, 4),
      estInputTokens: r.kind === 'main' ? Math.round(r.inputTokens || 0) : null,
      estOutputTokens: r.kind === 'main' ? Math.round(r.outputTokens || 0) : null,
      credits,
      usd: credits != null ? round(credits * price, 6) : null,
      ttftMs: r.firstEventMs ?? null,
      durationMs: r.durationMs ?? null,
      speedTokPerSec: round(r.speed, 2),
    };
  });
}

/**
 * @param {ReturnType<typeof buildExportRequests>} items
 */
function requestsToCsv(items) {
  const headers = [
    'timeUtc',
    'sessionId',
    'sessionTitle',
    'workspace',
    'source',
    'kind',
    'modelId',
    'outcome',
    'errorType',
    'isRetry',
    'isFallback',
    'contextPct',
    'estInputTokens',
    'estOutputTokens',
    'credits',
    'usd',
    'ttftMs',
    'durationMs',
    'speedTokPerSec',
  ];
  return toCsv(
    headers,
    items.map((r) => headers.map((k) => r[/** @type {keyof typeof r} */ (k)])),
  );
}

/**
 * Build exportable session summary rows for sessions active in `range`.
 * @param {any[]} sessions
 * @param {any[]} allRows enriched all-time rows
 * @param {{ range: import('./analytics').Range, price: number, settings: import('./estimate').WindowSettings, query?: string, workspaceOnly?: boolean, inWorkspace?: Set<string>, unlinkedTitle?: string }} ctx
 */
function buildExportSessions(sessions, allRows, { range, price, settings, query = '', workspaceOnly = false, inWorkspace, unlinkedTitle = '' }) {
  /** @type {Map<string, any[]>} */
  const bySession = new Map();
  for (const r of allRows) {
    const list = bySession.get(r.sessionId);
    if (list) list.push(r);
    else bySession.set(r.sessionId, [r]);
  }
  const q = query.trim().toLowerCase();
  /** @param {any} s */
  const displayTitle = (s) => s.title || (s.id === 'legacy:unlinked' && unlinkedTitle ? unlinkedTitle : '');
  return sessions
    .filter((s) => (s.updatedAt ?? 0) >= range.from)
    .filter((s) => {
      if (workspaceOnly && inWorkspace && !inWorkspace.has(s.id)) return false;
      if (!q) return true;
      const hay = `${displayTitle(s) || s.id} ${(s.workspaces && s.workspaces[0]) || ''} ${s.modelId || ''}`.toLowerCase();
      return hay.includes(q);
    })
    .map((s) => {
      const st = a.buildSessionStats(s, bySession.get(s.id) || [], { price, settings });
      const c = st.credits;
      return {
        sessionId: st.id,
        title: displayTitle(st) || null,
        workspace: st.workspace,
        source: st.source,
        modelId: st.modelId,
        turns: st.turns,
        requests: st.requests,
        toolCalls: st.toolCalls,
        creditsMain: c ? round(c.main, 6) : null,
        creditsDelegated: c ? round(c.delegated, 6) : null,
        creditsAux: c ? round(c.aux, 6) : null,
        creditsTotal: c ? round(c.total, 6) : null,
        usd: c ? round(c.usd, 6) : null,
        estInputTokens: Math.round(st.tokens.input),
        estOutputTokens: Math.round(st.tokens.output),
        estTotalTokens: Math.round(st.tokens.total),
        contextPct: round(st.context.pct, 4),
        avgTtftMs: st.timing.avgTtftMs != null ? Math.round(st.timing.avgTtftMs) : null,
        modelTimeMs: st.timing.modelTimeMs != null ? Math.round(st.timing.modelTimeMs) : null,
        toolTimeMs: st.timing.toolTimeMs != null ? Math.round(st.timing.toolTimeMs) : null,
        avgSpeedTokPerSec: round(st.speed.avg, 2),
        okCount: st.outcomes.ok,
        errorCount: st.outcomes.error,
        cancelledCount: st.outcomes.cancelled,
        createdAtUtc: iso(st.createdAt),
        updatedAtUtc: iso(st.updatedAt),
      };
    });
}

/**
 * @param {ReturnType<typeof buildExportSessions>} items
 */
function sessionsToCsv(items) {
  const headers = [
    'sessionId',
    'title',
    'workspace',
    'source',
    'modelId',
    'turns',
    'requests',
    'toolCalls',
    'creditsMain',
    'creditsDelegated',
    'creditsAux',
    'creditsTotal',
    'usd',
    'estInputTokens',
    'estOutputTokens',
    'estTotalTokens',
    'contextPct',
    'avgTtftMs',
    'modelTimeMs',
    'toolTimeMs',
    'avgSpeedTokPerSec',
    'okCount',
    'errorCount',
    'cancelledCount',
    'createdAtUtc',
    'updatedAtUtc',
  ];
  return toCsv(
    headers,
    items.map((r) => headers.map((k) => r[/** @type {keyof typeof r} */ (k)])),
  );
}

/**
 * @param {Array<{ day: number, credits: number, requests: number }>} daily
 * @param {{ price: number, utc?: boolean }} ctx
 */
function buildExportDaily(daily, { price, utc = false }) {
  return daily.map((d) => {
    const dt = new Date(d.day);
    const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
    const date = utc
      ? `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`
      : `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
    const credits = round(d.credits, 6) ?? 0;
    return {
      date,
      timezone: utc ? 'UTC' : 'local',
      requests: d.requests,
      credits,
      usd: round(credits * price, 6) ?? 0,
    };
  });
}

/**
 * @param {ReturnType<typeof buildExportDaily>} items
 */
function dailyToCsv(items) {
  const headers = ['date', 'timezone', 'requests', 'credits', 'usd'];
  return toCsv(
    headers,
    items.map((r) => headers.map((k) => r[/** @type {keyof typeof r} */ (k)])),
  );
}

module.exports = {
  UTF8_BOM,
  csvCell,
  toCsv,
  buildExportRequests,
  requestsToCsv,
  buildExportSessions,
  sessionsToCsv,
  buildExportDaily,
  dailyToCsv,
};
