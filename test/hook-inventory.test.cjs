'use strict';
/**
 * Every Claude or Codex spawn writes one hook-inventory row: how many hooks each settings source gives the seat, and a
 * digest over them.
 *
 * Hooks run outside the seat's sandbox, from several sources: the app's own generated settings, the owner's user
 * settings, managed settings, and (for Claude, unless dropped) the working folder's project and local files; for Codex,
 * the app's generated hooks and the owner's own config. The row says how many come from each, so a hook appearing from
 * a source nobody expected shows, and its digest (over source, event and a hash of each command) stays the same across
 * spawns until a hook changes. It carries classes and counts only, never a command, a path or file content, and a
 * source that cannot be read is counted as null, never a thrown spawn.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { codexTestBase, jailHome } = require('./codex-test-home.cjs');
const { withSeatSettings } = require('./seat-settings-dir.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const { sanitize } = loadTs('src/core/usageLog.ts');

const PROSE = 'a heron stood very still in the shallow green water of the millpond';
const hookFile = (event, command) => JSON.stringify({ hooks: { [event]: [{ matcher: 'Bash', hooks: [{ type: 'command', command }] }] } });

function floor(t, provider = 'claude') {
  const base = codexTestBase(t, 'mdhi-');
  const home = path.join(base, 'home');
  const harness = path.join(base, 'h');
  const work = path.join(base, 'work');
  for (const d of [path.join(home, '.claude'), path.join(home, '.codex'), harness, path.join(work, '.claude')]) fs.mkdirSync(d, { recursive: true });
  jailHome(t, home);
  const runtime = fs.realpathSync(fs.mkdtempSync('/tmp/mdhir-'));
  t.after(() => fs.rmSync(runtime, { recursive: true, force: true }));
  const hive = withSeatSettings(new HiveManager(() => harness));
  hive.setHookRuntime(runtime);
  t.after(() => hive.setHookRuntime(null));
  // No machine-wide settings on the test machine decide the counts.
  hive.managedClaudeSettings = path.join(base, 'managed', 'managed-settings.json');
  const rows = [];
  hive.setUsageSink((row) => rows.push(row));
  hive.ensureHive();
  return { base, home, harness, work, hive, rows, provider, root: path.join(harness, 'hive') };
}

const spawn = (f, id, opts = {}) => f.hive.ensureAgent({ id, name: id, provider: f.provider, cwd: f.work }, { spawnId: `pty-${id}-${Math.random()}`, ...opts });
const inventory = (f) => f.rows.filter((r) => r.kind === 'hook-inventory');
const counts = (row) => Object.fromEntries(row.sources.map((s) => [s.source, s.count]));
/** Hook entries in a Claude settings object, counted here from the file the seat was given. */
const appHooks = (args) => {
  const s = JSON.parse(fs.readFileSync(args[args.indexOf('--settings') + 1], 'utf8'));
  return Object.values(s.hooks ?? {}).flatMap((groups) => groups.flatMap((g) => g.hooks)).length;
};

test('a Claude seat: the app\'s hooks, a user hook and a project hook are each counted under their source', async (t) => {
  const f = floor(t);
  fs.writeFileSync(path.join(f.home, '.claude', 'settings.json'), hookFile('PreToolUse', 'user-hook'));
  fs.writeFileSync(path.join(f.work, '.claude', 'settings.json'), hookFile('Stop', 'project-hook'));
  const { args } = await spawn(f, 'c1');
  const [row] = inventory(f);
  assert.equal(inventory(f).length, 1, 'one row per spawn');
  assert.equal(row.agentId, 'c1');
  assert.equal(row.provider, 'claude');
  assert.ok(appHooks(args) > 0, 'the app generated hooks');
  assert.deepEqual(counts(row), { app: appHooks(args), user: 1, managed: 0, project: 1, local: 0 });
  assert.match(row.digest, /^[0-9a-f]{64}$/);

  // Dropped project sources are not counted.
  await spawn(f, 'c2', { scopedRoots: true });
  assert.deepEqual(Object.keys(counts(inventory(f)[1])).sort(), ['app', 'managed', 'user']);
});

test('a Codex seat: the app\'s hooks and one owner hook', async (t) => {
  const f = floor(t, 'codex');
  fs.writeFileSync(path.join(f.home, '.codex', 'config.toml'), '[[hooks.Stop]]\nmatcher = "x"\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "owner-hook"\n');
  const inj = await spawn(f, 'x1');
  const generated = fs.readFileSync(path.join(inj.env.CODEX_HOME, 'config.toml'), 'utf8').split('auto-generated; do not edit')[1];
  const appCount = (generated.match(/^\[\[hooks\.\w+\.hooks\]\]$/gm) ?? []).length;
  assert.ok(appCount > 0);
  const rows = inventory(f);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].provider, 'codex');
  assert.deepEqual(counts(rows[0]), { app: appCount, owner: 1 });
});

test('the digest is the same on a respawn, and changes when a hook changes', async (t) => {
  const f = floor(t);
  const user = path.join(f.home, '.claude', 'settings.json');
  fs.writeFileSync(user, hookFile('PreToolUse', 'user-hook'));
  await spawn(f, 'd1');
  await spawn(f, 'd1');
  fs.writeFileSync(user, hookFile('PreToolUse', 'user-hook --changed'));
  await spawn(f, 'd1');
  fs.writeFileSync(user, hookFile('PostToolUse', 'user-hook --changed'));
  await spawn(f, 'd1');
  const [a, b, c, d] = inventory(f).map((r) => r.digest);
  assert.equal(b, a, 'nothing changed');
  assert.notEqual(c, b, 'a command changed');
  assert.notEqual(d, c, 'an event changed');
  assert.deepEqual(counts(inventory(f)[2]), counts(inventory(f)[0]), 'same counts, different digest');
});

test('the row passes the usage log allowlist and carries no command, path or file text', async (t) => {
  const f = floor(t);
  fs.writeFileSync(path.join(f.home, '.claude', 'settings.json'), hookFile('PreToolUse', PROSE));
  fs.writeFileSync(path.join(f.work, '.claude', 'settings.json'), hookFile('Stop', `echo ${PROSE}`));
  fs.writeFileSync(path.join(f.work, '.claude', 'settings.local.json'), JSON.stringify({ hooks: { [PROSE]: [{ hooks: [{ type: 'command', command: PROSE }] }] } }));
  await spawn(f, 'q1');
  const [row] = inventory(f);
  assert.deepEqual(sanitize(row, { isAgent: (id) => id === 'q1', isCard: () => false }), row, 'written as it is');
  const text = JSON.stringify(f.rows);
  for (const s of ['heron', f.work, f.home, f.base, 'cth-hook', 'hive-node']) assert.equal(text.includes(s), false, s);
  assert.equal(sanitize({ ...row, sources: [{ source: 'user', count: 1, command: PROSE }] }, { isAgent: () => true, isCard: () => false }), null, 'a source carrying anything else is refused');
  assert.equal(sanitize({ ...row, sources: [{ source: PROSE, count: 1 }] }, { isAgent: () => true, isCard: () => false }), null, 'only known source classes');
  assert.equal(sanitize({ ...row, digest: PROSE }, { isAgent: () => true, isCard: () => false }), null, 'a digest is 64 hex characters');
});

test('a source that cannot be read is counted as null, and the spawn goes on', async (t) => {
  const f = floor(t);
  // Read by the CLI's roots check as valid (no roots), but its hooks cannot be understood.
  fs.writeFileSync(path.join(f.home, '.claude', 'settings.json'), JSON.stringify({ hooks: 'not a table' }));
  // A local file whose hooks have the wrong shape.
  fs.writeFileSync(path.join(f.work, '.claude', 'settings.local.json'), JSON.stringify({ hooks: { Stop: 'x' } }));
  const { args } = await spawn(f, 'e1');
  assert.ok(args.includes('--settings'), 'the spawn went on');
  const c = counts(inventory(f)[0]);
  assert.equal(c.user, null);
  assert.equal(c.local, null);
  assert.equal(c.project, 0, 'a missing file is none, not unreadable');
});

test('a source file that is a folder, a pipe or a link reads as null, without blocking or following it', { skip: process.platform === 'win32' }, (t) => {
  const { claudeFileHooks, hookInventoryRow } = loadTs('src/core/hookInventory.ts');
  const base = codexTestBase(t, 'mdhiu-');
  const ok = path.join(base, 'ok.json');
  fs.writeFileSync(ok, hookFile('Stop', 'x'));
  const folder = path.join(base, 'folder.json');
  fs.mkdirSync(folder);
  const pipe = path.join(base, 'pipe.json');
  require('node:child_process').execFileSync('mkfifo', [pipe]);
  const link = path.join(base, 'link.json');
  fs.symlinkSync(ok, link);
  assert.equal(claudeFileHooks([ok]).length, 1);
  assert.deepEqual(claudeFileHooks([path.join(base, 'missing.json')]), []);
  for (const f of [folder, pipe, link]) assert.equal(claudeFileHooks([ok, f]), null, path.basename(f));
  const row = hookInventoryRow('a', 'claude', [{ source: 'user', hooks: null }, { source: 'app', hooks: [] }]);
  assert.deepEqual(row.sources, [{ source: 'user', count: null }, { source: 'app', count: 0 }]);
});
