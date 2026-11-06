'use strict';
// A worker that reported done was released on the next tick, so a follow-up sent
// seconds later reached an archived agent and bounced. It now stays reachable
// for a grace window. The later tests run the real ephemeralWorkerTick body from
// index.ts (which cannot be imported on its own) against a real mailbox, a real
// git worktree and a fake clock, because the property that matters is what the
// tick does, not what a helper would return if the tick called it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');
const loadTs = require('./load-ts.cjs');

const grace = loadTs('src/main/workerDoneGrace.ts');
const unpushed = loadTs('src/main/workerUnpushed.ts');
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
// What counts is when the file arrived, so each message is dated by its mtime.
function put(dir, name, msg, at) {
  const file = path.join(dir, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(msg));
  fs.utimesSync(file, new Date(at), new Date(at));
}

test('the window lasts three minutes: kept inside it, released at its end', (t) => {
  const dir = inboxDir(t);
  assert.equal(GRACE, 3 * 60_000);
  assert.equal(afterWorkerDone(dir, 'god', T0, T0 + 1), 'keep');
  assert.equal(afterWorkerDone(dir, 'god', T0, T0 + GRACE - 1), 'keep');
  assert.equal(afterWorkerDone(dir, 'god', T0, T0 + GRACE), 'release');
});

// A kept worker skips the idle reaper, so a clock change that dates the done
// ahead of now must not hold the worker until the clock catches up.
test('a done dated in the future releases rather than holding the worker indefinitely', (t) => {
  assert.equal(afterWorkerDone(inboxDir(t), 'god', T0 + 3_600_000, T0), 'release');
});

test('a request or query from the orchestrator after the done re-engages, wherever it is filed', (t) => {
  for (const act of ['request', 'query']) {
    const dir = inboxDir(t);
    put(dir, 'f', { from: 'god', act }, T0 + 1);
    assert.equal(workerFollowUpAfter(dir, 'god', T0), true, `${act} in the inbox`);
    assert.equal(afterWorkerDone(dir, 'god', T0, T0 + GRACE + 1), 'reengaged');
    const filed = inboxDir(t);
    put(path.join(filed, '.done'), 'f', { from: 'god', act }, T0 + 1);
    assert.equal(workerFollowUpAfter(filed, 'god', T0), true, `${act} already filed by the worker`);
  }
});

test('mail that does not count as a follow-up leaves the window to run out', (t) => {
  const dir = inboxDir(t);
  put(dir, 'before', { from: 'god', act: 'request' }, T0 - 1);
  put(dir, 'same-instant', { from: 'god', act: 'request' }, T0);
  put(dir, 'peer', { from: 'worker-other', act: 'request' }, T0 + 1);
  // An inform asks for nothing. Re-engaging on one would pin the worker's slot
  // until the idle reaper, because no further done is coming.
  put(dir, 'inform', { from: 'god', act: 'inform' }, T0 + 1);
  fs.writeFileSync(path.join(dir, 'partial.json'), '{"from":"go');
  fs.writeFileSync(path.join(dir, 'note.txt'), 'not a message');
  assert.equal(workerFollowUpAfter(dir, 'god', T0), false);
  assert.equal(afterWorkerDone(dir, 'god', T0, T0 + GRACE), 'release');
});

test('the orchestrator is matched by the id it was given', (t) => {
  const dir = inboxDir(t);
  put(dir, 'f', { from: 'god-1', act: 'request' }, T0 + 5_000);
  assert.equal(workerFollowUpAfter(dir, 'god', T0), false);
  assert.equal(workerFollowUpAfter(dir, 'god-1', T0), true);
});

// created_at is whatever the sender wrote, and agents write round numbers that
// can be minutes off. The file's arrival is the app's own observation.
test('a follow-up is dated by its arrival, not by the stamp its sender wrote', (t) => {
  const behind = inboxDir(t);
  put(behind, 'f', { from: 'god', act: 'request', created_at: iso(T0 - 3_600_000) }, T0 + 1);
  assert.equal(workerFollowUpAfter(behind, 'god', T0), true, 'stamped an hour behind, arrived after the done');
  const ahead = inboxDir(t);
  put(ahead, 'f', { from: 'god', act: 'request', created_at: iso(T0 + 3_600_000) }, T0 - 1);
  assert.equal(workerFollowUpAfter(ahead, 'god', T0), false, 'stamped an hour ahead, arrived before the done');
});

// Each window tick reads this folder, and inbox/.done grows across re-hires.
test('a file older than the done is not read at all', (t) => {
  const dir = inboxDir(t);
  put(dir, 'old', { from: 'god', act: 'request' }, T0 - 1);
  const read = fs.readFileSync;
  const seen = [];
  fs.readFileSync = (file, ...rest) => { seen.push(file); return read(file, ...rest); };
  t.after(() => { fs.readFileSync = read; });
  workerFollowUpAfter(dir, 'god', T0);
  fs.readFileSync = read;
  assert.deepEqual(seen, []);
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
  const listHandler = ast.statements.find((n) => ts.isExpressionStatement(n) && n.getText(ast).startsWith("ipcMain.handle('workers:list'"));
  assert.ok(listHandler, 'the workers:list handler is a top-level statement of index.ts');
  bodies.push(listHandler.getText(ast));
  return ts.transpileModule(`${bodies.join('\n')}\n({ ephemeralWorkerTick })`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: GIT_ENV }).trim();

async function setup(t, overrides = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'md-grace-tick-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home, () => true);
  await hive.ensureAgent({ id: 'god-1', name: 'G', provider: 'claude', cwd: home, isGod: true });
  const id = 'worker-w';
  await hive.ensureAgent({ id, name: 'W', provider: 'claude', cwd: home });
  const agentDir = path.join(hive.root(), 'agents', id);
  for (const d of ['inbox/.done', 'outbox/.sent']) fs.mkdirSync(path.join(agentDir, d), { recursive: true });

  // A real repository whose worker branch has one unpushed commit.
  const remote = path.join(home, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote], { env: GIT_ENV });
  const repo = path.join(home, 'repo');
  execFileSync('git', ['clone', '-q', remote, repo], { env: GIT_ENV });
  const commit = (dir, m) => git(dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', m);
  commit(repo, 'base');
  git(repo, 'push', '-q', 'origin', 'HEAD:main');
  const wt = path.join(home, 'wt');
  git(repo, 'worktree', 'add', '-q', '-b', 'agent/w', wt, 'HEAD');

  let clock = T0;
  const FakeDate = class extends Date { static now() { return clock; } };
  const rec = { workerId: id, reqId: 'w', name: 'W', baseBranch: 'main', spawnedAt: T0 - 600_000, releasing: false };
  const liveWorkers = new Map([[id, rec]]);
  const calls = { kill: [], notices: [], gone: [] };
  const handlers = {};
  const context = {
    Date: FakeDate, Math, Number, JSON, Set, Map, console: { log() {}, warn() {}, error(e) { throw e; } },
    ipcMain: { handle: (channel, fn) => { handlers[channel] = fn; } },
    liveWorkers, workerTickRunning: false, preservedWorktrees: new Map(), lastGcSweepAt: T0, GC_SWEEP_MS: 60_000,
    worktreePaths: new Map([[id, wt]]),
    readConfig: () => ({ orchestratorMaySpawn: false }),
    hive, ptyManager: { idleFor: () => 0, list: () => [], kill: (pid) => { calls.kill.push(pid); } },
    teardownPty: (pid) => {
      // Teardown is what removes a worktree: a scan after it would find nothing.
      calls.gone.push(pid);
      fs.rmSync(wt, { recursive: true, force: true });
    },
    informGod: (subject, body) => calls.notices.push({ subject, body }),
    workerTokensUsed: () => 0, shouldReapIdle: () => false, workerHasLiveJob: () => false,
    existsSync: fs.existsSync, readdirSync: fs.readdirSync, readFileSync: fs.readFileSync, statSync: fs.statSync, join: path.join,
    afterWorkerDone: grace.afterWorkerDone,
    unpushedWorkerBranches: unpushed.unpushedWorkerBranches, describeUnpushed: unpushed.describeUnpushed,
    ...overrides
  };
  const { ephemeralWorkerTick } = vm.runInNewContext(liveTickSource(), context);
  const write = (dir, name, msg, at = clock) => put(path.join(agentDir, dir), name, msg, at);
  return {
    hive, id, rec, calls, wt, commit, context, tick: ephemeralWorkerTick,
    status: () => handlers['workers:list']().live.find((w) => w.workerId === id)?.status,
    advance: (ms) => { clock += ms; },
    done: (name, created_at = iso(clock)) => write('outbox/.sent', name, { from: id, to: 'god-1', act: 'done', created_at }),
    staleDone: (name, created_at) => write('outbox/.sent', name, { from: id, to: 'god-1', act: 'done', created_at }, T0 - 700_000),
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

for (const [name, offset] of [['ahead', 3_600_000], ['behind', -3_600_000]]) {
  test(`tick: a done stamped an hour ${name} still gets the full window from when it arrived`, async (t) => {
    const f = await setup(t);
    f.done('d1', iso(T0 + offset));
    f.advance(GRACE - 1);
    await f.tick();
    assert.deepEqual(f.calls.kill, [], 'the stamp must not shorten or spend the window');
    f.advance(1);
    await f.tick();
    assert.deepEqual(f.calls.kill, [f.id], 'and must not lengthen it either');
  });
}

test('tick: a done left by an earlier worker with this id does not count, whatever its stamp says', async (t) => {
  const f = await setup(t);
  f.staleDone('old', iso(T0 + 3_600_000));
  f.advance(GRACE + 1);
  await f.tick();
  assert.deepEqual(f.calls.kill, []);
  assert.deepEqual(f.calls.notices, []);
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

test('tick: an unpushed branch is named once when a done worker is released, before its worktree is torn down', async (t) => {
  const f = await setup(t);
  f.commit(f.wt, 'never pushed');
  f.done('d1');
  f.advance(1_000);
  await f.tick();
  assert.deepEqual(f.calls.notices, [], 'not during the window: the worker can still push');
  f.advance(GRACE);
  await f.tick();
  assert.equal(f.calls.notices.length, 1);
  assert.match(f.calls.notices[0].subject, /unpushed/);
  assert.match(f.calls.notices[0].body, /agent\/w at [0-9a-f]+ .*\(on no remote\)/);
  assert.match(f.calls.notices[0].body, /app-created worktree/);
  assert.deepEqual(f.calls.kill, [f.id]);
});

test('tick: a done worker with nothing unpushed costs the orchestrator no notice', async (t) => {
  const f = await setup(t);
  f.commit(f.wt, 'pushed');
  git(f.wt, 'push', '-q', '-u', 'origin', 'agent/w');
  f.done('d1');
  f.advance(GRACE + 1);
  await f.tick();
  assert.deepEqual(f.calls.kill, [f.id]);
  assert.deepEqual(f.calls.notices, []);
});

test('tick: a worker over its token cap is reaped inside the window, and one under it is not', async (t) => {
  let used = 500;
  const f = await setup(t, {
    workerTokensUsed: () => used,
    readConfig: () => ({ orchestratorMaySpawn: false, defaultWorkerTokenCap: 1_000 })
  });
  f.done('d1');
  f.advance(1_000);
  await f.tick();
  assert.deepEqual(f.calls.kill, [], 'under the cap: still inside its window');
  used = 2_000;
  f.advance(1_000);
  await f.tick();
  assert.deepEqual(f.calls.kill, [f.id], 'reporting done must not exempt a worker that keeps spending');
  assert.match(f.calls.notices.at(-1).subject, /token cap/);
});

// A kept worker still holds a concurrency slot, and showing it as working would
// leave a full tab with nothing to explain why new requests are queueing.
test('the workers list shows a kept worker as done, and as working again once re-engaged', async (t) => {
  const f = await setup(t);
  assert.equal(f.status(), 'working');
  f.done('d1');
  f.advance(1_000);
  await f.tick();
  assert.equal(f.status(), 'done');
  f.advance(1_000);
  f.fromGod('followup');
  await f.tick();
  assert.equal(f.status(), 'working', 'it has work again');
  f.done('d2');
  f.advance(GRACE);
  f.rec.releasing = true;
  assert.equal(f.status(), 'releasing');
});

test('tick: the idle reaper leaves a worker alone inside its window', async (t) => {
  const f = await setup(t, { shouldReapIdle: () => true });
  f.done('d1');
  f.advance(1_000);
  await f.tick();
  assert.deepEqual(f.calls.kill, []);
  assert.deepEqual(f.calls.notices, []);
});

for (const [name, overrides, subject] of [
  ['idle', { shouldReapIdle: () => true }, /idle/],
  ['token cap', { workerTokensUsed: () => 2_000, readConfig: () => ({ orchestratorMaySpawn: false, defaultWorkerTokenCap: 1_000 }) }, /token cap/]
]) {
  test(`tick: a ${name} reap names the unpushed branch and says what was scanned`, async (t) => {
    const f = await setup(t, overrides);
    f.commit(f.wt, 'never pushed');
    await f.tick();
    assert.equal(f.calls.notices.length, 1);
    assert.match(f.calls.notices[0].subject, subject);
    assert.match(f.calls.notices[0].body, /preserved for you/);
    assert.match(f.calls.notices[0].body, /agent\/w at [0-9a-f]+ .*\(on no remote\)/);
    assert.match(f.calls.notices[0].body, /app-created worktree/);
    assert.deepEqual(f.calls.kill, [f.id]);
  });

  test(`tick: a ${name} reap with nothing unpushed still says only app-created worktrees were checked`, async (t) => {
    const f = await setup(t, overrides);
    await f.tick();
    assert.equal(f.calls.notices.length, 1);
    assert.doesNotMatch(f.calls.notices[0].body, /NOT pushed/);
    assert.match(f.calls.notices[0].body, /made elsewhere/);
  });
}
