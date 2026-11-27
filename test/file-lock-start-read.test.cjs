'use strict';

// A writer that does not wait for the lock (waitMs 0) still reads start times, within a budget of its own
// (startReadMs): its own lock record carries `started`, and an old lock whose pid now names another running process
// is judged stale and broken, as it is for a writer that waits.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { acquireFileLock, releaseFileLock } = loadTs('src/core/fileLock.ts');

function place(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-start-read-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'file.lock');
}

const opts = (more) => ({
  waitMs: 0, staleMs: 30_000, retryMs: 10, link: fs.linkSync, hooks: {}, name: 'file', disabled: 'writes',
  startTime: (pid) => (pid === process.pid ? 'ps:this process' : null),
  timeout: (l, w, holder) => new Error(`busy: ${holder}`), ...more,
});

test('a writer that does not wait records its start time, given a start-time budget of its own', (t) => {
  const lock = place(t);
  let record = null;
  const own = acquireFileLock(lock, opts({ startReadMs: 100 }));
  record = JSON.parse(fs.readFileSync(lock, 'utf8'));
  releaseFileLock(lock, own);
  assert.equal(record.started, 'ps:this process');
});

test('a writer that does not wait breaks an old lock whose pid now names another running process', (t) => {
  const lock = place(t);
  const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
  // This process is running, but it is not the process that took the lock: its start time differs.
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, host: os.hostname(), started: 'ps:an earlier process', acquiredAt: hourAgo, token: 'old' }));
  const own = acquireFileLock(lock, opts({ startReadMs: 100 }));
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).token, own.token);
  releaseFileLock(lock, own);
});
