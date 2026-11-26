'use strict';

// The hive installs `<root>/bin/hive`, a sh launcher that runs the hive command
// bundle (out/main/hiveCli.js) through `<root>/bin/hive-node`, the bundled-node
// launcher, so an agent can run `<root>/bin/hive tasks …` whatever node it has.
// It is listed in installedHelpers so the helpers canary compares it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');
const { allCommitsIdle } = loadTs('src/core/hiveCommit.ts');
const { HiveManager } = loadTs('src/main/hive.ts');
const { buildHiveCliBundle } = loadTs('electron.vite.config.ts');

const POSIX = process.platform !== 'win32';

function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-hive-launcher-'));
  t.after(async () => { await allCommitsIdle(); fs.rmSync(home, { recursive: true, force: true }); });
  return { home, hive: new HiveManager(() => home) };
}

test('ensureHive installs bin/hive, which runs the hive command on this hive with the bundled node', { skip: !POSIX }, async (t) => {
  const { home, hive } = floor(t);
  const bundle = path.join(home, 'build', 'hiveCli.js');
  await buildHiveCliBundle(bundle);
  // Where the app's own build puts the bundle; here, the one just built.
  hive.hiveCliBundlePath = () => bundle;
  hive.ensureHive();
  const root = hive.root();
  const launcher = path.join(root, 'bin', 'hive');

  assert.equal(fs.statSync(launcher).mode & 0o777, 0o755);
  const text = fs.readFileSync(launcher, 'utf8');
  assert.match(text, /^#!\/bin\/sh\n/);
  assert.ok(text.includes(path.join(root, 'bin', 'hive-node')), 'it runs the bundle through the hive-node launcher');

  // Run from elsewhere, with a bare PATH and no HIVE_ROOT: the launcher knows its hive.
  const env = { PATH: '/usr/bin:/bin', HOME: home };
  const added = spawnSync(launcher, ['tasks', 'add', '--json', '{"id":"from-launcher","title":"T"}'], { cwd: os.tmpdir(), env, encoding: 'utf8' });
  assert.equal(added.status, 0, added.stderr);
  assert.equal(added.stdout, 'added from-launcher\n');
  const cards = JSON.parse(fs.readFileSync(path.join(root, 'tasks.json'), 'utf8')).tasks;
  assert.deepEqual(cards.map((c) => c.id), ['from-launcher']);

  const help = spawnSync(launcher, ['--help'], { env, encoding: 'utf8' });
  assert.equal(help.status, 2);
  assert.match(help.stderr, /^usage: hive /);

  // HIVE_ROOT, when set, still wins.
  const other = path.join(home, 'other-hive');
  fs.mkdirSync(other);
  const elsewhere = spawnSync(launcher, ['tasks', 'add', '--json', '{"id":"x"}'], { env: { ...env, HIVE_ROOT: other }, encoding: 'utf8' });
  assert.equal(elsewhere.status, 0, elsewhere.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(other, 'tasks.json'), 'utf8')).tasks.map((c) => c.id), ['x']);
});

test('installedHelpers lists bin/hive with the bytes ensureHive wrote, so the canary can compare it', { skip: !POSIX }, (t) => {
  const { hive } = floor(t);
  hive.ensureHive();
  const entry = hive.installedHelpers().find((h) => h.name === 'hive');
  assert.ok(entry, 'bin/hive is listed');
  assert.equal(entry.path, path.join(hive.root(), 'bin', 'hive'));
  assert.equal(entry.expected, fs.readFileSync(entry.path, 'utf8'));
});
