'use strict';

// A heavy-job slot remembers the CLI that asked for it: the hook's parent process, resolved past the shell that ran
// the hook, with its start time. The slot is judged by the file lock's holder rule (fileLock.ts isStaleHolder): it is
// freed when that process has exited, or, once the call is older than HOLDER_STALE_MS, when its pid now names a
// process that started at another time. A call from a subagent, whose agent id has no terminal of its own, is looked
// for in the process table under that CLI, so its command is seen while it runs and the slot is freed once it is
// gone. A call whose CLI is alive with the same start time is never freed early, and a call with no CLI pid (an older
// hook, another provider) is judged as before.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');
const { HeavyJobLock, HEAVY_SCAN_MISSES, HOLDER_STALE_MS, resolveHookHolder, gateHeavyCall } = loadTs('src/core/heavyJob.ts');

const H = { heavy: true, kind: 'suite', why: 'npm test' };
const CLI = process.pid; // a CLI that is running: this process
/** The pid of a process that has exited. */
const deadPid = () => Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).stdout.toString());

/** A lock whose clock, process table and start times the test sets. Agent "god" has a terminal at pid 100, and the
 *  CLI (this process) runs under it. */
function rig() {
  const logs = [];
  const world = {
    now: 1_000_000,
    rows: [{ pid: 100, parentPid: 1, commandLine: 'zsh' }, { pid: CLI, parentPid: 100, commandLine: 'claude' }],
    started: new Map([[CLI, 'ps:Mon 09:00']]),
  };
  const l = new HeavyJobLock({
    limit: () => 2, now: () => world.now,
    setTimer: () => ({}), clearTimer: () => {},
    log: (r) => logs.push(r),
    roots: () => [{ agentId: 'god', pid: 100 }],
    probe: async () => world.rows,
    startTime: (pid) => world.started.get(pid) ?? null,
    holderOf: (pid) => ({ pid, started: world.started.get(pid) ?? null }),
  });
  const released = () => logs.filter((r) => r.action === 'release').map((r) => r.reason);
  return { l, world, released };
}

const take = (x, agent, hookPid) => x.l.acquire(agent, H, 'npm test', `${agent}-1`, false, undefined, hookPid);

test('the CLI that asked for a slot has exited with the call still open: the slot is freed', async () => {
  const x = rig();
  take(x, 'sub-1', deadPid());
  await x.l.scan();
  assert.equal(x.l.snapshot().length, 0);
  assert.deepEqual(x.released(), ['holder-exit']);
});

test('the CLI\'s pid now names another process (another start time): the slot is freed once the call is old enough', async () => {
  const x = rig();
  take(x, 'sub-1', CLI);
  x.world.started.set(CLI, 'ps:Mon 10:30');
  await x.l.scan();
  assert.equal(x.l.snapshot().length, 1, 'a fresh call is not asked which process holds it');
  x.world.now += HOLDER_STALE_MS + 1;
  await x.l.scan();
  assert.equal(x.l.snapshot().length, 0);
  assert.deepEqual(x.released(), ['holder-exit']);
});

test('a subagent\'s command is seen under its CLI while it runs, and its slot is freed once the command is gone', async () => {
  const x = rig();
  take(x, 'sub-1', CLI);
  x.world.rows.push({ pid: 9001, parentPid: CLI, commandLine: 'sh -c npm test' });
  await x.l.scan();
  assert.equal(x.l.snapshot()[0].started, true, 'seen under the CLI');
  x.world.rows.pop();
  for (let i = 0; i < HEAVY_SCAN_MISSES; i++) await x.l.scan();
  assert.equal(x.l.snapshot().length, 0);
  assert.deepEqual(x.released(), ['process-exit']);
});

test('a long command whose CLI is alive with the same start time keeps its slot', async () => {
  const x = rig();
  take(x, 'sub-1', CLI);
  x.world.rows.push({ pid: 9001, parentPid: CLI, commandLine: 'sh -c npm test' });
  for (let i = 0; i < HEAVY_SCAN_MISSES * 3; i++) { x.world.now += HOLDER_STALE_MS; await x.l.scan(); }
  assert.equal(x.l.snapshot().length, 1);
  assert.deepEqual(x.released(), []);
});

test('a running CLI whose start time cannot be read is not freed early', async () => {
  const x = rig();
  take(x, 'sub-1', CLI);
  x.world.started.delete(CLI);
  for (let i = 0; i < HEAVY_SCAN_MISSES * 3; i++) { x.world.now += HOLDER_STALE_MS; await x.l.scan(); }
  assert.equal(x.l.snapshot().length, 1);
});

test('a call with no CLI pid is judged as before: a subagent\'s call never seen is kept', async () => {
  const x = rig();
  take(x, 'sub-1', undefined);
  x.world.rows.push({ pid: 9001, parentPid: CLI, commandLine: 'sh -c npm test' });
  for (let i = 0; i < HEAVY_SCAN_MISSES * 3; i++) await x.l.scan();
  assert.equal(x.l.snapshot().length, 1);
  assert.equal(x.l.snapshot()[0].started, false);
});

test('the hook gate passes the hook\'s parent pid to the lock', async () => {
  const x = rig();
  gateHeavyCall(x.l, 'sub-1', { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 't1', hook_ppid: deadPid() });
  await x.l.scan();
  assert.equal(x.l.snapshot().length, 0, 'freed: the lock knew the CLI, and it had exited');
});

test('the hook\'s parent is resolved past the shell that ran the hook, to the CLI', () => {
  const table = new Map([
    [700, { parentPid: 500, commandLine: '/bin/sh -c "/usr/local/bin/node" "/h/bin/cth-hook.cjs"' }],
    [500, { parentPid: 100, commandLine: 'claude --settings x' }],
  ]);
  const read = (pid) => table.get(pid) ?? null;
  const start = (pid) => `ps:start of ${pid}`;
  assert.deepEqual(resolveHookHolder(700, read, start), { pid: 500, started: 'ps:start of 500' });
  assert.deepEqual(resolveHookHolder(500, read, start), { pid: 500, started: 'ps:start of 500' });
  assert.equal(resolveHookHolder(999, read, start), null, 'a parent that cannot be read gives no holder');
});
