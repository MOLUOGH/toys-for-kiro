// @ts-check
'use strict';

// Local index of parsed Kiro data (node:sqlite, bundled with Kiro's Node 24).
// Session-derived rows are rebuilt whenever a session file changes. Log-derived
// rows are only ever added, because Kiro deletes old log folders.

const fs = require('fs');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  sig  TEXT,
  pos  INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  title TEXT,
  workspaces TEXT,
  model_id TEXT,
  agent_mode TEXT,
  created_at INTEGER,
  updated_at INTEGER,
  status TEXT,
  credits_main REAL NOT NULL DEFAULT 0,
  credits_delegated REAL NOT NULL DEFAULT 0,
  credits_aux REAL NOT NULL DEFAULT 0,
  context_pct REAL,
  turns INTEGER NOT NULL DEFAULT 0,
  user_messages INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  tool_time_ms INTEGER NOT NULL DEFAULT 0,
  turn_time_ms INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS session_requests (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  turn_id TEXT,
  request_id TEXT,
  ts INTEGER,
  model_id TEXT,
  context_pct REAL,
  credits REAL,
  est_input_tokens INTEGER,
  est_output_tokens INTEGER,
  duration_ms INTEGER,
  status TEXT,
  PRIMARY KEY (session_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_sr_request ON session_requests(request_id);
CREATE INDEX IF NOT EXISTS idx_sr_ts ON session_requests(ts);
CREATE TABLE IF NOT EXISTS log_requests (
  request_id TEXT PRIMARY KEY,
  ts INTEGER,
  conversation_id TEXT,
  model_id TEXT,
  outcome TEXT,
  error_type TEXT,
  first_event_ms INTEGER,
  first_visible_ms INTEGER,
  duration_ms INTEGER,
  is_retry INTEGER,
  is_fallback INTEGER,
  attempt INTEGER
);
CREATE INDEX IF NOT EXISTS idx_lr_conv ON log_requests(conversation_id);
CREATE INDEX IF NOT EXISTS idx_lr_ts ON log_requests(ts);
`;

const SESSION_COLS = `id, source, title, workspaces, model_id AS modelId, agent_mode AS agentMode,
  created_at AS createdAt, updated_at AS updatedAt, status,
  credits_main AS creditsMain, credits_delegated AS creditsDelegated, credits_aux AS creditsAux,
  context_pct AS contextPct, turns, user_messages AS userMessages, tool_calls AS toolCalls,
  tool_time_ms AS toolTimeMs, turn_time_ms AS turnTimeMs`;

/** SQLite cannot bind undefined, booleans or NaN. @param {unknown} v */
function b(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  return /** @type {any} */ (v);
}

/** @param {any} row */
function sessionFromRow(row) {
  if (!row) return null;
  let workspaces = [];
  try {
    workspaces = row.workspaces ? JSON.parse(row.workspaces) : [];
  } catch {
    /* ignore */
  }
  return { ...row, workspaces };
}

const MEMORY = ':memory:';

/** @param {string} file */
function sidecars(file) {
  return [file, `${file}-wal`, `${file}-shm`, `${file}-journal`];
}

/**
 * Empty the database in place and shrink it, for when the file cannot be deleted.
 * @param {string} file
 */
function clearInPlace(file) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA secure_delete = ON');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
    db.exec('BEGIN');
    for (const t of tables) db.exec(`DELETE FROM "${String(t.name).replace(/"/g, '""')}"`);
    db.exec('COMMIT');
    db.exec('VACUUM');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
}

class Store {
  /** @param {string} dbPath file path, or ':memory:' for an index that is never written to disk */
  constructor(dbPath) {
    const { DatabaseSync } = require('node:sqlite');
    /** @type {Map<string, any>} */
    this.stmts = new Map();
    this.inMemory = dbPath === MEMORY;
    this.closed = false;
    this.db = new DatabaseSync(dbPath);
    if (!this.inMemory) this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.db.exec(SCHEMA);
  }

  /** @param {string} file */
  static exists(file) {
    return sidecars(file).some((p) => fs.existsSync(p));
  }

  /**
   * Remove an index file. Close any Store using it first.
   * On Windows another Kiro window may still hold the file open; then the data is
   * deleted from inside the file instead.
   * @param {string} file
   * @returns {'none' | 'deleted' | 'cleared'}
   */
  static wipe(file) {
    if (!Store.exists(file)) return 'none';
    try {
      fs.rmSync(file, { force: true });
    } catch {
      clearInPlace(file);
      return 'cleared';
    }
    for (const p of sidecars(file).slice(1)) fs.rmSync(p, { force: true });
    return 'deleted';
  }

  /** @param {string} sql */
  prep(sql) {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  /** @template T @param {() => T} fn @returns {T} */
  transaction(fn) {
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // ---- bookkeeping ----

  /** @param {string} path @returns {{ path: string, kind: string, sig: string | null, pos: number } | undefined} */
  getFile(path) {
    return this.prep('SELECT path, kind, sig, pos FROM files WHERE path = ?').get(path);
  }

  /** @param {string} path @param {string} kind @param {string | null} sig @param {number} pos */
  setFile(path, kind, sig, pos) {
    this.prep('INSERT OR REPLACE INTO files (path, kind, sig, pos) VALUES (?, ?, ?, ?)').run(path, kind, b(sig), pos);
  }

  /** @param {string} kind @returns {string[]} */
  listFilePaths(kind) {
    return this.prep('SELECT path FROM files WHERE kind = ?').all(kind).map((/** @type {any} */ r) => r.path);
  }

  /** @param {string} path */
  deleteFile(path) {
    this.prep('DELETE FROM files WHERE path = ?').run(path);
  }

  /** @param {string} key */
  getKv(key) {
    const row = this.prep('SELECT value FROM kv WHERE key = ?').get(key);
    if (!row || row.value == null) return null;
    try {
      return JSON.parse(row.value);
    } catch {
      return null;
    }
  }

  /** @param {string} key @param {unknown} value */
  setKv(key, value) {
    this.prep('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(key, JSON.stringify(value ?? null));
  }

  // ---- writes ----

  /**
   * @param {import('./sessionParser').SessionRecord} s
   * @param {import('./sessionParser').RequestRow[]} rows
   */
  replaceSession(s, rows) {
    this.transaction(() => {
      this.prep(
        `INSERT OR REPLACE INTO sessions (id, source, title, workspaces, model_id, agent_mode, created_at, updated_at, status,
          credits_main, credits_delegated, credits_aux, context_pct, turns, user_messages, tool_calls, tool_time_ms, turn_time_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        s.id, s.source, b(s.title), JSON.stringify(s.workspaces || []), b(s.modelId), b(s.agentMode),
        b(s.createdAt), b(s.updatedAt), b(s.status), b(s.creditsMain) ?? 0, b(s.creditsDelegated) ?? 0,
        b(s.creditsAux) ?? 0, b(s.contextPct), s.turns, s.userMessages, s.toolCalls,
        Math.round(s.toolTimeMs), Math.round(s.turnTimeMs),
      );
      this.prep('DELETE FROM session_requests WHERE session_id = ?').run(s.id);
      const ins = this.prep(
        `INSERT INTO session_requests (session_id, seq, kind, turn_id, request_id, ts, model_id, context_pct, credits,
          est_input_tokens, est_output_tokens, duration_ms, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      rows.forEach((r, i) => {
        ins.run(
          s.id, i, r.kind, b(r.turnId), b(r.requestId), b(r.ts), b(r.modelId), b(r.contextPct), b(r.credits),
          b(r.estInputTokens), b(r.estOutputTokens), b(r.durationMs), b(r.status),
        );
      });
    });
  }

  /** @param {import('./logParser').LogRequest[]} rows */
  upsertLogRequests(rows) {
    if (!rows.length) return;
    this.transaction(() => {
      const ins = this.prep(
        `INSERT OR REPLACE INTO log_requests (request_id, ts, conversation_id, model_id, outcome, error_type,
          first_event_ms, first_visible_ms, duration_ms, is_retry, is_fallback, attempt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const r of rows) {
        ins.run(
          r.requestId, b(r.ts), b(r.conversationId), b(r.modelId), b(r.outcome), b(r.errorType),
          b(r.firstEventMs), b(r.firstVisibleMs), b(r.durationMs), b(r.isRetry), b(r.isFallback), b(r.attempt),
        );
      }
    });
  }

  /**
   * Delete log-derived rows older than `beforeTs`.
   * @param {number} beforeTs
   * @returns {number} rows deleted
   */
  pruneLogRequests(beforeTs) {
    return Number(this.prep('DELETE FROM log_requests WHERE ts < ?').run(beforeTs).changes) || 0;
  }

  /** Drop everything derived from session files (keeps log rows, which may no longer exist on disk). */
  resetDerived() {
    this.transaction(() => {
      this.db.exec("DELETE FROM sessions; DELETE FROM session_requests; DELETE FROM files WHERE kind = 'session';");
      this.prep('DELETE FROM kv WHERE key = ?').run('legacySignature');
    });
  }

  // ---- reads ----

  listSessions() {
    return this.prep(`SELECT ${SESSION_COLS} FROM sessions ORDER BY updated_at DESC`).all().map(sessionFromRow);
  }

  /** @param {string} id */
  getSession(id) {
    return sessionFromRow(this.prep(`SELECT ${SESSION_COLS} FROM sessions WHERE id = ?`).get(id));
  }

  earliestTs() {
    const row = this.prep('SELECT MIN(ts) AS t FROM session_requests').get();
    return row && typeof row.t === 'number' ? row.t : null;
  }

  /**
   * Rows from session files joined with log timing, plus log-only attempts
   * (errors, retries, requests of turns still running) for known sessions.
   * @param {{ from: number, to: number, sessionId?: string | null }} q
   */
  queryRows(q) {
    const bySession = q.sessionId ? ' AND sr.session_id = ?' : '';
    const sessionParams = q.sessionId ? [q.from, q.to, q.sessionId] : [q.from, q.to];
    const sessionRows = this.prep(
      `SELECT sr.session_id AS sessionId, sr.seq, sr.kind, sr.turn_id AS turnId, sr.request_id AS requestId,
              COALESCE(sr.ts, lr.ts) AS ts, COALESCE(lr.model_id, sr.model_id) AS modelId,
              sr.context_pct AS contextPct, sr.credits, sr.est_input_tokens AS estInputTokens,
              sr.est_output_tokens AS estOutputTokens, COALESCE(lr.duration_ms, sr.duration_ms) AS durationMs,
              lr.first_event_ms AS firstEventMs, lr.first_visible_ms AS firstVisibleMs, lr.outcome,
              lr.error_type AS errorType, lr.is_retry AS isRetry, lr.is_fallback AS isFallback,
              sr.status, s.source, s.title AS sessionTitle
         FROM session_requests sr
         JOIN sessions s ON s.id = sr.session_id
         LEFT JOIN log_requests lr ON sr.request_id IS NOT NULL AND lr.request_id = sr.request_id
        WHERE COALESCE(sr.ts, lr.ts) >= ? AND COALESCE(sr.ts, lr.ts) < ?${bySession}`,
    ).all(...sessionParams);
    const byConv = q.sessionId ? ' AND lr.conversation_id = ?' : '';
    const logRows = this.prep(
      `SELECT lr.conversation_id AS sessionId, lr.request_id AS requestId, lr.ts, lr.model_id AS modelId,
              lr.duration_ms AS durationMs, lr.first_event_ms AS firstEventMs, lr.first_visible_ms AS firstVisibleMs,
              lr.outcome, lr.error_type AS errorType, lr.is_retry AS isRetry, lr.is_fallback AS isFallback,
              s.source, s.title AS sessionTitle
         FROM log_requests lr
         JOIN sessions s ON s.id = lr.conversation_id
        WHERE NOT EXISTS (SELECT 1 FROM session_requests sr WHERE sr.request_id = lr.request_id)
          AND lr.ts >= ? AND lr.ts < ?${byConv}`,
    ).all(...sessionParams);
    return { sessionRows, logRows };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.stmts.clear();
    this.db.close();
  }
}

module.exports = { Store, MEMORY };
