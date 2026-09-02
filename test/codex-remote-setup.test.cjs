'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { setUpCodexRemote } = loadTs('src/main/codexRemoteSetup.ts');

const HOME = '/tmp/mdc/deadbeef';
const SOCKET = `${HOME}/app-server-control/app-server-control.sock`;

/** The setup's three IO edges, each defaulting to the happy path so a test only
 *  has to spell out the one it is breaking. */
function io(over = {}) {
  return {
    run: async () => ({ ok: true }),
    socketExists: () => true,
    ...over
  };
}
const ctx = (over = {}) => ({ home: HOME, executable: '/usr/bin/codex', agentId: 'worker-x', ...over });

test('a home whose control socket cannot be bound stops before the daemon is started', async () => {
  const ran = [];
  const r = await setUpCodexRemote(
    ctx({ home: '/Users/somebody/HarnessAgents/hive/agents/worker-with-a-very-long-name/.codex' }),
    io({ run: async (args) => { ran.push(args.join(' ')); return { ok: true }; } })
  );
  assert.equal(r.enabled, false);
  assert.equal(r.stage, 'socket-fit');
  assert.deepEqual(ran, [], 'a daemon must not be started for a home that cannot host its socket');
});

test('a failing daemon start is reported as the daemon start, and enable is never attempted', async () => {
  const ran = [];
  const r = await setUpCodexRemote(ctx(), io({
    run: async (args) => {
      ran.push(args.join(' '));
      return args.includes('start') ? { ok: false, error: 'boom' } : { ok: true };
    }
  }));
  assert.equal(r.enabled, false);
  assert.equal(r.stage, 'daemon-start');
  assert.match(r.detail, /boom/);
  assert.deepEqual(ran, ['app-server daemon start']);
});

test('a failing enable-remote-control is reported as the enable, not as the start', async () => {
  const r = await setUpCodexRemote(ctx(), io({
    run: async (args) => (args.includes('enable-remote-control') ? { ok: false, error: 'nope' } : { ok: true })
  }));
  assert.equal(r.enabled, false);
  assert.equal(r.stage, 'enable-remote');
  assert.match(r.detail, /nope/);
});

test('a daemon that reports success without leaving a socket is reported as the missing socket', async () => {
  const asked = [];
  const r = await setUpCodexRemote(ctx(), io({ socketExists: (p) => { asked.push(p); return false; } }));
  assert.equal(r.enabled, false);
  assert.equal(r.stage, 'socket-check');
  assert.deepEqual(asked, [SOCKET], 'the socket checked must be the one the endpoint will name');
});

test('a thrown IO error is caught and named, not propagated into the spawn', async () => {
  const r = await setUpCodexRemote(ctx(), io({ run: async () => { throw new Error('EPIPE'); } }));
  assert.equal(r.enabled, false);
  assert.equal(r.stage, 'setup-error');
  assert.match(r.detail, /EPIPE/);
});

test('the happy path hands back the endpoint the TUI should connect to', async () => {
  const r = await setUpCodexRemote(ctx(), io());
  assert.equal(r.enabled, true);
  assert.equal(r.stage, 'enabled');
  assert.equal(r.endpoint, `unix://${SOCKET}`);
});

// ── The record the floor can read ───────────────────────────────────────────
// Every branch above used to end in a console.warn, i.e. in the terminal the app
// was launched from. These pin the durable line instead.

const { CODEX_SPAWN_LOG_KIND } = loadTs('src/main/codexRemoteSetup.ts');

/** io() plus a recording trace sink. */
function tracingIo(over = {}) {
  const seen = [];
  return [seen, { ...io(over), trace: (e) => seen.push(e) }];
}

test('every outcome — success and each failure — leaves exactly one durable line', async () => {
  const cases = [
    ['socket-fit', ctx({ home: '/Users/somebody/HarnessAgents/hive/agents/worker-with-a-very-long-name/.codex' }), {}],
    ['daemon-start', ctx(), { run: async (a) => (a.includes('start') ? { ok: false, error: 'boom' } : { ok: true }) }],
    ['enable-remote', ctx(), { run: async (a) => (a.includes('enable-remote-control') ? { ok: false, error: 'nope' } : { ok: true }) }],
    ['socket-check', ctx(), { socketExists: () => false }],
    ['setup-error', ctx(), { run: async () => { throw new Error('EPIPE'); } }],
    ['enabled', ctx(), {}]
  ];
  for (const [stage, c, over] of cases) {
    const [seen, deps] = tracingIo(over);
    const r = await setUpCodexRemote(c, deps);
    assert.equal(seen.length, 1, `${stage}: expected one line, got ${seen.length}`);
    assert.equal(seen[0].kind, CODEX_SPAWN_LOG_KIND);
    assert.equal(seen[0].stage, stage, `${stage}: the line must report the stage actually reached`);
    assert.equal(seen[0].ok, r.enabled, `${stage}: the line must agree with what the spawn was told`);
    assert.equal(seen[0].agentId, c.agentId);
    assert.equal(typeof seen[0].ms, 'number');
  }
});

test('the line names the executable the daemon commands were run with', async () => {
  // The datum that separates "codex could not start its daemon" from "the daemon
  // commands were handed to a different CLI entirely" — indistinguishable in the
  // log without it, and the second is what actually happened on this machine.
  const [seen] = await (async () => {
    const [s, deps] = tracingIo({ run: async () => ({ ok: false, error: 'timed out' }) });
    await setUpCodexRemote(ctx({ executable: '/opt/homebrew/bin/claude' }), deps);
    return [s];
  })();
  assert.equal(seen[0].executable, '/opt/homebrew/bin/claude');
  assert.equal(seen[0].home, HOME);
});

test('a sink that throws cannot take the spawn down with it', async () => {
  const deps = { ...io(), trace: () => { throw new Error('disk full'); } };
  const r = await setUpCodexRemote(ctx(), deps);
  assert.equal(r.enabled, true, 'a failed log write must not be reported as a failed setup');
  assert.equal(r.stage, 'enabled');
});
