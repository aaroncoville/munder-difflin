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

test('flag on: an allow rule for any file-writing tool outside the seat\'s roots refuses the spawn, as Edit does', async (t) => {
  const f = floor(t);
  const other = f.A('other');
  // Listed here by hand, not imported: dropping a tool from the module's list must fail this test.
  for (const [i, tool] of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].entries()) {
    f.user({ permissions: { allow: [`${tool}(/${other}/**)`] } });
    await assert.rejects(f.spawn(`w${i}`, true), refusedFor(f, 'user settings', `permissions.allow ${tool}`), tool);
    f.user({ permissions: { allow: [tool] } });
    await assert.rejects(f.spawn(`b${i}`, true), refusedFor(f, 'user settings', `permissions.allow ${tool}`), `bare ${tool}`);
  }
});

test('flag on: a permissions allow, ask or deny list that is not a list of text refuses the spawn, rather than being skipped', async (t) => {
  const f = floor(t);
  const cases = [
    { allow: [`Edit(/${f.A('other')}/**)`, 5] },
    { allow: 'Edit' },
    { ask: [null] },
    { deny: { Bash: true } },
  ];
  for (const [i, permissions] of cases.entries()) {
    f.user({ permissions });
    await assert.rejects(f.spawn(`l${i}`, true), (e) => e instanceof ScopedRootsRefused && /user settings \(could not be understood/.test(e.message), JSON.stringify(permissions));
  }
});

test('the Claude file-writing tools the admission reads include every Claude write tool the gate protects', () => {
  const { CLAUDE_FILE_WRITE_TOOLS } = loadTs('src/core/launchLine.ts');
  const { PROTECTED_WRITE_TOOLS } = loadTs('src/core/writeRoots.ts');
  const claudeOnes = PROTECTED_WRITE_TOOLS.filter((x) => x !== 'apply_patch'); // apply_patch is Codex's
  for (const tool of [...claudeOnes, 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']) assert.ok(CLAUDE_FILE_WRITE_TOOLS.includes(tool), tool);
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
