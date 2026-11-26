'use strict';
/**
 * A scoped spawn's policy and token end with the spawn.
 *
 * Each scoped spawn records a policy (its roots, grants and working folder) and a token that names it; the hook's write
 * check judges a call carrying that token by that policy. Nothing removed either one, so a spawn that never started, or
 * whose terminal had exited, still had a live token: a process holding it could go on writing under a policy for a
 * spawn that no longer exists, and every spawn added an entry that was never freed. A spawn's policy and token are now
 * retired, by its spawn id, when it is refused, rolled back or never starts a terminal, and when its terminal is torn
 * down. A call carrying a retired token is refused, as for a token the app never issued.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const loadTs = require('./load-ts.cjs');
const { codexTestBase, jailHome, removeDir } = require('./codex-test-home.cjs');
const { withSeatSettings } = require('./seat-settings-dir.cjs');

const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron, filename: electron, loaded: true,
  exports: { Notification: class { show() {} static isSupported() { return false; } } }
};

const { HiveManager } = loadTs('src/main/hive.ts');
const { HookServer } = loadTs('src/main/hooks.ts');
const { seatGate } = loadTs('src/core/writeRoots.ts');

const INDEX = fs.readFileSync(path.resolve(__dirname, '..', 'src/main/index.ts'), 'utf8');
const TREE = ts.createSourceFile('index.ts', INDEX, ts.ScriptTarget.ES2022, true);
const transpile = (src) => ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function topLevel(name) {
  const node = TREE.statements.find((n) => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(node, `${name} is a top-level function of index.ts`);
  return node.getText(TREE);
}

function floor(t) {
  const base = codexTestBase(t, 'mdrt-');
  jailHome(t, base);
  const harness = path.join(base, 'h');
  const work = path.join(base, 'work');
  for (const d of [harness, work]) fs.mkdirSync(d, { recursive: true });
  const hive = withSeatSettings(new HiveManager(() => harness));
  const runtime = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mdrt-rt-')));
  t.after(async () => removeDir(runtime));
  hive.setHookRuntime(runtime);
  hive.ensureHive();
  const root = hive.root();
  const server = new HookServer(hive, () => null, () => ({ notifications: false, scopedRoots: true }), undefined, undefined);
  server.setWriteGate((seat, token) => seatGate(hive.root(), seat, token, (tk) => hive.spawnPolicy(tk), () => undefined));
  const write = (seat, token, file_path) => server.handle({ hive_seat_id: seat, agent_id: seat, cwd: work, hive_spawn: token, session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path, content: 'x' } });
  const prov = async (id, spawnId, launch) => (await hive.ensureAgent({ id, name: id, provider: 'claude', cwd: work }, { spawnId, scopedRoots: true, ...(launch ? { launch } : {}) })).env.HIVE_SPAWN_TOKEN;
  const own = (id) => path.join(root, 'agents', id, 'notes.md');
  return { base, root, work, hive, write, prov, own };
}

const denied = (r) => r?.hookSpecificOutput?.permissionDecision === 'deny';
const gone = (hive, spawnId, token) => hive.spawnScope(spawnId) === undefined && hive.spawnPolicy(token) === undefined;

test('a refused spawn leaves no policy or token behind', async (t) => {
  const f = floor(t);
  const token = await f.prov('ag', 'pty-ag');
  assert.ok(f.hive.spawnPolicy(token), 'provisioning recorded the policy');
  f.hive.withdrawRefusedSpawn('pty-ag', 'refused');
  assert.ok(gone(f.hive, 'pty-ag', token));
});

test('a spawn whose terminal does not start leaves no policy or token behind', async (t) => {
  const f = floor(t);
  const settings = f.hive.seatSettingsPath('ag');
  const argv = ['claude', '--settings', settings];
  const token = await f.prov('ag', 'pty-ag', { argv, env: {} });
  f.hive.markHookProvisioned('pty-ag');
  const start = INDEX.indexOf('  // The late check on the launch exactly as it will start');
  const end = INDEX.indexOf('  syncKeepAwake(); // arm the power-save blocker', start);
  assert.ok(start > 0 && end > start, 'spawnAgentCore has its late check and terminal start');
  const tail = transpile(`(async function run(opts, provider) {
    const codexHomeFromApp = false; const codexResumedSession = undefined; const didResume = false;
    ${INDEX.slice(start, end)}
    return res;
  })`);
  const run = vm.runInNewContext(tail, {
    console: { error() {}, warn() {}, log() {} }, process, hive: f.hive, owner: null,
    ptyToAgent: new Map(), spawnRoots: new Map(), spawnGeneration: 0,
    codexHomes: { recordSpawn() {} }, codexThreads: { spawned() {} }, workerWake: { noteSpawn() {} },
    ptyManager: { spawn: () => ({ ok: false, error: 'cwd does not exist: /gone' }) },
    analytics: { track() {} }, spawnFailReason: () => 'cwd_missing',
    relocationEnv: loadTs('src/core/launchLine.ts').relocationEnv,
    buildPtyEnv: loadTs('src/main/ptyEnv.ts').buildPtyEnv,
    HookRuntimeUnavailable: loadTs('src/core/hookRuntime.ts').HookRuntimeUnavailable,
    refuseSpawn: async () => ({ ok: false, error: 'refused' }),
  });
  const out = await run({ id: 'pty-ag', cwd: f.work, command: 'claude', args: ['--settings', settings], env: { HIVE_SPAWN_TOKEN: token }, hive: { id: 'ag', name: 'ag' } }, 'claude');
  assert.equal(out.ok, false);
  assert.ok(gone(f.hive, 'pty-ag', token));
});

const wrapper = (context) => vm.runInNewContext(`${transpile(topLevel("spawnAgent"))}; spawnAgent`, context);

test('a spawn that throws before its terminal starts leaves no policy or token behind', async (t) => {
  const f = floor(t);
  let token;
  const spawnAgentCore = async (opts) => { token = await f.prov('ag', opts.id); throw new Error('unexpected'); };
  await assert.rejects(wrapper({ hive: f.hive, spawnAgentCore })({ id: 'pty-ag' }, null), /unexpected/);
  assert.ok(token);
  assert.ok(gone(f.hive, 'pty-ag', token));
});

test('a spawn whose terminal started keeps its policy after the spawn call returns', async (t) => {
  const f = floor(t);
  let token;
  const spawnAgentCore = async (opts) => { token = await f.prov('ag', opts.id); f.hive.spawnStarted(opts.id); return { ok: true }; };
  await wrapper({ hive: f.hive, spawnAgentCore })({ id: 'pty-ag' }, null);
  assert.ok(f.hive.spawnPolicy(token), 'a running spawn is still judged by its own policy');
  assert.equal(denied(await f.write('ag', token, f.own('ag'))), false);
});

function teardown(hive, ptyToAgent) {
  const noop = new Proxy({}, { get: () => () => undefined });
  return vm.runInNewContext(`${transpile(topLevel('teardownPty'))}; teardownPty`, {
    hive, ptyToAgent, liveWorkers: new Map(), worktreePaths: new Map(), worktreeOrigins: new Map(),
    workerExitEvent: () => null, integrationBroker: noop, writeRootsDryRun: noop, workerWake: noop, heavyLock: noop,
    breaker: noop, telemetry: noop, grokLedgerGate: noop, breakerBaseline: noop, syncKeepAwake() {},
    liveWebContents: () => null, console: { error() {}, warn() {}, log() {} },
  });
}

test('a torn-down terminal leaves no policy or token behind, and its token is refused', async (t) => {
  const f = floor(t);
  const token = await f.prov('ag', 'pty-ag');
  f.hive.spawnStarted('pty-ag');
  assert.equal(denied(await f.write('ag', token, f.own('ag'))), false, 'while running, its own folder is allowed');
  teardown(f.hive, new Map([['pty-ag', 'ag']]))('pty-ag');
  assert.ok(gone(f.hive, 'pty-ag', token));
  const r = await f.write('ag', token, f.own('ag'));
  assert.ok(denied(r), 'a stale token is refused');
  assert.equal(r.hookSpecificOutput.permissionDecisionReason, (await f.write('ag', 'f'.repeat(32), f.own('ag'))).hookSpecificOutput.permissionDecisionReason, 'refused as a token the app never issued is');
});

test('retiring twice, or retiring a spawn the app does not know, is harmless', async (t) => {
  const f = floor(t);
  const token = await f.prov('ag', 'pty-ag');
  const other = await f.prov('bg', 'pty-bg');
  const down = teardown(f.hive, new Map([['pty-ag', 'ag']]));
  down('pty-ag');
  down('pty-ag');
  f.hive.withdrawRefusedSpawn('pty-ag', 'again');
  f.hive.spawnSettled('pty-ag');
  down('pty-nobody');
  f.hive.withdrawRefusedSpawn('pty-nobody', 'unknown');
  assert.ok(gone(f.hive, 'pty-ag', token));
  assert.ok(f.hive.spawnPolicy(other), 'another agent\'s spawn is untouched');
});

test('retiring an older spawn of an agent leaves the newer spawn its own policy', async (t) => {
  const f = floor(t);
  const older = await f.prov('ag', 'pty-old');
  f.hive.spawnStarted('pty-old');
  const newer = await f.prov('ag', 'pty-new');
  f.hive.spawnStarted('pty-new');
  teardown(f.hive, new Map([['pty-old', 'ag'], ['pty-new', 'ag']]))('pty-old');
  assert.ok(gone(f.hive, 'pty-old', older));
  assert.ok(f.hive.spawnPolicy(newer), 'the newer spawn keeps its policy');
  assert.equal(denied(await f.write('ag', newer, f.own('ag'))), false, 'and its writes are judged by it');
  assert.ok(denied(await f.write('ag', older, f.own('ag'))), 'the older token is refused');
});

test('a retired token stays refused when its terminal id is used for a later spawn', async (t) => {
  const f = floor(t);
  const older = await f.prov('ag', 'pty-ag');
  f.hive.withdrawRefusedSpawn('pty-ag', 'refused');
  const newer = await f.prov('ag', 'pty-ag');
  assert.notEqual(newer, older);
  assert.equal(f.hive.spawnPolicy(older), undefined, 'the retired token names nothing');
  assert.ok(denied(await f.write('ag', older, f.own('ag'))), 'and its writes are refused');
  assert.equal(denied(await f.write('ag', newer, f.own('ag'))), false, 'the later spawn\'s own token works');
});
