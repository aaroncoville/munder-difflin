'use strict';

/**
 * spawnRetry.ts: the one-retry decision for a PTY that dies right after
 * launch, and the timer/owner/teardown path that carries it out (see the
 * module header for the 2026-10-20 god spawn it exists for).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  spawnRetryReason, SpawnRetrier, SPAWN_RETRY_WINDOW_MS, SPAWN_RETRY_DELAY_MS, SPAWN_RETRY_LOG_KIND
} = loadTs('src/main/spawnRetry.ts');

// The crash as recorded in hive/crashes/2026-10-20T18-39-48-574Z-god.log.
const EXECVP_TAIL = 'execvp(3) failed.: Permission denied\r\n';
const GOD_EXIT = { exitCode: 1, signal: 0, uptimeMs: 444, tail: EXECVP_TAIL, hadInput: false };

// ── the decision ─────────────────────────────────────────────────────────

test('repro: the god spawn that died on execvp Permission denied is retried', () => {
  assert.equal(spawnRetryReason({ ...GOD_EXIT, alreadyRetried: false }), 'exec-failed');
});

test('an exec failure is retried however long the PTY lived', () => {
  assert.equal(spawnRetryReason({ ...GOD_EXIT, uptimeMs: 30_000, alreadyRetried: false }), 'exec-failed');
  assert.equal(
    spawnRetryReason({ exitCode: 1, signal: 0, uptimeMs: 10, tail: 'posix_spawnp failed.: No such file or directory', alreadyRetried: false }),
    'exec-failed'
  );
});

test('any non-zero exit inside the launch window is retried, whatever it printed', () => {
  assert.equal(
    spawnRetryReason({ exitCode: 1, signal: 0, uptimeMs: SPAWN_RETRY_WINDOW_MS - 1, tail: 'error: unknown option', alreadyRetried: false }),
    'early-exit'
  );
  assert.equal(spawnRetryReason({ exitCode: 3, signal: 0, uptimeMs: 0, tail: '', alreadyRetried: false }), 'early-exit');
});

test('a non-zero exit after the launch window is a real failure, not a launch failure', () => {
  assert.equal(
    spawnRetryReason({ exitCode: 1, signal: 0, uptimeMs: SPAWN_RETRY_WINDOW_MS, tail: 'rate limited', alreadyRetried: false }),
    null
  );
});

test('a clean exit is never retried', () => {
  assert.equal(spawnRetryReason({ exitCode: 0, signal: 0, uptimeMs: 100, tail: '', alreadyRetried: false }), null);
});

test('a signal death is a chosen death, not a launch failure', () => {
  assert.equal(spawnRetryReason({ exitCode: 0, signal: 9, uptimeMs: 100, tail: EXECVP_TAIL, alreadyRetried: false }), null);
  assert.equal(spawnRetryReason({ exitCode: 1, signal: 15, uptimeMs: 100, tail: '', alreadyRetried: false }), null);
});

test('a person ending the process (Ctrl-C 130, SIGTERM 143, the CLI\'s interrupted 2) is never retried', () => {
  for (const exitCode of [130, 143, 2]) {
    assert.equal(spawnRetryReason({ exitCode, signal: 0, uptimeMs: 100, tail: '', alreadyRetried: false }), null, `code ${exitCode}`);
    assert.equal(spawnRetryReason({ exitCode, signal: 0, uptimeMs: 100, tail: EXECVP_TAIL, alreadyRetried: false }), null, `code ${exitCode} with exec tail`);
  }
});

test('a PTY that had input before it died was already in use, not a failed launch', () => {
  assert.equal(spawnRetryReason({ ...GOD_EXIT, hadInput: true, alreadyRetried: false }), null);
  assert.equal(
    spawnRetryReason({ exitCode: 1, signal: 0, uptimeMs: 100, tail: '', hadInput: true, alreadyRetried: false }),
    null
  );
});

test('an unknown exit code is not second-guessed', () => {
  assert.equal(spawnRetryReason({ uptimeMs: 100, tail: EXECVP_TAIL, alreadyRetried: false }), null);
});

test('one retry per launch: the second identical death tears down', () => {
  assert.equal(spawnRetryReason({ ...GOD_EXIT, alreadyRetried: true }), null);
});

// ── the retry itself: timer, owner, teardown ─────────────────────────────

const OPTS = { id: 'pty-god', cwd: '/hive', command: 'claude', args: ['--model', 'x'] };

function fakeWindow() {
  const w = { destroyed: false, sent: [], isDestroyed: () => w.destroyed, send: (channel, payload) => w.sent.push({ channel, payload }) };
  return w;
}

/** A retrier over fakes that record everything. */
function harness({ spawn } = {}) {
  const calls = { spawn: [], teardown: [], log: [], warn: [], afterSpawn: 0 };
  const live = new Set();
  let liveWindow = null;
  const retrier = new SpawnRetrier({
    spawn: spawn ?? ((opts, owner) => { calls.spawn.push({ opts, owner }); live.add(opts.id); return { ok: true }; }),
    isLive: (id) => live.has(id),
    liveWebContents: () => liveWindow,
    teardown: (id) => calls.teardown.push(id),
    log: (e) => calls.log.push(e),
    afterSpawn: () => { calls.afterSpawn += 1; },
    warn: (m) => calls.warn.push(m)
  });
  return { retrier, calls, live, setLiveWindow: (w) => { liveWindow = w; } };
}

test('a launch failure is re-run once, as-is, after the delay, and the terminal is re-armed only after the spawn succeeds', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { retrier, calls } = harness();
  const owner = fakeWindow();
  retrier.spawned(OPTS.id, OPTS, owner);

  assert.equal(retrier.onExit(OPTS.id, 'god', GOD_EXIT), true, 'the retrier took the exit');
  assert.deepEqual(calls.teardown, []);
  assert.equal(calls.log.length, 1);
  assert.equal(calls.log[0].kind, SPAWN_RETRY_LOG_KIND);
  assert.equal(calls.log[0].reason, 'exec-failed');
  assert.equal(calls.log[0].agentId, 'god');
  assert.equal(calls.log[0].delayMs, SPAWN_RETRY_DELAY_MS);

  t.mock.timers.tick(SPAWN_RETRY_DELAY_MS - 1);
  assert.deepEqual(calls.spawn, [], 'nothing before the delay');
  t.mock.timers.tick(1);
  assert.equal(calls.spawn.length, 1);
  assert.equal(calls.spawn[0].opts, OPTS, 'the very same spawn options');
  assert.equal(calls.spawn[0].owner, owner, 'into the same window');
  assert.deepEqual(owner.sent.map((s) => s.channel), [`pty:relaunch:${OPTS.id}`]);
  assert.equal(calls.afterSpawn, 1);
  assert.deepEqual(calls.teardown, []);

  // The relaunched process dies the same way: no second retry.
  assert.equal(retrier.onExit(OPTS.id, 'god', GOD_EXIT), false);
  assert.equal(calls.spawn.length, 1);
});

test('a fresh spawn under the same id gets its own single retry', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { retrier, calls, live } = harness();
  retrier.spawned(OPTS.id, OPTS, fakeWindow());
  assert.equal(retrier.onExit(OPTS.id, 'god', GOD_EXIT), true);
  t.mock.timers.tick(SPAWN_RETRY_DELAY_MS);
  assert.equal(retrier.onExit(OPTS.id, 'god', GOD_EXIT), false);
  live.clear();
  retrier.spawned(OPTS.id, OPTS, fakeWindow());
  assert.equal(retrier.onExit(OPTS.id, 'god', GOD_EXIT), true);
  t.mock.timers.tick(SPAWN_RETRY_DELAY_MS);
  assert.equal(calls.spawn.length, 2);
});

test('the owner window destroyed during the wait cancels the retry and runs the normal teardown', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { retrier, calls, setLiveWindow } = harness();
  const owner = fakeWindow();
  const other = fakeWindow();
  setLiveWindow(other);
  retrier.spawned(OPTS.id, OPTS, owner);
  assert.equal(retrier.onExit(OPTS.id, 'god', GOD_EXIT), true);

  owner.destroyed = true; // the floor closed mid-wait
  t.mock.timers.tick(SPAWN_RETRY_DELAY_MS);

  assert.deepEqual(calls.spawn, [], 'never spawned into a fallback window');
  assert.deepEqual(other.sent, [], 'the other window heard nothing');
  assert.deepEqual(owner.sent, []);
  assert.deepEqual(calls.teardown, [OPTS.id]);
  assert.equal(calls.log[calls.log.length - 1].outcome, 'cancelled');
});

test('a PTY with no owner relaunches into the default window, and is torn down when there is none', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  {
    const { retrier, calls, setLiveWindow } = harness();
    const primary = fakeWindow();
    setLiveWindow(primary);
    retrier.spawned(OPTS.id, OPTS, null);
    assert.equal(retrier.onExit(OPTS.id, 'god', GOD_EXIT), true);
    t.mock.timers.tick(SPAWN_RETRY_DELAY_MS);
    assert.equal(calls.spawn.length, 1);
    assert.equal(calls.spawn[0].owner, null, 'still owner-less, as spawned');
    assert.deepEqual(primary.sent.map((s) => s.channel), [`pty:relaunch:${OPTS.id}`]);
  }
  {
    const { retrier, calls } = harness();
    retrier.spawned(OPTS.id, OPTS, null);
    assert.equal(retrier.onExit(OPTS.id, 'god', GOD_EXIT), true);
    t.mock.timers.tick(SPAWN_RETRY_DELAY_MS);
    assert.deepEqual(calls.spawn, []);
    assert.deepEqual(calls.teardown, [OPTS.id]);
  }
});

test('a teardown during the wait (tab closed, archived, quit) leaves nothing to retry', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { retrier, calls } = harness();
  retrier.spawned(OPTS.id, OPTS, fakeWindow());
  assert.equal(retrier.onExit(OPTS.id, 'god', GOD_EXIT), true);
  retrier.forget(OPTS.id);
  t.mock.timers.tick(SPAWN_RETRY_DELAY_MS);
  assert.deepEqual(calls.spawn, []);
  assert.deepEqual(calls.teardown, [], 'the caller already tore down; not again');
});

test('an id that is live again when the timer fires is left alone', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { retrier, calls, live } = harness();
  retrier.spawned(OPTS.id, OPTS, fakeWindow());
  assert.equal(retrier.onExit(OPTS.id, 'god', GOD_EXIT), true);
  live.add(OPTS.id); // something else respawned it meanwhile
  t.mock.timers.tick(SPAWN_RETRY_DELAY_MS);
  assert.deepEqual(calls.spawn, []);
  assert.deepEqual(calls.teardown, []);
});

for (const [label, spawn] of [
  ['returns an error', () => ({ ok: false, error: 'cwd does not exist' })],
  ['throws', () => { throw new Error('posix_spawnp failed'); }]
]) {
  test(`a retry whose spawn ${label} reports the exit to the renderer and tears down; no relaunch is ever sent`, (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { retrier, calls } = harness({ spawn });
    const owner = fakeWindow();
    retrier.spawned(OPTS.id, OPTS, owner);
    assert.equal(retrier.onExit(OPTS.id, 'god', GOD_EXIT), true);
    t.mock.timers.tick(SPAWN_RETRY_DELAY_MS);
    assert.deepEqual(owner.sent, [{ channel: `pty:exit:${OPTS.id}`, payload: { exitCode: 1, signal: 0 } }]);
    assert.deepEqual(calls.teardown, [OPTS.id]);
    assert.equal(calls.afterSpawn, 0);
    assert.equal(calls.log[calls.log.length - 1].outcome, 'failed');
  });
}

test('an exit the decision declines is handed straight back for the normal teardown', () => {
  const { retrier, calls } = harness();
  retrier.spawned(OPTS.id, OPTS, fakeWindow());
  assert.equal(retrier.onExit(OPTS.id, 'god', { exitCode: 130, signal: 0, uptimeMs: 100, tail: '' }), false);
  assert.equal(retrier.onExit(OPTS.id, 'god', { ...GOD_EXIT, hadInput: true }), false);
  assert.equal(retrier.onExit('unknown-id', 'x', GOD_EXIT), false, 'an id never spawned through the retrier');
  assert.deepEqual(calls.log, []);
});
