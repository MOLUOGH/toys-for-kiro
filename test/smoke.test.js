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

/**
 * Run media/i18n.js + media/dashboard.js in a fake DOM and wire them to the real
 * panel controller. Returns after the overview has rendered.
 */
async function bootDashboard(panel) {
  const dom = fakeDom();
  const ctx = vm.createContext(dom.sandbox);
  for (const f of ['i18n.js', 'dashboard.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'media', f), 'utf8'), ctx);
  assert.equal(dom.posted.at(-1).type, 'ready');
  const deliver = (m) => dom.handlers['win:message']({ data: m });
  panel.deliver = deliver;
  // Route webview -> extension -> webview through the real panel controller.
  const pump = async () => {
    const msg = dom.posted.at(-1);
    panel.posted.length = 0;
    await panel.send(msg);
    for (const m of panel.posted) deliver(m);
  };
  const click = (attrs) =>
    dom.handlers['doc:click']({ target: Object.assign(new dom.sandbox.Element(), { closest: () => ({ dataset: attrs }) }) });
  await pump(); // ready -> init -> load(overview)
  await pump(); // load -> data
  return { dom, pump, click };
}

/** Fixture + stubbed vscode + activated extension, torn down after the test. */
async function activateWith(t, config = {}) {
  const realNow = Date.now;
  const rawNow = realNow();
  const sameLocalDay = (t1, t2) => {
    const d1 = new Date(t1);
    const d2 = new Date(t2);
    return d1.getFullYear() === d2.getFullYear() && d1.getMonth() === d2.getMonth() && d1.getDate() === d2.getDate();
  };
  // Keep `now - 60_000` and `now + 15_000` on the same local calendar day across midnight.
  const clockOffset = sameLocalDay(rawNow - 60_000, rawNow + 15_000) ? 0 : 120_000;
  if (clockOffset) Date.now = () => realNow() + clockOffset;
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
    Date.now = realNow;
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
  assert.equal(item.backgroundColor, undefined);
  const tip = item.tooltip.value;
  assert.match(tip, /演示 \\<会话\\> \\\| test/); // escaped title
  assert.match(tip, /1 \/ 3 \/ 1/); // turns / requests (2 + log-only error) / tools
  assert.match(tip, /11\\\.20 \/ 1000\\\.0 credits/);
  assert.match(tip, /command:toysForKiro\.openSettings/);
  assert.ok(item.tooltip.isTrusted.enabledCommands.includes('toysForKiro.openSettings'));
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
  assert.match(panel.iconPath.fsPath, /media[\\/]icon\.svg$/);
  assert.match(panel.webview.html, /Content-Security-Policy/);
  assert.match(panel.webview.html, /script-src 'nonce-/);

  const { dom, pump, click } = await bootDashboard(panel);
  assert.match(dom.root.innerHTML, /<div class="brand"><svg class="brand-icon"[\s\S]*?<ellipse[\s\S]*?<span>Kiro Usage<\/span><\/div>/);
  assert.match(dom.root.innerHTML, /data-action="settings"/);
  assert.match(dom.root.innerHTML, /请求数/);
  assert.match(dom.root.innerHTML, /用量热力图/);
  assert.match(dom.root.innerHTML, /claude-opus-5\.5/);

  // Settings entry points: dashboard gear button and command palette command.
  stub.executed.length = 0;
  click({ action: 'settings' });
  await pump();
  assert.deepEqual(stub.executed.at(-1), { id: 'workbench.action.openSettings', args: ['@ext:moluogh.toys-for-kiro'] });
  stub.executed.length = 0;
  await stub.vscode.commands.executeCommand('toysForKiro.openSettings');
  assert.deepEqual(stub.executed.at(-1), { id: 'workbench.action.openSettings', args: ['@ext:moluogh.toys-for-kiro'] });

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

  // Sessions filter: workspace toggle & search input.
  dom.handlers['doc:change']({ target: { dataset: { change: 'session-ws' }, checked: true } });
  assert.match(dom.root.innerHTML, /演示 &lt;会话&gt; \| test/);
  assert.doesNotMatch(dom.root.innerHTML, /Old chat/);
  dom.handlers['doc:input']({ target: { dataset: { input: 'session-query' }, value: 'no-such-session' } });
  assert.match(dom.root.innerHTML, /没有符合筛选条件的会话/);

  // Quota forecast renders daily pace.
  click({ action: 'view', view: 'quota' });
  await pump();
  assert.match(dom.root.innerHTML, /日均消耗/);

  // Status bar background color highlights high context usage.
  const baseStats = api.app.buildPayload({ view: 'sessions', range: 'all', sessionId: 'sess_demo' }).selected;
  api.app.statusBar.update({ stats: { ...baseStats, context: { ...baseStats.context, pct: 78 } }, quota: null, price: 0.04 }, 'zh');
  assert.equal(item.backgroundColor.id, 'statusBarItem.warningBackground');
  api.app.statusBar.update({ stats: { ...baseStats, context: { ...baseStats.context, pct: 92 } }, quota: null, price: 0.04 }, 'zh');
  assert.equal(item.backgroundColor.id, 'statusBarItem.errorBackground');
  api.app.statusBar.update(null, 'zh');
  assert.equal(item.backgroundColor, undefined);
  assert.equal(item.text, '$(pie-chart) Kiro Usage');
  assert.match(item.tooltip.value, /command:toysForKiro\.openSettings/);

  // Customizable status bar modes ('today' and 'cycle').
  stub.config['statusBar.mode'] = 'today';
  await api.app.onSettingsChanged();
  assert.equal(item.text, '$(pie-chart) 3.1% · 今日 0.71 cr');
  assert.deepEqual(item.command.arguments[0], { view: 'overview', range: 'today' });
  assert.match(item.tooltip.value, /今日：0\\\.71 credits/);

  stub.config['statusBar.mode'] = 'cycle';
  await api.app.onSettingsChanged();
  assert.equal(item.text, '$(pie-chart) 3.1% · 额度 1.1%');
  assert.deepEqual(item.command.arguments[0], { view: 'quota' });

  // Export CSV via dashboard button: inactive-tab filters must NOT leak into Overview or Quota exports.
  click({ action: 'view', view: 'requests' });
  await pump();
  dom.handlers['doc:change']({ target: { dataset: { change: 'outcome' }, value: 'error' } });
  await pump();
  click({ action: 'view', view: 'overview' });
  await pump();
  dom.handlers['doc:change']({ target: { dataset: { change: 'range' }, value: 'all' } });
  await pump();
  const csvOut = path.join(path.dirname(dbFile), 'export-requests.csv');
  stub.answers.push('requests-csv', csvOut);
  click({ action: 'export' });
  await pump();
  const csvText = fs.readFileSync(csvOut, 'utf8');
  assert.ok(csvText.startsWith('\uFEFFtimeUtc,sessionId,'));
  assert.match(csvText, /claude-opus-5\.5/);
  assert.ok(csvText.trim().split('\r\n').length >= 5, 'all Overview rows exported despite inactive Requests filter');

  // Quota tab hides the range selector and must always export 'cycle' even if state.range was 'today'.
  dom.handlers['doc:change']({ target: { dataset: { change: 'range' }, value: 'today' } });
  await pump();
  click({ action: 'view', view: 'quota' });
  await pump();
  const quotaJsonOut = path.join(path.dirname(dbFile), 'export-quota-report.json');
  stub.answers.push('report-json', quotaJsonOut);
  click({ action: 'export' });
  await pump();
  assert.equal(JSON.parse(fs.readFileSync(quotaJsonOut, 'utf8')).range.key, 'cycle');

  const jsonOut = path.join(path.dirname(dbFile), 'export-report.json');
  stub.answers.push(jsonOut);
  const savedJson = await stub.vscode.commands.executeCommand('toysForKiro.exportData', { target: 'report-json', range: 'all' });
  assert.equal(savedJson, jsonOut);
  const report = JSON.parse(fs.readFileSync(jsonOut, 'utf8'));
  assert.equal(report.summary.requests, 4);
  assert.equal(report.sessions.length, 2);
  assert.ok(Array.isArray(report.daily));

  // Changing defaultRange in Settings updates the open Dashboard live.
  click({ action: 'view', view: 'overview' });
  await pump();
  stub.config.defaultRange = '7d';
  panel.posted.length = 0;
  await api.app.onSettingsChanged();
  for (const m of panel.posted) panel.deliver(m);
  await pump();
  assert.match(dom.root.innerHTML, /<option value="7d" selected>/);

  // Default export filename uses kiro-usage-<slug>-<date>.<ext>.
  const origWorkspaceFolders = stub.vscode.workspace.workspaceFolders;
  stub.vscode.workspace.workspaceFolders = [{ uri: stub.vscode.Uri.file(path.dirname(dbFile)) }];
  stub.answers.push(true);
  const savedDaily = await stub.vscode.commands.executeCommand('toysForKiro.exportData', { target: 'daily-csv' });
  stub.vscode.workspace.workspaceFolders = origWorkspaceFolders;
  assert.match(path.basename(savedDaily), /^kiro-usage-daily-\d{4}-\d{2}-\d{2}\.csv$/);
  assert.ok(fs.existsSync(savedDaily));
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

test('English UI: status bar, every dashboard view, and switching language live', async (t) => {
  const { api, stub } = await activateWith(t, { language: 'en' });
  const tip = stub.statusItems[0].tooltip.value;
  assert.match(tip, /Kiro Usage · current session/);
  assert.match(tip, /Turns \/ requests \/ tool calls/);
  assert.doesNotMatch(tip.replace('演示 \\<会话\\> \\| test', ''), /[\u4e00-\u9fff]/, 'no Chinese except the session title');

  await stub.vscode.commands.executeCommand('toysForKiro.openDashboard', {});
  const panel = stub.panels[0];
  assert.match(panel.webview.html, /<html lang="en">/);
  assert.match(panel.webview.html, /i18n\.js/);
  const { dom, pump, click } = await bootDashboard(panel);
  // Strip the fixture's Chinese session title before looking for untranslated text.
  const visible = () => dom.root.innerHTML.replace(/演示 &lt;会话&gt; \| test/g, '');
  assert.match(dom.root.innerHTML, /Usage heatmap/);
  assert.match(dom.root.innerHTML, /Model health/);
  for (const view of ['overview', 'requests', 'sessions', 'quota']) {
    click({ action: 'view', view });
    await pump();
    assert.doesNotMatch(visible(), /[\u4e00-\u9fff]/, `view ${view} has untranslated text`);
  }
  click({ action: 'session', id: 'sess_demo' });
  await pump();
  assert.match(dom.root.innerHTML, /Time to first token/);
  assert.doesNotMatch(visible(), /[\u4e00-\u9fff]/, 'session card has untranslated text');

  // Switch to Chinese without reopening: the panel and the status bar follow.
  stub.config.language = 'zh-CN';
  panel.posted.length = 0;
  await api.app.onSettingsChanged();
  assert.deepEqual({ ...panel.posted.find((m) => m.type === 'lang') }, { type: 'lang', lang: 'zh' });
  for (const m of panel.posted) panel.deliver(m);
  assert.match(dom.root.innerHTML, /首包延迟/);
  assert.match(stub.statusItems[0].tooltip.value, /当前会话/);
});

test('both languages define the same keys', () => {
  const { messages, resolveLang } = require('../media/i18n');
  assert.deepEqual(Object.keys(messages.en).sort(), Object.keys(messages.zh).sort());
  const nlsEn = Object.keys(require('../package.nls.json')).sort();
  const nlsZh = Object.keys(require('../package.nls.zh-cn.json')).sort();
  assert.deepEqual(nlsEn, nlsZh);
  const manifest = fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8');
  for (const m of manifest.matchAll(/"%([\w.]+)%"/g)) assert.ok(nlsEn.includes(m[1]), `package.nls.json is missing ${m[1]}`);
  assert.equal(resolveLang('auto', 'zh-cn'), 'zh');
  assert.equal(resolveLang('auto', 'zh-tw'), 'zh');
  assert.equal(resolveLang('auto', 'en'), 'en');
  assert.equal(resolveLang('auto', 'ja'), 'en');
  assert.equal(resolveLang('en', 'zh-cn'), 'en');
  assert.equal(resolveLang('zh-CN', 'en'), 'zh');
});

test('manifest metadata, command registrations, zero-session status bar modes, and export cancel paths', async (t) => {
  const pkg = require('../package.json');
  assert.equal(pkg.name, 'toys-for-kiro', 'extension ID must stay stable for Open VSX upgrades');
  assert.equal(pkg.publisher, 'moluogh');
  assert.equal(pkg.displayName, 'Kiro Usage');
  assert.ok(pkg.description.length > 0 && pkg.description.length <= 200);
  assert.ok(pkg.description.startsWith('Credits, quota & context usage stats.'), 'sidebar ~38-char preview leads with core metrics');
  assert.ok(Array.isArray(pkg.keywords) && pkg.keywords.length >= 10 && pkg.keywords.length <= 30);
  for (const kw of ['kiro', 'usage', 'credits', 'quota', 'tokens', 'context', '用量', '额度', '统计']) {
    assert.ok(pkg.keywords.includes(kw), `missing keyword ${kw}`);
  }
  assert.equal(pkg.icon, 'media/icon.png');
  assert.deepEqual(pkg.galleryBanner, { color: '#24104e', theme: 'dark' });
  const iconPng = fs.readFileSync(path.join(__dirname, '..', pkg.icon));
  assert.deepEqual([...iconPng.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'valid PNG signature');
  assert.equal(iconPng.readUInt32BE(16), 256, 'icon.png width is 256');
  assert.equal(iconPng.readUInt32BE(20), 256, 'icon.png height is 256');
  assert.equal(iconPng[25], 6, 'icon.png is RGBA');
  const iconSvg = fs.readFileSync(path.join(__dirname, '..', 'media', 'icon.svg'), 'utf8');
  assert.match(iconSvg, /^<svg\b[^>]*\bwidth="16"[^>]*\bheight="16"[^>]*\bviewBox="0 0 16 16"/, 'icon.svg has explicit 16x16 tab dimensions');
  assert.equal((iconSvg.match(/<ellipse\b/g) || []).length, 2, 'icon.svg has two Kiro ghost pill eyes');
  assert.match(iconSvg, /<path\b[\s\S]*<rect\b[\s\S]*<\/svg>\s*$/, 'icon.svg includes quota arc, ghost, and usage bars');
  const dashboardCss = fs.readFileSync(path.join(__dirname, '..', 'media', 'dashboard.css'), 'utf8');
  assert.match(dashboardCss, /\.brand-icon\s*\{[^}]*forced-color-adjust:\s*none/, 'brand-icon preserves colors in High Contrast');

  const { api, stub, fx } = await activateWith(t);
  for (const cmd of pkg.contributes.commands) {
    assert.ok(stub.commands.has(cmd.command), `command ${cmd.command} must be registered on activate`);
    assert.equal(cmd.category, 'Kiro Usage');
  }
  const editorTitleMenus = pkg.contributes.menus['editor/title'];
  assert.ok(Array.isArray(editorTitleMenus) && editorTitleMenus.length >= 5);
  for (const item of editorTitleMenus) {
    assert.ok(stub.commands.has(item.command), `menu command ${item.command} is registered`);
    assert.equal(item.when, "activeWebviewPanelId == 'toysForKiro.dashboard'");
  }
  // Editor title menus pass a vscode.Uri argument; commands must ignore Uri args cleanly.
  await stub.vscode.commands.executeCommand('toysForKiro.openDashboard', stub.vscode.Uri.file(fx.userData));
  stub.answers.push(undefined);
  assert.equal(await stub.vscode.commands.executeCommand('toysForKiro.exportData', stub.vscode.Uri.file(fx.userData)), undefined);

  // Zero-session edge cases across all three status bar modes and both languages.
  const item = stub.statusItems[0];
  const emptyData = {
    stats: null,
    today: { credits: 0, requests: 0 },
    cycleCredits: 0,
    quota: { used: 5, limit: 100, percent: 5, resetAt: '2026-12-01T00:00:00Z' },
    price: 0.04,
    storage: 'memory',
  };
  api.app.statusBar.update(emptyData, 'en', 'session');
  assert.equal(item.text, '$(pie-chart) Kiro Usage');
  assert.match(item.tooltip.value, /5\\\.00 \/ 100\\\.0 credits/);
  assert.match(item.tooltip.value, /Memory mode/);
  assert.match(item.tooltip.value, /command:toysForKiro\.exportData/);
  assert.match(item.tooltip.value, /command:toysForKiro\.openSettings/);
  assert.doesNotMatch(item.tooltip.value, /[\u4e00-\u9fff]/);

  api.app.statusBar.update({ ...emptyData, quota: null, storage: 'disk' }, 'en', 'today');
  assert.equal(item.text, '$(pie-chart) Today 0.00 cr');
  assert.match(item.tooltip.value, /\*\*Kiro Usage\*\*/);
  assert.match(item.tooltip.value, /command:toysForKiro\.openSettings/);
  assert.doesNotMatch(item.tooltip.value, /[\u4e00-\u9fff]/);

  api.app.statusBar.update({ ...emptyData, quota: null, storage: 'disk' }, 'zh', 'cycle');
  assert.equal(item.text, '$(pie-chart) 本周期 0.00 cr');
  assert.match(item.tooltip.value, /\*\*Kiro Usage\*\*/);
  assert.match(item.tooltip.value, /command:toysForKiro\.openSettings/);

  // Export cancel paths and write-error handling (e.g. locked file / directory target).
  stub.answers.push(undefined);
  assert.equal(await stub.vscode.commands.executeCommand('toysForKiro.exportData', {}), undefined);
  stub.answers.push(undefined);
  assert.equal(await stub.vscode.commands.executeCommand('toysForKiro.exportData', { target: 'requests-csv' }), undefined);
  stub.allowErrors = true;
  stub.answers.push(fx.userData); // directory path forces writeFile failure
  assert.equal(await stub.vscode.commands.executeCommand('toysForKiro.exportData', { target: 'requests-csv' }), undefined);
  stub.allowErrors = false;
  assert.equal(stub.messages.at(-1).kind, 'error');
  assert.match(stub.messages.at(-1).text, /Kiro Usage/);

  // Concurrent settings change during an in-flight background tick must not drop legacy import.
  stub.config.importLegacySessions = false;
  await api.app.onSettingsChanged();
  assert.equal(api.app.buildPayload({ view: 'overview', range: 'all' }).totals.legacyRequests, 0);
  const bgTick = api.app.tick({});
  stub.config.importLegacySessions = true;
  await Promise.all([bgTick, api.app.onSettingsChanged()]);
  assert.equal(api.app.buildPayload({ view: 'overview', range: 'all' }).totals.legacyRequests, 1);
});

test('bilingual CHANGELOG, default-English README + README.zh-CN.md, packaging manifest, and Kiro icon geometry', () => {
  const root = path.join(__dirname, '..');
  const pkg = require('../package.json');

  // README.md is English by default with a Chinese overview note + link to README.zh-CN.md.
  const readmeEn = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const readmeZh = fs.readFileSync(path.join(root, 'README.zh-CN.md'), 'utf8');
  assert.equal(fs.existsSync(path.join(root, 'README.en.md')), false, 'stale README.en.md is removed');
  assert.match(readmeEn, /\*\*English\*\*\s*\|\s*\[简体中文\]\(https:\/\/github\.com\/MOLUOGH\/toys-for-kiro\/blob\/main\/README\.zh-CN\.md\)/);
  assert.match(readmeEn, /中文说明[\s\S]*README\.zh-CN\.md/);
  assert.match(readmeEn, /^## Features$/m);
  assert.match(readmeEn, /docs\/images\/en\/overview\.png/);
  assert.match(readmeZh, /\[English\]\(https:\/\/github\.com\/MOLUOGH\/toys-for-kiro\/blob\/main\/README\.md\)\s*\|\s*\*\*简体中文\*\*/);
  assert.match(readmeZh, /^## 功能$/m);
  assert.match(readmeZh, /docs\/images\/overview\.png/);

  for (const settingKey of Object.keys(pkg.contributes.configuration.properties)) {
    assert.ok(readmeEn.includes(`\`${settingKey}\``), `README.md documents ${settingKey}`);
    assert.ok(readmeZh.includes(`\`${settingKey}\``), `README.zh-CN.md documents ${settingKey}`);
  }

  // CHANGELOG.md is bilingual and matches .github/workflows/release.yml extraction rules.
  const changelogLines = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').split(/\r?\n/);
  const versionHeader = `## ${pkg.version}`;
  const start = changelogLines.indexOf(versionHeader);
  assert.ok(start >= 0, `CHANGELOG.md has exact '${versionHeader}' heading`);
  let end = start + 1;
  while (end < changelogLines.length && !changelogLines[end].startsWith('## ')) end++;
  const releaseNotes = changelogLines.slice(start + 1, end).join('\n');
  assert.match(releaseNotes, /^### English$/m);
  assert.match(releaseNotes, /^### 简体中文$/m);
  assert.match(releaseNotes, /Kiro Usage/);
  assert.match(releaseNotes, /README\.zh-CN\.md/);

  const versionSections = [];
  for (let i = 0; i < changelogLines.length; i++) {
    if (changelogLines[i].startsWith('## ')) versionSections.push(i);
  }
  assert.ok(versionSections.length >= 7, 'all historical version sections are preserved');
  for (let s = 0; s < versionSections.length; s++) {
    const secStart = versionSections[s];
    const secEnd = s + 1 < versionSections.length ? versionSections[s + 1] : changelogLines.length;
    const secBody = changelogLines.slice(secStart + 1, secEnd).join('\n');
    assert.match(secBody, /^### English$/m, `${changelogLines[secStart]} has English section`);
    assert.match(secBody, /^### 简体中文$/m, `${changelogLines[secStart]} has Chinese section`);
  }

  // Packaging script includes README.zh-CN.md and excludes removed README.en.md.
  const pkgScript = fs.readFileSync(path.join(root, 'scripts', 'package.ps1'), 'utf8');
  assert.match(pkgScript, /'README\.md',\s*'README\.zh-CN\.md'/);
  assert.doesNotMatch(pkgScript, /README\.en\.md/);

  // Kiro ghost vertical pill eyes, ghost-to-arc clearance, bar separation, and 256x256 RGBA icon.png.
  const iconPng = fs.readFileSync(path.join(root, 'media', 'icon.png'));
  assert.deepEqual([...iconPng.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'icon.png has PNG signature');
  assert.equal(iconPng.readUInt32BE(16), 256, 'icon.png width is 256');
  assert.equal(iconPng.readUInt32BE(20), 256, 'icon.png height is 256');
  assert.equal(iconPng[24], 8, 'icon.png is 8-bit');
  assert.equal(iconPng[25], 6, 'icon.png is RGBA (colorType 6)');

  const checkKiroIconSvg = (svg, label, minGhostX, expectedBars) => {
    const eyes = [...svg.matchAll(/<ellipse\s+cx="([\d.]+)"\s+cy="([\d.]+)"\s+rx="([\d.]+)"\s+ry="([\d.]+)"/g)].map((m) => ({
      cx: Number(m[1]),
      cy: Number(m[2]),
      rx: Number(m[3]),
      ry: Number(m[4]),
    }));
    assert.equal(eyes.length, 2, `${label} has exactly two Kiro ghost pill eyes`);
    for (const eye of eyes) assert.ok(eye.ry > eye.rx * 1.8, `${label} eye is vertical pill-shaped`);
    const [left, right] = eyes.sort((a, b) => a.cx - b.cx);
    assert.equal(right.cx - left.cx, 2, `${label} eyes use 2px center spacing for symmetrical 1x/1.5x/2x DPI rasterization`);
    assert.ok(right.cx - left.cx - left.rx - right.rx >= 0.8 - 1e-9, `${label} eyes have >= 0.8px horizontal separation`);

    const ghostPath = svg.match(/<path\s+d="([^"]+)"\s+fill="#FFFFFF"/)?.[1] || '';
    assert.ok(ghostPath.length > 0, `${label} contains white Kiro ghost silhouette`);
    const nums = [...ghostPath.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
    const xs = nums.filter((_, i) => i % 2 === 0);
    assert.ok(Math.min(...xs) >= minGhostX, `${label} ghost clears left gauge arc without bleeding`);

    const bars = [...svg.matchAll(/<rect\s+x="([\d.]+)"\s+y="([\d.]+)"\s+width="([\d.]+)"\s+height="([\d.]+)"\s+rx="([\d.]+)"\s+fill="#/g)].map((m) => ({
      x: Number(m[1]),
      w: Number(m[3]),
    }));
    assert.equal(bars.length, expectedBars, `${label} has ${expectedBars} crisp usage bars`);
    assert.ok(bars[0].x - Math.max(...xs) >= 1.0, `${label} first bar clears ghost silhouette`);
    for (let i = 1; i < bars.length; i++) {
      assert.ok(bars[i].x - (bars[i - 1].x + bars[i - 1].w) >= 0.8, `${label} bar ${i} has crisp gap from previous bar`);
    }
  };
  checkKiroIconSvg(fs.readFileSync(path.join(root, 'media', 'icon.svg'), 'utf8'), 'media/icon.svg', 3.8, 2);
  const dashJs = fs.readFileSync(path.join(root, 'media', 'dashboard.js'), 'utf8');
  const brandSvg = dashJs.match(/const BRAND_ICON =\s*'([^']+)'/)?.[1] || '';
  checkKiroIconSvg(brandSvg, 'BRAND_ICON', 5.5, 3);
});
