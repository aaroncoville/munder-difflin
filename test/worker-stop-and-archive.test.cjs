'use strict';

/**
 * Stopping a worker whose objective could not be sent has two ways to go wrong. A kill that reports failure must not lose
 * the worker's bookkeeping, or nothing can ever stop it. And with the registry unreadable, recording the worker as archived
 * cannot land, so it must be remembered: a roster entry still reading as live would go on taking work into a dead inbox.
 * These run the real processSpawnRequest, teardownPty and worker tick from index.ts on a real hive, with a fake PTY manager.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const loadTs = require('./load-ts.cjs');
const { allCommitsIdle } = loadTs('src/main/hiveCommit.ts');

const { HiveManager } = loadTs('src/main/hive.ts');
const { RegistryUnreadable } = loadTs('src/main/messageTarget.ts');
const { workerExitEvent } = loadTs('src/main/workerExitLog.ts');
const stopRetry = loadTs('src/main/workerStopRetry.ts');
const { PtyManager } = loadTs('src/main/pty.ts');

const FUNCTIONS = ['informGod', 'processSpawnRequest', 'spawnAgent', 'archiveRequest', 'spawnRequestsDir', 'teardownPty', 'stopWorker', 'workerDoneAt', 'ephemeralWorkerTick'];

function live() {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'src/main/index.ts'), 'utf8');
  const tree = ts.createSourceFile('index.ts', source, ts.ScriptTarget.ES2022, true);
  const bodies = FUNCTIONS.map((name) => {
    const node = tree.statements.find((n) => ts.isFunctionDeclaration(n) && n.name?.text === name);
    assert.ok(node, `${name} is a top-level function of index.ts`);
    return node.getText(tree);
  });
  return ts.transpileModule(`${bodies.join('\n')}\n({ processSpawnRequest, teardownPty, ephemeralWorkerTick })`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}

const noop = new Proxy({}, { get: () => () => undefined });
const ID = 'worker-w1';

async function setup(t, { kill } = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'md-worker-stop-')));
  t.after(async () => { await allCommitsIdle(); fs.rmSync(home, { recursive: true, force: true }); });
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god-1', name: 'Boss', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'worker-1', name: 'One', provider: 'claude', cwd: home });
  const registry = path.join(hive.root(), 'registry.json');
  const queue = path.join(hive.root(), 'spawn-requests');
  fs.mkdirSync(queue, { recursive: true });
  const file = path.join(queue, 'w1.json');
  fs.writeFileSync(file, JSON.stringify({ id: 'w1', objective: 'do the thing', cwd: home }));

  const sessions = new Map();
  const calls = { revoked: [], finalized: [], archivedCards: [], informed: [], killAttempts: 0 };
  const liveWorkers = new Map();
  const worktreePaths = new Map();
  const ptyToAgent = new Map();
  let killResult = kill ?? (() => ({ ok: true }));
  let good;
  // Frozen, so a test can land one millisecond either side of a deadline.
  const clockStart = Date.now();
  let clockOffset = 0;
  class ClockDate extends Date {
    static now() { return clockStart + clockOffset; }
  }
  const context = {
    hive, RegistryUnreadable, liveWorkers, worktreePaths, worktreeOrigins: new Map(), ptyToAgent, preservedWorktrees: new Map(),
    workerTickRunning: false, lastGcSweepAt: Date.now(), GC_SWEEP_MS: 60_000, workerExitEvent, ...stopRetry,
    console: { log() {}, warn() {}, error() {} }, Date: ClockDate, Number, JSON, String, Math, Set, Map, Object, Array,
    readFileSync: fs.readFileSync, existsSync: fs.existsSync, mkdirSync: fs.mkdirSync, renameSync: fs.renameSync, unlinkSync: fs.unlinkSync,
    statSync: fs.statSync, readdirSync: fs.readdirSync,
    join: path.join, basename: path.basename, isAbsolute: path.isAbsolute,
    expandTilde: (p) => p, readConfig: () => ({ orchestratorMaySpawn: false }),
    buildWorkerLaunch: () => ({ bin: 'claude', args: [], command: 'claude' }), isSafeCommandName: () => true,
    getBranch: async () => ({ current: 'main' }),
    integrationBroker: { running: () => false, revoke: (id) => calls.revoked.push(id) }, integrations: { enabledIds: () => [] },
    telemetry: { startFreshSession() {}, forgetAgent() {} },
    workerWake: noop, heavyLock: noop, breaker: noop, grokLedgerGate: noop, breakerBaseline: noop, wakeSkipLog: noop, agentStatus: noop, control: noop,
    syncKeepAwake() {}, removeWorktree: async () => ({ ok: true }),
    finalizeWorkerWorktree: async (wt) => { calls.finalized.push(wt); },
    liveWebContents: () => ({ send: (channel, payload) => { if (channel === 'hive:agentArchived') calls.archivedCards.push(payload.id); } }),
    buildAutonomousRequestProtocol: () => '', slackReplyScriptPath: () => '',
    spawnAgentCore: async (opts) => {
      await hive.ensureAgent({ id: opts.id, name: 'W', provider: 'claude', cwd: home });
      sessions.set(opts.id, { id: opts.id, pid: 4242 });
      ptyToAgent.set(opts.id, opts.id);
      worktreePaths.set(opts.id, '/wt/worker-w1');
      good = fs.readFileSync(registry, 'utf8');
      fs.writeFileSync(registry, '{"agents":'); // the send that follows cannot be delivered
      return { ok: true };
    },
    ptyManager: {
      isCommandAvailable: () => true,
      list: () => [...sessions.values()],
      idleFor: () => 0,
      kill: (id) => {
        calls.killAttempts += 1;
        const result = killResult();
        if (result.ok) sessions.delete(id);
        return result;
      }
    },
    workerDoneAtStub: null, workerTokensUsed: () => 0, shouldReapIdle: () => false, workerHasLiveJob: () => false,
    afterWorkerDone: () => null, describeUnpushed: () => '', unpushedWorkerBranches: async () => [], spawnRequestsDirStub: null,
  };
  const send = hive.send.bind(hive);
  hive.send = (message, from) => {
    const sent = send(message, from);
    if (from === 'ephemeral-worker') calls.informed.push(message.subject);
    return sent;
  };
  const fns = vm.runInNewContext(live(), context);
  const repair = () => fs.writeFileSync(registry, good);
  const rows = (kind) => hive.logTail(500).filter((e) => e.kind === kind);
  return { hive, home, file, queue, calls, liveWorkers, ptyToAgent, worktreePaths, sessions, repair, rows, fns, agents: path.join(hive.root(), 'agents'), setKill: (fn) => { killResult = fn; }, advance: (ms) => { clockOffset += ms; }, run: () => fns.processSpawnRequest(file) };
}

const inFailed = (f) => fs.readdirSync(path.join(f.queue, '.failed'));

test('the full failure: a dead worker is cleaned up, recorded as archived after repair, and god hears once', async (t) => {
  const f = await setup(t);
  await f.run();

  assert.equal(f.liveWorkers.size, 0, 'no slot held');
  assert.equal(f.sessions.size, 0);
  assert.deepEqual(f.calls.revoked, [ID], 'the broker token');
  assert.deepEqual(f.calls.finalized, ['/wt/worker-w1'], 'the worktree');
  assert.deepEqual(f.calls.archivedCards, [ID], 'the floor card');
  assert.deepEqual(inFailed(f), ['w1.json']);
  assert.equal(f.rows('archive-pending').length, 1);

  f.repair();
  assert.notEqual(f.hive.registry().agents[ID].archived, true, 'it cannot have been recorded yet');
  f.hive.routeOnce();

  assert.equal(f.hive.registry().agents[ID].archived, true, 'recorded on the next pass that can read the registry');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.hive.root(), 'registry.json'), 'utf8')).agents[ID].archived, true);
  const told = () => f.hive.inbox('god-1').filter((m) => m.subject.includes(ID) && m.subject.includes('archived'));
  assert.equal(told().length, 1, 'god is told it happened');
  f.hive.routeOnce();
  assert.equal(told().length, 1, 'once');
  assert.deepEqual(fs.readdirSync(path.join(f.agents, ID)).filter((n) => n.includes('archive')), [], 'the marker is gone');
});

test('after repair, a later request to that id tells its sender no one is there', async (t) => {
  const f = await setup(t);
  await f.run();
  f.repair();
  f.hive.routeOnce();
  fs.writeFileSync(path.join(f.agents, 'worker-1', 'outbox', 'later.json'), JSON.stringify({ to: ID, act: 'request', requires_reply: true, subject: 'later', body: 'the later body' }));
  f.hive.routeOnce();
  const notices = f.hive.inbox('worker-1').map((m) => m.subject);
  assert.equal(notices.filter((s) => s.includes('no one is there to answer')).length, 1);
});

test('mail in the same pass that records the archive already sees the worker as archived', async (t) => {
  const f = await setup(t);
  await f.run();
  f.repair();
  fs.writeFileSync(path.join(f.agents, 'worker-1', 'outbox', 'same.json'), JSON.stringify({ to: ID, act: 'request', requires_reply: true, subject: 'same', body: 'b' }));
  f.hive.routeOnce();
  assert.ok(f.hive.inbox('worker-1').some((m) => m.subject.includes('no one is there to answer')));
});

test('between repair and the next pass, the marker already makes routing treat the worker as archived', async (t) => {
  const f = await setup(t);
  await f.run();
  f.repair();
  assert.notEqual(f.hive.registry().agents[ID].archived, true, 'not recorded yet');
  f.hive.send({ to: ID, act: 'request', requires_reply: true, subject: 'early', body: 'b' }, 'worker-1');
  assert.ok(f.hive.inbox('worker-1').some((m) => m.subject.includes('no one is there to answer')), 'it reads as live otherwise, and the sender hears nothing');
});

test('a broadcast between repair and the next pass skips the worker', async (t) => {
  const f = await setup(t);
  await f.run();
  f.repair();
  f.hive.send({ to: 'broadcast', act: 'inform', subject: 'all', body: 'b' }, 'worker-1');
  assert.deepEqual(f.hive.inbox(ID).filter((m) => m.subject === 'all'), []);
});

test('re-hiring the worker before the record lands clears the marker, so a live worker is not archived', async (t) => {
  const f = await setup(t);
  await f.run();
  f.repair();
  await f.hive.ensureAgent({ id: ID, name: 'W', provider: 'claude', cwd: f.home });
  f.hive.routeOnce();
  assert.notEqual(f.hive.registry().agents[ID].archived, true, 'it is live again');
  assert.deepEqual(f.hive.inbox('god-1').filter((m) => m.subject.includes('archived')), []);
});

test('a marker in a folder not on the roster is removed and archives nothing', async (t) => {
  const f = await setup(t);
  const stray = path.join(f.agents, 'stray');
  fs.mkdirSync(stray);
  fs.writeFileSync(path.join(stray, '.archive-pending'), '');
  const before = fs.readFileSync(path.join(f.hive.root(), 'registry.json'), 'utf8');
  f.hive.routeOnce();
  assert.equal(fs.existsSync(path.join(stray, '.archive-pending')), false);
  assert.equal(fs.readFileSync(path.join(f.hive.root(), 'registry.json'), 'utf8'), before);
  assert.deepEqual(f.hive.inbox('god-1'), []);
});

test('with a readable registry setArchived records at once and leaves no marker', async (t) => {
  const f = await setup(t);
  f.hive.setArchived('worker-1', true);
  assert.equal(f.hive.registry().agents['worker-1'].archived, true);
  assert.equal(fs.existsSync(path.join(f.agents, 'worker-1', '.archive-pending')), false);
});

test('un-archiving with an unreadable registry leaves no marker', async (t) => {
  const f = await setup(t);
  fs.writeFileSync(path.join(f.hive.root(), 'registry.json'), '{');
  f.hive.setArchived('worker-1', false);
  assert.equal(fs.existsSync(path.join(f.agents, 'worker-1', '.archive-pending')), false);
});

// A read that succeeds says nothing about the next one, so setArchived decides from one read and checks the file before it
// writes. Going bad in between must leave the same marker as a read that failed outright.
function changeFileAfterNextRead(f, content) {
  const read = f.hive.readableRegistry.bind(f.hive);
  f.hive.readableRegistry = () => {
    const roster = read();
    fs.writeFileSync(path.join(f.hive.root(), 'registry.json'), content);
    f.hive.readableRegistry = read;
    return roster;
  };
}

test('a registry corrupted right after setArchived reads it leaves the marker, and the archive lands after repair', async (t) => {
  const f = await setup(t);
  const file = path.join(f.hive.root(), 'registry.json');
  const good = fs.readFileSync(file, 'utf8');
  changeFileAfterNextRead(f, '{"agents":');

  f.hive.setArchived('worker-1', true);

  assert.equal(fs.readFileSync(file, 'utf8'), '{"agents":', 'nothing was written over it');
  assert.equal(fs.existsSync(path.join(f.agents, 'worker-1', '.archive-pending')), true, 'the archive would be lost');
  assert.equal(f.rows('archive-pending').length, 1);

  fs.writeFileSync(file, good);
  f.hive.routeOnce();
  assert.equal(f.hive.registry().agents['worker-1'].archived, true);
  assert.equal(fs.existsSync(path.join(f.agents, 'worker-1', '.archive-pending')), false);
  assert.equal(f.hive.inbox('god-1').filter((m) => m.subject.includes('worker-1') && m.subject.includes('archived')).length, 1);
});

test('a roster changed right after setArchived reads it is not overwritten, and the archive still lands', async (t) => {
  const f = await setup(t);
  const file = path.join(f.hive.root(), 'registry.json');
  const reg = JSON.parse(fs.readFileSync(file, 'utf8'));
  reg.agents['added-since'] = { id: 'added-since', name: 'A', provider: 'claude', cwd: '.' };
  const changed = JSON.stringify(reg);
  changeFileAfterNextRead(f, changed);

  f.hive.setArchived('worker-1', true);

  assert.equal(fs.readFileSync(file, 'utf8'), changed, 'the write would have undone this change');
  f.hive.routeOnce();
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8')).agents;
  assert.equal(onDisk['worker-1'].archived, true);
  assert.ok(onDisk['added-since'], 'and the later change survives');
});

test('un-archiving in that gap writes nothing and leaves no marker', async (t) => {
  const f = await setup(t);
  f.hive.setArchived('worker-1', true);
  changeFileAfterNextRead(f, '{"agents":');
  f.hive.setArchived('worker-1', false);
  assert.equal(fs.readFileSync(path.join(f.hive.root(), 'registry.json'), 'utf8'), '{"agents":');
  assert.equal(fs.existsSync(path.join(f.agents, 'worker-1', '.archive-pending')), false);
});

test('an agent already archived, or not on the roster, gets no write and no marker', async (t) => {
  const f = await setup(t);
  f.hive.setArchived('worker-1', true);
  const file = path.join(f.hive.root(), 'registry.json');
  const before = fs.readFileSync(file, 'utf8');
  f.hive.setArchived('worker-1', true);
  f.hive.setArchived('nobody', true);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.deepEqual(f.rows('archive').filter((r) => r.agentId === 'nobody'), [], 'nothing happened, so nothing is logged');
  assert.equal(fs.existsSync(path.join(f.agents, 'worker-1', '.archive-pending')), false);
});

// ---- a kill that reports failure ----

const STUCK = () => ({ ok: false, error: 'EPERM' });

test('a kill that fails keeps the worker tracked as stopping, logs the pid, and still files the request as failed', async (t) => {
  const f = await setup(t, { kill: STUCK });
  await f.run();

  const rec = f.liveWorkers.get(ID);
  assert.ok(rec, 'its bookkeeping is the only way left to stop it');
  assert.equal(rec.releasing, true);
  assert.deepEqual(inFailed(f), ['w1.json']);
  const [row, ...others] = f.rows('worker-kill-failed');
  assert.deepEqual(others, []);
  assert.deepEqual([row.workerId, row.pid, row.code], [ID, 4242, 'kill-failed']);
  assert.deepEqual(f.calls.revoked, [], 'nothing is torn down around a live process');
  assert.equal(f.ptyToAgent.get(ID), ID);
  assert.equal(f.worktreePaths.get(ID), '/wt/worker-w1');
});

test('a kill that throws is handled the same way', async (t) => {
  const f = await setup(t, { kill: () => { throw new Error('boom'); } });
  await f.run();
  assert.ok(f.liveWorkers.has(ID));
  assert.equal(f.rows('worker-kill-failed').length, 1);
  assert.deepEqual(inFailed(f), ['w1.json']);
});

test('the worker tick retries the stop, without a new log row each time, and tears down once it works', async (t) => {
  const f = await setup(t, { kill: STUCK });
  await f.run();
  const after = f.calls.killAttempts;

  f.advance(stopRetry.STOP_RETRY_MAX_MS);
  await f.fns.ephemeralWorkerTick();
  f.advance(stopRetry.STOP_RETRY_MAX_MS);
  await f.fns.ephemeralWorkerTick();
  assert.equal(f.calls.killAttempts, after + 2, 'it is retried');
  assert.equal(f.rows('worker-kill-failed').length, 1, 'one row, not one per tick');
  assert.ok(f.liveWorkers.has(ID));

  f.setKill(() => ({ ok: true }));
  f.advance(stopRetry.STOP_RETRY_MAX_MS);
  await f.fns.ephemeralWorkerTick();
  assert.equal(f.liveWorkers.has(ID), false);
  assert.deepEqual(f.calls.revoked, [ID]);
  assert.deepEqual(f.calls.archivedCards, [ID]);
  const attempts = f.calls.killAttempts;
  await f.fns.ephemeralWorkerTick();
  assert.equal(f.calls.killAttempts, attempts, 'and stops retrying');
});

test('a session already gone counts as stopped, so the retry cannot run forever', async (t) => {
  const f = await setup(t, { kill: STUCK });
  await f.run();
  f.sessions.clear();
  await f.fns.ephemeralWorkerTick();
  assert.equal(f.liveWorkers.has(ID), false);
  assert.deepEqual(f.calls.revoked, [ID]);
});

// ---- a kill that keeps failing ----

const stuckNotices = (f) => f.calls.informed.filter((subject) => subject.includes('could not be stopped'));

test('retries back off instead of running on every tick', async (t) => {
  const f = await setup(t, { kill: STUCK });
  await f.run();
  const first = f.calls.killAttempts;

  await f.fns.ephemeralWorkerTick();
  f.advance(stopRetry.STOP_RETRY_FIRST_MS - 1);
  await f.fns.ephemeralWorkerTick();
  assert.equal(f.calls.killAttempts, first, 'not before the first delay is up');

  f.advance(1);
  await f.fns.ephemeralWorkerTick();
  assert.equal(f.calls.killAttempts, first + 1);

  f.advance(stopRetry.STOP_RETRY_FIRST_MS * 2 - 1);
  await f.fns.ephemeralWorkerTick();
  assert.equal(f.calls.killAttempts, first + 1, 'the second delay is twice the first');

  f.advance(1);
  await f.fns.ephemeralWorkerTick();
  assert.equal(f.calls.killAttempts, first + 2);
});

test('retries never give up, because the record is all that can still stop the worker', async (t) => {
  const f = await setup(t, { kill: STUCK });
  await f.run();
  for (let i = 0; i < 100; i += 1) {
    f.advance(stopRetry.STOP_RETRY_MAX_MS);
    await f.fns.ephemeralWorkerTick();
  }
  assert.equal(f.calls.killAttempts, 101);
  assert.ok(f.liveWorkers.has(ID));
  assert.equal(f.ptyToAgent.get(ID), ID);
  assert.equal(f.rows('worker-kill-failed').length, 1);

  f.setKill(() => ({ ok: true }));
  f.advance(stopRetry.STOP_RETRY_MAX_MS);
  await f.fns.ephemeralWorkerTick();
  assert.equal(f.liveWorkers.has(ID), false);
});

test('a session that goes away is torn down on the next tick, without waiting out the delay', async (t) => {
  const f = await setup(t, { kill: STUCK });
  await f.run();
  for (let i = 0; i < 8; i += 1) {
    f.advance(stopRetry.STOP_RETRY_MAX_MS);
    await f.fns.ephemeralWorkerTick();
  }
  f.sessions.clear();
  await f.fns.ephemeralWorkerTick();
  assert.equal(f.liveWorkers.has(ID), false);
  assert.deepEqual(f.calls.revoked, [ID]);
});

test('god hears once per notice period while a worker stays stuck, and not after it stops', async (t) => {
  const f = await setup(t, { kill: STUCK });
  await f.run();
  f.repair(); // the failure under test here is the kill; a notice needs a readable roster to land
  const tickAfter = async (ms) => { f.advance(ms); await f.fns.ephemeralWorkerTick(); };

  await tickAfter(stopRetry.STUCK_NOTICE_EVERY_MS - 1);
  assert.equal(stuckNotices(f).length, 0, 'a brief failure is not news');

  await tickAfter(stopRetry.STOP_RETRY_MAX_MS);
  assert.equal(stuckNotices(f).length, 1);
  const [notice] = f.hive.inbox('god-1').filter((m) => m.subject.includes('could not be stopped'));
  assert.match(notice.subject, new RegExp(ID));
  assert.match(notice.body, /4242/, 'names the pid to deal with');
  assert.match(notice.body, /slot/, 'says what it is costing');

  await tickAfter(stopRetry.STOP_RETRY_MAX_MS);
  assert.equal(stuckNotices(f).length, 1, 'not on every attempt');

  await tickAfter(stopRetry.STUCK_NOTICE_EVERY_MS);
  assert.equal(stuckNotices(f).length, 2, 'again after another period');

  f.setKill(() => ({ ok: true }));
  await tickAfter(stopRetry.STOP_RETRY_MAX_MS);
  await tickAfter(stopRetry.STUCK_NOTICE_EVERY_MS);
  assert.equal(stuckNotices(f).length, 2, 'nothing once it has stopped');
});

test('a notice that could not be sent is sent on the next attempt after the registry is repaired', async (t) => {
  const f = await setup(t, { kill: STUCK });
  await f.run(); // leaves the registry unreadable
  const tickAfter = async (ms) => { f.advance(ms); await f.fns.ephemeralWorkerTick(); };
  const landed = () => f.hive.inbox('god-1').filter((m) => m.subject.includes('could not be stopped')).length;

  await tickAfter(stopRetry.STUCK_NOTICE_EVERY_MS);
  await tickAfter(stopRetry.STOP_RETRY_MAX_MS);
  assert.equal(stuckNotices(f).length, 0, 'the notice cannot land while the registry is unreadable');

  f.repair();
  assert.equal(landed(), 0);
  await tickAfter(stopRetry.STOP_RETRY_MAX_MS);
  assert.equal(landed(), 1, 'the failed send must not use up the notice period');

  await tickAfter(stopRetry.STOP_RETRY_MAX_MS);
  assert.equal(landed(), 1, 'once delivered, the next is a full period away');

  await tickAfter(stopRetry.STUCK_NOTICE_EVERY_MS);
  assert.equal(landed(), 2);
});

test('retrying a failed kill schedules no sweep timer, and a kill that works schedules one', (t) => {
  // The retry only runs after a kill reported failure. If that path scheduled the
  // process-group sweep, the timers would pile up with every attempt.
  const scheduled = t.mock.method(globalThis, 'setTimeout', () => ({ unref() {} }));
  const mgr = new PtyManager();
  let works = false;
  const proc = { pid: 999_999, kill() { if (!works) throw new Error('EPERM'); } };
  mgr.sessions.set('w', { id: 'w', proc });

  for (let i = 0; i < 5; i += 1) assert.equal(mgr.kill('w').ok, false);
  assert.equal(scheduled.mock.callCount(), 0);
  assert.ok(mgr.sessions.has('w'), 'still there to retry');

  works = true;
  assert.equal(mgr.kill('w').ok, true);
  assert.equal(scheduled.mock.callCount(), 1);
  assert.equal(mgr.sessions.has('w'), false, 'so a later retry finds nothing to kill');
  assert.equal(mgr.kill('w').ok, false);
  assert.equal(scheduled.mock.callCount(), 1);
});
