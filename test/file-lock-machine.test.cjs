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

// An id file can be copied to a second machine (a restore, a migration), so this machine's id under another host
// name only protects a holder this machine can see running; it never condemns one by itself.
test('this machine\'s id under another host name, with no such process here, is judged by age, not broken at once', (t) => {
  const dir = place(t);
  const gone = 2 ** 22 + 12345; // a pid no process has here
  const fresh = path.join(dir, 'fresh.lock');
  fs.writeFileSync(fresh, JSON.stringify({ pid: gone, host: 'other-mac.local', machine: MINE, started: started(gone), acquiredAt: new Date(Date.now() - 1000).toISOString(), token: 'theirs' }));
  assert.equal(taken(fresh, { machine: MINE, staleMs: 30_000 }), false, 'a second old: kept, as another machine\'s holder is');
  const old = path.join(dir, 'old.lock');
  fs.writeFileSync(old, JSON.stringify({ pid: gone, host: 'other-mac.local', machine: MINE, started: started(gone), acquiredAt: new Date(Date.now() - 10 * 60_000).toISOString(), token: 'theirs' }));
  assert.equal(taken(old, { machine: MINE, staleMs: 30_000 }), true, 'older than staleMs: broken');
});

test('this machine\'s id under another host name, where the pid runs another process, is judged by age', (t) => {
  const dir = place(t);
  const fresh = path.join(dir, 'fresh.lock');
  holdLock(fresh, { host: 'other-mac.local', machine: MINE, started: 'ps:another process', acquiredAt: new Date(Date.now() - 1000).toISOString() });
  assert.equal(taken(fresh, { machine: MINE, staleMs: 30_000 }), false, 'a second old: kept');
  const old = path.join(dir, 'old.lock');
  holdLock(old, { host: 'other-mac.local', machine: MINE, started: 'ps:another process' });
  assert.equal(taken(old, { machine: MINE, staleMs: 30_000 }), true, 'older than staleMs: broken');
});

test('this machine\'s id under another host name, where the start time cannot be read, is judged by age', (t) => {
  const lock = path.join(place(t), 'file.lock');
  holdLock(lock, { host: 'other-mac.local', machine: MINE });
  assert.equal(taken(lock, { machine: MINE, staleMs: 30_000, startTime: () => null }), true, 'not shown to be the same process: broken once old');
});

test('a writer that times out names the holder\'s pid as one to stop only when the holder is on this host', (t) => {
  const dir = place(t);
  const message = (record) => {
    const lock = path.join(dir, `${record.machine}-${record.host}.lock`);
    holdLock(lock, record);
    try { acquireFileLock(lock, opts({ machine: MINE, staleMs: 30 * 60_000 })); } catch (e) { return e.message; }
    return 'taken';
  };
  assert.match(message({ host: os.hostname(), machine: MINE }), /stopping it frees the lock/);
  assert.doesNotMatch(message({ host: os.hostname(), machine: OTHER }), /stopping it frees the lock/, 'another machine\'s holder');
  assert.doesNotMatch(message({ host: 'other-mac.local', machine: MINE }), /stopping it frees the lock/, 'this id under another host name');
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
