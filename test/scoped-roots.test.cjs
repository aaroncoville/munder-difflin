'use strict';
/**
 * Scoped write roots for Claude and Codex seats (the scopedRoots setting).
 *
 * Every sandboxed seat was given the whole hive folder as a write root, so any agent could rewrite another agent's
 * mail, the task list or the hive config. With the setting on, a seat gets only the roots its role needs, from the
 * same model the dry run reports with (writeRoots.ts): an agent its own folder, `evidence/` and a working folder
 * outside the hive; god the hive and its working folder. Explicit grants (the shared memory folder) are kept. The
 * same set goes to Claude's sandbox and directories and to Codex's writable roots, and a root the owner's Codex config
 * would add is not carried into the seat's config. Off (the default), nothing changes.
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
const { parse: parseToml } = require('smol-toml');

function floor(t) {
  const base = codexTestBase(t, 'mdscr-');
  jailHome(t, base);
  const harness = path.join(base, 'h');
  const work = path.join(base, 'work');
  const palace = path.join(harness, 'palace');
  for (const d of [harness, work, palace]) fs.mkdirSync(d, { recursive: true });
  const hive = withSeatSettings(new HiveManager(() => harness));
  // The app's own hook runtime folder, outside the hive, as the app sets one at start.
  const runtime = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mdscr-rt-')));
  t.after(async () => removeDir(runtime));
  hive.setHookRuntime(runtime);
  hive.ensureHive();
  const root = hive.root();
  return { base, harness, work, palace, hive, root, agentDir: (id) => path.join(root, 'agents', id) };
}

const settingsOf = (inj) => JSON.parse(fs.readFileSync(inj.args[inj.args.indexOf('--settings') + 1], 'utf8'));
const addDirs = (args) => args.flatMap((a, i) => (a === '--add-dir' ? [args[i + 1]] : []));
const codexConfig = (inj) => fs.readFileSync(path.join(inj.env.CODEX_HOME, 'config.toml'), 'utf8');

function claude(f, id, { scopedRoots, isGod = false, cwd = f.work } = {}) {
  return f.hive.ensureAgent({ id, name: id, provider: 'claude', cwd, isGod }, {
    spawnId: `pty-${id}`, extraWritableDirs: [f.palace], ...(scopedRoots === undefined ? {} : { scopedRoots }),
  });
}
function codex(f, id, { scopedRoots, cwd = f.work } = {}) {
  return f.hive.ensureAgent({ id, name: id, provider: 'codex', cwd }, {
    spawnId: `pty-${id}`, extraWritableDirs: [f.palace], ...(scopedRoots === undefined ? {} : { scopedRoots }),
  });
}

test('flag off: a Claude seat keeps its folder, the hive root and the explicit grant, as before', async (t) => {
  const f = floor(t);
  for (const [id, scopedRoots] of [['off0', undefined], ['off1', false]]) {
    const inj = await claude(f, id, { scopedRoots });
    const s = settingsOf(inj);
    assert.deepEqual(s.sandbox, { enabled: true, filesystem: { allowWrite: [f.agentDir(id), f.root, f.palace] } }, id);
    assert.deepEqual(s.permissions, { additionalDirectories: [f.agentDir(id), f.root, f.palace] }, id);
    assert.equal(fs.existsSync(path.join(f.root, 'evidence')), false, 'no folder is made with the flag off');
  }
});

test('flag off: a Codex seat\'s roots and config are as before, the owner\'s own roots kept after the app\'s', async (t) => {
  const f = floor(t);
  const other = f.agentDir('someone-else');
  fs.mkdirSync(path.join(f.base, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(f.base, '.codex', 'config.toml'), `[sandbox_workspace_write]\nwritable_roots = [${JSON.stringify(other)}]\n`);
  const inj = await codex(f, 'coff', { scopedRoots: false });
  const want = [f.agentDir('coff'), f.root, f.palace];
  assert.deepEqual(addDirs(inj.args), want);
  const toml = codexConfig(inj);
  assert.ok(toml.includes(`[sandbox_workspace_write]\nwritable_roots = [${want.map((p) => JSON.stringify(p)).join(', ')}, ${JSON.stringify(other)}]\n`), toml);
});

test('flag on: an agent\'s Claude roots are its folder, evidence/, an outside working folder and the grant, never the hive root', async (t) => {
  const f = floor(t);
  const inj = await claude(f, 'ag1', { scopedRoots: true });
  const s = settingsOf(inj);
  const want = [f.agentDir('ag1'), path.join(f.root, 'evidence'), f.work, f.palace];
  assert.deepEqual(s.sandbox.filesystem.allowWrite, want);
  assert.deepEqual(s.permissions.additionalDirectories, want);
  assert.equal(s.sandbox.enabled, true);
  for (const r of [...s.sandbox.filesystem.allowWrite, ...s.permissions.additionalDirectories]) {
    assert.notEqual(path.resolve(r), path.resolve(f.root), 'the hive root is not a root');
  }
  assert.ok(fs.lstatSync(path.join(f.root, 'evidence')).isDirectory(), 'evidence/ exists, so the grant names a real folder');
});

test('flag on: a working folder inside the hive is not granted on its own', async (t) => {
  const f = floor(t);
  const inside = path.join(f.root, 'research');
  fs.mkdirSync(inside, { recursive: true });
  const s = settingsOf(await claude(f, 'ag2', { scopedRoots: true, cwd: inside }));
  assert.deepEqual(s.sandbox.filesystem.allowWrite, [f.agentDir('ag2'), path.join(f.root, 'evidence'), f.palace]);
});

test('flag on: god\'s Claude roots are its working folder and the hive root', async (t) => {
  const f = floor(t);
  // God works from the folder that holds the hive, above it, on purpose.
  const s = settingsOf(await claude(f, 'god1', { scopedRoots: true, isGod: true, cwd: f.harness }));
  assert.deepEqual(s.sandbox.filesystem.allowWrite, [f.harness, f.root, f.palace]);
  assert.deepEqual(s.permissions.additionalDirectories, [f.harness, f.root, f.palace]);
});

test('flag on: a Codex agent\'s writable roots are the scoped set, and a root the owner\'s config adds is not kept', async (t) => {
  const f = floor(t);
  const other = f.agentDir('someone-else');
  fs.mkdirSync(path.join(f.base, '.codex'), { recursive: true });
  // Multi-line, commented, the way an owner writes it by hand.
  fs.writeFileSync(path.join(f.base, '.codex', 'config.toml'),
    `model = "m"\n\n[sandbox_workspace_write]\nnetwork_access = true\nwritable_roots = [\n  ${JSON.stringify(other)}, # mail\n  ${JSON.stringify(f.root)},\n]\n`);
  const inj = await codex(f, 'cag', { scopedRoots: true });
  const want = [f.agentDir('cag'), path.join(f.root, 'evidence'), f.work, f.palace];
  assert.deepEqual(addDirs(inj.args), want);
  const doc = parseToml(codexConfig(inj));
  assert.deepEqual(doc.sandbox_workspace_write.writable_roots, want);
  assert.equal(doc.sandbox_workspace_write.network_access, true, 'the rest of the owner\'s table is kept');
  assert.equal(doc.model, 'm');
});

test('flag on: an owner\'s Codex roots in a form that cannot be rewritten refuse the spawn rather than be kept', async (t) => {
  const f = floor(t);
  fs.mkdirSync(path.join(f.base, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(f.base, '.codex', 'config.toml'), `sandbox_workspace_write = { writable_roots = [${JSON.stringify(f.agentDir('x'))}] }\n`);
  await assert.rejects(codex(f, 'cin', { scopedRoots: true }), /writable roots/);
});

test('replacing the owner\'s roots: a bracket inside a quoted root or a comment does not end the list early', () => {
  const { withOnlyCodexWritableRoots } = loadTs('src/shared/codexWritableRoots.ts');
  const user = `[sandbox_workspace_write]\nwritable_roots = [ "/odd]name", # ] not the end\n  '/lit]eral' ]\nnetwork_access = false\n`;
  const out = withOnlyCodexWritableRoots(user, ['/mine']);
  assert.deepEqual({ ...parseToml(out).sandbox_workspace_write }, { writable_roots: ['/mine'], network_access: false });
  assert.equal(out.includes('odd]name'), false, out);
});

test('replacing the owner\'s roots: a config with none gains exactly the seat\'s, as without the flag', () => {
  const { withOnlyCodexWritableRoots, withCodexWritableRoots } = loadTs('src/shared/codexWritableRoots.ts');
  for (const user of ['model = "m"\n', '[sandbox_workspace_write]\nnetwork_access = true\n']) {
    assert.equal(withOnlyCodexWritableRoots(user, ['/a', '/b']), withCodexWritableRoots(user, ['/a', '/b']));
  }
});

test('a resumed Codex home is written with the scoped roots its agent\'s provisioning decided', async (t) => {
  const f = floor(t);
  const inj = await codex(f, 'cres', { scopedRoots: true });
  const home = inj.env.CODEX_HOME;
  fs.writeFileSync(path.join(home, 'config.toml'), '');
  f.hive.prepareResumedCodexHome('cres', f.work, home, [f.palace], 'pty-cres');
  assert.deepEqual(parseToml(codexConfig(inj)).sandbox_workspace_write.writable_roots, [f.agentDir('cres'), path.join(f.root, 'evidence'), f.work, f.palace]);
  assert.deepEqual(f.hive.spawnScope('pty-cres'), { scoped: true, isGod: false, grants: [f.palace] });
});
