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

test('a PTY a person had typed into was already in use, not a failed launch', () => {
  assert.equal(spawnRetryReason({ ...GOD_EXIT, hadInput: true, alreadyRetried: false }), null);
  assert.equal(
    spawnRetryReason({ exitCode: 1, signal: 0, uptimeMs: 100, tail: '', hadInput: true, alreadyRetried: false }),
    null
  );
});

// ── who counts as input: the PTY manager's write source ──────────────────

/** A PtyManager over a stubbed node-pty whose process we can end at will. */
function managerWithFakeProcess() {
  const procs = [];
  const ptyModulePath = require.resolve('node-pty');
  const saved = require.cache[ptyModulePath];
  require.cache[ptyModulePath] = {
    id: ptyModulePath, filename: ptyModulePath, loaded: true,
    exports: {
      spawn: () => {
        const p = { pid: 77, writes: [], dataCb: null, exitCb: null };
        p.onData = (cb) => { p.dataCb = cb; };
        p.onExit = (cb) => { p.exitCb = cb; };
        p.write = (d) => p.writes.push(d);
        p.kill = () => {};
        p.resize = () => {};
        procs.push(p);
        return p;
      }
    }
  };
  loadTs.reset();
  loadTs.stub('src/main/procKill.ts', { ensureKilled: () => {} });
  loadTs.stub('src/main/shellEnv.ts', {
    captureFromLoginShell: () => null, userShellPath: () => '/stub/bin', isSafeCommandName: () => true,
    windowsFallbackCandidates: () => []
  });
  const { PtyManager } = loadTs('src/main/pty.ts');
  if (saved) require.cache[ptyModulePath] = saved; else delete require.cache[ptyModulePath];
  const exits = [];
  const manager = new PtyManager();
  manager.setExitHandler((id, exitCode, info) => exits.push({ id, exitCode, info }));
  return { manager, procs, exits };
}

test('automation writes (OSC/DEC replies, seeded prompts, inbox nudges) do not mark the PTY as used by a person', () => {
  const { manager, procs, exits } = managerWithFakeProcess();
  const res = manager.spawn({ id: 'p1', cwd: process.cwd(), command: '/bin/true', args: [] }, null);
  assert.equal(res.ok, true, res.error);
  // The default source is 'auto', so no automation caller has to say so.
  assert.equal(manager.write('p1', '\x1b[?997;1n').ok, true);
  assert.equal(manager.write('p1', 'seeded prompt text\r', 'auto').ok, true);
  procs[0].exitCb({ exitCode: 1, signal: 0 });
  assert.equal(exits[0].info.hadInput, false);
  assert.equal(
    spawnRetryReason({ exitCode: 1, signal: 0, uptimeMs: 100, tail: '', hadInput: exits[0].info.hadInput, alreadyRetried: false }),
    'early-exit', 'the retry is not blocked by the harness\'s own writes'
  );
});

test('a keystroke from the terminal (source user) marks the PTY as used, and that blocks the retry', () => {
  const { manager, procs, exits } = managerWithFakeProcess();
  assert.equal(manager.spawn({ id: 'p2', cwd: process.cwd(), command: '/bin/true', args: [] }, null).ok, true);
  assert.equal(manager.write('p2', 'y', 'user').ok, true);
  procs[0].exitCb({ exitCode: 1, signal: 0 });
  assert.equal(exits[0].info.hadInput, true);
  assert.equal(
    spawnRetryReason({ exitCode: 1, signal: 0, uptimeMs: 100, tail: '', hadInput: exits[0].info.hadInput, alreadyRetried: false }),
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

/** A stand-in for the PtyManager's routing: output for an owner-less session
 *  goes to the ATTACHED sink, never anywhere else. `attach` / `attachedWebContents`
 *  mirror the real manager's API; `sinkFor` is its safeSend's choice. */
function fakePtyManager() {
  let attached = null;
  return {
    attach: (wc) => { attached = wc; },
    attachedWebContents: () => attached,
    sinkFor: (owner) => owner ?? attached
  };
}

/** A retrier over fakes that record everything. The app's "live window"
 *  (what main's own liveWebContents() would answer) is a DISTINCT object from
 *  the manager's attached sink, and is handed to nothing: a retrier that
 *  reached for it instead of the manager's sink would fail these tests. */
function harness({ spawn } = {}) {
  const calls = { spawn: [], teardown: [], log: [], warn: [], afterSpawn: 0 };
  const live = new Set();
  const manager = fakePtyManager();
  const decoyLiveWindow = fakeWindow();
  const retrier = new SpawnRetrier({
    spawn: spawn ?? ((opts, owner) => { calls.spawn.push({ opts, owner }); live.add(opts.id); return { ok: true }; }),
    isLive: (id) => live.has(id),
    attachedWebContents: () => manager.attachedWebContents(),
    teardown: (id) => calls.teardown.push(id),
    log: (e) => calls.log.push(e),
    afterSpawn: () => { calls.afterSpawn += 1; },
    warn: (m) => calls.warn.push(m)
  });
  return { retrier, calls, live, manager, decoyLiveWindow };
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
  const { retrier, calls, manager, decoyLiveWindow } = harness();
  const owner = fakeWindow();
  const attached = fakeWindow();
  manager.attach(attached);
  retrier.spawned(OPTS.id, OPTS, owner);
  assert.equal(retrier.onExit(OPTS.id, 'god', GOD_EXIT), true);

  owner.destroyed = true; // the floor closed mid-wait
  t.mock.timers.tick(SPAWN_RETRY_DELAY_MS);

  assert.deepEqual(calls.spawn, [], 'never spawned into a fallback window');
  assert.deepEqual(attached.sent, [], 'the manager\'s default sink heard nothing: it is not this PTY\'s window');
  assert.deepEqual(decoyLiveWindow.sent, []);
  assert.deepEqual(owner.sent, []);
  assert.deepEqual(calls.teardown, [OPTS.id]);
  assert.equal(calls.log[calls.log.length - 1].outcome, 'cancelled');
  assert.equal(calls.log[calls.log.length - 1].reason, 'window-gone');
});

test('an owner-less PTY is checked against, and relaunched into, the manager\'s attached sink — the one its output goes to', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { retrier, calls, manager, decoyLiveWindow } = harness();
  const attached = fakeWindow();
  manager.attach(attached);
  retrier.spawned(OPTS.id, OPTS, null);
  assert.equal(retrier.onExit(OPTS.id, 'god', GOD_EXIT), true);
  t.mock.timers.tick(SPAWN_RETRY_DELAY_MS);
  assert.equal(calls.spawn.length, 1);
  assert.equal(calls.spawn[0].owner, null, 'still owner-less, as spawned');
  const sink = manager.sinkFor(null);
  assert.equal(sink, attached);
  assert.deepEqual(sink.sent.map((s) => s.channel), [`pty:relaunch:${OPTS.id}`]);
  assert.deepEqual(decoyLiveWindow.sent, [], 'the app\'s live window is not the sink');
});

test('an owner-less PTY whose attached sink is destroyed (or missing) is cancelled with window-gone', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  {
    const { retrier, calls, manager, decoyLiveWindow } = harness();
    const attached = fakeWindow();
    manager.attach(attached);
    retrier.spawned(OPTS.id, OPTS, null);
    assert.equal(retrier.onExit(OPTS.id, 'god', GOD_EXIT), true);
    attached.destroyed = true;
    t.mock.timers.tick(SPAWN_RETRY_DELAY_MS);
    assert.deepEqual(calls.spawn, []);
    assert.deepEqual(decoyLiveWindow.sent, [], 'no fallback to the app\'s live window');
    assert.deepEqual(calls.teardown, [OPTS.id]);
    assert.equal(calls.log[calls.log.length - 1].reason, 'window-gone');
  }
  {
    const { retrier, calls } = harness(); // nothing attached at all
    retrier.spawned(OPTS.id, OPTS, null);
    assert.equal(retrier.onExit(OPTS.id, 'god', GOD_EXIT), true);
    t.mock.timers.tick(SPAWN_RETRY_DELAY_MS);
    assert.deepEqual(calls.spawn, []);
    assert.deepEqual(calls.teardown, [OPTS.id]);
    assert.equal(calls.log[calls.log.length - 1].reason, 'window-gone');
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
