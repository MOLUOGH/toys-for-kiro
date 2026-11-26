'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseAttemptLine, parseUsageLimitsLine, readNewLines } = require('../src/core/logParser');
const { fromUsageLimitsOutput, fromUsageState, mergeQuota } = require('../src/core/quota');

const ATTEMPT =
  '2026-03-14 09:26:53.589 [info] q.converse.model_call_attempt {"api":"GenerateAssistantResponse","requestId":"r-1","conversationId":"sess_x","modelId":"claude-opus-5.5","attemptNumber":1,"isRetry":false,"isFallback":false,"headersMs":1200,"firstEventMs":1200,"firstVisibleMs":1500,"durationMs":3000,"outcome":"error","errorType":"ServerConnectionResetError"}';
const LIMITS =
  '2026-03-14 09:20:00.000 [info] {"clientName":"CodeWhispererRuntimeClient","commandName":"GetUsageLimitsCommand","input":{},"output":{"nextDateReset":"2026-04-01T00:00:00.000Z","usageBreakdownList":[{"currentUsage":120,"usageLimit":1000,"resourceType":"CREDIT","currentUsageWithPrecision":120.5,"usageLimitWithPrecision":1000,"overageRate":0.04,"nextDateReset":"2026-04-01T00:00:00.000Z","bonuses":[{"displayName":"Bonus credits","currentUsage":0,"usageLimit":100,"expiresAt":"2027-01-01T00:00:00.000Z","status":"ACTIVE"}]}],"subscriptionInfo":{"subscriptionTitle":"Example Plan"},"overageConfiguration":{"overageStatus":"DISABLED"},"userInfo":{"userId":"secret"}}}';

test('parses model call attempts with local timestamps', () => {
  const r = parseAttemptLine(ATTEMPT);
  assert.ok(r);
  assert.equal(r.requestId, 'r-1');
  assert.equal(r.conversationId, 'sess_x');
  assert.equal(r.outcome, 'error');
  assert.equal(r.errorType, 'ServerConnectionResetError');
  assert.equal(r.firstEventMs, 1200);
  assert.equal(r.durationMs, 3000);
  assert.equal(r.ts, new Date(2026, 2, 14, 9, 26, 53, 589).getTime());
  assert.equal(parseAttemptLine('2026-03-14 09:26:53.589 [info] q.converse.dispatch {"modelId":"x"}'), null);
  assert.equal(parseAttemptLine('garbage model_call_attempt {'), null);
});

test('parses usage limits and drops account identifiers', () => {
  const q = parseUsageLimitsLine(LIMITS);
  assert.ok(q);
  const snap = fromUsageLimitsOutput(q.output, q.ts);
  assert.ok(snap);
  assert.equal(snap.plan, 'Example Plan');
  assert.equal(snap.used, 120.5);
  assert.equal(snap.limit, 1000);
  assert.equal(snap.overageEnabled, false);
  assert.equal(snap.bonuses[0].limit, 100);
  assert.ok(!JSON.stringify(snap).includes('secret'));
});

test('mergeQuota prefers the newer usage numbers but keeps the plan name', () => {
  const client = fromUsageLimitsOutput(parseUsageLimitsLine(LIMITS).output, 1000);
  const state = fromUsageState({
    usageBreakdowns: [{ type: 'CREDIT', currentUsage: 130.25, usageLimit: 1000, overageRate: 0.04, resetDate: '2026-04-01T00:00:00.000Z', bonuses: [] }],
    timestamp: 2000,
  });
  const q = mergeQuota(state, client);
  assert.equal(q.used, 130.25);
  assert.equal(q.plan, 'Example Plan');
  assert.equal(q.source, 'state');
  assert.equal(q.bonuses.length, 1); // falls back to the client's bonuses
  assert.equal(mergeQuota(null, null), null);
});

test('readNewLines returns only complete lines and resumes from the offset', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-log-'));
  const file = path.join(dir, 'a.log');
  fs.writeFileSync(file, 'one\r\ntwo\nthr');
  const a = await readNewLines(file, 0);
  assert.deepEqual(a.lines, ['one', 'two']);
  fs.appendFileSync(file, 'ee\n中文\n');
  const b = await readNewLines(file, a.pos);
  assert.deepEqual(b.lines, ['three', '中文']);
  const c = await readNewLines(file, b.pos);
  assert.deepEqual(c.lines, []);
  fs.writeFileSync(file, 'new\n'); // truncated and rewritten
  const d = await readNewLines(file, c.pos);
  assert.deepEqual(d.lines, ['new']);
  assert.equal(await readNewLines(path.join(dir, 'missing.log'), 0), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
