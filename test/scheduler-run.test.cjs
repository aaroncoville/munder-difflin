'use strict';
// The scheduler's runs, with a stub runner, a temporary hive and a temporary core.db.
//
// A due task is claimed as one run per (task, slot): a unique row in core.db, keyed by the slot the schedule names,
// so two schedulers, a restart or a clock that jumps cannot fire one slot twice, and a slot older than the newest one
// claimed is never fired. Whoever runs a task holds its lease (holder pid, host, start time; renewed by a heartbeat
// while the runner works); a holder on this host that is still running is never taken over on expiry alone, the same
// rule as the shared file lock, and the status names it. A dead holder's run is resumed, not repeated: rerun when its
// runner had not finished, finished off without another runner call when it had. The run uses the definition frozen
// at claim. Its cost row and done mail are keyed by the run id, so a crash anywhere leaves exactly one of each.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');
const { AGENT, at, floor, taskDef, headlessRun, ledgerRows, mail, calls } = require('./scheduler-fixtures.cjs');

const S = loadTs('src/core/scheduler/store.ts');
const T = loadTs('src/core/scheduler/task.ts');
const { Scheduler, schedulerStatus } = loadTs('src/core/scheduler/scheduler.ts');

const CHILD = path.join(__dirname, 'scheduler-child.cjs');
const LIMIT = { timeout: 30_000 };

function open(t, f) {
  const store = S.openSchedulerStore({ path: f.dbPath, hiveRoots: [f.hiveRoot] });
  t.after(() => store.close());
  return store;
}

/** A stub runner that records each call (in `f.calls`, as a child's does) and returns a finished, done run. */
function stub(f, more = {}) {
  const jobs = [];
  const runner = async (job) => {
    jobs.push(job);
    fs.appendFileSync(f.calls, `${job.runId} ${job.snapshot.prompt}\n`);
    if (more.throws) throw new Error(more.throws);
    return { run: headlessRun(), done: true, doneReason: null };
  };
  return { runner, jobs };
}

/** A scheduler in a child process. Its pid is recorded and only that pid is ever killed. */
function child(t, opts) {
  const proc = spawn(process.execPath, [CHILD, JSON.stringify(opts)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { err += d; });
  const exited = new Promise((resolve) => proc.on('exit', (code, signal) => resolve({ code, signal, out, err })));
  t.after(() => { try { process.kill(proc.pid, 'SIGKILL'); } catch { /* already gone */ } });
  return { pid: proc.pid, exited };
}

async function waitFor(file, ms = 10_000) {
  const end = Date.now() + ms;
  while (!fs.existsSync(file)) {
    if (Date.now() > end) throw new Error(`${file} never appeared`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const runsOf = (store) => store.runs();
const rowsFor = (f, runId) => ledgerRows(f).filter((r) => r.run_id === runId);

/** One cost row and one done mail for the run, and the run done. */
function exactlyOnce(f, store) {
  const runs = runsOf(store);
  assert.equal(runs.length, 1, 'one run row');
  const [run] = runs;
  assert.equal(run.state, 'done');
  assert.equal(rowsFor(f, run.id).length, 1, 'one cost row for the run');
  assert.equal(ledgerRows(f).length, 2, 'and no other row was added');
  const msgs = mail(f);
  assert.equal(msgs.length, 1, 'one done mail');
  assert.equal(msgs[0].act, 'done');
  assert.equal(msgs[0].to, 'god');
  return run;
}

test('Given a due task and a free lease, when the scheduler ticks, then exactly one run is claimed and the runner is called once', LIMIT, async (t) => {
  const f = floor(t);
  const store = open(t, f);
  store.putTask(taskDef(f), at(0, 6));
  const { runner } = stub(f);
  const s = new Scheduler({ store, hiveRoot: f.hiveRoot, runner, now: () => at(1, 7, 20) });
  await s.tick();
  await s.tick();
  assert.equal(calls(f).length, 1);
  const run = exactlyOnce(f, store);
  assert.equal(run.slot, '2026-11-21T07:19');
  assert.equal(rowsFor(f, run.id)[0].agent_id, AGENT);
  assert.deepEqual(schedulerStatus(store, { now: at(1, 7, 21) }).leases, [], 'the lease is released after the run');
});

test('Given a task not yet due, when the scheduler ticks, then nothing is claimed', LIMIT, async (t) => {
  const f = floor(t);
  const store = open(t, f);
  store.putTask(taskDef(f), at(1, 6));
  const { runner } = stub(f);
  await new Scheduler({ store, hiveRoot: f.hiveRoot, runner, now: () => at(1, 7, 18) }).tick();
  assert.equal(calls(f).length, 0);
  assert.equal(runsOf(store).length, 0);
});

test('Given two schedulers in two processes, when they tick at the same moment, then one run is claimed and run once', LIMIT, async (t) => {
  const f = floor(t);
  const store = open(t, f);
  store.putTask(taskDef(f), at(0, 6));
  const opts = { dbPath: f.dbPath, hiveRoot: f.hiveRoot, calls: f.calls, now: at(1, 7, 20), mode: 'slow' };
  const [a, b] = [child(t, opts), child(t, opts)];
  const results = await Promise.all([a.exited, b.exited]);
  for (const r of results) assert.equal(r.code, 0, r.err);
  assert.equal(calls(f).length, 1);
  exactlyOnce(f, store);
});

test('Given a holder killed while its runner was working, when a scheduler restarts, then the same run resumes with no new row', LIMIT, async (t) => {
  const f = floor(t);
  const store = open(t, f);
  store.putTask(taskDef(f), at(0, 6));
  const started = path.join(f.base, 'started');
  const c = child(t, { dbPath: f.dbPath, hiveRoot: f.hiveRoot, calls: f.calls, started, now: at(1, 7, 20), mode: 'hang' });
  await waitFor(started);
  const [claimed] = runsOf(store);
  process.kill(c.pid, 'SIGKILL');
  await c.exited;
  const { runner } = stub(f);
  await new Scheduler({ store, hiveRoot: f.hiveRoot, runner, now: () => at(1, 7, 25) }).tick();
  const run = exactlyOnce(f, store);
  assert.equal(run.id, claimed.id, 'the same run');
  assert.equal(run.attempt, 2, 'its runner ran again, because it had not finished');
  assert.deepEqual(calls(f).map((l) => l.split(' ')[0]), [claimed.id, claimed.id]);
});

test('Given a holder killed after its runner finished, when a scheduler restarts, then the run is finished off without calling the runner again', LIMIT, async (t) => {
  const f = floor(t);
  const store = open(t, f);
  store.putTask(taskDef(f), at(0, 6));
  const c = child(t, { dbPath: f.dbPath, hiveRoot: f.hiveRoot, calls: f.calls, now: at(1, 7, 20), mode: 'ok', crashAt: 'afterRunnerResult' });
  assert.equal((await c.exited).signal, 'SIGKILL');
  const { runner } = stub(f);
  await new Scheduler({ store, hiveRoot: f.hiveRoot, runner, now: () => at(1, 7, 25) }).tick();
  assert.equal(calls(f).length, 1, 'the runner was called once, by the holder that died');
  assert.equal(exactlyOnce(f, store).attempt, 1);
});

test('Given a live holder that keeps heartbeating past its first expiry, when another scheduler ticks, then it is not taken over and the status names it', LIMIT, async (t) => {
  const f = floor(t);
  const store = open(t, f);
  store.putTask(taskDef(f), at(0, 6));
  const started = path.join(f.base, 'started');
  const c = child(t, { dbPath: f.dbPath, hiveRoot: f.hiveRoot, calls: f.calls, started, mode: 'hang', leaseMs: 300, heartbeatMs: 50 });
  await waitFor(started);
  await new Promise((r) => setTimeout(r, 700));
  const { runner } = stub(f);
  const report = await new Scheduler({ store, hiveRoot: f.hiveRoot, runner, leaseMs: 300 }).tick();
  assert.equal(calls(f).length, 1, 'only the holder ran it');
  assert.equal(report.skipped.length, 1);
  assert.match(report.skipped[0].reason, new RegExp(`pid ${c.pid}`));
  const [lease] = schedulerStatus(store).leases;
  assert.equal(lease.pid, c.pid);
  assert.equal(lease.host, os.hostname());
  assert.equal(lease.state, 'held');
  assert.ok(lease.heartbeatAgeMs < 300, `heartbeat ${lease.heartbeatAgeMs} ms ago`);
});

test('Given a live holder that has stopped heartbeating, when another scheduler ticks past the expiry, then it is not taken over and the status reports it hung with pid, host and age; once it is stopped, the run resumes', LIMIT, async (t) => {
  const f = floor(t);
  const store = open(t, f);
  store.putTask(taskDef(f), at(0, 6));
  const started = path.join(f.base, 'started');
  const c = child(t, { dbPath: f.dbPath, hiveRoot: f.hiveRoot, calls: f.calls, started, mode: 'block', leaseMs: 300, heartbeatMs: 50 });
  await waitFor(started);
  await new Promise((r) => setTimeout(r, 700));
  const { runner } = stub(f);
  const s = new Scheduler({ store, hiveRoot: f.hiveRoot, runner, leaseMs: 300 });
  const report = await s.tick();
  assert.equal(calls(f).length, 1);
  assert.match(report.skipped[0].reason, new RegExp(`pid ${c.pid}`));
  const [lease] = schedulerStatus(store).leases;
  assert.equal(lease.state, 'hung');
  assert.equal(lease.pid, c.pid);
  assert.equal(lease.host, os.hostname());
  assert.ok(lease.heartbeatAgeMs >= 300, `heartbeat ${lease.heartbeatAgeMs} ms ago`);
  assert.match(lease.summary, new RegExp(`pid ${c.pid} on ${os.hostname()}.*\\d+ ms`));
  process.kill(c.pid, 'SIGKILL');
  await c.exited;
  await s.tick();
  assert.equal(calls(f).length, 2);
  assert.equal(exactlyOnce(f, store).attempt, 2);
});

test('Given a task edited after its run was claimed, when the run goes ahead, then it uses the definition frozen at claim', LIMIT, async (t) => {
  const f = floor(t);
  const store = open(t, f);
  const def = taskDef(f);
  store.putTask(def, at(0, 6));
  const { runner, jobs } = stub(f);
  const hooks = { afterClaim: () => store.putTask({ ...def, prompt: 'Edited prompt.', model: 'opus', maxBudgetUsd: 9 }, at(1, 7, 20)) };
  await new Scheduler({ store, hiveRoot: f.hiveRoot, runner, hooks, now: () => at(1, 7, 20) }).tick();
  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0].snapshot, def);
  assert.equal(jobs[0].maxBudgetUsd, def.maxBudgetUsd);
  assert.deepEqual(runsOf(store)[0].snapshot, def);
  assert.equal(store.getTask(def.id).prompt, 'Edited prompt.', 'the task itself is edited');
});

test('Given a task edited while its claimed run waited for a restart, when the run resumes, then it uses the frozen definition', LIMIT, async (t) => {
  const f = floor(t);
  const store = open(t, f);
  const def = taskDef(f);
  store.putTask(def, at(0, 6));
  const c = child(t, { dbPath: f.dbPath, hiveRoot: f.hiveRoot, calls: f.calls, now: at(1, 7, 20), mode: 'ok', crashAt: 'afterClaim' });
  assert.equal((await c.exited).signal, 'SIGKILL');
  store.putTask({ ...def, prompt: 'Edited prompt.' }, at(1, 7, 21));
  const { runner, jobs } = stub(f);
  await new Scheduler({ store, hiveRoot: f.hiveRoot, runner, now: () => at(1, 7, 22) }).tick();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].snapshot.prompt, def.prompt);
});

test('Given a task whose cap is within the ceiling, when it runs, then the runner is given maxBudgetUsd equal to the task cap', LIMIT, async (t) => {
  const f = floor(t);
  const store = open(t, f);
  const def = T.importTaskDefinition(JSON.stringify(taskDef(f, { maxBudgetUsd: 2.5 })), { ceilingUsd: 10 });
  store.putTask(def, at(0, 6));
  const { runner, jobs } = stub(f);
  await new Scheduler({ store, hiveRoot: f.hiveRoot, runner, now: () => at(1, 7, 20) }).tick();
  assert.equal(jobs[0].maxBudgetUsd, 2.5);
  assert.throws(() => T.importTaskDefinition(JSON.stringify(taskDef(f, { maxBudgetUsd: 12 })), { ceilingUsd: 10 }), /maxBudgetUsd/);
});

test('Given the wall clock jumping backwards and forwards, when the scheduler ticks, then no slot fires twice and no older slot fires after a newer one', LIMIT, async (t) => {
  const f = floor(t);
  const store = open(t, f);
  store.putTask(taskDef(f), at(0, 6));
  const { runner } = stub(f);
  let now = at(1, 7, 20);
  const s = new Scheduler({ store, hiveRoot: f.hiveRoot, runner, now: () => now });
  const steps = [at(1, 7, 20), at(1, 7, 0), at(0, 8), at(1, 7, 30), at(4, 9), at(3, 8), at(4, 9, 30), at(2, 23)];
  for (const step of steps) { now = step; await s.tick(); }
  assert.deepEqual(runsOf(store).map((r) => r.slot).sort(), ['2026-11-21T07:19', '2026-11-24T07:19']);
  assert.equal(calls(f).length, 2);
});

test('Given a runner that throws, when the run fails, then it is marked failed with the reason, the lease is released, and the next slot runs', LIMIT, async (t) => {
  const f = floor(t);
  const store = open(t, f);
  store.putTask(taskDef(f), at(0, 6));
  const bad = stub(f, { throws: 'the stub runner broke' });
  await new Scheduler({ store, hiveRoot: f.hiveRoot, runner: bad.runner, now: () => at(1, 7, 20) }).tick();
  const [failed] = runsOf(store);
  assert.equal(failed.state, 'failed');
  assert.match(failed.failure, /the stub runner broke/);
  assert.deepEqual(schedulerStatus(store, { now: at(1, 7, 21) }).leases, []);
  assert.equal(ledgerRows(f).length, 1, 'no cost row');
  assert.equal(mail(f).length, 0, 'no mail');
  const good = stub(f);
  await new Scheduler({ store, hiveRoot: f.hiveRoot, runner: good.runner, now: () => at(2, 7, 20) }).tick();
  const runs = runsOf(store);
  assert.equal(runs.length, 2);
  const next = runs.find((r) => r.slot === '2026-11-22T07:19');
  assert.equal(next.state, 'done');
  assert.equal(runs.find((r) => r.id === failed.id).state, 'failed', 'the failed run is left failed, not retried');
});

for (const crashAt of ['afterClaim', 'beforeRunnerStart']) {
  test(`Given a crash between claim and runner start (${crashAt}), when a scheduler recovers, then there is exactly one cost row and one done mail`, LIMIT, async (t) => {
    const f = floor(t);
    const store = open(t, f);
    store.putTask(taskDef(f), at(0, 6));
    const c = child(t, { dbPath: f.dbPath, hiveRoot: f.hiveRoot, calls: f.calls, now: at(1, 7, 20), mode: 'ok', crashAt });
    assert.equal((await c.exited).signal, 'SIGKILL');
    assert.equal(calls(f).length, 0, 'the runner never started');
    const { runner } = stub(f);
    const s = new Scheduler({ store, hiveRoot: f.hiveRoot, runner, now: () => at(1, 7, 25) });
    await s.tick();
    await s.tick();
    assert.equal(calls(f).length, 1);
    exactlyOnce(f, store);
  });
}

for (const crashAt of ['afterRunnerResult', 'afterCostAppend', 'afterMailWrite']) {
  test(`Given a crash between runner end and mark done (${crashAt}), when a scheduler recovers, then there is exactly one cost row and one done mail`, LIMIT, async (t) => {
    const f = floor(t);
    const store = open(t, f);
    store.putTask(taskDef(f), at(0, 6));
    const c = child(t, { dbPath: f.dbPath, hiveRoot: f.hiveRoot, calls: f.calls, now: at(1, 7, 20), mode: 'ok', crashAt });
    assert.equal((await c.exited).signal, 'SIGKILL');
    const { runner } = stub(f);
    const s = new Scheduler({ store, hiveRoot: f.hiveRoot, runner, now: () => at(1, 7, 25) });
    await s.tick();
    await s.tick();
    assert.equal(calls(f).length, 1, 'the runner is not called again');
    exactlyOnce(f, store);
  });
}

test('Given a crash after the done mail was written and the router has since filed it, when a scheduler recovers, then no second mail is written', LIMIT, async (t) => {
  const f = floor(t);
  const store = open(t, f);
  store.putTask(taskDef(f), at(0, 6));
  const c = child(t, { dbPath: f.dbPath, hiveRoot: f.hiveRoot, calls: f.calls, now: at(1, 7, 20), mode: 'ok', crashAt: 'afterMailWrite' });
  assert.equal((await c.exited).signal, 'SIGKILL');
  const sent = path.join(f.outbox, '.sent');
  fs.mkdirSync(sent);
  for (const n of fs.readdirSync(f.outbox).filter((x) => x.endsWith('.json'))) fs.renameSync(path.join(f.outbox, n), path.join(sent, n));
  const { runner } = stub(f);
  await new Scheduler({ store, hiveRoot: f.hiveRoot, runner, now: () => at(1, 7, 25) }).tick();
  exactlyOnce(f, store);
  assert.deepEqual(fs.readdirSync(f.outbox).filter((x) => x.endsWith('.json')), [], 'nothing new in the outbox');
});

test('Given two tasks due in the same tick, when the scheduler ticks, then both run', LIMIT, async (t) => {
  const f = floor(t);
  const store = open(t, f);
  store.putTask(taskDef(f), at(0, 6));
  store.putTask(taskDef(f, { id: 'second-scan', prompt: 'The second task.', schedule: { daily: '07:00' } }), at(0, 6));
  const { runner, jobs } = stub(f);
  await new Scheduler({ store, hiveRoot: f.hiveRoot, runner, now: () => at(1, 7, 20) }).tick();
  assert.deepEqual(jobs.map((j) => j.taskId).sort(), ['daily-scan', 'second-scan']);
  const runs = runsOf(store);
  assert.equal(runs.length, 2);
  assert.ok(runs.every((r) => r.state === 'done'));
  assert.equal(ledgerRows(f).length, 3);
  assert.equal(mail(f).length, 2);
});

/** Every entry under `dir` with its size and modification time. */
function tree(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      const st = fs.lstatSync(p);
      out[path.relative(dir, p)] = st.isDirectory() ? 'dir' : `${st.size}:${st.mtimeMs}`;
      if (st.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out;
}

test('Given a scheduler run in a process whose home is a temporary folder, when it claims and runs a task, then nothing is written outside the temporary hive and state folders', LIMIT, async (t) => {
  const f = floor(t);
  const home = path.join(f.base, 'home');
  fs.mkdirSync(home);
  const repo = path.join(__dirname, '..');
  const gitStatus = () => spawnSync('git', ['status', '--porcelain', '--ignored=no'], { cwd: repo, encoding: 'utf8' }).stdout;
  const defaultDb = S.coreDbPath({ hiveRoots: [f.hiveRoot] });
  const defaultDbBefore = fs.existsSync(defaultDb) ? fs.statSync(defaultDb).mtimeMs : null;
  const repoBefore = gitStatus();
  const before = tree(f.base);
  const proc = spawn(process.execPath, [CHILD, JSON.stringify({ dbPath: f.dbPath, hiveRoot: f.hiveRoot, calls: f.calls, now: at(1, 7, 20), mode: 'ok', put: taskDef(f), putAt: at(0, 6) })], {
    cwd: home, env: { PATH: process.env.PATH, HOME: home, TMPDIR: home }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { try { process.kill(proc.pid, 'SIGKILL'); } catch { /* already gone */ } });
  let err = '';
  proc.stderr.on('data', (d) => { err += d; });
  const code = await new Promise((resolve) => proc.on('exit', resolve));
  assert.equal(code, 0, err);
  const after = tree(f.base);
  const changed = Object.keys(after).filter((k) => after[k] !== before[k]).sort();
  const allowed = (k) => k === 'calls.log' || k.startsWith(`state${path.sep}`) || k === path.join('hive', 'cost-ledger.jsonl')
    || k === path.join('hive', 'agents', AGENT, 'outbox') || k.startsWith(path.join('hive', 'agents', AGENT, 'outbox') + path.sep);
  assert.deepEqual(changed.filter((k) => !allowed(k)), [], 'only core.db, the ledger and the seat\'s outbox change');
  assert.deepEqual(fs.readdirSync(home), [], 'nothing in the process\'s home or temp folder');
  assert.equal(Object.keys(before).filter((k) => !(k in after)).length, 0, 'nothing removed');
  assert.equal(gitStatus(), repoBefore, 'the repository is untouched');
  assert.equal(fs.existsSync(defaultDb) ? fs.statSync(defaultDb).mtimeMs : null, defaultDbBefore, 'the default core.db is untouched');
  exactlyOnce(f, open(t, f));
});

// --- a run whose runner's process outlives its scheduler --------------------------------------------------------------

const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const cliPids = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(Number) : []);

/** `p`, or a failure naming `what` once `ms` have passed: a restart that started the runner again would wait for its
 *  CLI, so this turns that into a failed assertion rather than a test that ends by its time limit. */
function within(p, ms, what) {
  let timer;
  return Promise.race([p, new Promise((_, reject) => { timer = setTimeout(() => reject(new assert.AssertionError({ message: what })), ms); })])
    .finally(() => clearTimeout(timer));
}

async function gone(pid, ms = 10_000) {
  const end = Date.now() + ms;
  while (isAlive(pid)) {
    if (Date.now() > end) throw new Error(`pid ${pid} is still running`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('Given a scheduler killed while the detached CLI it started keeps running, when schedulers restart three times, then the CLI is never started again beside it and each restart reports it; once it has ended, the run goes on', LIMIT, async (t) => {
  const f = floor(t);
  const store = open(t, f);
  store.putTask(taskDef(f), at(0, 6));
  const cliLog = path.join(f.base, 'cli.log');
  t.after(() => { for (const pid of cliPids(cliLog)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } });
  const opts = { dbPath: f.dbPath, hiveRoot: f.hiveRoot, calls: f.calls, cliLog, now: at(1, 7, 20), mode: 'detached', cliMs: 60_000 };
  const first = child(t, opts);
  await waitFor(cliLog);
  const end = Date.now() + 10_000;
  while (!runsOf(store)[0]?.runner) { if (Date.now() > end) throw new Error('the CLI was never recorded'); await new Promise((r) => setTimeout(r, 20)); }
  const [cli] = cliPids(cliLog);
  assert.equal(runsOf(store)[0].runner.pid, cli, 'the run row names the CLI the runner started');
  assert.equal(runsOf(store)[0].runner.pgid, cli);
  process.kill(first.pid, 'SIGKILL');
  await first.exited;
  assert.ok(isAlive(cli), 'the detached CLI outlived its scheduler');
  for (let i = 0; i < 3; i++) {
    const again = await within(child(t, { ...opts, now: at(1, 7, 25 + i) }).exited, 10_000, 'a restart did not return: it started the runner again beside the survivor');
    assert.equal(again.code, 0, again.err);
    const report = JSON.parse(again.out);
    assert.equal(report.ran.length, 0);
    assert.equal(report.skipped.length, 1);
    assert.equal(report.skipped[0].runner.pid, cli);
    assert.match(report.skipped[0].reason, new RegExp(`pid ${cli}.*still running.*not started again`));
  }
  assert.equal(calls(f).length, 1, 'the runner was called once');
  assert.deepEqual(cliPids(cliLog), [cli], 'one CLI was ever started');
  const status = schedulerStatus(store, { now: at(1, 7, 30) });
  assert.equal(status.openRuns[0].runner.pid, cli);
  assert.equal(status.openRuns[0].attempt, 1);

  process.kill(cli, 'SIGKILL');
  await gone(cli);
  const last = await child(t, { ...opts, now: at(1, 7, 40), cliMs: 50 }).exited;
  assert.equal(last.code, 0, last.err);
  assert.equal(calls(f).length, 2, 'started again once its CLI was gone');
  assert.equal(cliPids(cliLog).length, 2);
  const run = exactlyOnce(f, store);
  assert.equal(run.attempt, 2);
});

test('Given a scheduler killed while its runner worked, twice, when a scheduler restarts a third time, then the run is marked failed and its runner is not started again', LIMIT, async (t) => {
  const f = floor(t);
  const store = open(t, f);
  store.putTask(taskDef(f), at(0, 6));
  for (let i = 0; i < 2; i++) {
    const started = path.join(f.base, `started-${i}`);
    const c = child(t, { dbPath: f.dbPath, hiveRoot: f.hiveRoot, calls: f.calls, started, now: at(1, 7, 20 + i), mode: 'hang' });
    await waitFor(started);
    process.kill(c.pid, 'SIGKILL');
    await c.exited;
  }
  assert.equal(calls(f).length, 2);
  const { runner } = stub(f);
  const report = await new Scheduler({ store, hiveRoot: f.hiveRoot, runner, now: () => at(1, 7, 30) }).tick();
  assert.equal(calls(f).length, 2, 'not started a third time');
  const [run] = runsOf(store);
  assert.equal(run.state, 'failed');
  assert.equal(run.attempt, 2);
  assert.match(run.failure, /interrupted after each of its 2 attempts/);
  assert.deepEqual(report.ran.map((r) => r.state), ['failed']);
  assert.equal(ledgerRows(f).length, 1, 'no cost row');
  assert.equal(mail(f).length, 0, 'no mail');
});

test('Given a task whose turn is still going in this scheduler, when its lease looks like another host\'s and has expired, then a second tick does not start it again', LIMIT, async (t) => {
  const f = floor(t);
  const store = open(t, f);
  store.putTask(taskDef(f), at(0, 6));
  let release;
  const gate = new Promise((r) => { release = r; });
  t.after(() => release());
  let n = 0;
  const runner = async () => { n++; await gate; return { run: headlessRun(), done: true, doneReason: null }; };
  const clock = { now: at(1, 7, 20) };
  const s = new Scheduler({ store, hiveRoot: f.hiveRoot, runner, now: () => clock.now, leaseMs: 1000, heartbeatMs: 60_000 });
  const firstTick = s.tick();
  while (n === 0) await new Promise((r) => setImmediate(r));
  // As after a sleep in which the machine took another host name: the lease has missed its heartbeats, and its holder
  // no longer looks like this host's.
  store.db.prepare('UPDATE scheduler_leases SET host = ?').run('renamed.local');
  clock.now = at(1, 7, 30);
  const secondTick = s.tick();
  await new Promise((r) => setTimeout(r, 50));
  release();
  const second = await secondTick;
  assert.equal(n, 1, 'the runner was called once');
  assert.match(second.skipped[0].reason, /already running it/);
  await firstTick;
  exactlyOnce(f, store);
});

test('Given a CLI run that did not succeed, when the run ends, then it is stored failed with the CLI\'s reason, and its cost is still recorded once', LIMIT, async (t) => {
  const f = floor(t);
  const store = open(t, f);
  store.putTask(taskDef(f), at(0, 6));
  const runner = async () => ({ run: headlessRun(0.01, { ok: false, outcome: 'failed', exitCode: 1, error: 'the CLI exited 1: usage limit reached' }), done: false, doneReason: 'the run did not succeed' });
  const report = await new Scheduler({ store, hiveRoot: f.hiveRoot, runner, now: () => at(1, 7, 20) }).tick();
  const [run] = runsOf(store);
  assert.equal(run.state, 'failed');
  assert.match(run.failure, /usage limit reached/);
  assert.deepEqual(report.ran.map((r) => r.state), ['failed']);
  assert.equal(rowsFor(f, run.id).length, 1, 'its cost is recorded');
  assert.equal(mail(f).length, 0, 'no done mail');
  assert.deepEqual(schedulerStatus(store, { now: at(1, 7, 21) }).openRuns, []);
});

test('Given a lease taken over while the runner worked, when the runner returns, then nothing more is written for the run', LIMIT, async (t) => {
  const f = floor(t);
  const store = open(t, f);
  store.putTask(taskDef(f), at(0, 6));
  const runner = async () => {
    store.db.prepare('UPDATE scheduler_leases SET token = ?').run('another-holder');
    return { run: headlessRun(), done: true, doneReason: null };
  };
  const report = await new Scheduler({ store, hiveRoot: f.hiveRoot, runner, now: () => at(1, 7, 20) }).tick();
  const [run] = runsOf(store);
  assert.equal(run.state, 'running', 'the outcome was not stored by a holder that lost the lease');
  assert.equal(run.outcome, null);
  assert.match(report.errors[0].error, /taken over/);
  assert.equal(ledgerRows(f).length, 1, 'no cost row');
  assert.equal(mail(f).length, 0, 'no mail');
});

test('Given a scheduler killed and then its CLI, while a subprocess the CLI started still runs in its group, when a scheduler restarts, then the run is not started again; once the group is empty, it is', LIMIT, async (t) => {
  const f = floor(t);
  const store = open(t, f);
  store.putTask(taskDef(f), at(0, 6));
  const cliLog = path.join(f.base, 'cli.log');
  t.after(() => { for (const pid of cliPids(cliLog)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } });
  const opts = { dbPath: f.dbPath, hiveRoot: f.hiveRoot, calls: f.calls, cliLog, now: at(1, 7, 20), mode: 'detached', cliMs: 60_000, cliChild: true };
  const first = child(t, opts);
  const end = Date.now() + 10_000;
  while (cliPids(cliLog).length < 2 || !runsOf(store)[0]?.runner) { if (Date.now() > end) throw new Error('the CLI and its subprocess never started'); await new Promise((r) => setTimeout(r, 20)); }
  const [cli, sub] = cliPids(cliLog);
  process.kill(first.pid, 'SIGKILL');
  await first.exited;
  process.kill(cli, 'SIGKILL');
  await gone(cli);
  assert.ok(isAlive(sub), 'the subprocess outlived the CLI');
  const again = await within(child(t, { ...opts, now: at(1, 7, 25), cliChild: false }).exited, 10_000, 'a restart did not return: it started the runner again beside the group');
  assert.equal(again.code, 0, again.err);
  const report = JSON.parse(again.out);
  assert.equal(report.ran.length, 0);
  assert.match(report.skipped[0].reason, new RegExp(`group ${cli}.*still running`));
  assert.equal(calls(f).length, 1);

  process.kill(sub, 'SIGKILL');
  await gone(sub);
  const last = await within(child(t, { ...opts, now: at(1, 7, 30), cliMs: 50, cliChild: false }).exited, 10_000, 'the last restart did not finish');
  assert.equal(last.code, 0, last.err);
  assert.equal(calls(f).length, 2, 'started again once the group was empty');
  exactlyOnce(f, store);
});

test('Given a live survivor recorded under a host name the machine no longer has, when a scheduler restarts, then it is still not started again', LIMIT, async (t) => {
  const f = floor(t);
  const store = open(t, f);
  store.putTask(taskDef(f), at(0, 6));
  const cliLog = path.join(f.base, 'cli.log');
  t.after(() => { for (const pid of cliPids(cliLog)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } });
  const opts = { dbPath: f.dbPath, hiveRoot: f.hiveRoot, calls: f.calls, cliLog, now: at(1, 7, 20), mode: 'detached', cliMs: 60_000 };
  const first = child(t, opts);
  const end = Date.now() + 10_000;
  while (!runsOf(store)[0]?.runner) { if (Date.now() > end) throw new Error('the CLI was never recorded'); await new Promise((r) => setTimeout(r, 20)); }
  process.kill(first.pid, 'SIGKILL');
  await first.exited;
  // As after the machine took another name on another network.
  store.db.prepare('UPDATE scheduler_runs SET runner_host = ?').run('renamed.local');
  const again = await within(child(t, { ...opts, now: at(1, 7, 35) }).exited, 10_000, 'a restart did not return: it started the runner again beside the survivor');
  assert.equal(again.code, 0, again.err);
  assert.match(JSON.parse(again.out).skipped[0].reason, /still running/);
  assert.equal(calls(f).length, 1);
  assert.equal(cliPids(cliLog).length, 1);
});

test('Given the runner\'s process cannot be recorded, when the runner reports it, then the tick reports that, naming the pid', LIMIT, async (t) => {
  const f = floor(t);
  const store = open(t, f);
  store.putTask(taskDef(f), at(0, 6));
  const runner = async (job) => {
    // The lease is taken over, so the record write is refused.
    store.db.prepare('UPDATE scheduler_leases SET token = ?').run('another-holder');
    job.onProcess({ pid: 4242, pgid: 4242 });
    return { run: headlessRun(), done: true, doneReason: null };
  };
  const report = await new Scheduler({ store, hiveRoot: f.hiveRoot, runner, now: () => at(1, 7, 20) }).tick();
  assert.ok(report.errors.some((e) => /pid 4242\) could not be recorded/.test(e.error)), JSON.stringify(report.errors));
  assert.equal(runsOf(store)[0].runner, null);
});

test('Given a scheduler killed after starting its CLI but before recording its pid, when a scheduler restarts, then it finds the CLI by its settings argument in the process table and does not start another; once it has ended, the run goes on', LIMIT, async (t) => {
  const f = floor(t);
  const store = open(t, f);
  store.putTask(taskDef(f), at(0, 6));
  const cliLog = path.join(f.base, 'cli.log');
  t.after(() => { for (const pid of cliPids(cliLog)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } });
  const opts = { dbPath: f.dbPath, hiveRoot: f.hiveRoot, calls: f.calls, cliLog, now: at(1, 7, 20), mode: 'detached', cliMs: 60_000, unreported: true };
  const first = child(t, opts);
  await waitFor(cliLog);
  const [cli] = cliPids(cliLog);
  assert.match(runsOf(store)[0].runnerMarker, /^--settings .*\.settings\.json $/, 'what to look for was recorded before the start');
  assert.equal(runsOf(store)[0].runner, null, 'its pid was never recorded');
  process.kill(first.pid, 'SIGKILL');
  await first.exited;
  const again = await within(child(t, { ...opts, now: at(1, 7, 25) }).exited, 10_000, 'a restart did not return: it started the runner again beside the unrecorded CLI');
  assert.equal(again.code, 0, again.err);
  assert.match(JSON.parse(again.out).skipped[0].reason, new RegExp(`pid ${cli}.*still running`));
  assert.equal(runsOf(store)[0].runner.pid, cli, 'the CLI found is recorded as the runner\'s');
  assert.equal(calls(f).length, 1);

  process.kill(cli, 'SIGKILL');
  await gone(cli);
  const last = await within(child(t, { ...opts, now: at(1, 7, 30), cliMs: 50 }).exited, 10_000, 'the last restart did not finish');
  assert.equal(last.code, 0, last.err);
  assert.equal(calls(f).length, 2);
  exactlyOnce(f, store);
});

test('Given an unrecorded runner process and a process table that cannot be read, when a scheduler resumes the run, then it is not started again and the reason says why', LIMIT, async (t) => {
  const f = floor(t);
  const store = open(t, f);
  store.putTask(taskDef(f), at(0, 6));
  const { runner } = stub(f);
  const s = new Scheduler({ store, hiveRoot: f.hiveRoot, runner, now: () => at(1, 7, 20), processTable: async () => { throw new Error('ps is not allowed here'); } });
  // A run left "running" by a scheduler that stopped after recording what to look for, before the pid.
  store.db.prepare(`INSERT INTO scheduler_runs (id, task_id, slot, slot_at, state, snapshot, claimed_at, attempt, runner_marker)
    VALUES ('r-x', 'daily-scan', '2026-11-21T07:19', ?, 'running', ?, ?, 1, '--settings /nowhere.json ')`).run(at(1, 7, 19), JSON.stringify(taskDef(f)), at(1, 7, 19));
  const report = await s.tick();
  assert.equal(calls(f).length, 0);
  assert.match(report.skipped[0].reason, /process table.*could not be read.*ps is not allowed here/);
  assert.equal(store.run('r-x').attempt, 1);
});
