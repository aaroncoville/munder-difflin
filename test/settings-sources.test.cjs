'use strict';
/**
 * Which Claude setting sources a seat loads, and a count of what dropping the project ones would drop.
 *
 * A Claude seat merges <cwd>/.claude/settings.json and settings.local.json, which any agent working in that folder can
 * write. With the scopedRoots setting on, the app launches Claude seats with `--setting-sources user`: the owner's
 * user settings and the app's generated --settings file stay, the project and local files are not loaded. The launch
 * model treats exactly that value as known (any other --setting-sources stays unknown), and the dry run's roots leave
 * the project files out. Off (the default) nothing changes. On every Claude spawn either way, one usage row counts how
 * many of the two project files exist (checked with lstat, never read), so the effect is known before it is turned on.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { codexTestBase, jailHome } = require('./codex-test-home.cjs');
const { withSeatSettings } = require('./seat-settings-dir.cjs');

// config.ts reads the app's data folder through electron: a throwaway one here.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-sources-cfg-'));
const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { app: { getPath: () => userData } } };
test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

const { HiveManager } = loadTs('src/main/hive.ts');
const { claudeLaunch } = loadTs('src/main/launchLine.ts');
const W = loadTs('src/main/writeRoots.ts');
const { sanitize } = loadTs('src/main/usageLog.ts');
const { readConfig } = loadTs('src/main/config.ts');

const PROSE = 'the quick brown fox jumps over a lazy dog near the riverbank at dusk';

function floor(t) {
  const base = codexTestBase(t, 'mdsrc-');
  const home = path.join(base, 'home');
  const harness = path.join(base, 'h');
  const work = path.join(base, 'work');
  for (const d of [home, harness, path.join(work, '.claude')]) fs.mkdirSync(d, { recursive: true });
  jailHome(t, home);
  const hive = withSeatSettings(new HiveManager(() => harness));
  const rows = [];
  hive.setUsageSink((row) => rows.push(row));
  hive.ensureHive();
  return { base, home, harness, work, hive, rows, root: path.join(harness, 'hive') };
}

const spawn = (f, id, scopedRoots) => f.hive.ensureAgent({ id, name: id, provider: 'claude', cwd: f.work }, { spawnId: `pty-${id}`, ...(scopedRoots === undefined ? {} : { scopedRoots }) });
const sourcesRows = (f) => f.rows.filter((r) => r.kind === 'settings-sources');

test('the scopedRoots setting is off by default', () => {
  assert.equal(readConfig().scopedRoots, false);
});

test('flag off: the launch line is unchanged, and the row counts the project files that exist', async (t) => {
  const f = floor(t);
  const none = await spawn(f, 'a0', false);
  assert.equal(none.args.includes('--setting-sources'), false);
  fs.writeFileSync(path.join(f.work, '.claude', 'settings.json'), JSON.stringify({ note: PROSE }));
  const one = await spawn(f, 'a1');
  assert.equal(one.args.includes('--setting-sources'), false, 'unset reads as off');
  fs.writeFileSync(path.join(f.work, '.claude', 'settings.local.json'), JSON.stringify({ note: PROSE }));
  await spawn(f, 'a2', false);
  assert.deepEqual(sourcesRows(f), [
    { kind: 'settings-sources', agentId: 'a0', provider: 'claude', projectFiles: 0, dropped: false },
    { kind: 'settings-sources', agentId: 'a1', provider: 'claude', projectFiles: 1, dropped: false },
    { kind: 'settings-sources', agentId: 'a2', provider: 'claude', projectFiles: 2, dropped: false },
  ]);
});

test('flag on: Claude seats launch with --setting-sources user, and the roots leave the project files out', async (t) => {
  const f = floor(t);
  const bin = path.join(f.root, 'bin');
  fs.writeFileSync(path.join(f.work, '.claude', 'settings.json'), JSON.stringify({ sandbox: { enabled: true, filesystem: { allowWrite: [bin] } } }));
  fs.writeFileSync(path.join(f.work, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { additionalDirectories: [bin] } }));
  const { args } = await spawn(f, 's1', true);
  const i = args.indexOf('--setting-sources');
  assert.ok(i !== -1, 'the option is on the line');
  assert.equal(args[i + 1], 'user');
  assert.deepEqual(sourcesRows(f), [{ kind: 'settings-sources', agentId: 's1', provider: 'claude', projectFiles: 2, dropped: true }]);

  const generated = args[args.indexOf('--settings') + 1];
  const launch = (extra) => ({ args: ['claude', '--settings', generated, ...extra], platform: 'darwin', env: {}, claudeSettings: generated });
  const dropped = W.effectiveRoots('claude', path.join(f.root, 'agents', 's1'), f.work, f.home, launch(['--setting-sources', 'user']));
  const kept = W.effectiveRoots('claude', path.join(f.root, 'agents', 's1'), f.work, f.home, launch([]));
  assert.equal(dropped.state, 'ok');
  assert.equal(dropped.roots.includes(bin), false, 'the project files are not read');
  assert.ok(kept.roots.includes(bin), 'without the option they are');
});

test('the launch model knows the app\'s --setting-sources user, and no other value', () => {
  const ok = (...a) => claudeLaunch(['claude', '--settings', '/s.json', ...a], '/s.json');
  assert.equal(ok('--setting-sources', 'user'), 'ok');
  assert.equal(ok('--setting-sources=user'), 'ok');
  for (const v of ['user,project', 'project', 'local', 'user,local', 'User', '']) {
    assert.equal(ok('--setting-sources', v), 'unknown', v);
    assert.equal(ok(`--setting-sources=${v}`), 'unknown', `=${v}`);
  }
  assert.equal(ok('--setting-sources'), 'unknown', 'no value');
});

test('the row passes the usage log allowlist and carries no path or file text', async (t) => {
  const f = floor(t);
  fs.writeFileSync(path.join(f.work, '.claude', 'settings.json'), JSON.stringify({ [PROSE]: PROSE }));
  fs.writeFileSync(path.join(f.work, '.claude', 'settings.local.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: PROSE }] }] } }));
  await spawn(f, 'p1', true);
  await spawn(f, 'p2', false);
  const rows = sourcesRows(f);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    const clean = sanitize(row, { isAgent: (id) => id === row.agentId, isCard: () => false });
    assert.deepEqual(clean, row, 'written as it is');
    const text = JSON.stringify(row);
    for (const s of [PROSE, 'quick brown', f.work, f.base, f.root, '.claude', '.json']) assert.equal(text.includes(s), false, s);
  }
  for (const row of f.rows) assert.equal(JSON.stringify(row).includes('quick brown'), false, row.kind);
});
