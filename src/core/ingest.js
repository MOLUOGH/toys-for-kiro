// @ts-check
'use strict';

const fsp = require('fs/promises');
const path = require('path');
const { parseSession, PARSER_VERSION } = require('./sessionParser');
const { findLogFiles, readNewLines, parseAttemptLine, parseUsageLimitsLine, readdirSafe } = require('./logParser');
const { parseLegacy, legacySignature } = require('./legacyParser');
const { readUsageState, fromUsageState, fromUsageLimitsOutput, mergeQuota } = require('./quota');

const LOG_LIST_TTL_MS = 60_000;
const pause = () => new Promise((r) => setImmediate(r));

/** @param {string} p */
async function statSafe(p) {
  try {
    return await fsp.stat(p);
  } catch {
    return null;
  }
}

/** @param {string} p */
async function readSafe(p) {
  try {
    return await fsp.readFile(p, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Incrementally copies Kiro's local data into the Store. All file IO is async and
 * the loop yields between files, because the extension host is shared with Kiro's agent.
 */
class Ingestor {
  /**
   * @param {{ store: import('./store').Store, paths: ReturnType<typeof import('./paths').resolveKiroPaths>, log?: (msg: string) => void }} deps
   */
  constructor({ store, paths, log }) {
    this.store = store;
    this.paths = paths;
    this.log = log || (() => {});
    /** @type {Array<{ path: string, kind: 'agent' | 'client' }> | null} */
    this.logFiles = null;
    this.logFilesAt = 0;
  }

  checkParserVersion() {
    if (this.store.getKv('parserVersion') !== PARSER_VERSION) {
      this.store.resetDerived();
      this.store.setKv('parserVersion', PARSER_VERSION);
    }
  }

  async scanSessions() {
    const { store } = this;
    let changed = 0;
    for (const group of await readdirSafe(this.paths.sessionsDir)) {
      if (!group.isDirectory()) continue;
      const groupDir = path.join(this.paths.sessionsDir, group.name);
      for (const e of await readdirSafe(groupDir)) {
        if (!e.isDirectory() || !e.name.startsWith('sess_')) continue;
        const dir = path.join(groupDir, e.name);
        const msgPath = path.join(dir, 'messages.jsonl');
        const metaPath = path.join(dir, 'session.json');
        const [ms, mt] = await Promise.all([statSafe(msgPath), statSafe(metaPath)]);
        if (!ms && !mt) continue;
        const sig = `${PARSER_VERSION}:${ms?.size ?? -1}:${ms?.mtimeMs ?? 0}:${mt?.size ?? -1}:${mt?.mtimeMs ?? 0}`;
        if (store.getFile(dir)?.sig === sig) continue;

        const [metaText, jsonl] = await Promise.all([readSafe(metaPath), readSafe(msgPath)]);
        let meta = null;
        let metaOk = true;
        if (metaText) {
          try {
            meta = JSON.parse(metaText);
          } catch {
            metaOk = false; // being rewritten; retry next scan
          }
        }
        const parsed = parseSession(meta, jsonl || '', { sessionId: e.name, mtimeMs: ms?.mtimeMs });
        store.replaceSession(parsed.session, parsed.rows);
        if (metaOk) store.setFile(dir, 'session', sig, 0);
        changed++;
        await pause();
      }
    }
    return changed;
  }

  async scanLogs() {
    const { store } = this;
    const now = Date.now();
    if (!this.logFiles || now - this.logFilesAt > LOG_LIST_TTL_MS) {
      this.logFiles = await findLogFiles(this.paths.logsDir);
      this.logFilesAt = now;
    }
    let requests = 0;
    /** @type {import('./quota').QuotaSnapshot | null} */
    let latestClient = null;
    for (const f of this.logFiles) {
      const prevPos = store.getFile(f.path)?.pos ?? 0;
      const res = await readNewLines(f.path, prevPos);
      if (!res || res.pos === prevPos) continue;
      /** @type {import('./logParser').LogRequest[]} */
      const rows = [];
      for (const line of res.lines) {
        if (f.kind === 'agent') {
          const r = parseAttemptLine(line);
          if (r) rows.push(r);
        } else {
          const q = parseUsageLimitsLine(line);
          const snap = q && fromUsageLimitsOutput(q.output, q.ts);
          if (snap && (!latestClient || (snap.updatedAt ?? 0) >= (latestClient.updatedAt ?? 0))) latestClient = snap;
        }
      }
      store.upsertLogRequests(rows);
      store.setFile(f.path, 'log', null, res.pos);
      requests += rows.length;
      await pause();
    }
    if (latestClient) {
      const prev = store.getKv('clientQuota');
      if (!prev || (latestClient.updatedAt ?? 0) >= (prev.updatedAt ?? 0)) store.setKv('clientQuota', latestClient);
    }
    return { requests, quota: !!latestClient };
  }

  async scanLegacy() {
    const sig = await legacySignature(this.paths.legacyDir);
    if (!sig || this.store.getKv('legacySignature') === sig) return 0;
    const sessions = await parseLegacy(this.paths.legacyDir);
    for (const s of sessions) {
      this.store.replaceSession(s.session, s.rows);
      await pause();
    }
    this.store.setKv('legacySignature', sig);
    return sessions.length;
  }

  /**
   * Drop log-derived rows older than `days` (0 = keep forever). Data from Kiro's
   * session files is not affected: Kiro keeps those itself.
   * @param {number} days
   * @param {number} [now]
   */
  prune(days, now = Date.now()) {
    if (!(days > 0)) return 0;
    return this.store.pruneLogRequests(now - days * 86_400_000);
  }

  scanQuota() {
    const state = fromUsageState(readUsageState(this.paths.globalStateDb));
    const q = mergeQuota(state, this.store.getKv('clientQuota'));
    if (!q) return false;
    const prev = this.store.getKv('quota');
    if (JSON.stringify(prev) === JSON.stringify(q)) return false;
    this.store.setKv('quota', q);
    return true;
  }

  /**
   * @param {{ legacy?: boolean, quota?: boolean }} [opts]
   */
  async run(opts = {}) {
    const result = { sessions: 0, requests: 0, legacy: 0, quota: false, changed: false };
    this.checkParserVersion();
    /** @param {string} name @param {() => Promise<void> | void} fn */
    const step = async (name, fn) => {
      try {
        await fn();
      } catch (e) {
        this.log(`${name} failed: ${e instanceof Error ? e.stack || e.message : String(e)}`);
      }
    };
    await step('sessions', async () => {
      result.sessions = await this.scanSessions();
    });
    await step('logs', async () => {
      const r = await this.scanLogs();
      result.requests = r.requests;
      result.quota = r.quota;
    });
    if (opts.legacy) {
      await step('legacy', async () => {
        result.legacy = await this.scanLegacy();
      });
    }
    if (opts.quota || result.quota) {
      await step('quota', () => {
        result.quota = this.scanQuota() || result.quota;
      });
    }
    result.changed = result.sessions > 0 || result.requests > 0 || result.legacy > 0 || result.quota;
    return result;
  }
}

module.exports = { Ingestor };
