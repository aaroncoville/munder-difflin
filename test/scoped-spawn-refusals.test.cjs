'use strict';
/**
 * With scoped roots on, a seat whose roots cannot be trusted is refused at spawn.
 *
 * Every agent could write the whole hive before scoped roots, so an agent can have replaced its own folder with a link
 * to another agent's folder, or to the hive root. The spawn granted the folder wherever it pointed, and provisioning
 * wrote the agent's identity and memory through the link. With the setting on, the spawn is now refused when the
 * agent's folder is a link or not a folder, or resolves anywhere but <hive>/agents/<id>. Every root the seat is given,
 * explicit grants included, is resolved before it is granted. With the setting off nothing changes.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { codexTestBase, jailHome, removeDir } = require('./codex-test-home.cjs');
const { withSeatSettings } = require('./seat-settings-dir.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const { ScopedRootsRefused } = loadTs('src/core/writeRoots.ts');

function floor(t) {
  const base = codexTestBase(t, 'mdsr-');
  jailHome(t, base);
  const harness = path.join(base, 'h');
  const work = path.join(base, 'work');
  for (const d of [harness, work]) fs.mkdirSync(d, { recursive: true });
  const hive = withSeatSettings(new HiveManager(() => harness));
  const runtime = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mdsr-rt-')));
  t.after(async () => removeDir(runtime));
  hive.setHookRuntime(runtime);
  hive.ensureHive();
  const root = hive.root();
  const A = (id) => path.join(root, 'agents', id);
  const spawn = (id, provider, scopedRoots, o = {}) => hive.ensureAgent({ id, name: id, provider, cwd: o.cwd ?? work, isGod: o.isGod === true }, { spawnId: `pty-${id}`, scopedRoots, extraWritableDirs: o.extra ?? [] });
  return { base, harness, work, hive, root, A, spawn };
}

const tree = (dir) => fs.readdirSync(dir, { recursive: true }).sort();
const settingsOf = (inj) => JSON.parse(fs.readFileSync(inj.args[inj.args.indexOf('--settings') + 1], 'utf8'));

test('flag on: a seat whose own folder is a link to another agent\'s folder is refused, and nothing is written through it', async (t) => {
  const f = floor(t);
  for (const provider of ['claude', 'codex']) {
    const victim = `victim-${provider}`;
    await f.spawn(victim, 'claude', true);
    const before = tree(f.A(victim));
    fs.symlinkSync(f.A(victim), f.A(`linked-${provider}`));
    await assert.rejects(f.spawn(`linked-${provider}`, provider, true), (e) => e instanceof ScopedRootsRefused && /folder/.test(e.message), provider);
    assert.deepEqual(tree(f.A(victim)), before, `${provider}: nothing written into the other agent's folder`);
  }
});

test('flag on: a seat whose own folder is a link to the hive root, or a file, is refused', async (t) => {
  const f = floor(t);
  fs.symlinkSync(f.root, f.A('toroot'));
  await assert.rejects(f.spawn('toroot', 'claude', true), ScopedRootsRefused);
  fs.writeFileSync(f.A('afile'), 'x');
  await assert.rejects(f.spawn('afile', 'claude', true), ScopedRootsRefused);
});

test('flag on: an explicit grant given as a link is granted where it resolves', async (t) => {
  const f = floor(t);
  const real = path.join(f.harness, 'palace-real');
  fs.mkdirSync(real);
  const link = path.join(f.harness, 'palace');
  fs.symlinkSync(real, link);
  const s = settingsOf(await f.spawn('g1', 'claude', true, { extra: [link] }));
  assert.ok(s.sandbox.filesystem.allowWrite.includes(real), JSON.stringify(s.sandbox.filesystem.allowWrite));
  assert.equal(s.sandbox.filesystem.allowWrite.includes(link), false);
});

test('flag off: a linked own folder and a linked grant are handled as before', async (t) => {
  const f = floor(t);
  await f.spawn('victim', 'claude', false);
  fs.symlinkSync(f.A('victim'), f.A('linked'));
  const link = path.join(f.harness, 'palace');
  fs.mkdirSync(path.join(f.harness, 'palace-real'));
  fs.symlinkSync(path.join(f.harness, 'palace-real'), link);
  const s = settingsOf(await f.spawn('linked', 'claude', false, { extra: [link] }));
  assert.deepEqual(s.sandbox.filesystem.allowWrite, [f.A('linked'), f.root, link]);
});

test('flag on: an agent whose working folder is the hive root, or holds it, is refused; god is not', async (t) => {
  const f = floor(t);
  for (const [id, cwd] of [['inroot', () => f.root], ['above', () => f.harness], ['tilde', () => '~/h']]) {
    await assert.rejects(f.spawn(id, 'claude', true, { cwd: cwd() }), (e) => e instanceof ScopedRootsRefused && /working folder/.test(e.message) && !e.message.includes(f.base), id);
    await assert.rejects(f.spawn(`${id}-cx`, 'codex', true, { cwd: cwd() }), ScopedRootsRefused, `${id} codex`);
  }
  await f.spawn('god', 'claude', true, { cwd: f.harness, isGod: true });
  await f.spawn('fine', 'claude', true, { cwd: f.work });
});

test('flag off: an agent working in the folder that holds the hive starts as before', async (t) => {
  const f = floor(t);
  await f.spawn('above', 'claude', false, { cwd: f.harness });
  await f.spawn('inroot', 'claude', false, { cwd: f.root });
});

test('flag on: an agent whose working folder is inside the hive but not inside its own folder is refused; god is not', async (t) => {
  const f = floor(t);
  await f.spawn('peer', 'claude', true);
  for (const [id, cwd] of [['ev', () => path.join(f.root, 'evidence')], ['evsub', () => path.join(f.root, 'evidence', 'run-1')], ['peerdir', () => f.A('peer')], ['agents', () => path.join(f.root, 'agents')]]) {
    for (const provider of ['claude', 'codex']) {
      await assert.rejects(f.spawn(`${id}-${provider}`, provider, true, { cwd: cwd() }), (e) => e instanceof ScopedRootsRefused && /working folder/.test(e.message) && !e.message.includes(f.base), `${id} ${provider}`);
      assert.equal(Object.hasOwn(f.hive.registry().agents, `${id}-${provider}`), false, `${id} ${provider}: no registry row`);
    }
  }
  await f.spawn('god', 'claude', true, { cwd: path.join(f.root, 'evidence'), isGod: true });
});

test('flag on: an agent working inside its own folder, or outside the hive, starts as before', async (t) => {
  const f = floor(t);
  await f.spawn('own', 'claude', true, { cwd: f.A('own') });
  fs.mkdirSync(path.join(f.A('own'), 'repo'));
  await f.spawn('own', 'claude', true, { cwd: path.join(f.A('own'), 'repo') });
  await f.spawn('own-cx', 'codex', true, { cwd: f.A('own-cx') });
  await f.spawn('outside', 'claude', true, { cwd: f.work });
});

test('flag off: an agent working in another agent\'s folder or evidence/ starts as before', async (t) => {
  const f = floor(t);
  await f.spawn('peer', 'claude', false);
  await f.spawn('peerdir', 'claude', false, { cwd: f.A('peer') });
  fs.mkdirSync(path.join(f.root, 'evidence'), { recursive: true });
  await f.spawn('ev', 'claude', false, { cwd: path.join(f.root, 'evidence') });
});
