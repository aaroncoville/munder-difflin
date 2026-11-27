'use strict';

// A heavy-job slot remembers the CLI that asked for it, as the hook shim found it (hook_ppid). Nothing is read about
// that process when the slot is taken (that runs on the app's main thread). Each scan reads the process table once,
// for every slot. The first scan after a slot is taken confirms its CLI when the table shows that pid, and records its
// start time; a pid the table does not show (a helper the CLI ran the hook through, a pid that was never the CLI) is
// dropped, and the slot is judged as one whose hook gave no pid. Only a confirmed CLI frees a slot, by the file lock's
// holder rule (fileLock.ts isStaleHolder): exited, at once; another start time, once the call is older than
// HOLDER_STALE_MS. A call from a subagent, whose agent id has no terminal of its own, is looked for under its CLI.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');
const { HeavyJobLock, HEAVY_SCAN_MISSES, gateHeavyCall, parsePsOutput } = loadTs('src/core/heavyJob.ts');
/** The age under which a running holder is never asked which process it is: 30 s, written out here, not imported. */
const HOLDER_STALE_MS = 30_000;

const H = { heavy: true, kind: 'suite', why: 'npm test' };
/** The pid of a process that has exited. */
const deadPid = () => Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).stdout.toString());
/** A running process standing in for a CLI; killed when the test ends. */
function cli(t) {
  const p = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => { try { p.kill('SIGKILL'); } catch { /* gone */ } });
  return p;
}
const gone = async (p) => { p.kill('SIGKILL'); await new Promise((r) => (p.exitCode !== null || p.signalCode !== null ? r() : p.once('exit', r))); };

/** A lock whose clock and process table the test sets; it counts the table reads. Agent "god" has a terminal at pid
 *  100. A CLI listed in `world.clis` shows in the table under it, with the start time `world.started` gives. */
function rig() {
  const logs = [];
  const world = { now: 1_000_000, reads: 0, clis: new Set(), started: new Map(), extra: [], fail: false, hang: false };
  const l = new HeavyJobLock({
    limit: () => 64, now: () => world.now,
    setTimer: () => ({}), clearTimer: () => {},
    log: (r) => logs.push(r),
    roots: () => [{ agentId: 'god', pid: 100 }],
    probe: async () => {
      world.reads++;
      if (world.hang) return new Promise(() => {});
      if (world.fail) throw new Error('ps: Operation not permitted');
      return [{ pid: 100, parentPid: 1, commandLine: 'zsh' },
        ...[...world.clis].map((pid) => ({ pid, parentPid: 100, commandLine: '/usr/local/bin/claude -p', ...(world.started.has(pid) ? { started: world.started.get(pid) } : {}) })),
        ...world.extra];
    },
  });
  const released = () => logs.filter((r) => r.action === 'release').map((r) => r.reason);
  return { l, world, logs, released };
}

let n = 0;
const take = (x, agent, hookPid) => x.l.acquire(agent, H, 'npm test', `${agent}-${n++}`, false, undefined, hookPid, 'claude');

test('a confirmed CLI that exits with the call still open frees the slot', async (t) => {
  const x = rig();
  const c = cli(t);
  x.world.clis.add(c.pid); x.world.started.set(c.pid, 'ps:Mon 09:00');
  take(x, 'sub-1', c.pid);
  await x.l.scan();
  assert.ok(x.logs.some((r) => r.action === 'holder-confirmed' && r.holderPid === c.pid && r.holderCommand === 'claude'));
  await gone(c); x.world.clis.delete(c.pid);
  await x.l.scan();
  assert.equal(x.l.snapshot().length, 0);
  assert.deepEqual(x.released(), ['holder-exit']);
});

test('a confirmed CLI whose pid now shows another start time frees the slot once the call is old enough', async () => {
  const x = rig();
  x.world.clis.add(process.pid); x.world.started.set(process.pid, 'ps:Mon 09:00');
  take(x, 'sub-1', process.pid);
  await x.l.scan();
  x.world.started.set(process.pid, 'ps:Mon 10:30');
  x.world.now += HOLDER_STALE_MS - 1;
  await x.l.scan();
  assert.equal(x.l.snapshot().length, 1, 'a call younger than HOLDER_STALE_MS is not asked which process holds it');
  x.world.now += 2;
  await x.l.scan();
  assert.equal(x.l.snapshot().length, 0, 'freed once the call is older than the bound');
  assert.deepEqual(x.released(), ['holder-exit']);
});

test('a hook pid of 0 or 1 gives no holder', () => {
  const x = rig();
  take(x, 'sub-0', 0);
  take(x, 'sub-1', 1);
  const acquires = x.logs.filter((r) => r.action === 'acquire');
  assert.equal(acquires.length, 2);
  assert.ok(acquires.every((r) => !('holderPid' in r)), JSON.stringify(acquires));
});

test('a start time that arrives only in a later listing is still used', async () => {
  const x = rig();
  x.world.clis.add(process.pid);
  take(x, 'sub-1', process.pid);
  await x.l.scan();
  x.world.started.set(process.pid, 'ps:Mon 09:00');
  await x.l.scan();
  x.world.started.set(process.pid, 'ps:Mon 10:30');
  x.world.now += HOLDER_STALE_MS + 1;
  await x.l.scan();
  assert.deepEqual(x.released(), ['holder-exit']);
});

test('a hook pid never seen running (a helper the CLI ran the hook through) is dropped, and the slot is kept while the CLI lives', async () => {
  const x = rig();
  x.world.clis.add(process.pid); x.world.started.set(process.pid, 'ps:Mon 09:00');
  take(x, 'god', deadPid());
  for (let i = 0; i < HEAVY_SCAN_MISSES * 3; i++) { x.world.now += HOLDER_STALE_MS; await x.l.scan(); }
  assert.equal(x.l.snapshot().length, 1, 'kept, as a slot whose hook gave no pid');
  assert.ok(x.logs.some((r) => r.action === 'holder-dropped'));
  assert.deepEqual(x.released(), []);
});

test('a subagent\'s command is seen under its CLI while it runs, and its slot is freed once the command is gone', async () => {
  const x = rig();
  x.world.clis.add(process.pid); x.world.started.set(process.pid, 'ps:Mon 09:00');
  take(x, 'sub-1', process.pid);
  x.world.extra.push({ pid: 9001, parentPid: process.pid, commandLine: 'sh -c npm test' });
  await x.l.scan();
  assert.equal(x.l.snapshot()[0].started, true, 'seen under the CLI');
  x.world.extra.pop();
  for (let i = 0; i < HEAVY_SCAN_MISSES; i++) await x.l.scan();
  assert.equal(x.l.snapshot().length, 0);
  assert.deepEqual(x.released(), ['process-exit']);
});

test('a long command whose CLI is alive with the same start time keeps its slot', async () => {
  const x = rig();
  x.world.clis.add(process.pid); x.world.started.set(process.pid, 'ps:Mon 09:00');
  take(x, 'sub-1', process.pid);
  x.world.extra.push({ pid: 9001, parentPid: process.pid, commandLine: 'sh -c npm test' });
  for (let i = 0; i < HEAVY_SCAN_MISSES * 3; i++) { x.world.now += HOLDER_STALE_MS; await x.l.scan(); }
  assert.equal(x.l.snapshot().length, 1);
  assert.deepEqual(x.released(), []);
});

test('a running CLI whose start time the listing never gives is not freed early', async () => {
  const x = rig();
  x.world.clis.add(process.pid);
  take(x, 'sub-1', process.pid);
  for (let i = 0; i < HEAVY_SCAN_MISSES * 3; i++) { x.world.now += HOLDER_STALE_MS; await x.l.scan(); }
  assert.equal(x.l.snapshot().length, 1);
});

test('a call with no CLI pid is judged as before: a subagent\'s call never seen is kept', async () => {
  const x = rig();
  take(x, 'sub-1', undefined);
  x.world.extra.push({ pid: 9001, parentPid: process.pid, commandLine: 'sh -c npm test' });
  for (let i = 0; i < HEAVY_SCAN_MISSES * 3; i++) await x.l.scan();
  assert.equal(x.l.snapshot().length, 1);
  assert.equal(x.l.snapshot()[0].started, false);
});

test('sixteen slots with live CLIs cost one table read per scan, and taking a slot reads nothing', async () => {
  const x = rig();
  const pids = Array.from({ length: 16 }, (_, i) => 40_000 + i);
  for (const pid of pids) { x.world.clis.add(pid); x.world.started.set(pid, 'ps:Mon 09:00'); }
  for (const pid of pids) take(x, `sub-${pid}`, pid);
  assert.equal(x.world.reads, 0, 'no read when the slots are taken');
  await x.l.scan();
  await x.l.scan();
  assert.equal(x.world.reads, 2, 'one read per scan, for all sixteen');
});

test('a table read that fails, or never answers, frees nothing, and slots can still be taken', async () => {
  const x = rig();
  take(x, 'sub-1', deadPid());
  x.world.fail = true;
  await x.l.scan();
  assert.equal(x.l.snapshot().length, 1);
  x.world.fail = false; x.world.hang = true;
  void x.l.scan();
  assert.equal(take(x, 'sub-2', deadPid()).allow, true, 'taking a slot does not wait for the read');
  assert.equal(x.l.snapshot().length, 2);
});

test('the hook gate passes the CLI pid and its command name to the lock', async (t) => {
  const x = rig();
  const c = cli(t);
  x.world.clis.add(c.pid);
  gateHeavyCall(x.l, 'sub-1', { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 't1', hook_ppid: c.pid, hook_ppid_command: 'claude' });
  assert.ok(x.logs.some((r) => r.action === 'acquire' && r.holderPid === c.pid && r.holderCommand === 'claude'));
  await x.l.scan();
  await gone(c); x.world.clis.delete(c.pid);
  await x.l.scan();
  assert.equal(x.l.snapshot().length, 0, 'freed: the lock knew the CLI, and it exited');
});

test('the process listing reads each process\'s start time, and lines without one as before', () => {
  assert.deepEqual(parsePsOutput('  10     1 Thu Nov 27 05:02:11 2026 /bin/zsh -c npm test\n 11 10 npm test\n'), [
    { pid: 10, parentPid: 1, commandLine: '/bin/zsh -c npm test', started: 'ps:Thu Nov 27 05:02:11 2026' },
    { pid: 11, parentPid: 10, commandLine: 'npm test' },
  ]);
  assert.deepEqual(parsePsOutput(' 12 1 Mon Dec  1 09:00:00 2026 node x')[0].started, 'ps:Mon Dec  1 09:00:00 2026');
});

test('a listing that was already being read when the slot was taken does not confirm its holder', async () => {
  const x = rig();
  // A helper the CLI ran the hook through, shown by a listing taken while the hook was still running.
  const helper = 41_001;
  let answer = null;
  const late = new HeavyJobLock({
    limit: () => 64, now: () => x.world.now, setTimer: () => ({}), clearTimer: () => {},
    log: (r) => x.logs.push(r), roots: () => [{ agentId: 'god', pid: 100 }],
    probe: () => new Promise((resolve) => { answer = resolve; }),
  });
  late.acquire('other', H, 'npm test', 'other-a', false);
  const inFlight = late.scan();
  late.acquire('sub-1', H, 'npm test', 'sub-1-a', false, undefined, helper, 'sh');
  answer([{ pid: 100, parentPid: 1, commandLine: 'zsh' }, { pid: helper, parentPid: 100, commandLine: 'sh -c cth-hook', started: 'ps:Mon 09:00' }]);
  await inFlight;
  assert.ok(!x.logs.some((r) => r.action === 'holder-confirmed'), 'the in-flight listing did not confirm the helper');
});

