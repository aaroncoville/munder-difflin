'use strict';
// The real runner for a scheduled task: a thin adapter that runs the frozen definition as one headless stream
// (runHeadlessStream). It passes the task's prompt, model, working folder, output file and timeout, and the task cap
// as maxBudgetUsd (the CLI's --max-budget-usd). The stream's own cost row and done mail are switched off, because the
// scheduler writes both, keyed by the run id; so the adapter writes nothing in the hive itself. A definition whose
// roots the seat could not write is refused before anything runs. These tests inject runHeadlessStream: no CLI runs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { AGENT, at, floor, taskDef, headlessRun, ledgerRows, mail } = require('./scheduler-fixtures.cjs');

const R = loadTs('src/core/scheduler/headlessRunner.ts');
const S = loadTs('src/core/scheduler/store.ts');
const { Scheduler } = loadTs('src/core/scheduler/scheduler.ts');

/** What a seat needs besides the task: the parts of HeadlessSeatOptions the definition does not carry. */
function seat(f) {
  return { hiveRoot: f.hiveRoot, settingsDir: path.join(f.base, 'app', 'settings'), hookRuntime: { dir: '/staged' }, enabledPlugins: {}, noPlugins: true };
}

/** A runHeadlessStream stand-in that records its options, calls the writers it was given as the real one would,
 *  and resolves as the real one does. */
function fakeStream(result = {}) {
  const seen = [];
  const fn = async (o) => {
    seen.push(o);
    const run = headlessRun();
    const cost = o.effects.recordCost(run);
    const messageId = o.effects.publish({ id: 'x', to: 'god', act: 'done', subject: 's', body: 'b', created_at: new Date(0).toISOString() });
    return { run, cost, done: true, doneReason: null, messageId, messageError: null, ...result };
  };
  return { fn, seen };
}

const job = (f, more = {}) => ({ runId: 'r-abc', taskId: 'daily-scan', slot: '2026-11-21T07:19', snapshot: taskDef(f, { timeoutMs: 60_000, ...more }), maxBudgetUsd: more.maxBudgetUsd ?? 3 });

test('Given a frozen definition, when the adapter runs it, then runHeadlessStream gets its prompt, model, folder, output file, timeout and the task cap as maxBudgetUsd', async (t) => {
  const f = floor(t);
  const s = fakeStream();
  const runner = R.headlessStreamRunner(seat(f), { runHeadlessStream: s.fn });
  const j = job(f, { maxBudgetUsd: 2.5 });
  const out = await runner(j);
  assert.equal(s.seen.length, 1);
  const o = s.seen[0];
  assert.equal(o.prompt, j.snapshot.prompt);
  assert.equal(o.model, 'sonnet');
  assert.equal(o.maxBudgetUsd, 2.5);
  assert.equal(o.agentId, AGENT);
  assert.equal(o.cwd, f.work);
  assert.equal(o.outputFile, j.snapshot.outputFile);
  assert.equal(o.timeoutMs, 60_000);
  assert.equal(o.hiveRoot, f.hiveRoot);
  assert.equal(out.done, true);
  assert.equal(out.run.totalCostUsd, headlessRun().totalCostUsd);
});

test('Given the adapter, when the stream would record its cost and mail god, then nothing is written in the hive', async (t) => {
  const f = floor(t);
  const before = fs.readFileSync(f.ledger, 'utf8');
  const s = fakeStream();
  await R.headlessStreamRunner(seat(f), { runHeadlessStream: s.fn })(job(f));
  assert.equal(fs.readFileSync(f.ledger, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(f.outbox), []);
});

test('Given a definition naming a root outside the seat\'s write roots, when the adapter runs it, then it is refused before the stream runs', async (t) => {
  const f = floor(t);
  const s = fakeStream();
  const runner = R.headlessStreamRunner(seat(f), { runHeadlessStream: s.fn });
  await assert.rejects(runner(job(f, { roots: [path.join(f.base, 'elsewhere')] })), /elsewhere.*write roots/);
  assert.equal(s.seen.length, 0);
});

test('Given the scheduler with the adapter, when a task runs, then exactly one cost row and one done mail land, written by the scheduler', async (t) => {
  const f = floor(t);
  const store = S.openSchedulerStore({ path: f.dbPath, hiveRoots: [f.hiveRoot] });
  t.after(() => store.close());
  store.putTask(taskDef(f), at(0, 6));
  const s = fakeStream();
  await new Scheduler({ store, hiveRoot: f.hiveRoot, runner: R.headlessStreamRunner(seat(f), { runHeadlessStream: s.fn }), now: () => at(1, 7, 20) }).tick();
  const [run] = store.runs();
  assert.equal(run.state, 'done');
  assert.deepEqual(ledgerRows(f).filter((r) => r.run_id === run.id).length, 1);
  assert.equal(ledgerRows(f).length, 2);
  assert.equal(mail(f).length, 1);
});

test('Given a definition with no timeout, when the adapter runs it, then the stream gets the default limit, so no run holds its task for good', async (t) => {
  const f = floor(t);
  const s = fakeStream();
  await R.headlessStreamRunner(seat(f), { runHeadlessStream: s.fn })(job(f, { timeoutMs: undefined }));
  assert.equal(s.seen[0].timeoutMs, R.DEFAULT_SCHEDULED_TIMEOUT_MS);
  assert.equal(R.DEFAULT_SCHEDULED_TIMEOUT_MS, 30 * 60_000);
});

test('Given a job, when the adapter runs it, then the seat reports the CLI it starts to the job\'s onProcess', async (t) => {
  const f = floor(t);
  const s = fakeStream();
  const seen = [];
  await R.headlessStreamRunner(seat(f), { runHeadlessStream: async (o) => { o.onSpawn({ pid: 4242, pgid: 4242 }); return s.fn(o); } })({ ...job(f), onProcess: (p) => seen.push(p) });
  assert.deepEqual(seen, [{ pid: 4242, pgid: 4242 }]);
});

test('Given a job, when the seat is about to start the CLI, then the job is told the settings argument to find it by', async (t) => {
  const f = floor(t);
  const s = fakeStream();
  const seen = [];
  await R.headlessStreamRunner(seat(f), { runHeadlessStream: async (o) => { o.onLaunch({ settingsFile: '/s/headless.json', argv: [] }); return s.fn(o); } })({ ...job(f), onLaunch: (m) => seen.push(m), onProcess: () => {} });
  assert.deepEqual(seen, ['--settings /s/headless.json ']);
});

test('Given a job, when the adapter runs it, then the seat is given a launch key naming the run and the attempt, so the launch has a settings file of its own', async (t) => {
  const f = floor(t);
  const s = fakeStream();
  await R.headlessStreamRunner(seat(f), { runHeadlessStream: s.fn })({ ...job(f), attempt: 2, onLaunch: () => {}, onProcess: () => {} });
  assert.equal(s.seen[0].launchKey, 'r-abc.a2');
});

const { headlessLaunchSettingsFile } = loadTs('src/core/headlessSeat.ts');
const { seatSettingsFile } = loadTs('src/core/seatSettings.ts');

/** A clock 20 minutes on, so that files written by the test are old enough to be swept. */
const later = () => Date.now() + 20 * 60_000;

/** A store holding runs in the given states, each with the attempts given. */
function storeWith(t, f, runs) {
  const store = S.openSchedulerStore({ path: f.dbPath, hiveRoots: [f.hiveRoot] });
  t.after(() => store.close());
  for (const [id, state, attempt] of runs) {
    store.db.prepare(`INSERT INTO scheduler_runs (id, task_id, slot, slot_at, state, snapshot, claimed_at, attempt) VALUES (?, 'daily-scan', ?, 1, ?, ?, 1, ?)`)
      .run(id, `slot-${id}`, state, JSON.stringify(taskDef(f)), attempt);
  }
  return store;
}

test('Given launch settings files a dead scheduler left, when the sweep runs, then only those of runs that are over or unknown, named by no running process, are removed; seat files and files a run may still need are kept', async (t) => {
  const f = floor(t);
  const dir = path.join(f.base, 'app', 'seat-settings');
  fs.mkdirSync(dir, { recursive: true });
  const store = storeWith(t, f, [['r-done', 'done', 2], ['r-failed', 'failed', 1], ['r-running', 'running', 1], ['r-ran', 'ran', 1], ['r-held', 'done', 1], ['r-again', 'running', 2]]);
  const file = (run, n) => headlessLaunchSettingsFile(dir, f.hiveRoot, AGENT, `${run}.a${n}`);
  const all = {
    done1: file('r-done', 1), done2: file('r-done', 2), failed: file('r-failed', 1), unknown: file('r-gone', 1),
    running: file('r-running', 1), ran: file('r-ran', 1), held: file('r-held', 1), again: file('r-again', 2),
    seat: seatSettingsFile(dir, f.hiveRoot, `headless:${AGENT}`), interactive: seatSettingsFile(dir, f.hiveRoot, AGENT),
  };
  for (const p of Object.values(all)) fs.writeFileSync(p, '{}');
  const table = async () => [{ pid: 99999, parentPid: 1, pgid: 99999, commandLine: `claude -p --settings ${all.held} --setting-sources ` }];
  const r = await R.sweepLaunchSettings({ store, settingsDir: dir, hiveRoot: f.hiveRoot, processTable: table, now: later });
  assert.equal(r.error, null);
  assert.deepEqual(r.removed.sort(), [all.done1, all.done2, all.failed, all.unknown].sort());
  for (const k of ['running', 'ran', 'held', 'again', 'seat', 'interactive']) assert.ok(fs.existsSync(all[k]), `${k} is kept`);
  for (const k of ['done1', 'done2', 'failed', 'unknown']) assert.ok(!fs.existsSync(all[k]), `${k} is removed`);
});

test('Given a process table that cannot be read, when the sweep runs, then nothing is removed and it says why', async (t) => {
  const f = floor(t);
  const dir = path.join(f.base, 'app', 'seat-settings');
  fs.mkdirSync(dir, { recursive: true });
  const store = storeWith(t, f, [['r-done', 'done', 1]]);
  const p = headlessLaunchSettingsFile(dir, f.hiveRoot, AGENT, 'r-done.a1');
  fs.writeFileSync(p, '{}');
  const r = await R.sweepLaunchSettings({ store, settingsDir: dir, hiveRoot: f.hiveRoot, processTable: async () => { throw new Error('ps refused'); }, now: later });
  assert.deepEqual(r.removed, []);
  assert.match(r.error, /process table could not be read.*ps refused/);
  assert.ok(fs.existsSync(p));
});

/** A settings folder with a store holding the given runs, and a writer for launch files of `AGENT`. */
function sweepFloor(t, runs) {
  const f = floor(t);
  const dir = path.join(f.base, 'app', 'seat-settings');
  fs.mkdirSync(dir, { recursive: true });
  const store = storeWith(t, f, runs);
  const file = (run, n) => headlessLaunchSettingsFile(dir, f.hiveRoot, AGENT, `${run}.a${n}`);
  return { f, dir, store, file };
}
const sweep = (s, more = {}) => R.sweepLaunchSettings({ store: s.store, settingsDir: s.dir, hiveRoot: s.f.hiveRoot, processTable: async () => [], now: later, ...more });

test('Given a launch file written less than ten minutes ago, when the sweep runs, then it is kept, though its run is unknown (another hive\'s fresh launch); an old one is removed', async (t) => {
  const s = sweepFloor(t, []);
  const fresh = s.file('r-other-hive', 1);
  fs.writeFileSync(fresh, '{}');
  assert.deepEqual((await sweep(s, { now: () => Date.now() + 5 * 60_000 })).removed, []);
  assert.ok(fs.existsSync(fresh));
  assert.deepEqual((await sweep(s)).removed, [fresh]);
});

test('Given a live process that names a finished run\'s launch file through another spelling of the folder, when the sweep runs, then the file is kept', async (t) => {
  const s = sweepFloor(t, [['r-done', 'done', 1]]);
  const p = s.file('r-done', 1);
  fs.writeFileSync(p, '{}');
  const link = path.join(s.f.base, 'linked-settings');
  fs.symlinkSync(s.dir, link);
  const table = async () => [{ pid: 4242, parentPid: 1, pgid: 4242, commandLine: `claude -p --settings ${path.join(link, path.basename(p))} --setting-sources ` }];
  const r = await sweep(s, { processTable: table });
  assert.deepEqual(r.removed, []);
  assert.ok(fs.existsSync(p));
  const elsewhere = async () => [{ pid: 4242, parentPid: 1, pgid: 4242, commandLine: `claude -p --settings /x/other.json --note /tmp/${path.basename(p)} ` }];
  assert.deepEqual((await sweep(s, { processTable: elsewhere })).removed, [p], 'a name outside the --settings argument does not count');
});

test('Given a link and a folder named as launch files, when the sweep runs, then neither is removed', async (t) => {
  const s = sweepFloor(t, []);
  const target = path.join(s.f.base, 'outside.json');
  fs.writeFileSync(target, '{}');
  const link = s.file('r-link', 1);
  fs.symlinkSync(target, link);
  const folder = s.file('r-folder', 1);
  fs.mkdirSync(folder);
  const r = await sweep(s);
  assert.deepEqual(r.removed, []);
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.ok(fs.statSync(folder).isDirectory());
  assert.ok(fs.existsSync(target));
});

test('Given a run still going at its second attempt, when the sweep runs, then its first attempt\'s file is kept with the second\'s', async (t) => {
  const s = sweepFloor(t, [['r-again', 'running', 2]]);
  for (const n of [1, 2]) fs.writeFileSync(s.file('r-again', n), '{}');
  assert.deepEqual((await sweep(s)).removed, []);
});

test('Given a hive folder that cannot be resolved, when the sweep runs, then it removes nothing and returns the reason rather than throwing', async (t) => {
  const s = sweepFloor(t, [['r-done', 'done', 1]]);
  const p = s.file('r-done', 1);
  fs.writeFileSync(p, '{}');
  const r = await sweep(s, { hiveRoot: path.join(s.f.base, 'no-such-hive') });
  assert.deepEqual(r.removed, []);
  assert.match(r.error, /could not be named.*no-such-hive/);
  assert.ok(fs.existsSync(p));
});
