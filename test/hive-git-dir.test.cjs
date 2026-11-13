'use strict';

/**
 * The hive's git directory lives in the app data folder, where no agent can write, so nothing an agent puts in the
 * hive decides what the app's git runs. The first commit moves an existing repository there with its history, an
 * interrupted move finishes, and what an agent could have written is never adopted.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { removeDir } = require('./codex-test-home.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const { hiveGitDirFor } = (() => { try { return loadTs('src/main/hiveGitDir.ts'); } catch { return {}; } })();

const REAL_GIT = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();

function scratch(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'md-hive-gitdir-')));
  t.after(async () => { await removeDir(dir); });
  return { dir, base: path.join(dir, 'userData', 'hive-git'), marker: path.join(dir, 'PLANTED-PROGRAM-RAN') };
}

/** A hive manager as the app sets it up: its git directory in the app data folder. */
async function floor(dir, base) {
  const hive = new HiveManager(() => dir);
  hive.setGitDirBase?.(base);
  await hive.ensureAgent({ id: 'god-1', name: 'Boss', provider: 'claude', cwd: dir, isGod: true });
  await hive.commitsSettled();
  return hive;
}

const git = (cwd, ...args) => spawnSync(REAL_GIT, args, { cwd, encoding: 'utf8' });
const target = (base, root) => (hiveGitDirFor ? hiveGitDirFor(base, root) : path.join(root, '.git'));

/** What an agent could write into a git directory in the hive: a filter driver, an fsmonitor and a hook, all of which
 *  would run `touch <marker>`, plus a .gitattributes that routes every file through the filter. */
function plantInGitDir(gitDir, hiveRoot, marker) {
  // One program for all three: it records that it ran, and passes a filter's input through.
  const program = path.join(path.dirname(marker), 'planted-program.sh');
  fs.writeFileSync(program, `#!/bin/sh\ntouch '${marker}'\ncat\n`, { mode: 0o755 });
  fs.mkdirSync(path.join(gitDir, 'hooks'), { recursive: true });
  fs.appendFileSync(path.join(gitDir, 'config'), `[filter "evil"]\n\tclean = ${program}\n[core]\n\tfsmonitor = ${program}\n`);
  fs.writeFileSync(path.join(gitDir, 'hooks', 'pre-commit'), `#!/bin/sh\n${program} </dev/null\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(hiveRoot, '.gitattributes'), '* filter=evil\n');
}

test('settings an agent planted in the hive repository before the move never run', async (t) => {
  const { dir, base, marker } = scratch(t);
  // An existing hive, from before this change: its repository inside the hive.
  const legacy = new HiveManager(() => dir);
  await legacy.ensureAgent({ id: 'god-1', name: 'Boss', provider: 'claude', cwd: dir, isGod: true });
  await legacy.commitsSettled();
  const root = legacy.root();
  plantInGitDir(path.join(root, '.git'), root, marker);

  const hive = new HiveManager(() => dir);
  hive.setGitDirBase?.(base);
  hive.ensureHive();
  fs.writeFileSync(path.join(root, 'board.md'), '# after the move\n');
  hive.commit('hive: first commit of the new build');
  await hive.commitsSettled();

  assert.equal(fs.existsSync(marker), false, 'a program planted in the hive repository ran');
  assert.equal(git(root, 'show', 'HEAD:board.md').stdout, '# after the move\n');
});

test('a commondir planted in the hive repository before the move cannot point git at another config', async (t) => {
  const { dir, base, marker } = scratch(t);
  const legacy = new HiveManager(() => dir);
  await legacy.ensureAgent({ id: 'god-1', name: 'Boss', provider: 'claude', cwd: dir, isGod: true });
  await legacy.commitsSettled();
  const root = legacy.root();
  // A full copy of the repository, whose config is the agent's: commondir sends git there for config, refs and objects.
  const elsewhere = path.join(dir, 'elsewhere.git');
  fs.cpSync(path.join(root, '.git'), elsewhere, { recursive: true });
  plantInGitDir(elsewhere, root, marker);
  fs.writeFileSync(path.join(root, '.git', 'commondir'), `${elsewhere}\n`);

  const hive = new HiveManager(() => dir);
  hive.setGitDirBase?.(base);
  hive.ensureHive();
  fs.writeFileSync(path.join(root, 'board.md'), '# after the move\n');
  hive.commit('hive: first commit of the new build');
  await hive.commitsSettled();

  assert.equal(fs.existsSync(marker), false, 'a program in the config commondir named ran');
});

test('a git folder an agent puts in the hive after the move is ignored, and its settings never run', async (t) => {
  const { dir, base, marker } = scratch(t);
  const hive = await floor(dir, base);
  const root = hive.root();
  const before = git(root, '--git-dir', target(base, root), 'rev-list', '--count', 'HEAD').stdout.trim();
  // The agent replaces the gitfile with a repository of its own.
  fs.rmSync(path.join(root, '.git'), { recursive: true, force: true });
  git(root, 'init', '-q');
  plantInGitDir(path.join(root, '.git'), root, marker);

  fs.writeFileSync(path.join(root, 'board.md'), '# later\n');
  hive.commit('hive: after the agent planted a repository');
  await hive.commitsSettled();
  const fresh = new HiveManager(() => dir);
  fresh.setGitDirBase?.(base);
  fresh.commit('hive: after a restart');
  await fresh.commitsSettled();

  assert.equal(fs.existsSync(marker), false, 'a program planted in the hive ran');
  assert.ok(Number(git(root, '--git-dir', target(base, root), 'rev-list', '--count', 'HEAD').stdout.trim()) > Number(before));
});

test('the first commit moves the history into the app data folder and leaves a gitfile that still reads it', async (t) => {
  const { dir, base } = scratch(t);
  const legacy = new HiveManager(() => dir);
  await legacy.ensureAgent({ id: 'god-1', name: 'Boss', provider: 'claude', cwd: dir, isGod: true });
  await legacy.commitsSettled();
  const root = legacy.root();
  const oldHead = git(root, 'rev-parse', 'HEAD').stdout.trim();

  const hive = new HiveManager(() => dir);
  hive.setGitDirBase(base);
  hive.commit('hive: after the move');
  await hive.commitsSettled();

  const gitDir = hiveGitDirFor(base, root);
  assert.equal(fs.readFileSync(path.join(root, '.git'), 'utf8'), `gitdir: ${gitDir}\n`);
  assert.equal(git(root, '--git-dir', gitDir, 'rev-parse', 'HEAD~1').stdout.trim(), oldHead, 'the old history is kept');
  assert.equal(git(root, 'rev-parse', 'HEAD').stdout.trim(), git(root, '--git-dir', gitDir, 'rev-parse', 'HEAD').stdout.trim(), 'git in the hive reads the moved repository');
  assert.equal(fs.existsSync(path.join(gitDir, 'config.before-move')), true);
  assert.equal(hive.logTail(50).some((e) => e.kind === 'hive-git-dir' && e.action === 'moved'), true);
});

test('a move interrupted between its two renames finishes on the next run', async (t) => {
  const { dir, base } = scratch(t);
  const legacy = new HiveManager(() => dir);
  await legacy.ensureAgent({ id: 'god-1', name: 'Boss', provider: 'claude', cwd: dir, isGod: true });
  await legacy.commitsSettled();
  const root = legacy.root();
  const oldHead = git(root, 'rev-parse', 'HEAD').stdout.trim();
  const gitDir = hiveGitDirFor(base, root);
  fs.mkdirSync(base, { recursive: true });
  fs.renameSync(path.join(root, '.git'), `${gitDir}.partial`);

  const hive = new HiveManager(() => dir);
  hive.setGitDirBase(base);
  hive.ensureHive();
  hive.commit('hive: after the interruption');
  await hive.commitsSettled();

  assert.equal(fs.existsSync(`${gitDir}.partial`), false);
  assert.equal(git(root, '--git-dir', gitDir, 'rev-parse', 'HEAD~1').stdout.trim(), oldHead);
});

test('a gitfile pointing outside the app folder is never followed; one pointing at another hive\'s repository there is copied', async (t) => {
  const { dir, base, marker } = scratch(t);
  const first = await floor(dir, base);
  const firstRoot = first.root();
  const firstHead = git(firstRoot, '--git-dir', hiveGitDirFor(base, firstRoot), 'rev-parse', 'HEAD').stdout.trim();

  // The data folder moved: the hive was copied, gitfile and all, to a new home.
  const moved = path.join(dir, 'new-home');
  fs.mkdirSync(moved);
  fs.cpSync(path.join(dir, 'hive'), path.join(moved, 'hive'), { recursive: true });
  const second = new HiveManager(() => moved);
  second.setGitDirBase(base);
  second.commit('hive: in the new home');
  await second.commitsSettled();
  assert.equal(git(second.root(), '--git-dir', hiveGitDirFor(base, second.root()), 'rev-parse', 'HEAD~1').stdout.trim(), firstHead, 'the history came along');
  assert.equal(git(firstRoot, '--git-dir', hiveGitDirFor(base, firstRoot), 'rev-parse', 'HEAD').stdout.trim(), firstHead, 'the old home is untouched');

  // An agent points a gitfile at a repository of its own.
  const third = path.join(dir, 'third-home');
  fs.mkdirSync(path.join(third, 'hive'), { recursive: true });
  const evil = path.join(dir, 'agent-repo.git');
  git(dir, 'init', '-q', '--bare', evil);
  const agentTree = path.join(dir, 'agent-tree');
  fs.mkdirSync(agentTree);
  fs.writeFileSync(path.join(agentTree, 'x'), 'x');
  git(dir, '--git-dir', evil, '--work-tree', agentTree, 'add', '-A');
  git(dir, '--git-dir', evil, '--work-tree', agentTree, '-c', 'user.name=a', '-c', 'user.email=a@a', 'commit', '-q', '-m', 'agent history');
  plantInGitDir(evil, path.join(third, 'hive'), marker);
  fs.writeFileSync(path.join(third, 'hive', '.git'), `gitdir: ${evil}\n`);
  const hive3 = new HiveManager(() => third);
  hive3.setGitDirBase(base);
  hive3.ensureHive();
  hive3.commit('hive: third');
  await hive3.commitsSettled();

  assert.equal(fs.existsSync(marker), false, 'a program in a repository the gitfile named ran');
  const gitDir3 = hiveGitDirFor(base, hive3.root());
  assert.equal(git(hive3.root(), '--git-dir', gitDir3, 'log', '--format=%s', '-1').stdout.trim(), 'hive: third');
  assert.doesNotMatch(git(hive3.root(), '--git-dir', gitDir3, 'log', '--format=%s').stdout, /agent history/, 'the agent\'s repository was adopted');
  assert.equal(fs.readFileSync(path.join(hive3.root(), '.git'), 'utf8'), `gitdir: ${gitDir3}\n`);
});

test('a full reset removes the hive\'s git directory, so a new hive at the same path starts its own history', async (t) => {
  const { dir, base } = scratch(t);
  const hive = await floor(dir, base);
  const gitDir = hiveGitDirFor(base, hive.root());
  assert.equal(fs.existsSync(gitDir), true);

  await hive.stopCommits();
  hive.removeGitDir();

  assert.equal(fs.existsSync(gitDir), false);
  assert.equal(fs.existsSync(base), true, 'only this hive\'s directory is removed');
});

test('maintenance clears a maintenance.lock older than any step can run', async (t) => {
  const { dir, base } = scratch(t);
  const hive = await floor(dir, base);
  hive.setMaintenanceTiming({ idleMs: 100, everyMs: 24 * 60 * 60 * 1000 });
  const gitDir = hiveGitDirFor(base, hive.root());
  const lock = path.join(gitDir, 'objects', 'maintenance.lock');
  fs.writeFileSync(lock, '');
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
  fs.utimesSync(lock, old, old);
  fs.writeFileSync(path.join(hive.root(), 'board.md'), '# loose objects\n');
  hive.commit('hive: something to pack');
  await hive.commitsSettled();
  const loose = () => Number(/^count: (\d+)/m.exec(git(hive.root(), '--git-dir', gitDir, 'count-objects', '-v').stdout)[1]);
  const before = loose();

  const end = Date.now() + 10000;
  while (hive.logTail(200).filter((e) => e.kind === 'hive-maintenance' && e.phase === 'end').length < 4) {
    assert.ok(Date.now() < end, 'maintenance never finished');
    await new Promise((r) => setTimeout(r, 25));
  }
  await hive.commitsSettled();

  assert.equal(fs.existsSync(lock), false, 'the stale lock was left');
  assert.ok(loose() < before, `nothing was packed: ${before} -> ${loose()}`);
  assert.equal(fs.existsSync(path.join(gitDir, 'hive-maintenance-at')), true, 'the stamp lives in the app-owned directory');
  assert.equal(fs.existsSync(path.join(hive.root(), '.git', 'hive-maintenance-at')), false);
});

test('an untrack pass that keeps failing is tried at most once a minute, its first failure logged with git\'s error', async (t) => {
  const { dir, base } = scratch(t);
  await floor(dir, base);
  const root = path.join(dir, 'hive');
  const gitDir = hiveGitDirFor(base, root);
  const junk = path.join(root, 'agents', 'god-1', '.nuget', 'pkg.nupkg');
  fs.mkdirSync(path.dirname(junk), { recursive: true });
  fs.writeFileSync(junk, 'package');
  git(root, '--git-dir', gitDir, '--work-tree', root, 'add', '-f', '--', 'agents/god-1/.nuget');
  git(root, '--git-dir', gitDir, '--work-tree', root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'tracked');
  // A git whose `rm` always fails.
  const bin = path.join(dir, 'fake-bin');
  const calls = path.join(dir, 'rm-calls');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\ncase " $* " in *" rm "*) echo x >> '${calls}'; echo boom >&2; exit 1 ;; esac\nexec '${REAL_GIT}' "$@"\n`, { mode: 0o755 });
  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${savedPath}`;
  t.after(() => { process.env.PATH = savedPath; });
  const warnings = [];
  const warn = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  t.after(() => { console.warn = warn; });

  const hive = new HiveManager(() => dir);
  hive.setGitDirBase(base);
  hive.ensureHive();
  for (let i = 0; i < 5; i++) {
    hive.commit(`hive: commit ${i}`);
    await hive.commitsSettled();
  }

  assert.equal(fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean).length, 1, 'retried without backing off');
  const failures = warnings.filter((w) => w.includes('could not stop tracking'));
  assert.equal(failures.length, 1);
  assert.match(failures[0], /boom/);
});
