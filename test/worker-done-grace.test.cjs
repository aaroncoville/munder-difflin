'use strict';
// A worker that reported done was released on the next tick, so a follow-up sent
// seconds later reached an archived agent and bounced. It now stays reachable
// for a grace window. The later tests run the real ephemeralWorkerTick body from
// index.ts (which cannot be imported on its own) against a real mailbox and a
// fake clock, because the property that matters is what the
// tick does, not what a helper would return if the tick called it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const loadTs = require('./load-ts.cjs');

const grace = loadTs('src/main/workerDoneGrace.ts');
const { HiveManager } = loadTs('src/main/hive.ts');
const { WORKER_DONE_GRACE_MS: GRACE, workerFollowUpAfter, afterWorkerDone } = grace;

const T0 = Date.parse('2026-03-01T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

function inboxDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-grace-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, '.done'));
  return dir;
}
const put = (dir, name, msg) => fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(msg));

test('the window lasts three minutes: kept inside it, released at its end', (t) => {
  const dir = inboxDir(t);
  assert.equal(GRACE, 3 * 60_000);
  assert.equal(afterWorkerDone(dir, 'god', T0, T0 + 1), 'keep');
  assert.equal(afterWorkerDone(dir, 'god', T0, T0 + GRACE - 1), 'keep');
  assert.equal(afterWorkerDone(dir, 'god', T0, T0 + GRACE), 'release');
});

// created_at is written by the agent. Nothing else ends the window (a kept
// worker skips the idle reaper), so a future stamp must not hold it forever.
test('a done stamped in the future releases rather than holding the worker indefinitely', (t) => {
  assert.equal(afterWorkerDone(inboxDir(t), 'god', T0 + 3_600_000, T0), 'release');
});

test('a request or query from the orchestrator after the done re-engages, wherever it is filed', (t) => {
  for (const act of ['request', 'query']) {
    const dir = inboxDir(t);
    put(dir, 'f', { from: 'god', act, created_at: iso(T0 + 1) });
    assert.equal(workerFollowUpAfter(dir, 'god', T0), true, `${act} in the inbox`);
    assert.equal(afterWorkerDone(dir, 'god', T0, T0 + GRACE + 1), 'reengaged');
    const filed = inboxDir(t);
    put(path.join(filed, '.done'), 'f', { from: 'god', act, created_at: iso(T0 + 1) });
    assert.equal(workerFollowUpAfter(filed, 'god', T0), true, `${act} already filed by the worker`);
  }
});

test('mail that does not count as a follow-up leaves the window to run out', (t) => {
  const dir = inboxDir(t);
  put(dir, 'before', { from: 'god', act: 'request', created_at: iso(T0 - 1) });
  put(dir, 'same-instant', { from: 'god', act: 'request', created_at: iso(T0) });
  put(dir, 'peer', { from: 'worker-other', act: 'request', created_at: iso(T0 + 1) });
  // An inform asks for nothing. Re-engaging on one would pin the worker's slot
  // until the idle reaper, because no further done is coming.
  put(dir, 'inform', { from: 'god', act: 'inform', created_at: iso(T0 + 1) });
  fs.writeFileSync(path.join(dir, 'partial.json'), '{"from":"go');
  fs.writeFileSync(path.join(dir, 'note.txt'), 'not a message');
  assert.equal(workerFollowUpAfter(dir, 'god', T0), false);
  assert.equal(afterWorkerDone(dir, 'god', T0, T0 + GRACE), 'release');
});

test('the orchestrator is matched by the id it was given, and a missing stamp falls back to the file time', (t) => {
  const dir = inboxDir(t);
  put(dir, 'f', { from: 'god-1', act: 'request' });
  const mtime = new Date(T0 + 5_000);
  fs.utimesSync(path.join(dir, 'f.json'), mtime, mtime);
  assert.equal(workerFollowUpAfter(dir, 'god', T0), false);
  assert.equal(workerFollowUpAfter(dir, 'god-1', T0), true);
  assert.equal(workerFollowUpAfter(dir, 'god-1', T0 + 10_000), false);
});

test('a missing inbox is no follow-up', () => {
  assert.equal(workerFollowUpAfter('/nonexistent/inbox', 'god', T0), false);
});

// ---- the live tick ----

function liveTickSource() {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'src/main/index.ts'), 'utf8');
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.ES2022, true);
  const bodies = ['workerDoneAt', 'ephemeralWorkerTick'].map((name) => {
    const node = ast.statements.find((n) => ts.isFunctionDeclaration(n) && n.name?.text === name);
    assert.ok(node, `${name} is a top-level function of index.ts`);
    return node.getText(ast);
  });
  return ts.transpileModule(`${bodies.join('\n')}\n({ ephemeralWorkerTick })`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}

async function setup(t, overrides = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'md-grace-tick-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home, () => true);
  await hive.ensureAgent({ id: 'god-1', name: 'G', provider: 'claude', cwd: home, isGod: true });
  const id = 'worker-w';
  await hive.ensureAgent({ id, name: 'W', provider: 'claude', cwd: home });
  const agentDir = path.join(hive.root(), 'agents', id);
  for (const d of ['inbox/.done', 'outbox/.sent']) fs.mkdirSync(path.join(agentDir, d), { recursive: true });

  let clock = T0;
  const FakeDate = class extends Date { static now() { return clock; } };
  const rec = { workerId: id, reqId: 'w', name: 'W', baseBranch: 'main', spawnedAt: T0 - 600_000, releasing: false };
  const liveWorkers = new Map([[id, rec]]);
  const calls = { kill: [], notices: [], gone: [] };
  const context = {
    Date: FakeDate, Math, Number, JSON, Set, Map, console: { log() {}, warn() {}, error(e) { throw e; } },
    liveWorkers, workerTickRunning: false, preservedWorktrees: new Map(), lastGcSweepAt: T0, GC_SWEEP_MS: 60_000,
    readConfig: () => ({ orchestratorMaySpawn: false }),
    hive, ptyManager: { idleFor: () => 0, list: () => [], kill: (pid) => { calls.kill.push(pid); } },
    teardownPty: (pid) => { calls.gone.push(pid); },
    informGod: (subject, body) => calls.notices.push({ subject, body }),
    workerTokensUsed: () => 0, shouldReapIdle: () => false, workerHasLiveJob: () => false,
    existsSync: fs.existsSync, readdirSync: fs.readdirSync, readFileSync: fs.readFileSync, statSync: fs.statSync, join: path.join,
    afterWorkerDone: grace.afterWorkerDone,
    ...overrides
  };
  const { ephemeralWorkerTick } = vm.runInNewContext(liveTickSource(), context);
  const write = (dir, name, msg) => fs.writeFileSync(path.join(agentDir, dir, `${name}.json`), JSON.stringify(msg));
  return {
    hive, id, rec, calls, context, tick: ephemeralWorkerTick,
    advance: (ms) => { clock += ms; },
    done: (name) => write('outbox/.sent', name, { from: id, to: 'god-1', act: 'done', created_at: iso(clock) }),
    fromGod: (name, act = 'request', conversation = 'c') => write('inbox', name,
      { id: name, from: 'god-1', to: id, act, subject: name, conversation, created_at: iso(clock) })
  };
}

test('tick: a done worker stays alive through the window, then is released', async (t) => {
  const f = await setup(t);
  f.done('d1');
  f.advance(12_000);
  await f.tick();
  assert.deepEqual(f.calls.kill, [], 'killed 12 s after its done, so a follow-up would bounce');
  assert.equal(f.rec.releasing, false, 'not marked releasing, or later ticks would skip it for good');
  f.advance(GRACE);
  await f.tick();
  assert.deepEqual(f.calls.kill, [f.id]);
  assert.deepEqual(f.calls.gone, [f.id]);
  assert.equal(f.rec.releasing, true);
});

test('tick: a follow-up keeps the worker past the window, and its next done starts a new one', async (t) => {
  const f = await setup(t);
  f.done('d1');
  f.advance(21_000);
  f.fromGod('followup');
  await f.tick();
  f.advance(GRACE + 60_000);
  await f.tick();
  assert.deepEqual(f.calls.kill, [], 'the old done is spent');
  assert.equal(f.hive.inbox(f.id).length, 1, 'and the follow-up is still there for the worker to read');
  f.done('d2');
  f.advance(GRACE - 1);
  await f.tick();
  assert.deepEqual(f.calls.kill, [], 'the second done gets a full window of its own');
  f.advance(1);
  await f.tick();
  assert.deepEqual(f.calls.kill, [f.id]);
});

// The inbox-wake watchdog nudges any idle worker with pending mail, and workers
// seldom file their own work order. Left unsettled during the window, the
// finished order would draw a "read your inbox, act on them now" nudge, the
// worker would act and report done again, and each new done restarts the window.
test('tick: mail from before the done is settled when the window opens, so nothing can wake the worker to redo it', async (t) => {
  const f = await setup(t);
  f.fromGod('work-order', 'request', 'worker-w');
  f.fromGod('other-order');
  f.advance(1_000);
  f.done('d1');
  f.advance(1_000);
  await f.tick();
  assert.deepEqual(f.calls.kill, [], 'still in its window');
  assert.deepEqual(f.hive.inbox(f.id), [], 'nothing pending for the watchdog to nudge about');
  assert.equal(f.calls.notices.length, 1, 'the order it did not complete is reported, its own is not');
  assert.match(f.calls.notices[0].body, /other-order/);
  assert.doesNotMatch(f.calls.notices[0].body, /work-order/);
  assert.match(f.calls.notices[0].body, /is being released/, 'the worker is not gone yet, so the notice must not say it is');

  f.advance(1_500);
  await f.tick();
  assert.equal(f.calls.notices.length, 1, 'later ticks of the window do not repeat the report');
});

test('tick: mail from after the done stays pending during the window', async (t) => {
  const f = await setup(t);
  f.done('d1');
  f.advance(1_000);
  f.fromGod('fyi', 'inform');
  await f.tick();
  assert.deepEqual(f.hive.inbox(f.id).map((m) => m.id), ['fyi'], 'reachable: it can still read this');
  f.advance(GRACE);
  await f.tick();
  assert.deepEqual(f.calls.kill, [f.id], 'an inform does not hold the slot past the window');
});
