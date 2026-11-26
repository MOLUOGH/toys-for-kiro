'use strict';

// End-to-end: build a fake Kiro data tree, activate the extension against a
// stubbed vscode API, check the status bar, then render every dashboard view
// with the real webview script in a minimal fake DOM.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { createStub, installStub, loadExtension } = require('./helpers/vscodeStub');

const WORKSPACE = 'd:\\proj\\demo';

function writeFixture(root) {
  const home = path.join(root, 'home');
  const userData = path.join(root, 'Kiro');
  const sess = path.join(home, '.kiro', 'sessions', 'abc123', 'sess_demo');
  fs.mkdirSync(sess, { recursive: true });
  const now = Date.now();
  const iso = (dt) => new Date(now - 60_000 + dt).toISOString();
  fs.writeFileSync(
    path.join(sess, 'session.json'),
    JSON.stringify({ id: 'sess_demo', title: '演示 <会话> | test', workspacePaths: [WORKSPACE], modelId: 'claude-opus-5.5', createdAt: iso(0), lastModifiedAt: iso(9000), status: 'idle' }),
  );
  const rec = (dt, payload) => JSON.stringify({ id: String(dt), timestamp: iso(dt), payload });
  fs.writeFileSync(
    path.join(sess, 'messages.jsonl'),
    [
      rec(0, { type: 'user', content: 'hi' }),
      rec(100, { type: 'turn_start', turnId: 't1', executionId: 't1' }),
      rec(1000, { type: 'assistant', content: 'Let me look. 我来看看', turnId: 't1', reasoningModelId: 'qdev::claude-opus-5.5' }),
      rec(1100, { type: 'tool_call', toolCallId: 'c1', toolName: 'read_file', args: { path: 'a.js' }, turnId: 't1' }),
      rec(1200, { type: 'session_metadata', key: 'creditSplit', value: { main: 0.4, delegated: 0, auxiliary: 0.01 }, executionId: '' }),
      rec(1300, { type: 'session_metadata', key: 'contextUsage', value: { usagePercentage: 2.5 }, executionId: 't1' }),
      rec(3300, { type: 'tool_result', toolCallId: 'c1', content: 'x', turnId: 't1' }),
      rec(5000, { type: 'assistant', content: 'Done.', turnId: 't1' }),
      rec(5100, { type: 'session_metadata', key: 'creditSplit', value: { main: 0.7, delegated: 0, auxiliary: 0.01 }, executionId: '' }),
      rec(5200, { type: 'session_metadata', key: 'contextUsage', value: { usagePercentage: 3.1 }, executionId: 't1' }),
      rec(5300, { type: 'usage_summary', elapsedTime: 5200, status: 'success', turnId: 't1', requestIds: ['req-1', 'req-2'] }),
      rec(5400, { type: 'turn_end', stopReason: 'end_turn', turnId: 't1' }),
    ].join('\n') + '\n',
  );

  const logDir = path.join(userData, 'logs', '20261125T100000', 'window1', 'exthost', 'kiro.kiroAgent');
  fs.mkdirSync(logDir, { recursive: true });
  const pad = (n) => String(n).padStart(2, '0');
  const local = (t) => {
    const d = new Date(t);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
  };
  const attempt = (dt, id, outcome, extra = {}) =>
    `${local(now - 60_000 + dt)} [info] q.converse.model_call_attempt ${JSON.stringify({ requestId: id, conversationId: 'sess_demo', modelId: 'claude-opus-5.5', firstEventMs: 800, firstVisibleMs: 900, durationMs: 1200, outcome, ...extra })}`;
  fs.writeFileSync(
    path.join(logDir, 'Kiro Logs.log'),
    [
      attempt(1300, 'req-1', 'ok'),
      attempt(5200, 'req-2', 'ok'),
      attempt(5250, 'req-err', 'error', { errorType: 'ServerConnectionResetError' }),
      `${local(now)} [info] q.converse.model_call_attempt ${JSON.stringify({ requestId: 'cls', conversationId: 'random-uuid', modelId: 'permission-classifier', outcome: 'ok' })}`,
    ].join('\n') + '\n',
  );
  fs.writeFileSync(
    path.join(logDir, 'q-client.log'),
    `${local(now - 120_000)} [info] ${JSON.stringify({
      commandName: 'GetUsageLimitsCommand',
      output: {
        usageBreakdownList: [{ resourceType: 'CREDIT', currentUsageWithPrecision: 10.5, usageLimitWithPrecision: 1000, overageRate: 0.04, nextDateReset: new Date(now + 5 * 86_400_000).toISOString(), bonuses: [] }],
        subscriptionInfo: { subscriptionTitle: 'Example Plan' },
        overageConfiguration: { overageStatus: 'DISABLED' },
      },
    })}\n`,
  );

  const gs = path.join(userData, 'User', 'globalStorage');
  fs.mkdirSync(gs, { recursive: true });
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(gs, 'state.vscdb'));
  db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
  db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
    'kiro.kiroAgent',
    JSON.stringify({
      'kiro.resourceNotifications.usageState': {
        usageBreakdowns: [{ type: 'CREDIT', currentUsage: 11.2, usageLimit: 1000, overageRate: 0.04, resetDate: new Date(now + 5 * 86_400_000).toISOString(), bonuses: [{ displayName: 'Bonus credits', currentUsage: 0, usageLimit: 100, expiryDate: '2027-01-01T00:00:00Z', status: 'ACTIVE' }] }],
        timestamp: now - 30_000,
      },
    }),
  );
  db.close();

  const legacy = path.join(gs, 'kiro.kiroagent');
  const wsDir = path.join(legacy, 'workspace-sessions', 'ZDpccHJvalxvbGQ_');
  fs.mkdirSync(wsDir, { recursive: true });
  fs.writeFileSync(path.join(wsDir, 'sessions.json'), JSON.stringify([{ sessionId: 'old1', title: 'Old chat', dateCreated: String(now - 10 * 86_400_000), workspaceDirectory: 'd:\\proj\\old' }]));
  fs.writeFileSync(path.join(wsDir, 'old1.json'), JSON.stringify({ sessionId: 'old1', title: 'Old chat', selectedModel: 'claude-opus-4.5', contextUsagePercentage: 12, history: [{ message: { role: 'user', content: 'q' }, executionId: 'exec-1' }, { message: { role: 'assistant', content: 'a' } }] }));
  const hashDir = path.join(legacy, '0123456789abcdef0123456789abcdef');
  fs.mkdirSync(hashDir, { recursive: true });
  fs.writeFileSync(
    path.join(hashDir, 'aa.chat'),
    JSON.stringify({ executionId: 'exec-1', metadata: { modelId: 'claude-opus-4.5', startTime: now - 10 * 86_400_000, endTime: now - 10 * 86_400_000 + 9000 }, chat: [{ role: 'human', content: 'x'.repeat(400) }, { role: 'bot', content: 'y'.repeat(40) }, { role: 'tool', content: 'z' }] }),
  );
  return { home, userData, globalStorage: path.join(gs, 'moluogh.toys-for-kiro') };
}

function fakeDom() {
  const root = { innerHTML: '' };
  const handlers = {};
  const posted = [];
  let state = null;
  const sandbox = {
    document: { getElementById: () => root, addEventListener: (t, fn) => (handlers[`doc:${t}`] = fn) },
    window: { addEventListener: (t, fn) => (handlers[`win:${t}`] = fn) },
    acquireVsCodeApi: () => ({ postMessage: (m) => posted.push(m), getState: () => state, setState: (s) => (state = s) }),
    Element: class {},
    console,
  };
  return { sandbox, root, handlers, posted };
}

/** Fixture + stubbed vscode + activated extension, torn down after the test. */
async function activateWith(t, config = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'toys-for-kiro-smoke-'));
  const fx = writeFixture(tmp);
  const realHome = os.homedir;
  os.homedir = () => fx.home;
  const stub = createStub();
  Object.assign(stub.config, config);
  stub.vscode.workspace.workspaceFolders = [{ uri: stub.vscode.Uri.file(WORKSPACE) }];
  const uninstall = installStub(stub);
  const subscriptions = [];
  t.after(() => {
    for (const d of subscriptions) d.dispose();
    uninstall();
    os.homedir = realHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const ext = loadExtension();
  const context = {
    subscriptions,
    globalStorageUri: stub.vscode.Uri.file(fx.globalStorage),
    extensionUri: stub.vscode.Uri.file(path.join(__dirname, '..')),
  };
  const api = ext.activate(context);
  assert.ok(api, 'activate returned an API');
  await api.ready;
  return { api, stub, fx, dbFile: path.join(fx.globalStorage, 'toys-for-kiro.db') };
}

const EXPECTED_STATUS = '$(pie-chart) 3.1% · 0.71 cr';

test('extension activates, indexes data and renders every view', async (t) => {
  const { api, stub, dbFile } = await activateWith(t);
  assert.ok(fs.existsSync(dbFile), 'disk mode is the default');

  // Status bar shows the active session in this workspace.
  const item = stub.statusItems[0];
  assert.equal(item.visible, true);
  assert.equal(item.text, EXPECTED_STATUS);
  const tip = item.tooltip.value;
  assert.match(tip, /演示 \\<会话\\> \\\| test/); // escaped title
  assert.match(tip, /1 \/ 3 \/ 1/); // turns / requests (2 + log-only error) / tools
  assert.match(tip, /11\\\.20 \/ 1000\\\.0 credits/);
  assert.deepEqual(item.command.arguments[0], { view: 'sessions', sessionId: 'sess_demo' });

  // Payloads for every view.
  const overview = api.app.buildPayload({ view: 'overview', range: 'all' });
  assert.equal(overview.totals.requests, 4); // 2 ok + 1 error + 1 legacy
  assert.equal(overview.totals.errors, 1);
  assert.ok(Math.abs(overview.totals.credits - 0.71) < 1e-9);
  assert.equal(overview.totals.legacyRequests, 1);
  const requests = api.app.buildPayload({ view: 'requests', range: 'all', filters: { outcome: 'ok' } });
  assert.equal(requests.total, 3);
  assert.equal(requests.rows[0].ttftMs, 800);
  const sessions = api.app.buildPayload({ view: 'sessions', range: 'all', sessionId: 'sess_demo' });
  assert.equal(sessions.rows.length, 2);
  assert.equal(sessions.selected.requests, 3);
  assert.equal(sessions.selected.context.tokens, 31_000);
  const quota = api.app.buildPayload({ view: 'quota' });
  assert.equal(quota.quota.plan, 'Example Plan');
  assert.equal(quota.quota.used, 11.2);

  // Dashboard panel + real webview script.
  await stub.vscode.commands.executeCommand('toysForKiro.openDashboard', {});
  const panel = stub.panels[0];
  assert.match(panel.webview.html, /Content-Security-Policy/);
  assert.match(panel.webview.html, /script-src 'nonce-/);

  const dom = fakeDom();
  const script = fs.readFileSync(path.join(__dirname, '..', 'media', 'dashboard.js'), 'utf8');
  vm.runInNewContext(script, dom.sandbox);
  assert.equal(dom.posted.at(-1).type, 'ready');
  const deliver = (m) => dom.handlers['win:message']({ data: m });

  // Route webview -> extension -> webview through the real panel controller.
  const pump = async () => {
    const msg = dom.posted.at(-1);
    panel.posted.length = 0;
    await panel.send(msg);
    for (const m of panel.posted) deliver(m);
  };
  await pump(); // ready -> init -> load(overview)
  await pump(); // load -> data
  assert.match(dom.root.innerHTML, /请求数/);
  assert.match(dom.root.innerHTML, /用量热力图/);
  assert.match(dom.root.innerHTML, /claude-opus-5\.5/);

  const click = (attrs) =>
    dom.handlers['doc:click']({ target: Object.assign(new dom.sandbox.Element(), { closest: () => ({ dataset: attrs }) }) });
  for (const [view, marker] of [
    ['requests', /ServerConnectionResetError/],
    ['sessions', /演示 &lt;会话&gt; \| test/],
    ['quota', /Example Plan/],
  ]) {
    click({ action: 'view', view });
    await pump();
    assert.match(dom.root.innerHTML, marker, `view ${view}`);
    assert.doesNotMatch(dom.root.innerHTML, /<会话>/, 'titles are HTML-escaped');
  }
  click({ action: 'session', id: 'sess_demo' });
  await pump();
  assert.match(dom.root.innerHTML, /首包延迟/);
  assert.match(dom.root.innerHTML, /可见输出速度/);
});

test('memory mode writes nothing; switching, clearing and retention work', async (t) => {
  const { api, stub, dbFile } = await activateWith(t, { 'storage.mode': 'memory' });
  const status = () => stub.statusItems[0].text;
  const hasLogRows = () => api.app.store.db.prepare('SELECT COUNT(*) AS n FROM log_requests').get().n;

  // Memory mode: same numbers, no file on disk, UI says so.
  assert.equal(fs.existsSync(dbFile), false);
  assert.equal(api.app.store.inMemory, true);
  assert.equal(status(), EXPECTED_STATUS);
  assert.match(stub.statusItems[0].tooltip.value, /内存模式/);
  assert.equal(api.app.buildPayload({ view: 'overview', range: 'all' }).meta.storage, 'memory');
  assert.equal(await stub.vscode.commands.executeCommand('toysForKiro.clearData'), 'none');

  // Switch to disk: the index file appears and stats are unchanged.
  stub.config['storage.mode'] = 'disk';
  await api.app.onSettingsChanged();
  assert.equal(api.app.store.inMemory, false);
  assert.ok(fs.existsSync(dbFile));
  assert.equal(status(), EXPECTED_STATUS);
  assert.ok(hasLogRows() > 0);

  // Clearing asks first; dismissing keeps the data.
  stub.answers.push(undefined);
  assert.equal(await stub.vscode.commands.executeCommand('toysForKiro.clearData'), undefined);
  assert.ok(hasLogRows() > 0);
  // Confirming deletes the file, then rebuilds it from Kiro's files.
  stub.answers.push('删除');
  assert.equal(await stub.vscode.commands.executeCommand('toysForKiro.clearData'), 'deleted');
  assert.ok(fs.existsSync(dbFile));
  assert.equal(status(), EXPECTED_STATUS);
  assert.match(stub.messages.at(-1).text, /已删除本地索引/);

  // Retention: rows older than the cutoff are pruned on the next full scan.
  api.app.store.upsertLogRequests([{ requestId: 'ancient', ts: Date.now() - 40 * 86_400_000, conversationId: 'sess_demo', modelId: 'm', outcome: 'ok', errorType: null, firstEventMs: 1, firstVisibleMs: 1, durationMs: 1, isRetry: 0, isFallback: 0, attempt: 1 }]);
  stub.config['storage.retentionDays'] = 30;
  await api.app.onSettingsChanged();
  const ids = api.app.store.db.prepare('SELECT request_id AS id FROM log_requests').all().map((r) => r.id);
  assert.ok(!ids.includes('ancient'));
  assert.ok(ids.includes('req-1'), 'recent rows are kept');

  // Back to memory: offered to delete the leftover file; accepting removes it.
  stub.answers.push('删除');
  stub.config['storage.mode'] = 'memory';
  await api.app.onSettingsChanged();
  assert.equal(api.app.store.inMemory, true);
  assert.equal(fs.existsSync(dbFile), false);
  assert.equal(status(), EXPECTED_STATUS);
});
