'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveKiroPaths, normalizeWorkspacePath, userDataDirFromGlobalStorage } = require('../src/core/paths');
const exp = require('../src/core/export');
const a = require('../src/core/analytics');

test('resolveKiroPaths resolves standard locations on Windows, macOS and Linux', () => {
  const win = resolveKiroPaths({ platform: 'win32', homedir: 'C:\\Users\\alice', env: { APPDATA: 'C:\\Users\\alice\\AppData\\Roaming' } });
  assert.equal(win.userDataDir, 'C:\\Users\\alice\\AppData\\Roaming\\Kiro');
  assert.equal(win.sessionsDir, 'C:\\Users\\alice\\.kiro\\sessions');
  assert.equal(win.globalStateDb, 'C:\\Users\\alice\\AppData\\Roaming\\Kiro\\User\\globalStorage\\state.vscdb');

  const mac = resolveKiroPaths({ platform: 'darwin', homedir: '/Users/alice', env: {} });
  assert.equal(mac.userDataDir, '/Users/alice/Library/Application Support/Kiro');
  assert.equal(mac.sessionsDir, '/Users/alice/.kiro/sessions');
  assert.equal(mac.logsDir, '/Users/alice/Library/Application Support/Kiro/logs');

  const linux = resolveKiroPaths({ platform: 'linux', homedir: '/home/alice', env: {} });
  assert.equal(linux.userDataDir, '/home/alice/.config/Kiro');
  assert.equal(linux.sessionsDir, '/home/alice/.kiro/sessions');

  const xdg = resolveKiroPaths({ platform: 'linux', homedir: '/home/alice', env: { XDG_CONFIG_HOME: '/custom/cfg' } });
  assert.equal(xdg.userDataDir, '/custom/cfg/Kiro');

  // Relative XDG_CONFIG_HOME is ignored per XDG Base Directory Specification.
  const relXdg = resolveKiroPaths({ platform: 'linux', homedir: '/home/alice', env: { XDG_CONFIG_HOME: 'relative/cfg' } });
  assert.equal(relXdg.userDataDir, '/home/alice/.config/Kiro');

  // Portable / custom --user-data-dir resolves three levels up from globalStorage on any OS.
  assert.equal(userDataDirFromGlobalStorage('/opt/kiro-data/User/globalStorage/moluogh.toys-for-kiro', 'linux'), '/opt/kiro-data');
  assert.equal(userDataDirFromGlobalStorage('D:\\KiroData\\User\\globalStorage\\moluogh.toys-for-kiro', 'win32'), 'D:\\KiroData');
});

test('normalizeWorkspacePath handles case sensitivity by OS and file:// URIs', () => {
  assert.equal(normalizeWorkspacePath('D:/Proj/Demo/', 'win32'), 'd:\\proj\\demo');
  assert.equal(normalizeWorkspacePath('file:///D:/Proj/Demo/', 'win32'), 'd:\\proj\\demo');
  assert.equal(normalizeWorkspacePath('file:///c%3A/Users/my%20name/proj/', 'win32'), 'c:\\users\\my name\\proj');
  assert.equal(normalizeWorkspacePath('file://server/share/dir/', 'win32'), '\\\\server\\share\\dir');
  assert.equal(normalizeWorkspacePath('C:\\', 'win32'), 'c:\\');
  assert.equal(normalizeWorkspacePath('/Users/Alice/Code/App/', 'darwin'), '/users/alice/code/app');
  assert.equal(normalizeWorkspacePath('file:///Users/Alice/Code/App', 'darwin'), '/users/alice/code/app');
  // Linux keeps case distinct and malformed %-escapes do not throw URIError.
  assert.notEqual(normalizeWorkspacePath('/home/alice/App', 'linux'), normalizeWorkspacePath('/home/alice/app', 'linux'));
  assert.equal(normalizeWorkspacePath('/home/alice/App/', 'linux'), '/home/alice/App');
  assert.equal(normalizeWorkspacePath('file:///home/alice/bad%ZZpath/', 'linux'), '/home/alice/bad%ZZpath');
});

test('CSV and export builders escape special characters and preserve totals', () => {
  const csv = exp.toCsv(['title', 'notes', 'n'], [['a, "b"', 'line1\nline2', 42], [null, false, NaN]]);
  assert.ok(csv.startsWith('\uFEFFtitle,notes,n\r\n'));
  assert.ok(csv.includes('"a, ""b""","line1\nline2",42\r\n'));
  assert.ok(csv.endsWith(',false,\r\n'));

  const settings = { contextWindowTokens: 1_000_000, modelContextWindows: {} };
  const rows = a.enrichRows(
    [
      { sessionId: 's1', sessionTitle: 'Fix "bug", fast', kind: 'main', ts: Date.parse('2026-11-10T12:00:00Z'), modelId: 'claude-opus-5.5', outcome: 'ok', contextPct: 5, credits: 1.25, estOutputTokens: 100, firstEventMs: 500, durationMs: 2500 },
      { sessionId: 's1', sessionTitle: 'Fix "bug", fast', kind: 'aux', ts: Date.parse('2026-11-10T12:00:05Z'), credits: 0.05 },
    ],
    settings,
  );
  const reqItems = exp.buildExportRequests(rows, { price: 0.04, sessionWorkspaces: new Map([['s1', '/work/app']]) });
  assert.equal(reqItems.length, 2);
  assert.equal(reqItems[1].credits, 1.25);
  assert.equal(reqItems[1].usd, 0.05);
  assert.equal(reqItems[0].kind, 'aux');
  const reqCsv = exp.requestsToCsv(reqItems);
  assert.match(reqCsv, /"Fix ""bug"", fast"/);

  // When a model/outcome filter is active, credit-only aux rows are excluded.
  const filteredReqs = exp.buildExportRequests(rows, { price: 0.04, filters: { outcome: 'ok' } });
  assert.equal(filteredReqs.length, 1);

  const sessions = [
    { id: 's1', source: 'v1', title: 'Fix "bug", fast', workspaces: ['/work/app'], modelId: 'claude-opus-5.5', createdAt: 1000, updatedAt: Date.parse('2026-11-10T12:00:05Z'), creditsMain: 1.25, creditsDelegated: 0, creditsAux: 0.05, contextPct: 5, turns: 1, toolCalls: 2, toolTimeMs: 300, turnTimeMs: 3000 },
  ];
  const sessItems = exp.buildExportSessions(sessions, rows, {
    range: { key: 'all', label: 'range.all', from: 0, to: Date.now() + 1 },
    price: 0.04,
    settings,
  });
  assert.equal(sessItems.length, 1);
  assert.equal(sessItems[0].creditsTotal, 1.3);
  assert.equal(sessItems[0].usd, 0.052);
  assert.match(exp.sessionsToCsv(sessItems), /claude-opus-5\.5/);

  // legacy:unlinked uses the localized fallback title for both filtering and export.
  const unlinked = [
    { id: 'legacy:unlinked', source: 'legacy', title: '', workspaces: [], modelId: 'claude-opus-4.5', createdAt: 1000, updatedAt: 2000, creditsMain: 0, creditsDelegated: 0, creditsAux: 0, contextPct: null, turns: 1, toolCalls: 0, toolTimeMs: 0, turnTimeMs: 1000 },
  ];
  const unlinkedOut = exp.buildExportSessions(unlinked, [], {
    range: { key: 'all', label: 'range.all', from: 0, to: Date.now() + 1 },
    price: 0.04,
    settings,
    query: '旧版执行',
    unlinkedTitle: '旧版执行（未匹配到会话）',
  });
  assert.equal(unlinkedOut.length, 1);
  assert.equal(unlinkedOut[0].title, '旧版执行（未匹配到会话）');

  const dailyItems = exp.buildExportDaily([{ day: Date.parse('2026-11-10T00:00:00Z'), credits: 1.3, requests: 1 }], { price: 0.04, utc: true });
  assert.deepEqual(dailyItems[0], { date: '2026-11-10', timezone: 'UTC', requests: 1, credits: 1.3, usd: 0.052 });
  assert.match(exp.dailyToCsv(dailyItems), /2026-11-10,UTC,1,1\.3,0\.052/);
});
