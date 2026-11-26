// @ts-check
'use strict';

const { estimateTokens } = require('./estimate');

/** Bump when parsing rules change so stored sessions get re-parsed. */
const PARSER_VERSION = 2;

const EPS = 1e-9;
const TYPE_RE = /"payload":\{"type":"([a-z_]+)"/;
const INTERESTING = new Set([
  'turn_start',
  'turn_end',
  'assistant',
  'tool_call',
  'tool_result',
  'session_metadata',
  'usage_summary',
]);

/**
 * @typedef {object} SessionRecord
 * @property {string} id
 * @property {'v1' | 'legacy'} source
 * @property {string} title
 * @property {string[]} workspaces
 * @property {string | null} modelId
 * @property {string | null} agentMode
 * @property {number | null} createdAt
 * @property {number | null} updatedAt
 * @property {string | null} status
 * @property {number} creditsMain
 * @property {number} creditsDelegated
 * @property {number} creditsAux
 * @property {number | null} contextPct
 * @property {number} turns
 * @property {number} userMessages
 * @property {number} toolCalls
 * @property {number} toolTimeMs
 * @property {number} turnTimeMs
 */

/**
 * One row per model request (`kind: 'main'`), plus credit-only rows for
 * auxiliary (classifier, titles) and delegated (sub-agent) credits.
 * @typedef {object} RequestRow
 * @property {'main' | 'aux' | 'delegated'} kind
 * @property {string | null} turnId
 * @property {string | null} requestId
 * @property {number | null} ts
 * @property {string | null} modelId
 * @property {number | null} contextPct
 * @property {number | null} credits
 * @property {number | null} estInputTokens
 * @property {number | null} estOutputTokens
 * @property {number | null} durationMs
 * @property {string | null} status   'ok' | 'cancelled' | 'unknown'
 */

/** @param {unknown} v */
function toMs(v) {
  if (v == null || v === '') return null;
  const t = typeof v === 'number' ? v : Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

/** @param {unknown} v */
function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * "qdev::claude-opus-5.5" -> "claude-opus-5.5"
 * @param {unknown} id
 */
function normalizeModelId(id) {
  if (typeof id !== 'string' || !id) return null;
  const i = id.lastIndexOf('::');
  return i >= 0 ? id.slice(i + 2) : id;
}

/** @param {unknown} v */
function safeJson(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return '';
  }
}

/**
 * Total length of the union of [start, end] intervals (parallel tool calls overlap).
 * @param {Array<[number, number]>} intervals
 */
function unionMs(intervals) {
  if (intervals.length === 0) return 0;
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [s, e] = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const [a, b] = sorted[i];
    if (a > e) {
      total += e - s;
      s = a;
      e = b;
    } else if (b > e) {
      e = b;
    }
  }
  return total + (e - s);
}

/**
 * @param {string} id
 * @param {'v1' | 'legacy'} source
 * @returns {SessionRecord}
 */
function emptySession(id, source) {
  return {
    id,
    source,
    title: '',
    workspaces: [],
    modelId: null,
    agentMode: null,
    createdAt: null,
    updatedAt: null,
    status: null,
    creditsMain: 0,
    creditsDelegated: 0,
    creditsAux: 0,
    contextPct: null,
    turns: 0,
    userMessages: 0,
    toolCalls: 0,
    toolTimeMs: 0,
    turnTimeMs: 0,
  };
}

/** @param {unknown} v */
function stringArray(v) {
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
}

/**
 * Parse one Kiro 1.x session (session.json + messages.jsonl).
 * @param {any} meta parsed session.json, or null
 * @param {string} jsonl messages.jsonl content
 * @param {{ sessionId?: string, mtimeMs?: number }} [opts]
 * @returns {{ session: SessionRecord, rows: RequestRow[] }}
 */
function parseSession(meta, jsonl, opts = {}) {
  const m = meta && typeof meta === 'object' ? meta : {};
  const session = emptySession(String(m.id || opts.sessionId || ''), 'v1');
  session.title = typeof m.title === 'string' ? m.title : '';
  const ws = stringArray(m.workspacePaths);
  session.workspaces = ws.length ? ws : stringArray(m.rootPaths);
  session.modelId = normalizeModelId(m.modelId);
  session.agentMode = typeof m.agentMode === 'string' ? m.agentMode : null;
  session.createdAt = toMs(m.createdAt);
  session.updatedAt = toMs(m.lastModifiedAt);
  session.status = typeof m.status === 'string' ? m.status : null;

  /** @type {RequestRow[]} */
  const rows = [];
  /** @type {Map<string, { id: string, startedAt: number | null, endedAt: number | null, elapsedMs: number | null, requests: RequestRow[] }>} */
  const turns = new Map();
  /** @type {{ id: string, startedAt: number | null, endedAt: number | null, elapsedMs: number | null, requests: RequestRow[] } | null} */
  let turn = null;
  let model = session.modelId;
  let text = '';
  let credits = 0;
  const last = { main: 0, delegated: 0, auxiliary: 0 };
  let aux = 0;
  /** @type {number | null} */
  let auxTs = null;
  let del = 0;
  /** @type {number | null} */
  let delTs = null;
  /** @type {Map<string, number>} */
  const toolStart = new Map();
  /** @type {Set<string>} */
  const seenTools = new Set();
  /** @type {Array<[number, number]>} */
  const intervals = [];
  /** @type {number | null} */
  let firstTs = null;
  /** @type {number | null} */
  let lastTs = null;

  /** @param {unknown} id @param {number | null} ts */
  const turnFor = (id, ts) => {
    if (typeof id !== 'string' || !id) return turn;
    let t = turns.get(id);
    if (!t) {
      t = { id, startedAt: ts, endedAt: null, elapsedMs: null, requests: [] };
      turns.set(id, t);
    }
    return t;
  };

  /** @param {'aux' | 'delegated'} kind @param {number} value @param {number | null} ts @returns {RequestRow} */
  const sideRow = (kind, value, ts) => ({
    kind,
    turnId: turn ? turn.id : null,
    requestId: null,
    ts,
    modelId: null,
    contextPct: null,
    credits: value,
    estInputTokens: null,
    estOutputTokens: null,
    durationMs: null,
    status: 'ok',
  });

  const flushSide = () => {
    if (aux > EPS) rows.push(sideRow('aux', aux, auxTs));
    if (del > EPS) rows.push(sideRow('delegated', del, delTs));
    aux = 0;
    del = 0;
    auxTs = null;
    delTs = null;
  };

  /**
   * @param {typeof turn} t
   * @param {number | null} ts
   * @param {number | null} pct
   * @param {string} status
   * @param {string | null} requestId
   */
  const pushMain = (t, ts, pct, status, requestId) => {
    /** @type {RequestRow} */
    const r = {
      kind: 'main',
      turnId: t ? t.id : null,
      requestId,
      ts,
      modelId: model,
      contextPct: pct,
      credits,
      estInputTokens: null,
      estOutputTokens: estimateTokens(text),
      durationMs: null,
      status,
    };
    rows.push(r);
    if (t) t.requests.push(r);
    text = '';
    credits = 0;
  };

  for (const line of jsonl.split('\n')) {
    if (line.length < 2) continue;
    const head = TYPE_RE.exec(line.length > 400 ? line.slice(0, 400) : line);
    if (!head) continue;
    const type = head[1];
    if (type === 'user') {
      // User lines can hold base64 images; counting them is enough.
      session.userMessages++;
      continue;
    }
    if (!INTERESTING.has(type)) continue;

    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // partial line while Kiro is writing
    }
    const p = rec && rec.payload;
    if (!p) continue;
    const ts = toMs(rec.timestamp);
    if (ts != null) {
      if (firstTs == null) firstTs = ts;
      lastTs = ts;
    }

    switch (type) {
      case 'turn_start': {
        flushSide();
        turn = turnFor(p.turnId || p.executionId, ts);
        session.turns++;
        break;
      }
      case 'assistant': {
        if (typeof p.content === 'string') text += p.content;
        const mid = normalizeModelId(p.reasoningModelId);
        if (mid) model = mid;
        break;
      }
      case 'tool_call': {
        const id = typeof p.toolCallId === 'string' ? p.toolCallId : null;
        if (id && seenTools.has(id)) break;
        if (id) seenTools.add(id);
        session.toolCalls++;
        text += (typeof p.toolName === 'string' ? p.toolName : '') + safeJson(p.args);
        if (id && ts != null) toolStart.set(id, ts);
        break;
      }
      case 'tool_result': {
        const start = toolStart.get(p.toolCallId);
        if (start != null && ts != null && ts >= start) {
          intervals.push([start, ts]);
          toolStart.delete(p.toolCallId);
        }
        break;
      }
      case 'session_metadata': {
        const v = p.value;
        if (!v || typeof v !== 'object') break;
        if (p.key === 'creditSplit') {
          const main = num(v.main);
          const d = num(v.delegated);
          const a = num(v.auxiliary);
          if (main > last.main + EPS) {
            credits += main - last.main;
            last.main = main;
          }
          if (d > last.delegated + EPS) {
            del += d - last.delegated;
            delTs = ts;
            last.delegated = d;
          }
          if (a > last.auxiliary + EPS) {
            aux += a - last.auxiliary;
            auxTs = ts;
            last.auxiliary = a;
          }
        } else if (p.key === 'contextUsage') {
          const pct = typeof v.usagePercentage === 'number' && Number.isFinite(v.usagePercentage) ? v.usagePercentage : null;
          pushMain(turnFor(p.executionId, ts), ts, pct, 'ok', null);
          if (pct != null) session.contextPct = pct;
        }
        break;
      }
      case 'usage_summary': {
        const t = turnFor(p.turnId || p.executionId, ts);
        if (!t) break;
        if (typeof p.elapsedTime === 'number' && Number.isFinite(p.elapsedTime)) t.elapsedMs = p.elapsedTime;
        const ids = stringArray(p.requestIds);
        for (let i = 0; i < ids.length; i++) {
          if (i < t.requests.length) {
            t.requests[i].requestId = ids[i];
          } else {
            // Request that never reported metering (e.g. cancelled mid-stream).
            pushMain(t, ts, null, p.status === 'aborted' ? 'cancelled' : 'unknown', ids[i]);
          }
        }
        break;
      }
      case 'turn_end': {
        const t = turnFor(p.turnId || p.executionId, ts);
        if (t) t.endedAt = ts;
        break;
      }
      default:
        break;
    }
  }
  flushSide();

  session.creditsMain = last.main;
  session.creditsDelegated = last.delegated;
  session.creditsAux = last.auxiliary;
  session.toolTimeMs = unionMs(intervals);
  for (const t of turns.values()) {
    if (t.elapsedMs != null) session.turnTimeMs += t.elapsedMs;
    else if (t.startedAt != null && t.endedAt != null && t.endedAt >= t.startedAt) session.turnTimeMs += t.endedAt - t.startedAt;
  }
  if (session.createdAt == null) session.createdAt = firstTs;
  const candidates = [session.updatedAt, lastTs, opts.mtimeMs ?? null].filter((x) => typeof x === 'number');
  session.updatedAt = candidates.length ? Math.max(...candidates) : null;
  if (!session.modelId) session.modelId = model;

  return { session, rows };
}

module.exports = { PARSER_VERSION, parseSession, emptySession, normalizeModelId, toMs, unionMs };
