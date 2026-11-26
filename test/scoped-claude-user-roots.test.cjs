'use strict';
/**
 * With scoped roots on, a Claude seat is refused when the owner's user or managed settings add a write root outside it.
 *
 * Claude merges the owner's user and managed settings into every seat, and a write root listed there (in
 * sandbox.filesystem.allowWrite, permissions.additionalDirectories, or an Edit(...) allow rule) is added to the seat's
 * sandbox whatever the seat's own settings say: one naming another seat's folder undid the scoping for every seat.
 * With the setting on, such a seat is refused at spawn, saying which settings source and key, never the path. God is
 * judged by the same rule against its own roots. With the setting off nothing changes.
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
  const base = codexTestBase(t, 'mdur-');
  jailHome(t, base);
  const harness = path.join(base, 'h');
  const work = path.join(base, 'work');
  for (const d of [harness, work, path.join(base, '.claude')]) fs.mkdirSync(d, { recursive: true });
  const hive = withSeatSettings(new HiveManager(() => harness));
  const runtime = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mdur-rt-')));
  t.after(async () => removeDir(runtime));
  hive.setHookRuntime(runtime);
  const managed = path.join(base, 'managed', 'managed-settings.json');
  fs.mkdirSync(path.dirname(managed));
  hive.managedClaudeSettings = managed;
  hive.ensureHive();
  const root = hive.root();
  const user = (o) => fs.writeFileSync(path.join(base, '.claude', 'settings.json'), JSON.stringify(o));
  const spawn = (id, scopedRoots, o = {}) => hive.ensureAgent({ id, name: id, provider: 'claude', cwd: o.cwd ?? work, isGod: o.isGod === true }, { spawnId: `pty-${id}`, scopedRoots });
  return { base, harness, work, root, managed, user, spawn, A: (id) => path.join(root, 'agents', id) };
}

const refusedFor = (f, source, key) => (e) => {
  assert.ok(e instanceof ScopedRootsRefused, String(e));
  assert.ok(e.message.includes(`${source}: ${key}`), e.message);
  for (const s of [f.base, f.root, 'other', '/']) if (s !== '/') assert.equal(e.message.includes(s), false, `no path in ${e.message}`);
  return true;
};

test('flag on: a user allowWrite, additionalDirectories or Edit allow rule outside the seat\'s roots refuses the spawn', async (t) => {
  const f = floor(t);
  const other = f.A('other');
  const cases = [
    [{ sandbox: { filesystem: { allowWrite: [other] } } }, 'sandbox.filesystem.allowWrite'],
    [{ permissions: { additionalDirectories: [other] } }, 'permissions.additionalDirectories'],
    [{ permissions: { allow: ['Read', `Edit(/${other}/**)`] } }, 'permissions.allow Edit'],
    [{ permissions: { allow: ['Edit'] } }, 'permissions.allow Edit'],
  ];
  for (const [i, [settings, key]] of cases.entries()) {
    f.user(settings);
    await assert.rejects(f.spawn(`a${i}`, true), refusedFor(f, 'user settings', key), key);
  }
});

test('flag on: the same entry in the managed settings refuses the spawn, naming the managed source', async (t) => {
  const f = floor(t);
  fs.writeFileSync(f.managed, JSON.stringify({ sandbox: { filesystem: { allowWrite: [f.A('other')] } } }));
  await assert.rejects(f.spawn('m1', true), refusedFor(f, 'managed settings', 'sandbox.filesystem.allowWrite'));
});

test('flag on: entries inside the seat\'s roots are allowed', async (t) => {
  const f = floor(t);
  f.user({ sandbox: { filesystem: { allowWrite: [path.join(f.A('in1'), 'scratch')] } }, permissions: { additionalDirectories: [f.work], allow: [`Edit(/${f.work}/**)`, 'Read'] } });
  await f.spawn('in1', true);
});

test('flag on: god is judged against its working folder and the hive root', async (t) => {
  const f = floor(t);
  f.user({ permissions: { additionalDirectories: [path.join(f.root, 'tasks'), f.harness] } });
  await f.spawn('god', true, { cwd: f.harness, isGod: true });
  f.user({ permissions: { additionalDirectories: [f.work] } });
  await assert.rejects(f.spawn('god', true, { cwd: f.harness, isGod: true }), refusedFor(f, 'user settings', 'permissions.additionalDirectories'));
});

test('flag off: the same settings change nothing', async (t) => {
  const f = floor(t);
  f.user({ sandbox: { filesystem: { allowWrite: [f.A('other')] } }, permissions: { additionalDirectories: [f.A('other')], allow: ['Edit'] } });
  await f.spawn('off', false);
  await f.spawn('off2', undefined);
});
