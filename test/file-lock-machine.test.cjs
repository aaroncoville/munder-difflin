'use strict';

// A lock record names the machine that wrote it by this installation's id, so a host that renames itself (macOS
// turns Mac.local into Mac-2.local when another machine has the name) does not make its own live holders look like
// another machine's, which are judged by age alone. A record with no machine id, or a writer that cannot read its
// own, is judged by host name as before.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { acquireFileLock, releaseFileLock } = loadTs('src/core/fileLock.ts');

function place(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-lock-machine-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const MINE = 'a'.repeat(32);
const OTHER = 'b'.repeat(32);
const started = (pid) => `ps:started ${pid}`;
const opts = (more) => ({
  waitMs: 150, staleMs: 50, retryMs: 10, link: fs.linkSync, hooks: {}, name: 'file', disabled: 'writes',
  startTime: started, timeout: (l, w, holder) => Object.assign(new Error(`busy: ${holder}`), { busy: true }), ...more,
});

/** A lock held by a running process (this test's parent), recorded ten minutes ago. */
function holdLock(lock, record) {
  const pid = process.ppid;
  fs.writeFileSync(lock, JSON.stringify({ pid, started: started(pid), acquiredAt: new Date(Date.now() - 10 * 60_000).toISOString(), token: 'theirs', ...record }));
}

const taken = (lock, more) => {
  try { releaseFileLock(lock, acquireFileLock(lock, opts(more))); return true; } catch (e) { if (e.busy) return false; throw e; }
};

test('a live holder recorded under a host name this machine no longer has, with this machine\'s id, keeps its lock', (t) => {
  const lock = path.join(place(t), 'file.lock');
  holdLock(lock, { host: 'renamed-host.local', machine: MINE });
  assert.equal(taken(lock, { machine: MINE }), false, 'not broken on age');
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).token, 'theirs');
});

test('a holder with another machine\'s id is judged by age, as a holder on another host always was', (t) => {
  const lock = path.join(place(t), 'file.lock');
  holdLock(lock, { host: os.hostname(), machine: OTHER });
  assert.equal(taken(lock, { machine: MINE }), true, 'broken once older than staleMs');
});

test('a record with no machine id is judged by host name, as before', (t) => {
  const dir = place(t);
  const elsewhere = path.join(dir, 'elsewhere.lock');
  holdLock(elsewhere, { host: 'renamed-host.local' });
  assert.equal(taken(elsewhere, { machine: MINE }), true, 'another host: broken on age');
  const here = path.join(dir, 'here.lock');
  holdLock(here, { host: os.hostname() });
  assert.equal(taken(here, { machine: MINE }), false, 'this host, running: kept');
});

test('a writer that cannot read its own machine id judges by host name, as before', (t) => {
  const dir = place(t);
  const renamed = path.join(dir, 'renamed.lock');
  holdLock(renamed, { host: 'renamed-host.local', machine: MINE });
  assert.equal(taken(renamed, { machine: null }), true, 'another host name: broken on age');
  const here = path.join(dir, 'here.lock');
  holdLock(here, { host: os.hostname(), machine: OTHER });
  assert.equal(taken(here, { machine: null }), false, 'this host name, running: kept');
});

test('a lock records the writer\'s machine id, and none when it has none', (t) => {
  const dir = place(t);
  const lock = path.join(dir, 'file.lock');
  let seen = null;
  const own = acquireFileLock(lock, opts({ machine: MINE }));
  seen = JSON.parse(fs.readFileSync(lock, 'utf8'));
  releaseFileLock(lock, own);
  assert.equal(seen.machine, MINE);
  const own2 = acquireFileLock(lock, opts({ machine: null }));
  seen = JSON.parse(fs.readFileSync(lock, 'utf8'));
  releaseFileLock(lock, own2);
  assert.equal(Object.hasOwn(seen, 'machine'), false);
});
