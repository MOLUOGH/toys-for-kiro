'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSession, unionMs, normalizeModelId } = require('../src/core/sessionParser');
const { estimateTokens } = require('../src/core/estimate');

let clock = Date.parse('2026-11-25T10:00:00.000Z');
/** @param {object} payload */
const rec = (payload) => JSON.stringify({ id: String(clock), timestamp: new Date((clock += 1000)).toISOString(), payload });
const split = (main, aux = 0, delegated = 0) => rec({ type: 'session_metadata', key: 'creditSplit', value: { main, delegated, auxiliary: aux }, executionId: '' });
const ctx = (turnId, pct) => rec({ type: 'session_metadata', key: 'contextUsage', value: { usagePercentage: pct }, executionId: turnId });

function fixture() {
  clock = Date.parse('2026-11-25T10:00:00.000Z');
  return [
    rec({ type: 'agent_note', content: 'x' }),
    rec({ type: 'user', content: 'hello', images: [] }),
    rec({ type: 'turn_start', turnId: 't1', executionId: 't1' }),
    split(0, 0.01),
    rec({ type: 'assistant', content: 'abcdefgh', turnId: 't1', reasoningModelId: 'qdev::claude-opus-5.5' }),
    rec({ type: 'tool_call', toolCallId: 'c1', toolName: 'read', args: { p: 1 }, turnId: 't1' }),
    split(0.5, 0.01),
    ctx('t1', 1.5),
    rec({ type: 'tool_result', toolCallId: 'c1', content: 'file', turnId: 't1' }),
    rec({ type: 'assistant', content: '完成了', turnId: 't1' }),
    split(0.8, 0.02),
    ctx('t1', 2.25),
    rec({ type: 'usage_summary', promptTurnSummaries: [{ usage: 0.8 }], elapsedTime: 9000, status: 'success', turnId: 't1', requestIds: ['r1', 'r2'] }),
    rec({ type: 'turn_end', stopReason: 'end_turn', turnId: 't1' }),
    // Second turn: cancelled after one metered request.
    rec({ type: 'user', content: 'more' }),
    rec({ type: 'turn_start', turnId: 't2', executionId: 't2' }),
    rec({ type: 'assistant', content: 'abcd', turnId: 't2' }),
    split(1.0, 0.02, 0.3),
    ctx('t2', 3),
    rec({ type: 'assistant', content: 'partial answer', turnId: 't2' }),
    rec({ type: 'usage_summary', elapsedTime: 4000, status: 'aborted', turnId: 't2', requestIds: ['r3', 'r4'] }),
    rec({ type: 'turn_end', stopReason: 'cancelled', turnId: 't2' }),
    // Third turn still running: no usage_summary yet.
    rec({ type: 'turn_start', turnId: 't3', executionId: 't3' }),
    rec({ type: 'assistant', content: 'x', turnId: 't3' }),
    split(1.25, 0.02, 0.3),
    ctx('t3', 3.5),
    '{"id":"broken","timestamp":"2026-11-25T10:00:00Z","payload":{"type":"assistant","content":"cut',
  ].join('\n');
}

const meta = {
  id: 'sess_a',
  title: 'Demo',
  workspacePaths: ['d:\\proj'],
  modelId: 'claude-opus-5.5',
  agentMode: 'vibe',
  createdAt: '2026-11-25T09:59:00.000Z',
  lastModifiedAt: '2026-11-25T10:00:10.000Z',
  status: 'in_progress',
};

test('pairs metered requests with requestIds in order', () => {
  const { session, rows } = parseSession(meta, fixture());
  const main = rows.filter((r) => r.kind === 'main');
  assert.deepEqual(
    main.map((r) => [r.turnId, r.requestId, r.contextPct, r.status]),
    [
      ['t1', 'r1', 1.5, 'ok'],
      ['t1', 'r2', 2.25, 'ok'],
      ['t2', 'r3', 3, 'ok'],
      ['t2', 'r4', null, 'cancelled'],
      ['t3', null, 3.5, 'ok'],
    ],
  );
  assert.deepEqual(main.map((r) => Number(r.credits.toFixed(4))), [0.5, 0.3, 0.2, 0, 0.25]);
  assert.equal(main[0].modelId, 'claude-opus-5.5');
  assert.equal(main[0].estOutputTokens, estimateTokens('abcdefgh' + 'read{"p":1}'));
  assert.equal(main[1].estOutputTokens, 3); // three CJK characters
  assert.equal(main[3].estOutputTokens, estimateTokens('partial answer'));

  assert.equal(session.turns, 3);
  assert.equal(session.userMessages, 2);
  assert.equal(session.toolCalls, 1);
  assert.equal(session.contextPct, 3.5);
  assert.equal(session.creditsMain, 1.25);
  assert.equal(session.creditsDelegated, 0.3);
  assert.equal(session.creditsAux, 0.02);
  assert.equal(session.turnTimeMs, 13000);
  assert.equal(session.toolTimeMs, 3000);
  assert.deepEqual(session.workspaces, ['d:\\proj']);
});

test('auxiliary and delegated credits become credit-only rows that sum to the totals', () => {
  const { session, rows } = parseSession(meta, fixture());
  const sum = (kind) => rows.filter((r) => r.kind === kind).reduce((s, r) => s + (r.credits || 0), 0);
  assert.ok(Math.abs(sum('main') - session.creditsMain) < 1e-9);
  assert.ok(Math.abs(sum('aux') - session.creditsAux) < 1e-9);
  assert.ok(Math.abs(sum('delegated') - session.creditsDelegated) < 1e-9);
});

test('works without session.json', () => {
  const { session, rows } = parseSession(null, fixture(), { sessionId: 'sess_b', mtimeMs: 1 });
  assert.equal(session.id, 'sess_b');
  assert.equal(session.modelId, 'claude-opus-5.5');
  assert.ok(session.createdAt);
  assert.equal(rows.filter((r) => r.kind === 'main').length, 5);
});

test('helpers', () => {
  assert.equal(unionMs([[0, 10], [5, 15], [20, 25]]), 20);
  assert.equal(unionMs([]), 0);
  assert.equal(normalizeModelId('qdev::claude-opus-5.5'), 'claude-opus-5.5');
  assert.equal(normalizeModelId('auto'), 'auto');
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('中文ab'), 3);
});
