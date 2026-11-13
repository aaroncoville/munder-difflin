'use strict';

/**
 * A worker's objective reaches it as a message. If that send failed, the worker used to stay live with no task, holding
 * a concurrency slot until the idle reaper, while its request was filed as done. Spawn success now includes delivering
 * the objective. This runs the real processSpawnRequest and archiveRequest from index.ts, which cannot be imported on
 * their own, against a real hive and real request files.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const { RegistryUnreadable } = loadTs('src/main/messageTarget.ts');

function liveFunctions() {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'src/main/index.ts'), 'utf8');
  const tree = ts.createSourceFile('index.ts', source, ts.ScriptTarget.ES2022, true);
  const bodies = ['processSpawnRequest', 'spawnAgent', 'archiveRequest', 'spawnRequestsDir', 'stopWorker'].map((name) => {
    const node = tree.statements.find((n) => ts.isFunctionDeclaration(n) && n.name?.text === name);
    assert.ok(node, `${name} is a top-level function of index.ts`);
    return node.getText(tree);
  });
  return ts.transpileModule(`${bodies.join('\n')}\n({ processSpawnRequest })`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}

async function setup(t, { sendThrows } = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'md-dispatch-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god-1', name: 'Boss', provider: 'claude', cwd: home, isGod: true });
  const registry = path.join(hive.root(), 'registry.json');
  const good = fs.readFileSync(registry, 'utf8');
  const queue = path.join(hive.root(), 'spawn-requests');
  fs.mkdirSync(queue, { recursive: true });
  const file = path.join(queue, 'w1.json');
  fs.writeFileSync(file, JSON.stringify({ id: 'w1', objective: 'do the thing', cwd: home }));

  const liveWorkers = new Map();
  const calls = { spawned: [], killed: [], tornDown: [], notices: [], revoked: [], agentCards: [], errors: [], releasingAtTeardown: [], logged: [] };
  const context = {
    hive: sendThrows ? new Proxy(hive, { get: (h, k) => (k === 'send' ? () => { throw sendThrows; } : typeof h[k] === 'function' ? h[k].bind(h) : h[k]) }) : hive,
    RegistryUnreadable, liveWorkers,
    console: { log: (...a) => calls.logged.push(a.join(' ')), warn() {}, error: (...a) => calls.errors.push(a.join(' ')) },
    Date, Number, JSON, String, Math,
    readFileSync: fs.readFileSync, existsSync: fs.existsSync, mkdirSync: fs.mkdirSync, renameSync: fs.renameSync, unlinkSync: fs.unlinkSync,
    join: path.join, basename: path.basename, isAbsolute: path.isAbsolute,
    expandTilde: (p) => p, readConfig: () => ({}),
    buildWorkerLaunch: () => ({ bin: 'claude', args: [], command: 'claude' }), isSafeCommandName: () => true,
    getBranch: async () => ({ current: 'main' }),
    integrationBroker: { running: () => false, revoke: (id) => calls.revoked.push(id) }, integrations: { enabledIds: () => [] },
    telemetry: { startFreshSession() {} },
    liveWebContents: () => ({ send: (channel, card) => calls.agentCards.push(card.id) }),
    buildAutonomousRequestProtocol: () => '', slackReplyScriptPath: () => '',
    // A spawn that worked. The registry going bad right after it is what makes the objective's real send fail.
    spawnAgentCore: async (opts) => {
      calls.spawned.push(opts.id);
      await hive.ensureAgent({ id: opts.id, name: 'W', provider: 'claude', cwd: home });
      if (!sendThrows && t.corruptAfterSpawn) fs.writeFileSync(registry, '{"agents":');
      return { ok: true };
    },
    ptyManager: { isCommandAvailable: () => true, list: () => [{ id: 'worker-w1', pid: 1 }], kill: (id) => { calls.killed.push(id); return { ok: true }; } },
    // As teardownPty does: it is what ends tracking.
    teardownPty: (id) => { calls.tornDown.push(id); calls.releasingAtTeardown.push(liveWorkers.get(id)?.releasing); liveWorkers.delete(id); },
    informGod: (subject, body) => calls.notices.push({ subject, body })
  };
  const { processSpawnRequest } = vm.runInNewContext(liveFunctions(), context);
  const inFolder = (sub) => { try { return fs.readdirSync(path.join(queue, sub)); } catch { return []; } };
  return { hive, home, registry, good, queue, file, liveWorkers, calls, inFolder, run: () => processSpawnRequest(file) };
}

const failedRows = (hive) => hive.logTail(500).filter((e) => e.kind === 'worker-dispatch-failed');

test('an objective that cannot be sent because the registry is unreadable leaves no worker, and files the request as failed', async (t) => {
  t.corruptAfterSpawn = true;
  const f = await setup(t);
  await f.run();
  fs.writeFileSync(f.registry, f.good);

  assert.deepEqual(f.calls.spawned, ['worker-w1'], 'the spawn itself worked');
  assert.equal(f.liveWorkers.size, 0, 'it would hold a slot until the idle reaper');
  assert.deepEqual(f.calls.killed, ['worker-w1'], 'the process is stopped');
  assert.deepEqual(f.calls.tornDown, ['worker-w1'], 'and torn down the way a release is');
  assert.deepEqual(f.inFolder('.failed'), ['w1.json']);
  assert.deepEqual(f.inFolder('.done'), [], 'a worker with no objective did not succeed');
  assert.equal(fs.existsSync(f.file), false, 'not left to be picked up again');
});

test('the failure names its typed reason in one log row and in the notice', async (t) => {
  t.corruptAfterSpawn = true;
  const f = await setup(t);
  await f.run();
  const [row, ...others] = failedRows(f.hive);
  assert.deepEqual(others, []);
  assert.deepEqual([row.workerId, row.request, row.code], ['worker-w1', 'w1.json', 'registry-unreadable']);
  assert.equal(JSON.stringify(row).includes('do the thing'), false, 'the objective stays out of the log');
  assert.equal(f.calls.notices.length, 1);
  assert.match(f.calls.notices[0].body, /registry-unreadable/);
  assert.match(f.calls.notices[0].subject, /objective not delivered/);
});

test('it tears down once, and the run does not go on to report success', async (t) => {
  t.corruptAfterSpawn = true;
  const f = await setup(t);
  await f.run();
  assert.equal(f.calls.killed.length, 1);
  assert.equal(f.calls.spawned.length, 1, 'no retry loop');
  assert.equal(f.calls.notices.length, 1);
  assert.deepEqual(f.calls.errors.filter((e) => e.includes('archiveRequest failed')), [], 'it does not then try to file the request as done');
  assert.deepEqual(f.calls.logged.filter((l) => l.includes('spawned')), []);
});

// Teardown logs a worker not marked as stopping as one that exited on its own.
test('the worker is marked as being stopped before teardown, so it is not logged as having quit', async (t) => {
  t.corruptAfterSpawn = true;
  const f = await setup(t);
  await f.run();
  assert.deepEqual(f.calls.releasingAtTeardown, [true]);
});

test('any other failure to send the objective ends the same way, under its own reason', async (t) => {
  const f = await setup(t, { sendThrows: new Error('disk full at /secret/path') });
  await f.run();
  assert.equal(f.liveWorkers.size, 0);
  assert.deepEqual(f.calls.killed, ['worker-w1']);
  assert.deepEqual(f.inFolder('.failed'), ['w1.json']);
  const [row] = failedRows(f.hive);
  assert.equal(row.code, 'send-failed');
  assert.equal(JSON.stringify(row).includes('/secret/path'), false, 'a raw error can quote a path');
  assert.ok(f.calls.errors.some((e) => e.includes('disk full')), 'the detail still reaches the console');
});

test('an objective that goes out leaves the worker live and files the request as done', async (t) => {
  const f = await setup(t);
  await f.run();
  assert.equal(f.liveWorkers.has('worker-w1'), true);
  assert.deepEqual(f.calls.killed, []);
  assert.deepEqual(f.inFolder('.done'), ['w1.json']);
  assert.deepEqual(f.inFolder('.failed'), []);
  assert.deepEqual(failedRows(f.hive), []);
  assert.equal(f.hive.inbox('worker-w1').length, 1, 'the objective arrived');
});
