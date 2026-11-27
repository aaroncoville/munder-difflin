'use strict';

// A heavy-job slot remembers the process that started its call's hook (hook_ppid). Nothing is read when the slot is
// taken. Each scan reads the process table once, and only a scan begun after the slot was taken judges that pid:
//  - not listed, or listed with a start time after the slot was taken (another process now has the pid): dropped, and
//    the slot is judged as one whose hook gave no pid, as before;
//  - under a seat's terminal: the slot is bound to that seat, looked for in its tree (seen, then gone, frees it) and
//    freed when that terminal exits; it has no holder of its own;
//  - otherwise (a headless caller): the slot's holder, freed when it has exited, or, once the call is 30 s old, when
//    its pid shows another start time (fileLock.ts isStaleHolder); never on age.
// A listing that cannot be read judges no one.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');
const { HeavyJobLock, HEAVY_SCAN_MISSES, gateHeavyCall, parsePsOutput } = loadTs('src/core/heavyJob.ts');

/** Written out here, not imported: a running holder is asked which process it is only once the call is this old. */
const HOLDER_STALE_MS = 30_000;
const H = { heavy: true, kind: 'suite', why: 'npm test' };
const deadPid = () => Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).stdout.toString());
/** A running process standing in for a headless CLI; killed when the test ends. */
function live(t) {
  const p = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => { try { p.kill('SIGKILL'); } catch { /* gone */ } });
  return p;
}
const gone = async (p) => { p.kill('SIGKILL'); await new Promise((r) => (p.exitCode !== null || p.signalCode !== null ? r() : p.once('exit', r))); };

/** A lock whose clock and process table the test sets; it counts table reads. Seat "god" has a terminal at pid 100 and
 *  its CLI at 500 under it. `world.rows` holds the other processes; each started at `world.started.get(pid)` (ms). */
function rig() {
  const logs = [];
  const world = { now: 1_000_000, mono: 0, reads: 0, rows: [], started: new Map(), fail: false, hang: false, roots: [{ agentId: 'god', pid: 100 }] };
  const l = new HeavyJobLock({
    limit: () => 64, now: () => world.now, monotonic: () => world.mono,
    setTimer: () => ({}), clearTimer: () => {},
    log: (r) => logs.push(r),
    roots: () => world.roots,
    probe: async () => {
      world.reads++;
      if (world.hang) return new Promise(() => {});
      if (world.fail) throw new Error('ps: Operation not permitted');
      return [{ pid: 100, parentPid: 1, commandLine: 'zsh' }, { pid: 500, parentPid: 100, commandLine: '/usr/local/bin/claude' }, ...world.rows]
        .map((r) => (world.started.has(r.pid) ? { ...r, started: `ps:${world.started.get(r.pid)}`, startedAt: world.started.get(r.pid) } : r));
    },
  });
  const released = () => logs.filter((r) => r.action === 'release').map((r) => r.reason);
  const acts = (a) => logs.filter((r) => r.action === a);
  return { l, world, logs, released, acts };
}

let n = 0;
const take = (x, agent, hookPid) => x.l.acquire(agent, H, 'npm test', `${agent}-${n++}`, false, undefined, hookPid);
/** A headless CLI (no seat terminal above it) at `pid`, started a minute ago. */
const headless = (x, pid) => { x.world.rows.push({ pid, parentPid: 1, commandLine: '/usr/local/bin/claude -p' }); x.world.started.set(pid, x.world.now - 60_000); };

// — headless caller: the holder rule —

test('a headless caller that exits with the call still open frees the slot', async (t) => {
  const x = rig();
  const c = live(t);
  headless(x, c.pid);
  take(x, 'sub-1', c.pid);
  await x.l.scan();
  assert.equal(x.acts('holder-confirmed').length, 1);
  assert.equal(x.acts('holder-confirmed')[0].holderCommand, 'claude', 'the command name comes from the listing');
  await gone(c);
  x.world.rows = x.world.rows.filter((r) => r.pid !== c.pid);
  await x.l.scan();
  assert.deepEqual(x.released(), ['holder-exit']);
});

test('a headless caller whose pid shows another start time frees the slot only once the call is 30 s old', async () => {
  const x = rig();
  headless(x, process.pid);
  take(x, 'sub-1', process.pid);
  await x.l.scan();
  x.world.started.set(process.pid, x.world.now - 5_000);
  x.world.now += HOLDER_STALE_MS - 1;
  await x.l.scan();
  assert.equal(x.l.snapshot().length, 1, 'not yet: younger than 30 s');
  x.world.now += 2;
  await x.l.scan();
  assert.deepEqual(x.released(), ['holder-exit']);
});

test('a headless caller alive with the same start time keeps a long call, and so does one whose start the listing never gives', async () => {
  for (const withStart of [true, false]) {
    const x = rig();
    x.world.rows.push({ pid: process.pid, parentPid: 1, commandLine: 'claude -p' });
    if (withStart) x.world.started.set(process.pid, x.world.now - 60_000);
    take(x, 'sub-1', process.pid);
    for (let i = 0; i < HEAVY_SCAN_MISSES * 3; i++) { x.world.now += HOLDER_STALE_MS; await x.l.scan(); }
    assert.equal(x.l.snapshot().length, 1, `start ${withStart ? 'given' : 'never given'}`);
  }
});

// — dropped: the slot behaves as before —

test('a pid another process took after the slot was taken (it started later) is dropped, not confirmed', async () => {
  const x = rig();
  // The hook's parent is gone, and a `sleep` now has its pid: it started after the slot was taken.
  take(x, 'sub-1', 41_000);
  x.world.rows.push({ pid: 41_000, parentPid: 1, commandLine: 'sleep 600' });
  x.world.started.set(41_000, x.world.now + 3_000);
  await x.l.scan();
  assert.equal(x.acts('holder-confirmed').length, 0);
  assert.deepEqual(x.acts('holder-dropped').map((r) => r.rule), ['started after the slot was taken']);
  for (let i = 0; i < HEAVY_SCAN_MISSES * 3; i++) { x.world.now += HOLDER_STALE_MS; await x.l.scan(); }
  assert.equal(x.l.snapshot().length, 1, 'kept, as a slot whose hook gave no pid');
});

test('a pid the listing does not show is dropped, and the slot is kept as before', async () => {
  const x = rig();
  take(x, 'sub-1', deadPid());
  for (let i = 0; i < HEAVY_SCAN_MISSES * 3; i++) await x.l.scan();
  assert.deepEqual(x.acts('holder-dropped').map((r) => r.rule), ['not listed']);
  assert.equal(x.l.snapshot().length, 1);
});

test('a listing that was already being read when the slot was taken judges nothing about it', async () => {
  const x = rig();
  let answer = null;
  const late = new HeavyJobLock({
    limit: () => 64, now: () => x.world.now, setTimer: () => ({}), clearTimer: () => {},
    log: (r) => x.logs.push(r), roots: () => [{ agentId: 'god', pid: 100 }],
    probe: () => new Promise((resolve) => { answer = resolve; }),
  });
  late.acquire('other', H, 'npm test', 'other-a', false);
  const inFlight = late.scan();
  late.acquire('sub-1', H, 'npm test', 'sub-1-a', false, undefined, 41_001);
  answer([{ pid: 100, parentPid: 1, commandLine: 'zsh' }, { pid: 41_001, parentPid: 1, commandLine: 'sh -c hook' }]);
  await inFlight;
  assert.ok(!x.logs.some((r) => ['holder-confirmed', 'holder-bound', 'holder-dropped'].includes(r.action)));
});

test('a listing that cannot be read judges no one, and is not taken for an empty one', async () => {
  const x = rig();
  headless(x, process.pid);
  take(x, 'sub-1', process.pid);
  x.world.fail = true;
  await x.l.scan();
  assert.equal(x.acts('holder-dropped').length, 0);
  x.world.fail = false;
  await x.l.scan();
  assert.equal(x.acts('holder-confirmed').length, 1);
});

// — under a seat's terminal: bound to that seat —

test('a subagent\'s hook under a seat\'s terminal binds the slot to that seat: its command is seen, then gone, and the slot is freed', async () => {
  const x = rig();
  take(x, 'sub-1', 500);
  x.world.rows.push({ pid: 9001, parentPid: 500, commandLine: 'sh -c npm test' });
  await x.l.scan();
  assert.deepEqual(x.acts('holder-bound').map((r) => [r.seat, r.holderCommand]), [['god', 'claude']]);
  assert.equal(x.l.snapshot()[0].started, true, 'seen in the seat\'s tree');
  x.world.rows = [];
  for (let i = 0; i < HEAVY_SCAN_MISSES; i++) await x.l.scan();
  assert.deepEqual(x.released(), ['process-exit']);
});

test('a slot bound to a seat is freed when that seat\'s terminal exits', async () => {
  const x = rig();
  take(x, 'sub-1', 500);
  await x.l.scan();
  x.l.agentGone('god');
  assert.deepEqual(x.released(), ['pty-exit']);
});

test('a hook run through a helper under a seat, with the CLI alive, keeps its slot', async () => {
  const x = rig();
  // The helper that ran the hook is still listed when the scan reads; it is under the seat, so the slot is bound.
  x.world.rows.push({ pid: 9100, parentPid: 500, commandLine: 'sh -c hook' });
  take(x, 'sub-1', 9100);
  await x.l.scan();
  x.world.rows = [];
  for (let i = 0; i < HEAVY_SCAN_MISSES * 3; i++) { x.world.now += HOLDER_STALE_MS; await x.l.scan(); }
  assert.equal(x.l.snapshot().length, 1);
  assert.deepEqual(x.released(), []);
});

// — unchanged, and cost —

test('a call with no hook pid is judged as before: a subagent\'s call never seen is kept', async () => {
  const x = rig();
  take(x, 'sub-1', undefined);
  x.world.rows.push({ pid: 9001, parentPid: 500, commandLine: 'sh -c npm test' });
  for (let i = 0; i < HEAVY_SCAN_MISSES * 3; i++) await x.l.scan();
  assert.equal(x.l.snapshot().length, 1);
  assert.equal(x.l.snapshot()[0].started, false);
});

test('a hook pid of 0 or 1 gives no holder', () => {
  const x = rig();
  take(x, 'sub-0', 0);
  take(x, 'sub-1', 1);
  assert.ok(x.acts('acquire').every((r) => !('holderPid' in r)));
});

test('sixteen slots cost one table read per scan, and taking a slot reads nothing', async () => {
  const x = rig();
  for (let i = 0; i < 16; i++) { headless(x, 40_000 + i); take(x, `sub-${i}`, 40_000 + i); }
  assert.equal(x.world.reads, 0);
  await x.l.scan();
  await x.l.scan();
  assert.equal(x.world.reads, 2);
});

test('a table read that never answers frees nothing, and slots can still be taken', async () => {
  const x = rig();
  take(x, 'sub-1', deadPid());
  x.world.hang = true;
  void x.l.scan();
  assert.equal(take(x, 'sub-2', deadPid()).allow, true);
  assert.equal(x.l.snapshot().length, 2);
});

test('the hook gate passes the hook\'s parent pid to the lock, which logs it', () => {
  const x = rig();
  gateHeavyCall(x.l, 'sub-1', { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 't1', hook_ppid: 4321 });
  assert.equal(x.acts('acquire')[0].holderPid, 4321);
});

test('the process listing reads each start time as text and in ms (UTC), and lines without one as before', () => {
  assert.deepEqual(parsePsOutput('  10     1 Thu Nov 27 05:02:11 2026 /bin/zsh -c npm test\n 11 10 npm test\n'), [
    { pid: 10, parentPid: 1, commandLine: '/bin/zsh -c npm test', started: 'ps:Thu Nov 27 05:02:11 2026', startedAt: Date.UTC(2026, 10, 27, 5, 2, 11) },
    { pid: 11, parentPid: 10, commandLine: 'npm test' },
  ]);
});

// — a wall clock that moved between the slot and the scan —

test('a wall clock set back, a reused pid under another seat: the holder is dropped, and that seat\'s exit frees nothing of this slot', async () => {
  const x = rig();
  x.world.roots.push({ agentId: 'seat-b', pid: 200 });
  take(x, 'sub-a', 600);
  // Five seconds pass; the wall clock is set back 100 s; a new process under seat B takes pid 600, "started" before
  // the slot was taken by the new clock.
  x.world.mono += 5_000;
  x.world.now = 900_000;
  x.world.rows.push({ pid: 200, parentPid: 1, commandLine: 'zsh' }, { pid: 600, parentPid: 200, commandLine: 'claude' });
  x.world.started.set(600, 899_000);
  await x.l.scan();
  assert.deepEqual(x.acts('holder-dropped').map((r) => r.rule), ['the wall clock changed']);
  assert.equal(x.acts('holder-bound').length, 0);
  x.l.agentGone('seat-b');
  assert.deepEqual(x.released(), [], 'seat B\'s exit freed nothing of seat A\'s');
  assert.equal(x.l.snapshot().length, 1);
});

test('a wall clock that jumped forward between the slot and the scan: the holder is dropped', async () => {
  const x = rig();
  headless(x, process.pid);
  take(x, 'sub-1', process.pid);
  x.world.mono += 1_000;
  x.world.now += 600_000;
  await x.l.scan();
  assert.deepEqual(x.acts('holder-dropped').map((r) => r.rule), ['the wall clock changed']);
});

test('a wall clock that kept pace with the monotonic one (within 2 s): judged as usual', async () => {
  const x = rig();
  take(x, 'sub-1', 500);
  x.world.mono += 10_000;
  x.world.now += 11_900;
  await x.l.scan();
  assert.equal(x.acts('holder-bound').length, 1);
});
