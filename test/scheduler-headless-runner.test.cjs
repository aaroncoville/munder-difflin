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
