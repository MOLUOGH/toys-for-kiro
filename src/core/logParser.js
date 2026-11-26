// @ts-check
'use strict';

const fsp = require('fs/promises');
const path = require('path');

const MAX_CHUNK = 32 * 1024 * 1024;
const TS = String.raw`^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3}) \[\w+\] `;
const ATTEMPT_RE = new RegExp(TS + String.raw`q\.converse\.model_call_attempt (\{.*\})\s*$`);
const CLIENT_RE = new RegExp(TS + String.raw`(\{.*\})\s*$`);

/**
 * @typedef {object} LogRequest
 * @property {string} requestId
 * @property {number} ts
 * @property {string | null} conversationId
 * @property {string | null} modelId
 * @property {string | null} outcome
 * @property {string | null} errorType
 * @property {number | null} firstEventMs
 * @property {number | null} firstVisibleMs
 * @property {number | null} durationMs
 * @property {number} isRetry
 * @property {number} isFallback
 * @property {number | null} attempt
 */

/** Log timestamps are local time without a zone. @param {RegExpExecArray} m */
function localTs(m) {
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]).getTime();
}

/** @param {unknown} v */
function int(v) {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null;
}

/** @param {unknown} v */
function str(v) {
  return typeof v === 'string' && v ? v : null;
}

/**
 * Parse a `q.converse.model_call_attempt` line from "Kiro Logs.log".
 * @param {string} line
 * @returns {LogRequest | null}
 */
function parseAttemptLine(line) {
  if (!line.includes('model_call_attempt')) return null;
  const m = ATTEMPT_RE.exec(line);
  if (!m) return null;
  let d;
  try {
    d = JSON.parse(m[8]);
  } catch {
    return null;
  }
  const requestId = str(d.requestId);
  if (!requestId) return null;
  return {
    requestId,
    ts: localTs(m),
    conversationId: str(d.conversationId),
    modelId: str(d.modelId),
    outcome: str(d.outcome),
    errorType: str(d.errorType),
    firstEventMs: int(d.firstEventMs),
    firstVisibleMs: int(d.firstVisibleMs),
    durationMs: int(d.durationMs),
    isRetry: d.isRetry ? 1 : 0,
    isFallback: d.isFallback ? 1 : 0,
    attempt: int(d.attemptNumber),
  };
}

/**
 * Parse a `GetUsageLimitsCommand` line from "q-client.log".
 * @param {string} line
 * @returns {{ ts: number, output: any } | null}
 */
function parseUsageLimitsLine(line) {
  if (!line.includes('"GetUsageLimitsCommand"')) return null;
  const m = CLIENT_RE.exec(line);
  if (!m) return null;
  try {
    const d = JSON.parse(m[8]);
    if (d.commandName !== 'GetUsageLimitsCommand' || !d.output || typeof d.output !== 'object') return null;
    return { ts: localTs(m), output: d.output };
  } catch {
    return null;
  }
}

/** @param {string} dir */
async function readdirSafe(dir) {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Candidate log files: logs/<launch>/window<N>/exthost/kiro.kiroAgent/{Kiro Logs.log, q-client.log}
 * @param {string} logsDir
 * @returns {Promise<Array<{ path: string, kind: 'agent' | 'client' }>>}
 */
async function findLogFiles(logsDir) {
  /** @type {Array<{ path: string, kind: 'agent' | 'client' }>} */
  const out = [];
  for (const launch of await readdirSafe(logsDir)) {
    if (!launch.isDirectory()) continue;
    const launchDir = path.join(logsDir, launch.name);
    for (const win of await readdirSafe(launchDir)) {
      if (!win.isDirectory() || !/^window\d+$/.test(win.name)) continue;
      const base = path.join(launchDir, win.name, 'exthost', 'kiro.kiroAgent');
      out.push({ path: path.join(base, 'Kiro Logs.log'), kind: 'agent' });
      out.push({ path: path.join(base, 'q-client.log'), kind: 'client' });
    }
  }
  return out;
}

/**
 * Read complete lines appended since byte offset `pos`.
 * @param {string} file
 * @param {number} pos
 * @returns {Promise<{ lines: string[], pos: number } | null>} null when the file is missing
 */
async function readNewLines(file, pos) {
  let st;
  try {
    st = await fsp.stat(file);
  } catch {
    return null;
  }
  let start = pos;
  if (st.size < start) start = 0; // truncated or replaced
  if (st.size === start) return { lines: [], pos: start };
  const len = Math.min(st.size - start, MAX_CHUNK);
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(len);
    const { bytesRead } = await fh.read(buf, 0, len, start);
    const lastNl = bytesRead > 0 ? buf.lastIndexOf(0x0a, bytesRead - 1) : -1;
    if (lastNl < 0) {
      // No complete line yet; skip a pathological line longer than the chunk.
      return { lines: [], pos: bytesRead === MAX_CHUNK ? start + bytesRead : start };
    }
    const text = buf.toString('utf8', 0, lastNl);
    return { lines: text.split(/\r?\n/), pos: start + lastNl + 1 };
  } finally {
    await fh.close();
  }
}

module.exports = { parseAttemptLine, parseUsageLimitsLine, findLogFiles, readNewLines, readdirSafe };
