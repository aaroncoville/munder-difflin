'use strict';
/**
 * A spawn whose terminal does not start leaves nothing behind.
 *
 * Everything before the terminal can pass (provisioning, the late launch check)
 * and the terminal itself can still fail to start: the id is already in use, or
 * the working folder vanished. The agent must not then look live (an owner for a
 * terminal that does not exist, a spawn record, a Codex home, a thread, wake
 * state) and a registry row the spawn added must go. Runs the real tail of
 * spawnAgentCore, from the late check to the terminal, against a real HiveManager.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const loadTs = require('./load-ts.cjs');
const { codexTestBase, jailHome } = require('./codex-test-home.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

function liveTail() {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'src/main/index.ts'), 'utf8');
  const start = source.indexOf('  // The late check on the launch exactly as it will start');
  const end = source.indexOf('  syncKeepAwake(); // arm the power-save blocker', start);
  assert.ok(start > 0 && end > start, 'spawnAgentCore has its late check and terminal start');
  return ts.transpileModule(
    `(async function run(opts, provider) {
      const codexHomeFromApp = false; const codexResumedSession = undefined; const didResume = false;
      ${source.slice(start, end)}
      return res;
    })`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }
  ).outputText;
}

async function setup(t, result) {
  const base = codexTestBase(t, 'mdsf-');
  jailHome(t, base);
  const cwd = path.join(base, 'work');
  fs.mkdirSync(cwd);
  const rt = fs.realpathSync(fs.mkdtempSync('/tmp/mdsfr-'));
  t.after(() => fs.rmSync(rt, { recursive: true, force: true }));
  const hive = new HiveManager(() => base);
  hive.setHookRuntime(rt);
  const id = 'w1';
  const settings = path.join(base, 'hive', 'agents', id, 'settings.json');
  const argv = ['claude', '--settings', settings];
  await hive.ensureAgent({ id, name: id, provider: 'claude', cwd }, { launch: { argv, env: {} }, spawnId: `pty-${id}` });
  hive.markHookProvisioned(`pty-${id}`);
  assert.equal(Object.hasOwn(hive.registry().agents, id), true, 'provisioning added the row');
  const calls = [];
  const maps = { ptyToAgent: new Map(), spawnRoots: new Map() };
  const context = {
    console: { error() {}, warn() {}, log() {} }, process,
    hive, owner: null,
    ...maps,
    spawnGeneration: 0,
    codexHomes: { recordSpawn: (...a) => calls.push(['codexHomes', ...a]) },
    codexThreads: { spawned: (...a) => calls.push(['codexThreads', ...a]) },
    workerWake: { noteSpawn: (...a) => calls.push(['workerWake', ...a]) },
    ptyManager: { spawn: () => result },
    analytics: { track: (...a) => calls.push(['analytics', a[0]]) },
    spawnFailReason: () => 'spawn_error',
    relocationEnv: loadTs('src/main/launchLine.ts').relocationEnv,
    buildPtyEnv: loadTs('src/main/ptyEnv.ts').buildPtyEnv,
    HookRuntimeUnavailable: loadTs('src/main/hookRuntime.ts').HookRuntimeUnavailable,
    refuseSpawn: async () => ({ ok: false, error: 'refused' }),
  };
  const run = vm.runInNewContext(liveTail(), context);
  const out = await run({ id: `pty-${id}`, cwd, command: 'claude', args: ['--settings', settings], env: {}, hive: { id, name: id } }, 'claude');
  return { hive, id, out, calls, maps };
}

for (const [label, result] of [
  ['the terminal id is already in use', { ok: false, error: 'pty pty-w1 already exists' }],
  ['the working folder vanished', { ok: false, error: 'cwd does not exist: /gone' }],
]) {
  test(`when ${label}, the spawn leaves no records and no registry row`, async (t) => {
    const f = await setup(t, result);
    assert.equal(f.out.ok, false);
    assert.equal(f.maps.ptyToAgent.size, 0, 'no owner for a terminal that does not exist');
    assert.equal(f.maps.spawnRoots.size, 0, 'no spawn record');
    assert.deepEqual(f.calls.filter((c) => c[0] !== 'analytics'), [], 'no Codex home, thread or wake state');
    assert.equal(Object.hasOwn(f.hive.registry().agents, f.id), false, 'the row this spawn added is gone');
    assert.ok(f.hive.logTail(500).some((r) => r.kind === 'spawn-rolled-back' && r.agentId === f.id && r.rowRemoved === true));
  });
}

test('when the terminal starts, the records are written', async (t) => {
  const f = await setup(t, { ok: true });
  assert.equal(f.out.ok, true);
  assert.equal(f.maps.ptyToAgent.get(`pty-${f.id}`), f.id);
  assert.equal(f.maps.spawnRoots.has(f.id), true);
  assert.ok(f.calls.some((c) => c[0] === 'workerWake'));
  assert.equal(Object.hasOwn(f.hive.registry().agents, f.id), true);
});

test('an unexpected failure between provisioning and the terminal does not keep Codex agents refused', async (t) => {
  const base = codexTestBase(t, 'mdsx-');
  jailHome(t, base);
  const cwd = path.join(base, 'work');
  fs.mkdirSync(cwd);
  const hive = new HiveManager(() => base);
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'src/main/index.ts'), 'utf8');
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.ES2022, true);
  const wrapper = ast.statements.find((n) => ts.isFunctionDeclaration(n) && n.name?.text === 'spawnAgent');
  assert.ok(wrapper, 'every spawn goes through spawnAgent');
  // The spawn core: an agent the app does not sandbox is admitted, then something throws before its terminal starts.
  const spawnAgentCore = async (opts) => {
    await hive.ensureAgent({ ...opts.hive, cwd, provider: 'custom' }, { spawnId: opts.id });
    throw new Error('unexpected');
  };
  const run = vm.runInNewContext(`${ts.transpileModule(wrapper.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText}; spawnAgent`, { hive, spawnAgentCore });
  await assert.rejects(run({ id: 'pty-u1', cwd, command: 'x', hive: { id: 'u1', name: 'u' } }, null), /unexpected/);
  const inj = await hive.ensureAgent({ id: 'cx', name: 'cx', provider: 'codex', cwd });
  assert.ok(inj, 'a Codex agent is admitted afterwards');
});
