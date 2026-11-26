// @ts-check
'use strict';

// Pure aggregation over joined request rows. No vscode / fs dependencies.

const { inputTokensFromPct, contextWindowFor } = require('./estimate');

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SPARK_BUCKETS = 40;
const HEALTH_BUCKETS = 36;
// Heatmap: always 7 rows, at most 53 columns. Each cell covers the smallest of
// these steps that fits the range; past 12 h the cells become days.
const HM_ROWS = 7;
const HM_MAX_COLS = 53;
const HM_MAX_CELLS = HM_ROWS * HM_MAX_COLS;
const MINUTE = 60_000;
const HM_UNITS = [5, 10, 15, 20, 30, 60, 120, 180, 240, 360, 480, 720].map((m) => m * MINUTE);

const RANGE_LABELS = /** @type {const} */ ({
  cycle: '本计费周期',
  today: '今天',
  '24h': '最近 24 小时',
  '7d': '最近 7 天',
  '30d': '最近 30 天',
  all: '全部时间',
});

/** @param {number} t */
function startOfDay(t) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** DST-safe day arithmetic in local time. @param {number} t @param {number} n */
function addDays(t, n) {
  const d = new Date(t);
  d.setDate(d.getDate() + n);
  return d.getTime();
}

/** Monday 00:00 of the week containing t. @param {number} t */
function startOfWeek(t) {
  const d = new Date(startOfDay(t));
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

/**
 * @typedef {{ key: string, label: string, from: number, to: number, resetAt?: string | null }} Range
 */

/**
 * @param {string | null | undefined} key
 * @param {{ now: number, quota?: { resetAt?: string | null } | null, earliest?: number | null }} ctx
 * @returns {Range}
 */
function resolveRange(key, { now, quota, earliest }) {
  const to = now + 1;
  switch (key) {
    case 'today':
      return { key, label: RANGE_LABELS.today, from: startOfDay(now), to };
    case '24h':
      return { key, label: RANGE_LABELS['24h'], from: now - DAY, to };
    case '7d':
      return { key, label: RANGE_LABELS['7d'], from: now - 7 * DAY, to };
    case '30d':
      return { key, label: RANGE_LABELS['30d'], from: now - 30 * DAY, to };
    case 'all':
      return { key, label: RANGE_LABELS.all, from: Math.min(earliest ?? now - 30 * DAY, now - HOUR), to };
    default: {
      const reset = quota?.resetAt ? Date.parse(quota.resetAt) : NaN;
      if (Number.isFinite(reset)) {
        const r = new Date(reset);
        const from = Date.UTC(r.getUTCFullYear(), r.getUTCMonth() - 1, r.getUTCDate(), r.getUTCHours(), r.getUTCMinutes());
        if (from < now) return { key: 'cycle', label: RANGE_LABELS.cycle, from, to, resetAt: quota?.resetAt ?? null };
      }
      return { key: 'cycle', label: '最近 30 天（未读到计费周期）', from: now - 30 * DAY, to, resetAt: null };
    }
  }
}

/**
 * Attach log timing to rows of turns that are still running (their requestIds are
 * only written at turn end), and keep log-only attempts such as errors.
 * @param {any[]} sessionRows
 * @param {any[]} logRows
 */
function reconcile(sessionRows, logRows) {
  const rows = sessionRows.map((r) => ({ ...r }));
  /** @type {Map<string, any[]>} */
  const pending = new Map();
  for (const r of rows) {
    if (r.kind !== 'main' || r.requestId || r.source === 'legacy') continue;
    const list = pending.get(r.sessionId) || [];
    list.push(r);
    pending.set(r.sessionId, list);
  }
  /** @type {Map<string, any[]>} */
  const logsBySession = new Map();
  for (const l of logRows) {
    const list = logsBySession.get(l.sessionId) || [];
    list.push(l);
    logsBySession.set(l.sessionId, list);
  }
  for (const [sid, logs] of logsBySession) {
    logs.sort((a, b) => a.ts - b.ts);
    const waiting = (pending.get(sid) || []).sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
    const oks = logs.filter((l) => l.outcome === 'ok');
    const used = new Set();
    for (let i = oks.length - 1, j = waiting.length - 1; i >= 0 && j >= 0; i--, j--) {
      const l = oks[i];
      Object.assign(waiting[j], {
        requestId: l.requestId,
        modelId: l.modelId ?? waiting[j].modelId,
        durationMs: l.durationMs,
        firstEventMs: l.firstEventMs,
        firstVisibleMs: l.firstVisibleMs,
        outcome: l.outcome,
        isRetry: l.isRetry,
        isFallback: l.isFallback,
      });
      used.add(l);
    }
    for (const l of logs) {
      if (used.has(l)) continue;
      rows.push({
        ...l,
        kind: 'main',
        seq: null,
        turnId: null,
        contextPct: null,
        credits: null,
        estInputTokens: null,
        estOutputTokens: null,
        status: null,
        logOnly: true,
      });
    }
  }
  return rows;
}

/**
 * @param {any[]} rows
 * @param {import('./estimate').WindowSettings} settings
 */
function enrichRows(rows, settings) {
  for (const r of rows) {
    r.kind = r.kind || 'main';
    r.creditsKnown = typeof r.credits === 'number';
    r.credits = r.creditsKnown ? r.credits : 0;
    r.inputTokens = typeof r.estInputTokens === 'number' ? r.estInputTokens : inputTokensFromPct(r.contextPct, r.modelId, settings) ?? 0;
    r.outputTokens = typeof r.estOutputTokens === 'number' ? r.estOutputTokens : 0;
    if (!r.outcome) r.outcome = r.status === 'ok' || r.status === 'cancelled' ? r.status : 'unknown';
    const gen = typeof r.durationMs === 'number' ? r.durationMs - (r.firstEventMs ?? 0) : null;
    r.speed = r.source !== 'legacy' && r.outputTokens > 0 && gen != null && gen >= 500 ? r.outputTokens / (gen / 1000) : null;
  }
  return rows;
}

/** @param {number} from @param {number} to @param {number} n @param {number} t */
function bucketOf(from, to, n, t) {
  const i = Math.floor(((t - from) / (to - from)) * n);
  return i < 0 || i >= n ? -1 : i;
}

/**
 * Cell boundaries on the local wall clock (12:00, 14:00, ...), so they stay on
 * round hours across daylight-saving changes. Returns null if more than `max`
 * cells would be needed.
 * @param {number} from @param {number} to @param {number} stepMin @param {number} max
 */
function localBounds(from, to, stepMin, max) {
  const d = new Date(from);
  const y = d.getFullYear();
  const mo = d.getMonth();
  const day = d.getDate();
  const first = Math.floor((d.getHours() * 60 + d.getMinutes()) / stepMin) * stepMin;
  /** @type {number[]} */
  const out = [];
  for (let i = 0; out.length <= max; i++) {
    const t = new Date(y, mo, day, 0, first + i * stepMin).getTime();
    // Times inside a skipped DST hour normalize forward; keep boundaries increasing.
    if (out.length && t <= out[out.length - 1]) continue;
    out.push(t);
    if (t >= to) return out;
  }
  return null;
}

/** @param {any[]} rows @param {Range} range */
function buildHeatmap(rows, range) {
  const blank = () => ({ requests: 0, tokens: 0, credits: 0 });
  /** @param {any} c @param {any} r */
  const add = (c, r) => {
    if (r.kind === 'main') {
      c.requests++;
      c.tokens += r.inputTokens + r.outputTokens;
    }
    c.credits += r.credits;
  };
  // Window to draw. Ranges shorter than a day show the whole day, so "today"
  // keeps its shape in the morning.
  let from = range.from;
  let to = range.to;
  if (to - from < DAY) {
    from = startOfDay(from);
    to = Math.max(to, addDays(from, 1));
  }

  /** @type {number[]} bucket boundaries, length = buckets + 1 */
  let bounds = [];
  let unit = DAY;
  for (const u of HM_UNITS) {
    const b = localBounds(from, to, u / MINUTE, HM_MAX_CELLS);
    if (b) {
      bounds = b;
      unit = u;
      break;
    }
  }
  if (!bounds.length) {
    // Daily cells, Monday on top, last 53 weeks at most (GitHub layout).
    const s = Math.max(startOfWeek(from), addDays(startOfWeek(to - 1), -7 * (HM_MAX_COLS - 1)));
    for (let d = s; d < to; d = addDays(d, 1)) bounds.push(d);
    bounds.push(addDays(bounds[bounds.length - 1], 1));
  }

  const n = bounds.length - 1;
  const cols = Math.ceil(n / HM_ROWS);
  /** @type {Array<Array<(ReturnType<typeof blank> & { t0: number, t1: number }) | null>>} */
  const cells = Array.from({ length: cols }, (_, c) =>
    Array.from({ length: HM_ROWS }, (_, r) => {
      const i = c * HM_ROWS + r;
      if (i >= n) return null;
      const t0 = bounds[i];
      const t1 = bounds[i + 1];
      // Padding before the range and time that has not happened yet stay blank.
      return t1 <= range.from || t0 >= range.to ? null : { t0, t1, ...blank() };
    }),
  );
  for (const r of rows) {
    if (r.ts == null || r.ts < bounds[0] || r.ts >= bounds[n]) continue;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (bounds[mid] <= r.ts) lo = mid;
      else hi = mid - 1;
    }
    const c = cells[Math.floor(lo / HM_ROWS)][lo % HM_ROWS];
    if (c) add(c, r);
  }
  return {
    unit,
    rows: HM_ROWS,
    cols,
    start: bounds[0],
    end: bounds[n],
    colStarts: Array.from({ length: cols }, (_, c) => bounds[c * HM_ROWS]),
    cells,
  };
}

/** @param {any[]} main @param {Range} range */
function buildHealth(main, range) {
  /** @type {Map<string, { model: string, ok: number, error: number, cancelled: number, total: number, buckets: Array<{ ok: number, error: number, cancelled: number, total: number }> }>} */
  const by = new Map();
  for (const r of main) {
    if (!r.modelId || r.ts == null) continue;
    let m = by.get(r.modelId);
    if (!m) {
      m = { model: r.modelId, ok: 0, error: 0, cancelled: 0, total: 0, buckets: Array.from({ length: HEALTH_BUCKETS }, () => ({ ok: 0, error: 0, cancelled: 0, total: 0 })) };
      by.set(r.modelId, m);
    }
    const key = r.outcome === 'ok' ? 'ok' : r.outcome === 'error' ? 'error' : r.outcome === 'cancelled' ? 'cancelled' : null;
    m.total++;
    if (key) m[key]++;
    const i = bucketOf(range.from, range.to, HEALTH_BUCKETS, r.ts);
    if (i >= 0) {
      m.buckets[i].total++;
      if (key) m.buckets[i][key]++;
    }
  }
  let ok = 0;
  let error = 0;
  const models = [...by.values()]
    .sort((a, b) => b.total - a.total)
    .map((m) => {
      ok += m.ok;
      error += m.error;
      return { ...m, rate: m.ok + m.error > 0 ? m.ok / (m.ok + m.error) : null };
    });
  return { overall: ok + error > 0 ? ok / (ok + error) : null, models, bucketMs: (range.to - range.from) / HEALTH_BUCKETS, from: range.from };
}

/** @param {Map<string, number>} map @param {number} top */
function topItems(map, top) {
  const sorted = [...map.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const items = sorted.slice(0, top).map(([label, value]) => ({ label, value }));
  const rest = sorted.slice(top).reduce((s, [, v]) => s + v, 0);
  if (rest > 0) items.push({ label: '其他', value: rest });
  return items;
}

/** @param {any[]} rows */
function buildDistribution(rows) {
  /** @type {Map<string, number>} */
  const tokens = new Map();
  /** @type {Map<string, number>} */
  const credits = new Map();
  for (const r of rows) {
    if (r.kind === 'main') {
      const m = r.modelId || '未知模型';
      tokens.set(m, (tokens.get(m) || 0) + r.inputTokens + r.outputTokens);
      credits.set(m, (credits.get(m) || 0) + r.credits);
    } else {
      const label = r.kind === 'aux' ? '辅助（权限分类、标题等）' : '子智能体';
      credits.set(label, (credits.get(label) || 0) + r.credits);
    }
  }
  return { tokens: topItems(tokens, 5), credits: topItems(credits, 5) };
}

/**
 * @param {any[]} rows enriched rows within range
 * @param {{ range: Range, price: number }} ctx
 */
function buildOverview(rows, { range, price }) {
  const main = rows.filter((r) => r.kind === 'main');
  const totals = {
    requests: main.length,
    ok: 0,
    errors: 0,
    cancelled: 0,
    inputTokens: 0,
    outputTokens: 0,
    credits: 0,
    usd: 0,
    avgCredits: /** @type {number | null} */ (null),
    avgTtftMs: /** @type {number | null} */ (null),
    legacyRequests: 0,
  };
  let mainCredits = 0;
  let metered = 0;
  let ttft = 0;
  let ttftN = 0;
  for (const r of main) {
    if (r.outcome === 'ok') totals.ok++;
    else if (r.outcome === 'error') totals.errors++;
    else if (r.outcome === 'cancelled') totals.cancelled++;
    if (r.source === 'legacy') totals.legacyRequests++;
    totals.inputTokens += r.inputTokens;
    totals.outputTokens += r.outputTokens;
    if (r.credits > 0) {
      mainCredits += r.credits;
      metered++;
    }
    if (typeof r.firstEventMs === 'number') {
      ttft += r.firstEventMs;
      ttftN++;
    }
  }
  for (const r of rows) totals.credits += r.credits;
  totals.usd = totals.credits * price;
  totals.avgCredits = metered ? mainCredits / metered : null;
  totals.avgTtftMs = ttftN ? ttft / ttftN : null;

  const spark = {
    requests: new Array(SPARK_BUCKETS).fill(0),
    tokens: new Array(SPARK_BUCKETS).fill(0),
    credits: new Array(SPARK_BUCKETS).fill(0),
  };
  for (const r of rows) {
    if (r.ts == null) continue;
    const i = bucketOf(range.from, range.to, SPARK_BUCKETS, r.ts);
    if (i < 0) continue;
    if (r.kind === 'main') {
      spark.requests[i]++;
      spark.tokens[i] += r.inputTokens + r.outputTokens;
    }
    spark.credits[i] += r.credits;
  }
  return {
    totals,
    spark,
    heatmap: buildHeatmap(rows, range),
    health: buildHealth(main, range),
    distribution: buildDistribution(rows),
  };
}

/**
 * @param {any[]} rows
 * @param {{ model?: string, session?: string, outcome?: string }} [filters]
 * @param {number} [limit]
 */
function buildRequestList(rows, filters = {}, limit = 500) {
  const main = rows.filter((r) => r.kind === 'main');
  const models = [...new Set(main.map((r) => r.modelId).filter(Boolean))].sort();
  /** @type {Map<string, { id: string, title: string, last: number }>} */
  const sessions = new Map();
  for (const r of main) {
    const s = sessions.get(r.sessionId);
    if (!s || (r.ts ?? 0) > s.last) sessions.set(r.sessionId, { id: r.sessionId, title: r.sessionTitle || r.sessionId, last: r.ts ?? 0 });
  }
  const list = main
    .filter((r) => (!filters.model || r.modelId === filters.model) && (!filters.session || r.sessionId === filters.session) && (!filters.outcome || r.outcome === filters.outcome))
    .sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
  return {
    total: list.length,
    truncated: list.length > limit,
    models,
    sessions: [...sessions.values()].sort((a, b) => b.last - a.last).map(({ id, title }) => ({ id, title })),
    rows: list.slice(0, limit).map((r) => ({
      ts: r.ts,
      sessionId: r.sessionId,
      sessionTitle: r.sessionTitle,
      source: r.source,
      modelId: r.modelId,
      outcome: r.outcome,
      errorType: r.errorType ?? null,
      isRetry: !!r.isRetry,
      isFallback: !!r.isFallback,
      contextPct: r.contextPct ?? null,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      credits: r.creditsKnown ? r.credits : null,
      ttftMs: r.firstEventMs ?? null,
      durationMs: r.durationMs ?? null,
      speed: r.speed,
    })),
  };
}

/**
 * Per-session statistics (the status bar tooltip and the session detail card).
 * @param {any} session
 * @param {any[]} rows enriched rows of this session
 * @param {{ price: number, settings: import('./estimate').WindowSettings }} ctx
 */
function buildSessionStats(session, rows, { price, settings }) {
  const main = rows.filter((r) => r.kind === 'main').sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  let input = 0;
  let output = 0;
  let duration = 0;
  let durationN = 0;
  let ttft = 0;
  let ttftN = 0;
  let speedTokens = 0;
  let speedMs = 0;
  let peak = null;
  let latest = null;
  const outcomes = { ok: 0, error: 0, cancelled: 0, unknown: 0 };
  for (const r of main) {
    input += r.inputTokens;
    output += r.outputTokens;
    if (r.outcome in outcomes) outcomes[/** @type {keyof typeof outcomes} */ (r.outcome)]++;
    if (r.source !== 'legacy' && typeof r.durationMs === 'number') {
      duration += r.durationMs;
      durationN++;
    }
    if (typeof r.firstEventMs === 'number') {
      ttft += r.firstEventMs;
      ttftN++;
    }
    if (r.speed != null) {
      speedTokens += r.outputTokens;
      speedMs += r.durationMs - (r.firstEventMs ?? 0);
      peak = peak == null ? r.speed : Math.max(peak, r.speed);
      latest = r.speed;
    }
  }
  const legacy = session.source === 'legacy';
  const lastModel = main.length ? main[main.length - 1].modelId : session.modelId;
  const window = contextWindowFor(lastModel, settings);
  const creditsTotal = legacy ? null : session.creditsMain + session.creditsDelegated + session.creditsAux;
  const modelTimeEstimated = durationN === 0;
  return {
    id: session.id,
    title: session.title,
    source: session.source,
    workspace: session.workspaces?.[0] ?? null,
    modelId: lastModel,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    turns: session.turns,
    requests: main.length,
    toolCalls: session.toolCalls,
    credits: legacy
      ? null
      : { main: session.creditsMain, delegated: session.creditsDelegated, aux: session.creditsAux, total: creditsTotal, usd: (creditsTotal ?? 0) * price },
    tokens: { input, output, total: input + output },
    context: {
      pct: session.contextPct,
      tokens: inputTokensFromPct(session.contextPct, lastModel, settings),
      window,
    },
    timing: {
      avgTtftMs: ttftN ? ttft / ttftN : null,
      modelTimeMs: modelTimeEstimated ? (session.turnTimeMs > 0 ? Math.max(0, session.turnTimeMs - session.toolTimeMs) : null) : duration,
      modelTimeEstimated,
      toolTimeMs: session.toolTimeMs || null,
    },
    speed: { avg: speedMs > 0 ? speedTokens / (speedMs / 1000) : null, peak, latest },
    outcomes,
  };
}

/**
 * @param {any[]} sessions
 * @param {any[]} rows enriched rows (all time)
 * @param {Range} range
 */
function buildSessionList(sessions, rows, range) {
  /** @type {Map<string, { requests: number, tokens: number }>} */
  const agg = new Map();
  for (const r of rows) {
    if (r.kind !== 'main') continue;
    const a = agg.get(r.sessionId) || { requests: 0, tokens: 0 };
    a.requests++;
    a.tokens += r.inputTokens + r.outputTokens;
    agg.set(r.sessionId, a);
  }
  return sessions
    .filter((s) => (s.updatedAt ?? 0) >= range.from)
    .map((s) => ({
      id: s.id,
      title: s.title,
      source: s.source,
      workspace: s.workspaces?.[0] ?? null,
      modelId: s.modelId,
      updatedAt: s.updatedAt,
      turns: s.turns,
      requests: agg.get(s.id)?.requests ?? 0,
      tokens: agg.get(s.id)?.tokens ?? 0,
      credits: s.source === 'legacy' ? null : s.creditsMain + s.creditsDelegated + s.creditsAux,
      contextPct: s.contextPct,
    }));
}

/** @param {any[]} rows @param {Range} range */
function buildDaily(rows, range) {
  /** @type {Array<{ day: number, credits: number, requests: number }>} */
  const days = [];
  for (let d = startOfDay(range.from); d < range.to; d = addDays(d, 1)) days.push({ day: d, credits: 0, requests: 0 });
  const index = new Map(days.map((d, i) => [d.day, i]));
  for (const r of rows) {
    if (r.ts == null) continue;
    const i = index.get(startOfDay(r.ts));
    if (i == null) continue;
    days[i].credits += r.credits;
    if (r.kind === 'main') days[i].requests++;
  }
  return days;
}

module.exports = {
  RANGE_LABELS,
  resolveRange,
  reconcile,
  enrichRows,
  buildOverview,
  buildHeatmap,
  buildHealth,
  buildRequestList,
  buildSessionStats,
  buildSessionList,
  buildDaily,
  startOfDay,
  startOfWeek,
};
