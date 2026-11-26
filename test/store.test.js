'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store, MEMORY } = require('../src/core/store');

/** @param {number} ts @param {string} id */
const logRow = (id, ts) => ({ requestId: id, ts, conversationId: 's', modelId: 'm', outcome: 'ok', errorType: null, firstEventMs: 1, firstVisibleMs: 2, durationMs: 3, isRetry: 0, isFallback: 0, attempt: 1 });

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('memory store never touches the disk', (t) => {
  const dir = tmpDir(t);
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    const s = new Store(MEMORY);
    s.upsertLogRequests([logRow('a', 1)]);
    s.setKv('k', { v: 1 });
    assert.equal(s.inMemory, true);
    assert.deepEqual(s.getKv('k'), { v: 1 });
    s.close();
    s.close(); // idempotent
  } finally {
    process.chdir(cwd);
  }
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('pruneLogRequests deletes only rows older than the cutoff', () => {
  const s = new Store(MEMORY);
  s.upsertLogRequests([logRow('old', 1000), logRow('edge', 2000), logRow('new', 3000)]);
  assert.equal(s.pruneLogRequests(2000), 1);
  const ids = s.db.prepare('SELECT request_id AS id FROM log_requests ORDER BY ts').all().map((r) => r.id);
  assert.deepEqual(ids, ['edge', 'new']);
  assert.equal(s.pruneLogRequests(0), 0);
  s.close();
});

test('wipe deletes a closed index file and its WAL files', (t) => {
  const file = path.join(tmpDir(t), 'i.db');
  assert.equal(Store.wipe(file), 'none');
  const s = new Store(file);
  s.upsertLogRequests([logRow('a', 1)]);
  s.close();
  assert.equal(Store.exists(file), true);
  assert.equal(Store.wipe(file), 'deleted');
  assert.equal(Store.exists(file), false);
});

test('wipe empties the file in place when another connection holds it open', (t) => {
  const file = path.join(tmpDir(t), 'i.db');
  const other = new Store(file); // e.g. a second Kiro window
  other.upsertLogRequests([logRow('secret-request', 1)]);
  other.setKv('quota', { used: 1 });
  t.after(() => other.close());
  const result = Store.wipe(file);
  if (process.platform === 'win32') {
    assert.equal(result, 'cleared');
    const fresh = new Store(file);
    assert.equal(fresh.db.prepare('SELECT COUNT(*) AS n FROM log_requests').get().n, 0);
    assert.equal(fresh.getKv('quota'), null);
    fresh.close();
    other.close();
    assert.ok(!fs.readFileSync(file).includes('secret-request'), 'deleted rows are not left in the file');
  } else {
    assert.equal(result, 'deleted'); // POSIX allows unlinking open files
  }
});
