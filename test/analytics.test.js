'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const a = require('../src/core/analytics');

const settings = { contextWindowTokens: 1_000_000, modelContextWindows: { small: 200_000 } };
const T0 = new Date(2026, 10, 25, 10, 0, 0).getTime();

test('reconcile attaches log timing to running-turn rows and keeps log-only errors', () => {
  const sessionRows = [
    { sessionId: 's1', kind: 'main', requestId: 'r1', ts: T0, outcome: 'ok', durationMs: 1000 },
    { sessionId: 's1', kind: 'main', requestId: null, ts: T0 + 10_000 },
    { sessionId: 's1', kind: 'main', requestId: null, ts: T0 + 20_000 },
  ];
  const logRows = [
    { sessionId: 's1', requestId: 'x-old', ts: T0 + 1000, outcome: 'ok', durationMs: 5 },
    { sessionId: 's1', requestId: 'r2', ts: T0 + 9_000, outcome: 'ok', durationMs: 2000, firstEventMs: 500 },
    { sessionId: 's1', requestId: 'r3', ts: T0 + 19_000, outcome: 'ok', durationMs: 3000, firstEventMs: 600 },
    { sessionId: 's1', requestId: 'e1', ts: T0 + 15_000, outcome: 'error', errorType: 'Boom' },
  ];
  const rows = a.reconcile(sessionRows, logRows);
  assert.equal(rows[1].requestId, 'r2');
  assert.equal(rows[2].requestId, 'r3');
  assert.equal(rows[2].firstEventMs, 600);
  const extra = rows.slice(3).map((r) => r.requestId).sort();
  assert.deepEqual(extra, ['e1', 'x-old']);
  assert.ok(rows.slice(3).every((r) => r.logOnly && r.kind === 'main'));
});

test('enrichRows converts context percentage with per-model windows', () => {
  const rows = a.enrichRows(
    [
      { kind: 'main', modelId: 'big', contextPct: 10, credits: 1, estOutputTokens: 100, durationMs: 2500, firstEventMs: 500, status: 'ok' },
      { kind: 'main', modelId: 'small', contextPct: 10, credits: null, estOutputTokens: 0, status: 'cancelled' },
      { kind: 'main', modelId: 'old', estInputTokens: 42, estOutputTokens: 7, source: 'legacy', durationMs: 9000, status: 'ok' },
    ],
    settings,
  );
  assert.equal(rows[0].inputTokens, 100_000);
  assert.equal(rows[0].speed, 50); // 100 tokens over 2 s of generation
  assert.equal(rows[1].inputTokens, 20_000);
  assert.equal(rows[1].credits, 0);
  assert.equal(rows[1].creditsKnown, false);
  assert.equal(rows[1].outcome, 'cancelled');
  assert.equal(rows[2].inputTokens, 42);
  assert.equal(rows[2].speed, null);
});

test('overview totals, heatmap and health', () => {
  const range = { key: '24h', label: '', from: T0 - 3_600_000, to: T0 + 3_600_000 };
  const rows = a.enrichRows(
    [
      { kind: 'main', sessionId: 's', modelId: 'm1', ts: T0, contextPct: 1, credits: 0.5, estOutputTokens: 10, outcome: 'ok', firstEventMs: 1000 },
      { kind: 'main', sessionId: 's', modelId: 'm1', ts: T0 + 60_000, contextPct: 2, credits: 0.25, estOutputTokens: 20, outcome: 'error', firstEventMs: 3000 },
      { kind: 'main', sessionId: 's', modelId: 'm2', ts: T0 + 120_000, credits: 0, outcome: 'cancelled' },
      { kind: 'aux', sessionId: 's', ts: T0 + 130_000, credits: 0.05 },
    ],
    settings,
  );
  const o = a.buildOverview(rows, { range, price: 0.04 });
  assert.equal(o.totals.requests, 3);
  assert.equal(o.totals.ok, 1);
  assert.equal(o.totals.errors, 1);
  assert.equal(o.totals.cancelled, 1);
  assert.equal(o.totals.inputTokens, 30_000);
  assert.equal(o.totals.outputTokens, 30);
  assert.ok(Math.abs(o.totals.credits - 0.8) < 1e-9);
  assert.ok(Math.abs(o.totals.avgCredits - 0.375) < 1e-9);
  assert.equal(o.totals.avgTtftMs, 2000);
  assert.equal(o.heatmap.mode, 'hourly');
  const hour = o.heatmap.cells.flat().find((c) => c.requests > 0);
  assert.equal(hour.requests, 3);
  assert.ok(Math.abs(hour.credits - 0.8) < 1e-9);
  assert.equal(o.health.overall, 0.5);
  assert.deepEqual(o.health.models.map((m) => [m.model, m.rate]), [['m1', 0.5], ['m2', null]]);
  assert.equal(o.distribution.credits.find((x) => x.label.startsWith('辅助')).value, 0.05);
});

test('daily heatmap covers at most 53 weeks and blanks days outside the range', () => {
  const to = new Date(2026, 10, 25, 12).getTime();
  const range = { key: 'all', label: '', from: to - 400 * 86_400_000, to };
  const h = a.buildHeatmap([], range);
  assert.equal(h.mode, 'daily');
  assert.ok(h.weeks.length <= 53 && h.weeks.length >= 52);
  // 2026-11-25 is a Wednesday; 31 days earlier is a Sunday, so the first week starts before the range.
  const short = a.buildHeatmap([], { key: '30d', label: '', from: to - 31 * 86_400_000, to });
  assert.ok(short.cells[0].some((c) => c === null));
  assert.ok(short.cells.at(-1).some((c) => c === null)); // days after today
});

test('resolveRange derives the billing cycle from the reset date', () => {
  const now = Date.parse('2026-11-26T06:00:00Z');
  const r = a.resolveRange('cycle', { now, quota: { resetAt: '2026-12-01T00:00:00.000Z' } });
  assert.equal(r.from, Date.parse('2026-11-01T00:00:00Z'));
  assert.equal(r.label, '本计费周期');
  const fallback = a.resolveRange('cycle', { now, quota: null });
  assert.equal(fallback.from, now - 30 * 86_400_000);
  assert.equal(a.resolveRange('today', { now }).from, a.startOfDay(now));
});

test('session stats use exact session credits and estimate model time without logs', () => {
  const session = { id: 's', source: 'v1', title: 't', workspaces: ['d:\\p'], modelId: 'm', creditsMain: 2, creditsDelegated: 0.5, creditsAux: 0.1, contextPct: 5, turns: 2, toolCalls: 3, turnTimeMs: 10_000, toolTimeMs: 4_000 };
  const rows = a.enrichRows([{ kind: 'main', modelId: 'm', ts: 1, contextPct: 5, credits: 2, estOutputTokens: 50, status: 'ok' }], settings);
  const s = a.buildSessionStats(session, rows, { price: 0.04, settings });
  assert.ok(Math.abs(s.credits.total - 2.6) < 1e-9);
  assert.ok(Math.abs(s.credits.usd - 0.104) < 1e-9);
  assert.equal(s.context.tokens, 50_000);
  assert.equal(s.timing.modelTimeMs, 6_000);
  assert.equal(s.timing.modelTimeEstimated, true);
  assert.equal(s.requests, 1);
});
