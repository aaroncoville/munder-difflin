'use strict';
/**
 * No agent's write roots may reach a folder the app keeps for itself.
 *
 * Main trusts what it finds in its own data folder: the hook runtime it stages,
 * the settings files of its helper sessions, its config and databases. An agent
 * whose working folder or extra writable root is one of those folders (or the
 * data folder itself) could forge files there. Each module registers the private
 * folder it chooses; admission refuses any agent whose roots contain, equal or lie
 * inside a registered folder, before its folder or registry row exists.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { codexTestBase, jailHome } = require('./codex-test-home.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const { setHelperSettingsDir } = loadTs('src/main/hiddenClaude.ts');
let registry = null;
try { registry = loadTs('src/main/privateDirs.ts'); } catch { /* none yet */ }
const needRegistry = () => { if (!registry) assert.fail('there is no registry of the app\'s private folders'); return registry; };

/** HOME, the hive and the working folders are outside the app's data folder, as on a real machine. */
function floor(t, { runtimeOutside = false } = {}) {
  const base = codexTestBase(t, 'mdpd-');
  const home = path.join(base, 'home');
  const userData = path.join(base, 'apps', 'ud');
  const harness = path.join(base, 'h');
  const work = path.join(base, 'work', 'repo');
  for (const d of [home, userData, harness, work]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  jailHome(t, home);
  const hive = new HiveManager(() => harness);
  // What the app does at start: its data folder is covered, and each module registers the folder it chooses.
  const off = [];
  if (registry) off.push(registry.registerPrivateDir(userData, 'the app data folder'));
  // On Windows the hook runtime lives in Local AppData, outside the data folder.
  const hookRuntime = runtimeOutside ? path.join(base, 'localappdata', 'munder-difflin-hooks') : path.join(userData, 'hook-runtime');
  hive.setHookRuntime(hookRuntime);
  const helper = path.join(userData, 'helper-sessions');
  setHelperSettingsDir(helper, () => hive.root());
  t.after(() => { for (const f of off) f?.(); setHelperSettingsDir(null, () => null); hive.setHookRuntime(null); });
  hive.ensureHive();
  return { base, home, userData, harness, work, hive, hookRuntime, helper };
}

const launch = (provider, dir) => provider === 'claude'
  ? { argv: ['claude', '--settings', path.join(dir, 'settings.json')], env: {} }
  : { argv: ['codex -a never -s workspace-write'], env: {} };

async function refusedBeforeAnything(f, id, provider, opts, folder) {
  const dir = path.join(f.harness, 'hive', 'agents', id);
  await assert.rejects(
    f.hive.ensureAgent({ id, name: id, provider, cwd: opts.cwd ?? f.work }, { launch: launch(provider, dir), spawnId: `pty-${id}`, extraWritableDirs: opts.extra }),
    (e) => { assert.ok(e.message.includes(folder), `the reason names ${folder}: ${e.message}`); return true; },
    `${id}`
  );
  assert.equal(fs.existsSync(dir), false, `${id}: no agent folder`);
  assert.equal(Object.hasOwn(f.hive.registry().agents, id), false, `${id}: no registry row`);
}

for (const [which, layout] of [['helper', {}], ['userData', { runtimeOutside: true }], ['hookRuntime', {}]]) {
  test(`an agent rooted at the ${which} folder is refused, naming it, before anything is created`, async (t) => {
    const f = floor(t, layout);
    const folder = f[which];
    fs.mkdirSync(folder, { recursive: true });
    for (const provider of ['claude', 'codex']) {
      await refusedBeforeAnything(f, `${which}-cwd-${provider}`, provider, { cwd: folder }, folder);
      await refusedBeforeAnything(f, `${which}-extra-${provider}`, provider, { extra: [folder] }, folder);
    }
  });
}

test('a root inside a private folder, or one that contains it, is refused', async (t) => {
  const f = floor(t, { runtimeOutside: true });
  fs.mkdirSync(path.join(f.helper, 'sub'), { recursive: true });
  await refusedBeforeAnything(f, 'inside', 'claude', { extra: [path.join(f.helper, 'sub')] }, path.join(f.helper, 'sub'));
  // The data folder's parent holds every private folder.
  await refusedBeforeAnything(f, 'contains', 'codex', { extra: [path.dirname(f.userData)] }, path.dirname(f.userData));
});

test('today\'s floor still starts: Claude and Codex agents in worktrees, the orchestrator, a worker', async (t) => {
  const f = floor(t);
  const dir = (id) => path.join(f.harness, 'hive', 'agents', id);
  await f.hive.ensureAgent({ id: 'cl', name: 'cl', provider: 'claude', cwd: f.work }, { launch: launch('claude', dir('cl')), spawnId: 'pty-cl' });
  await f.hive.ensureAgent({ id: 'cx', name: 'cx', provider: 'codex', cwd: f.work }, { launch: launch('codex'), spawnId: 'pty-cx' });
  await f.hive.ensureAgent({ id: 'god', name: 'god', provider: 'claude', cwd: f.harness, isGod: true }, { launch: launch('claude', dir('god')), spawnId: 'pty-god' });
  await f.hive.ensureAgent({ id: 'worker-1', name: 'w', provider: 'codex', cwd: f.work }, { launch: { argv: ['codex --model gpt-5 -a never -s workspace-write', 'do the task'], env: {} }, spawnId: 'pty-w' });
  for (const id of ['cl', 'cx', 'god', 'worker-1']) assert.equal(Object.hasOwn(f.hive.registry().agents, id), true, id);
});

test('a folder registered later is covered from then on', async (t) => {
  const { registerPrivateDir } = needRegistry();
  const f = floor(t);
  const ledger = path.join(f.userData, '..', 'ledger');
  fs.mkdirSync(ledger, { recursive: true });
  const real = fs.realpathSync(ledger);
  const off = registerPrivateDir(real, 'a test ledger');
  await refusedBeforeAnything(f, 'later', 'claude', { cwd: real }, real);
  off();
  await f.hive.ensureAgent({ id: 'after', name: 'a', provider: 'claude', cwd: real }, { launch: launch('claude', path.join(f.harness, 'hive', 'agents', 'after')), spawnId: 'pty-after' });
});

test('the app registers its data folder at start', () => {
  const sa = require('./source-assert.cjs');
  const src = sa.activeSource('src/main/index.ts');
  assert.match(src, /registerPrivateDir\(app\.getPath\('userData'\),/);
});
