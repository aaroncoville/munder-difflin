'use strict';

/**
 * Provisioning refuses an id it cannot safely give a folder. The spawn path treats
 * provisioning as best-effort and carried on regardless, so a refused id started a
 * real process with no prompt, environment, hooks or roster entry. A refused id must
 * fail the spawn; any other provisioning error stays best-effort.
 *
 * Runs the real provisioning statement from spawnAgentCore (which cannot be imported
 * on its own) against a real HiveManager.
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
const { RefusedRosterId, RegistryUnreadable } = loadTs('src/main/messageTarget.ts');

function liveProvisioning() {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'src/main/index.ts'), 'utf8');
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.ES2022, true);
  const fn = (name) => ast.statements.find((n) => ts.isFunctionDeclaration(n) && n.name?.text === name);
  let statement;
  const visit = (node) => {
    if (statement) return;
    if (ts.isIfStatement(node) && node.getText(ast).includes('hive.ensureAgent(')) statement = node;
    else ts.forEachChild(node, visit);
  };
  visit(fn('spawnAgentCore'));
  assert.ok(statement, 'spawnAgentCore provisions through hive.ensureAgent');
  const helper = fn('refuseSpawn');
  assert.ok(helper, 'no refuseSpawn: a refused id cannot fail the spawn');
  return ts.transpileModule(
    `${helper.getText(ast)}\n(async function run(opts, provider) { let seedPrompt; ${statement.getText(ast)}; return 'started a process'; })`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }
  ).outputText;
}

async function setup(t, overrides = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-spawn-refused-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const real = new HiveManager(() => home);
  await real.ensureAgent({ id: 'god-1', name: 'Boss', provider: 'claude', cwd: home, isGod: true });
  await real.ensureAgent({ id: 'Taken', name: 'Taken', provider: 'claude', cwd: home });
  const events = [];
  const removed = [];
  const worktreePaths = new Map();
  const worktreeOrigins = new Map();
  const errors = [];
  let removal = async () => ({ ok: true });
  const context = {
    console: { error: (...a) => errors.push(a.join(' ')), warn() {}, log() {} },
    hive: { enabled: () => true, ensureAgent: (...a) => real.ensureAgent(...a), appendLog: (row) => real.appendLog(row), ...overrides },
    memory: { active: () => false, env: () => ({}) },
    knowledge: { active: () => false, env: () => ({}) },
    readConfig: () => ({}), skillsResourceDir: () => '', breakerToast() {},
    analytics: { track: (name, props) => events.push([name, { ...props }]) },
    worktreePaths, worktreeOrigins,
    removeWorktree: (origin, wt) => { removed.push([origin, wt]); return removal(); },
    relocationEnv: loadTs('src/main/launchLine.ts').relocationEnv, buildPtyEnv: loadTs('src/main/ptyEnv.ts').buildPtyEnv, process,
    RefusedRosterId, RegistryUnreadable, HookRuntimeUnavailable: loadTs('src/main/hookRuntime.ts').HookRuntimeUnavailable, shortTarget: loadTs('src/main/messageTarget.ts').shortTarget
  };
  const run = vm.runInNewContext(liveProvisioning(), context);
  const spawn = (id) => run({ id: `pty-${id}`, cwd: home, hive: { id, name: 'x' } }, 'claude');
  const removalDoes = (fn) => { removal = fn; };
  return { real, home, events, removed, errors, worktreePaths, worktreeOrigins, spawn, removalDoes };
}

const rows = (hive) => hive.logTail(500).filter((e) => e.kind === 'spawn-refused');

for (const [label, id, why] of [
  ['one of the app\'s names', 'heartbeat', /reserved/],
  ['a name that is not a folder', 'a/b', /folder name/],
  ['another agent\'s folder in another case', 'taken', /already has that folder/]
]) {
  test(`a spawn under ${label} fails visibly and starts nothing`, async (t) => {
    const f = await setup(t);
    const result = await f.spawn(id);
    assert.notEqual(result, 'started a process', 'the refusal was swallowed and a process with no identity started');
    assert.equal(result.ok, false);
    assert.match(result.error, why);
    const logged = rows(f.real);
    assert.equal(logged.length, 1);
    assert.match(logged[0].reason, why);
    assert.deepEqual(f.events, [['agent_spawn_failed', { provider: 'claude', reason: 'spawn_error' }]]);
    assert.equal(Object.hasOwn(f.real.registry().agents, id), false);
  });
}

test('a refused id has its worktree removed, since no process will ever tear it down', async (t) => {
  const f = await setup(t);
  f.worktreePaths.set('pty-heartbeat', '/wt/heartbeat');
  f.worktreeOrigins.set('pty-heartbeat', '/repo');
  assert.equal((await f.spawn('heartbeat')).ok, false);
  assert.deepEqual(f.removed, [['/repo', '/wt/heartbeat']]);
  assert.equal(f.worktreePaths.has('pty-heartbeat'), false);
  assert.equal(f.worktreeOrigins.has('pty-heartbeat'), false);
  assert.deepEqual(f.errors, []);
});

for (const [label, removal, shown] of [
  ['reports failure', async () => ({ ok: false, error: 'still registered' }), /still registered/],
  ['throws', async () => { throw new Error('git is gone'); }, /git is gone/]
]) {
  test(`when removing the worktree ${label}, it is logged, stays tracked, and the spawn still fails`, async (t) => {
    const f = await setup(t);
    f.removalDoes(removal);
    f.worktreePaths.set('pty-heartbeat', '/wt/heartbeat');
    f.worktreeOrigins.set('pty-heartbeat', '/repo');
    const result = await f.spawn('heartbeat');
    assert.equal(result.ok, false);
    assert.match(result.error, /reserved/, 'the caller still hears why the spawn was refused');
    assert.equal(f.errors.length, 1);
    assert.match(f.errors[0], shown);
    assert.match(f.errors[0], /\/wt\/heartbeat/, 'and which worktree is left over');
    assert.equal(f.worktreePaths.get('pty-heartbeat'), '/wt/heartbeat', 'a worktree still on disk stays tracked');
    assert.equal(f.worktreeOrigins.get('pty-heartbeat'), '/repo');
  });
}

test('an unreadable registry fails the spawn, rather than starting a process with no identity', async (t) => {
  const f = await setup(t);
  const file = path.join(f.real.root(), 'registry.json');
  fs.writeFileSync(file, '{"agents":');
  const result = await f.spawn('worker-9');
  assert.notEqual(result, 'started a process');
  assert.equal(result.ok, false);
  assert.match(result.error, /registry could not be read/);
  assert.equal(rows(f.real).length, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"agents":');
});

test('a legacy roster entry under an app name fails its spawn when restored', async (t) => {
  const f = await setup(t);
  const file = path.join(f.real.root(), 'registry.json');
  const reg = JSON.parse(fs.readFileSync(file, 'utf8'));
  reg.agents.heartbeat = { id: 'heartbeat', name: 'x', provider: 'claude', cwd: '.' };
  fs.writeFileSync(file, JSON.stringify(reg));
  const result = await f.spawn('heartbeat');
  assert.notEqual(result, 'started a process');
  assert.match(result.error, /reserved/);
});

test('the log row stays bounded whatever the id or the agent it collides with', async (t) => {
  const f = await setup(t);
  const long = 'x'.repeat(5000);
  await f.spawn(long);
  const [row] = rows(f.real);
  assert.ok(row.agentId.length <= 64, `agentId is ${row.agentId.length} characters`);
  assert.ok(row.reason.length <= 200, `reason is ${row.reason.length} characters`);
});

test('any other provisioning error stays best-effort: the spawn goes on and nothing reads as refused', async (t) => {
  const f = await setup(t, { ensureAgent: async () => { throw new Error('disk full'); } });
  assert.equal(await f.spawn('worker-9'), 'started a process');
  assert.deepEqual(rows(f.real), []);
  assert.deepEqual(f.events, []);
});

test('an acceptable id provisions and goes on to start', async (t) => {
  const f = await setup(t);
  assert.equal(await f.spawn('worker-9'), 'started a process');
  assert.equal(Object.hasOwn(f.real.registry().agents, 'worker-9'), true);
  assert.deepEqual(rows(f.real), []);
});
