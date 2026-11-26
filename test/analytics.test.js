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
  assert.equal(o.heatmap.unit, 5 * 60_000); // a 2-hour range is drawn as a whole day of 5-minute cells
  const busy = o.heatmap.cells.flat().filter((c) => c && c.requests > 0);
  assert.equal(busy.length, 1); // everything happened within 10:00–10:05
  assert.equal(busy[0].requests, 3);
  assert.equal(busy[0].t0, T0);
  assert.ok(Math.abs(busy[0].credits - 0.8) < 1e-9);
  assert.equal(o.health.overall, 0.5);
  assert.deepEqual(o.health.models.map((m) => [m.model, m.rate]), [['m1', 0.5], ['m2', null]]);
  assert.equal(o.distribution.credits.find((x) => x.label === '@aux').value, 0.05);
});

test('heatmap picks a cell size that fills 7 rows and up to 53 columns for every range', () => {
  const MIN = 60_000;
  const H = 60 * MIN;
  const D = 24 * H;
  const now = new Date(2026, 10, 25, 9, 30).getTime(); // Wednesday morning
  const cases = [
    // [range, expected cell size]
    [{ from: a.startOfDay(now), to: now + 1 }, 5 * MIN], // today: whole day
    [{ from: now - D, to: now + 1 }, 5 * MIN],
    [{ from: now - 7 * D, to: now + 1 }, 30 * MIN],
    [{ from: now - 30 * D, to: now + 1 }, 2 * H], // the billing-cycle case from the screenshot
    [{ from: now - 90 * D, to: now + 1 }, 6 * H],
    [{ from: now - 400 * D, to: now + 1 }, D],
  ];
  for (const [r, unit] of cases) {
    const h = a.buildHeatmap([], { key: 'x', label: '', ...r });
    const label = `${Math.round((r.to - r.from) / H)}h range`;
    assert.equal(h.unit, unit, label);
    assert.ok(h.cols <= 53, `${label}: ${h.cols} columns`);
    assert.ok(h.cols >= 27, `${label}: only ${h.cols} columns`);
    assert.equal(h.cells.length, h.cols);
    assert.ok(h.cells.every((col) => col.length === 7));
    assert.equal(h.colStarts.length, h.cols);
    // Cells are contiguous and cover the range.
    const cells = h.cells.flat().filter(Boolean);
    for (let i = 1; i < cells.length; i++) assert.equal(cells[i].t0, cells[i - 1].t1, `${label}: gap at ${i}`);
    assert.ok(cells.at(-1).t1 >= r.to - 1, `${label}: reaches now`);
    // Ranges longer than 53 weeks show only the most recent 53 weeks.
    if (unit < D) assert.ok(cells[0].t0 <= r.from, `${label}: covers the start`);
    // Sub-day cells start on round local times, also after the DST change on 2026-11-01.
    if (unit < D) assert.ok(cells.every((c) => (new Date(c.t0).getHours() * 60 + new Date(c.t0).getMinutes()) % (unit / MIN) === 0), `${label}: aligned`);
  }
  // Today: cells after now stay blank.
  const today = a.buildHeatmap([], { key: 'today', label: '', from: a.startOfDay(now), to: now + 1 });
  assert.equal(today.end - today.start, D);
  assert.ok(today.cells.flat().filter(Boolean).every((c) => c.t0 <= now));
  // Daily cells: weeks start on Monday, at most 53 of them.
  const year = a.buildHeatmap([], { key: 'all', label: '', from: now - 400 * D, to: now + 1 });
  assert.equal(new Date(year.start).getDay(), 1);
  assert.equal(year.cols, 53);
});

test('heatmap puts each request in the cell that contains it', () => {
  const now = new Date(2026, 10, 25, 9, 30).getTime();
  const from = now - 30 * 86_400_000;
  const t = new Date(2026, 10, 24, 13, 59).getTime(); // falls in the 12:00–14:00 cell
  const rows = a.enrichRows([{ kind: 'main', ts: t, contextPct: 1, credits: 2, estOutputTokens: 0, status: 'ok' }], settings);
  const h = a.buildHeatmap(rows, { key: '30d', label: '', from, to: now + 1 });
  const hit = h.cells.flat().filter((c) => c && c.requests);
  assert.equal(hit.length, 1);
  assert.equal(hit[0].t0, new Date(2026, 10, 24, 12, 0).getTime());
  assert.equal(hit[0].credits, 2);
  assert.equal(hit[0].tokens, 10_000);
});

test('resolveRange derives the billing cycle from the reset date', () => {
  const now = Date.parse('2026-11-26T06:00:00Z');
  const r = a.resolveRange('cycle', { now, quota: { resetAt: '2026-12-01T00:00:00.000Z' } });
  assert.equal(r.from, Date.parse('2026-11-01T00:00:00Z'));
  assert.equal(r.label, 'range.cycle');
  assert.equal(r.utc, true);
  const fallback = a.resolveRange('cycle', { now, quota: null });
  assert.equal(fallback.from, now - 30 * 86_400_000);
  assert.equal(fallback.label, 'range.cycleFallback');
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

test('billing dates and daily credits follow UTC calendar days', () => {
  const f = require('../src/format');
  assert.equal(f.billingDay('2026-12-01T00:00:00.000Z'), '12/1');
  assert.equal(f.billingDay(null), '—');
  const cycle = { key: 'cycle', label: '', from: Date.parse('2026-11-01T00:00:00Z'), to: Date.parse('2026-11-03T12:00:00Z'), utc: true };
  const rows = [
    { kind: 'main', ts: Date.parse('2026-11-01T00:30:00Z'), credits: 1 },
    { kind: 'main', ts: Date.parse('2026-11-01T23:59:00Z'), credits: 2 },
    { kind: 'aux', ts: Date.parse('2026-11-02T00:01:00Z'), credits: 0.5 },
  ];
  const days = a.buildDaily(rows, cycle, { utc: true });
  assert.deepEqual(days.map((d) => new Date(d.day).toISOString().slice(0, 10)), ['2026-11-01', '2026-11-02', '2026-11-03']);
  assert.deepEqual(days.map((d) => d.credits), [3, 0.5, 0]);
  assert.deepEqual(days.map((d) => d.requests), [2, 0, 0]);
});
