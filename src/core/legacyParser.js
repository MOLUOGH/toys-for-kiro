// @ts-check
'use strict';

// Kiro before 1.0 stored chats under globalStorage/kiro.kiroagent:
//   workspace-sessions/<base64 workspace>/sessions.json + <sessionId>.json  (history with executionIds)
//   <32-hex>/<hash>.chat                                                     (one file per execution)
// There are no credits in this format; tokens are a rough estimate of the chat text.

const fsp = require('fs/promises');
const path = require('path');
const { estimateTokens } = require('./estimate');
const { emptySession, toMs } = require('./sessionParser');
const { readdirSafe } = require('./logParser');

const HASH_DIR = /^[0-9a-f]{32}$/;
const UNLINKED_ID = 'legacy:unlinked';

/**
 * @param {string} legacyDir
 * @returns {Promise<{ chats: string[], sessionDirs: string[] }>}
 */
async function listLegacyFiles(legacyDir) {
  /** @type {string[]} */
  const chats = [];
  /** @type {string[]} */
  const sessionDirs = [];
  for (const e of await readdirSafe(legacyDir)) {
    if (!e.isDirectory()) continue;
    const dir = path.join(legacyDir, e.name);
    if (HASH_DIR.test(e.name)) {
      for (const f of await readdirSafe(dir)) {
        if (f.isFile() && f.name.endsWith('.chat')) chats.push(path.join(dir, f.name));
      }
    } else if (e.name === 'workspace-sessions') {
      for (const w of await readdirSafe(dir)) {
        if (w.isDirectory()) sessionDirs.push(path.join(dir, w.name));
      }
    }
  }
  return { chats, sessionDirs };
}

/**
 * Cheap fingerprint so the import only reruns when legacy files change.
 * @param {string} legacyDir
 */
async function legacySignature(legacyDir) {
  const { chats, sessionDirs } = await listLegacyFiles(legacyDir);
  if (!chats.length && !sessionDirs.length) return null;
  let size = 0;
  let mtime = 0;
  const files = [...chats];
  for (const d of sessionDirs) {
    for (const f of await readdirSafe(d)) if (f.isFile() && f.name.endsWith('.json')) files.push(path.join(d, f.name));
  }
  for (const f of files) {
    try {
      const st = await fsp.stat(f);
      size += st.size;
      mtime = Math.max(mtime, st.mtimeMs);
    } catch {
      /* ignore */
    }
  }
  return `${files.length}:${size}:${Math.round(mtime)}`;
}

/** @param {string} file */
async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/** @param {unknown} c */
function contentText(c) {
  if (typeof c === 'string') return c;
  if (c == null) return '';
  try {
    return JSON.stringify(c);
  } catch {
    return '';
  }
}

/**
 * @param {string} legacyDir
 * @param {{ yieldEvery?: () => Promise<void> }} [opts]
 * @returns {Promise<Array<{ session: import('./sessionParser').SessionRecord, rows: import('./sessionParser').RequestRow[] }>>}
 */
async function parseLegacy(legacyDir, opts = {}) {
  const pause = opts.yieldEvery || (() => new Promise((r) => setImmediate(r)));
  const { chats, sessionDirs } = await listLegacyFiles(legacyDir);

  /** @type {Map<string, { session: import('./sessionParser').SessionRecord, rows: import('./sessionParser').RequestRow[] }>} */
  const out = new Map();
  /** @type {Map<string, string>} */
  const execToSession = new Map();

  for (const dir of sessionDirs) {
    const index = await readJson(path.join(dir, 'sessions.json'));
    /** @type {Map<string, any>} */
    const byId = new Map((Array.isArray(index) ? index : []).filter((x) => x && x.sessionId).map((x) => [String(x.sessionId), x]));
    for (const f of await readdirSafe(dir)) {
      if (!f.isFile() || !f.name.endsWith('.json') || f.name === 'sessions.json') continue;
      const file = path.join(dir, f.name);
      const data = await readJson(file);
      if (!data || typeof data !== 'object') continue;
      const sid = String(data.sessionId || f.name.replace(/\.json$/, ''));
      const idx = byId.get(sid) || {};
      let mtime = null;
      try {
        mtime = (await fsp.stat(file)).mtimeMs;
      } catch {
        /* ignore */
      }
      const history = Array.isArray(data.history) ? data.history : [];
      const s = emptySession(`legacy:${sid}`, 'legacy');
      s.title = String(data.title || idx.title || '');
      const wsDir = data.workspaceDirectory || idx.workspaceDirectory;
      s.workspaces = typeof wsDir === 'string' ? [wsDir] : [];
      s.modelId = typeof data.selectedModel === 'string' ? data.selectedModel : null;
      s.agentMode = typeof data.autonomyMode === 'string' ? data.autonomyMode : null;
      s.createdAt = toMs(Number(idx.dateCreated)) ?? mtime;
      s.updatedAt = mtime;
      s.contextPct = typeof data.contextUsagePercentage === 'number' ? data.contextUsagePercentage : null;
      s.userMessages = history.filter((h) => h?.message?.role === 'user').length;
      s.turns = s.userMessages;
      for (const h of history) if (h && typeof h.executionId === 'string') execToSession.set(h.executionId, s.id);
      out.set(s.id, { session: s, rows: [] });
    }
  }

  let i = 0;
  for (const file of chats) {
    if (++i % 10 === 0) await pause();
    const data = await readJson(file);
    if (!data || !Array.isArray(data.chat)) continue;
    const meta = data.metadata || {};
    const chat = data.chat;
    let lastHuman = -1;
    chat.forEach((c, idx) => {
      if (c?.role === 'human') lastHuman = idx;
    });
    let input = 0;
    let output = 0;
    let tools = 0;
    chat.forEach((c, idx) => {
      const t = estimateTokens(contentText(c?.content));
      if (idx > lastHuman && c?.role === 'bot') output += t;
      else input += t;
      if (idx > lastHuman && c?.role === 'tool') tools++;
    });
    const start = toMs(meta.startTime);
    const end = toMs(meta.endTime);
    const sid = execToSession.get(String(data.executionId)) ?? UNLINKED_ID;
    let entry = out.get(sid);
    if (!entry) {
      const s = emptySession(sid, 'legacy');
      s.title = ''; // the UI shows a translated name for UNLINKED_ID
      entry = { session: s, rows: [] };
      out.set(sid, entry);
    }
    const ts = end ?? start;
    entry.rows.push({
      kind: 'main',
      turnId: typeof data.executionId === 'string' ? data.executionId : null,
      requestId: null,
      ts,
      modelId: typeof meta.modelId === 'string' ? meta.modelId : entry.session.modelId,
      contextPct: null,
      credits: null,
      estInputTokens: input,
      estOutputTokens: output,
      durationMs: start != null && end != null && end >= start ? end - start : null,
      status: 'ok',
    });
    const s = entry.session;
    s.toolCalls += tools;
    if (start != null && end != null && end >= start) s.turnTimeMs += end - start;
    if (ts != null) {
      s.updatedAt = Math.max(s.updatedAt ?? 0, ts);
      s.createdAt = s.createdAt == null ? ts : Math.min(s.createdAt, ts);
    }
    if (!s.modelId && typeof meta.modelId === 'string') s.modelId = meta.modelId;
  }

  for (const e of out.values()) e.rows.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  if (out.get(UNLINKED_ID)) {
    const u = /** @type {any} */ (out.get(UNLINKED_ID));
    u.session.turns = u.rows.length;
  }
  return [...out.values()];
}

module.exports = { parseLegacy, legacySignature, listLegacyFiles, UNLINKED_ID };
