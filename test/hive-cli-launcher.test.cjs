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
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /^usage: hive /);

  // HIVE_ROOT, when set, still wins.
  const other = path.join(home, 'other-hive');
  fs.mkdirSync(other);
  const elsewhere = spawnSync(launcher, ['tasks', 'add', '--json', '{"id":"x"}'], { env: { ...env, HIVE_ROOT: other }, encoding: 'utf8' });
  assert.equal(elsewhere.status, 0, elsewhere.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(other, 'tasks.json'), 'utf8')).tasks.map((c) => c.id), ['x']);
});

test('bin/hive works in a hive whose path holds a space, quotes, $ and a backtick', { skip: !POSIX }, async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'md-hive-launcher-'));
  t.after(async () => { await allCommitsIdle(); fs.rmSync(base, { recursive: true, force: true }); });
  // Unquoted, or in double quotes, "$HOME" would expand to the HOME below and `x` would run.
  const home = path.join(base, 'it\'s "a" $HOME `x` dir');
  fs.mkdirSync(home);
  const hive = new HiveManager(() => home);
  const bundle = path.join(home, 'build', 'hiveCli.js');
  await buildHiveCliBundle(bundle);
  hive.hiveCliBundlePath = () => bundle;
  hive.ensureHive();
  const root = hive.root();
  const launcher = path.join(root, 'bin', 'hive');

  const env = { PATH: '/usr/bin:/bin', HOME: path.join(base, 'elsewhere') };
  const added = spawnSync(launcher, ['tasks', 'add', '--json', '{"id":"odd-path"}'], { cwd: os.tmpdir(), env, encoding: 'utf8' });
  assert.equal(added.status, 0, added.stderr);
  assert.equal(added.stdout, 'added odd-path\n');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'tasks.json'), 'utf8')).tasks.map((c) => c.id), ['odd-path']);
  assert.deepEqual(fs.readdirSync(base).sort(), ['it\'s "a" $HOME `x` dir'], 'nothing was created beside the hive');
});

test('installedHelpers lists bin/hive with the bytes ensureHive wrote, so the canary can compare it', { skip: !POSIX }, (t) => {
  const { hive } = floor(t);
  hive.ensureHive();
  const entry = hive.installedHelpers().find((h) => h.name === 'hive');
  assert.ok(entry, 'bin/hive is listed');
  assert.equal(entry.path, path.join(hive.root(), 'bin', 'hive'));
  assert.equal(entry.expected, fs.readFileSync(entry.path, 'utf8'));
});

test('a symlink planted at bin/hive is replaced, and the file it points to is left alone', { skip: !POSIX }, (t) => {
  const { home, hive } = floor(t);
  hive.ensureHive();
  const launcher = path.join(hive.root(), 'bin', 'hive');
  const victim = path.join(home, 'not-the-hive.txt');
  fs.writeFileSync(victim, 'not a launcher\n', { mode: 0o600 });
  fs.rmSync(launcher);
  fs.symlinkSync(victim, launcher);

  hive.ensureHive();

  assert.equal(fs.readFileSync(victim, 'utf8'), 'not a launcher\n', 'the link target keeps its content');
  assert.equal(fs.statSync(victim).mode & 0o777, 0o600, 'and its mode');
  const st = fs.lstatSync(launcher);
  assert.ok(st.isFile(), 'bin/hive is a regular file again');
  assert.equal(st.mode & 0o777, 0o755);
  assert.match(fs.readFileSync(launcher, 'utf8'), /^#!\/bin\/sh\n/);
  assert.deepEqual(fs.readdirSync(path.dirname(launcher)).filter((f) => f.startsWith('.hive')), [], 'no temporary file is left');
});
