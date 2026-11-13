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
  const aside = fs.readdirSync(root).filter((n) => n.startsWith('.git.set-aside-'));
  assert.equal(aside.length, 1, 'the planted folder was not set aside');
  assert.equal(fs.statSync(path.join(root, '.git')).isFile(), true, 'the gitfile was not put back');
  assert.equal(git(root, '--git-dir', target(base, root), 'ls-files', '--', aside[0]).stdout, '', 'the set-aside folder was recorded');
});

test('the first commit moves the history into the app data folder and leaves a gitfile that still reads it', async (t) => {
  const { dir, base } = scratch(t);
  const legacy = new HiveManager(() => dir);
  await legacy.ensureAgent({ id: 'god-1', name: 'Boss', provider: 'claude', cwd: dir, isGod: true });
  await legacy.commitsSettled();
  const root = legacy.root();
  const oldHead = git(root, 'rev-parse', 'HEAD').stdout.trim();
  // What the old folder carried that git follows: none of it may come along.
  fs.mkdirSync(path.join(root, '.git', 'info'), { recursive: true });
  fs.writeFileSync(path.join(root, '.git', 'info', 'attributes'), '* filter=evil\n');
  fs.writeFileSync(path.join(root, '.git', 'objects', 'info', 'alternates'), `${path.join(dir, 'nowhere')}\n`);
  fs.appendFileSync(path.join(root, '.git', 'config'), `[include]\n\tpath = ${path.join(dir, 'other-config')}\n`);
  fs.mkdirSync(path.join(root, '.git', 'modules', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(root, '.git', 'modules', 'sub', 'config'), '[filter "evil"]\n\tclean = /bin/false\n');

  const hive = new HiveManager(() => dir);
  hive.setGitDirBase(base);
  hive.commit('hive: after the move');
  await hive.commitsSettled();

  const gitDir = hiveGitDirFor(base, root);
  assert.equal(fs.readFileSync(path.join(root, '.git'), 'utf8'), `gitdir: ${gitDir}\n`);
  assert.equal(git(root, '--git-dir', gitDir, 'rev-parse', 'HEAD~1').stdout.trim(), oldHead, 'the old history is kept');
  assert.equal(git(root, 'rev-parse', 'HEAD').stdout.trim(), git(root, '--git-dir', gitDir, 'rev-parse', 'HEAD').stdout.trim(), 'git in the hive reads the moved repository');
  assert.equal(fs.existsSync(path.join(`${gitDir}.before-move`, 'config')), true, 'the old config is not kept aside for a reversal');
  for (const gone of ['hooks', 'modules', 'info/attributes', 'objects/info/alternates']) assert.equal(fs.existsSync(path.join(gitDir, gone)), false, `${gone} came along`);
  assert.doesNotMatch(fs.readFileSync(path.join(gitDir, 'config'), 'utf8'), /include/);
  const markerFile = JSON.parse(fs.readFileSync(path.join(gitDir, 'hive-git.json'), 'utf8'));
  assert.equal(markerFile.source, path.join(root, '.git'));
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
  // As if the app stopped right after the first rename.
  fs.renameSync(path.join(root, '.git'), `${gitDir}.import`);

  const hive = new HiveManager(() => dir);
  hive.setGitDirBase(base);
  hive.ensureHive();
  hive.commit('hive: after the interruption');
  await hive.commitsSettled();

  assert.equal(fs.existsSync(`${gitDir}.import`), false);
  assert.equal(fs.existsSync(`${gitDir}.partial`), false);
  assert.equal(git(root, '--git-dir', gitDir, 'rev-parse', 'HEAD~1').stdout.trim(), oldHead);
});

test('a gitfile is never followed, even into the app\'s own folder; a data-folder move carries the history from the old hive', async (t) => {
  const { dir, base, marker } = scratch(t);
  const first = await floor(dir, base);
  const firstRoot = first.root();
  const firstHead = git(firstRoot, '--git-dir', hiveGitDirFor(base, firstRoot), 'rev-parse', 'HEAD').stdout.trim();

  // The app moves its data folder: the hive is copied, and the app carries its history from the old hive's directory.
  const moved = path.join(dir, 'new-home');
  fs.mkdirSync(moved);
  await first.stopCommits();
  fs.cpSync(path.join(dir, 'hive'), path.join(moved, 'hive'), { recursive: true });
  assert.equal(first.carryGitDirTo(path.join(moved, 'hive')), true);
  const second = new HiveManager(() => moved);
  second.setGitDirBase(base);
  fs.writeFileSync(path.join(moved, 'hive', 'board.md'), '# in the new home\n');
  second.commit('hive: in the new home');
  await second.commitsSettled();
  assert.equal(git(second.root(), '--git-dir', hiveGitDirFor(base, second.root()), 'rev-parse', 'HEAD~1').stdout.trim(), firstHead, 'the history came along');

  // A hive whose gitfile points at another hive's directory in the app folder, with no move by the app: not followed.
  const copied = path.join(dir, 'copied-by-hand');
  fs.mkdirSync(copied);
  fs.cpSync(path.join(dir, 'hive'), path.join(copied, 'hive'), { recursive: true });
  const third = new HiveManager(() => copied);
  third.setGitDirBase(base);
  third.ensureHive();
  third.commit('hive: copied by hand');
  await third.commitsSettled();
  const thirdDir = hiveGitDirFor(base, third.root());
  assert.equal(git(third.root(), '--git-dir', thirdDir, 'rev-list', '--count', 'HEAD').stdout.trim(), '1', 'the gitfile was followed');
  assert.equal(third.logTail(50).some((e) => e.kind === 'hive-git-dir' && e.action === 'not-adopted'), true);

  // And one pointing at an agent's own repository.
  const fourth = path.join(dir, 'fourth-home');
  fs.mkdirSync(path.join(fourth, 'hive'), { recursive: true });
  const evil = path.join(dir, 'agent-repo.git');
  git(dir, 'init', '-q', '--bare', evil);
  const agentTree = path.join(dir, 'agent-tree');
  fs.mkdirSync(agentTree);
  fs.writeFileSync(path.join(agentTree, 'x'), 'x');
  git(dir, '--git-dir', evil, '--work-tree', agentTree, 'add', '-A');
  git(dir, '--git-dir', evil, '--work-tree', agentTree, '-c', 'user.name=a', '-c', 'user.email=a@a', 'commit', '-q', '-m', 'agent history');
  plantInGitDir(evil, path.join(fourth, 'hive'), marker);
  fs.writeFileSync(path.join(fourth, 'hive', '.git'), `gitdir: ${evil}\n`);
  const hive4 = new HiveManager(() => fourth);
  hive4.setGitDirBase(base);
  hive4.ensureHive();
  hive4.commit('hive: fourth');
  await hive4.commitsSettled();

  assert.equal(fs.existsSync(marker), false, 'a program in a repository the gitfile named ran');
  const gitDir4 = hiveGitDirFor(base, hive4.root());
  assert.doesNotMatch(git(hive4.root(), '--git-dir', gitDir4, 'log', '--format=%s').stdout, /agent history/, 'the agent\'s repository was adopted');
  assert.equal(fs.readFileSync(path.join(hive4.root(), '.git'), 'utf8'), `gitdir: ${gitDir4}\n`);
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

test('a filter defined only in the owner\'s global git config is never run by the hive\'s git', async (t) => {
  const { dir, base, marker } = scratch(t);
  const hive = await floor(dir, base);
  // As git-lfs does: a filter in the owner's global config, which a .gitattributes an agent wrote can name.
  const program = path.join(dir, 'global-filter.sh');
  fs.writeFileSync(program, `#!/bin/sh\ntouch '${marker}'\ncat\n`, { mode: 0o755 });
  // The owner's global config, where git looks for it: ~/.gitconfig.
  const ownerHome = path.join(dir, 'owner-home');
  fs.mkdirSync(ownerHome);
  fs.writeFileSync(path.join(ownerHome, '.gitconfig'), `[filter "owners"]\n\tclean = ${program}\n\tsmudge = ${program}\n`);
  const saved = { HOME: process.env.HOME, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL };
  process.env.HOME = ownerHome;
  delete process.env.GIT_CONFIG_GLOBAL;
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  fs.writeFileSync(path.join(hive.root(), '.gitattributes'), '* filter=owners\n');
  fs.writeFileSync(path.join(hive.root(), 'board.md'), '# routed through the filter\n');

  hive.commit('hive: with a .gitattributes naming the owner\'s filter');
  await hive.commitsSettled();

  assert.equal(fs.existsSync(marker), false, 'the owner\'s global filter ran on a hive commit');
  // The same file through plain git, with the same global config, does run it: the test would otherwise prove nothing.
  const control = path.join(dir, 'control');
  fs.mkdirSync(control);
  git(control, 'init', '-q');
  fs.writeFileSync(path.join(control, '.gitattributes'), '* filter=owners\n');
  fs.writeFileSync(path.join(control, 'f'), 'x');
  git(control, 'add', '-A');
  assert.equal(fs.existsSync(marker), true, 'the control did not run the filter');
});

test('history the old repository borrowed through alternates is copied in, not lost, when the alternates go', async (t) => {
  const { dir, base } = scratch(t);
  const legacy = new HiveManager(() => dir);
  await legacy.ensureAgent({ id: 'god-1', name: 'Boss', provider: 'claude', cwd: dir, isGod: true });
  await legacy.commitsSettled();
  const root = legacy.root();
  // A commit whose objects live only in another object store, reachable through a branch of the hive repository.
  const lender = path.join(dir, 'lender');
  fs.mkdirSync(lender);
  git(lender, 'init', '-q');
  fs.writeFileSync(path.join(lender, 'borrowed.txt'), 'borrowed history\n');
  git(lender, 'add', '-A');
  git(lender, '-c', 'user.name=l', '-c', 'user.email=l@l', 'commit', '-q', '-m', 'borrowed');
  const borrowed = git(lender, 'rev-parse', 'HEAD').stdout.trim();
  fs.writeFileSync(path.join(root, '.git', 'objects', 'info', 'alternates'), `${path.join(lender, '.git', 'objects')}\n`);
  git(root, 'update-ref', 'refs/heads/borrowed', borrowed);

  const hive = new HiveManager(() => dir);
  hive.setGitDirBase(base);
  hive.commit('hive: after the move');
  await hive.commitsSettled();
  fs.rmSync(lender, { recursive: true, force: true });

  const gitDir = hiveGitDirFor(base, root);
  assert.equal(fs.existsSync(path.join(gitDir, 'objects', 'info', 'alternates')), false);
  assert.equal(git(root, '--git-dir', gitDir, 'cat-file', '-p', `${borrowed}:borrowed.txt`).stdout, 'borrowed history\n', 'the borrowed history was lost');
});

/** A repository nested inside the hive, as an agent could make one: its own config names a filter that records that it
 *  ran, and its .gitattributes routes every file through it. `kind` 'folder' gives it a .git folder; 'file' a .git
 *  file pointing at a git directory outside the hive. */
function nestedRepo(dir, folder, kind, marker) {
  fs.mkdirSync(folder, { recursive: true });
  let gitDirArgs;
  if (kind === 'folder') {
    git(folder, 'init', '-q');
    gitDirArgs = ['--git-dir', path.join(folder, '.git'), '--work-tree', folder];
  } else {
    const elsewhere = path.join(dir, `${path.basename(folder)}-elsewhere.git`);
    git(dir, 'init', '-q', '--bare', elsewhere);
    git(dir, '--git-dir', elsewhere, 'config', 'core.bare', 'false');
    fs.writeFileSync(path.join(folder, '.git'), `gitdir: ${elsewhere}\n`);
    gitDirArgs = ['--git-dir', elsewhere, '--work-tree', folder];
  }
  const program = path.join(dir, `${path.basename(folder)}-filter.sh`);
  fs.writeFileSync(program, `#!/bin/sh\ntouch '${marker}'\ncat\n`, { mode: 0o755 });
  git(folder, ...gitDirArgs, 'config', 'filter.evil.clean', program);
  fs.writeFileSync(path.join(folder, '.gitattributes'), '* filter=evil\n');
  fs.writeFileSync(path.join(folder, 'f.txt'), 'aaaa\n');
  git(folder, ...gitDirArgs, 'add', '-A');
  git(folder, ...gitDirArgs, '-c', 'user.name=a', '-c', 'user.email=a@a', 'commit', '-q', '-m', 'nested');
  fs.rmSync(marker, { force: true }); // making it ran the filter; only what the app runs counts
}

const gitlinks = (root, gitDir) => git(root, '--git-dir', gitDir, 'ls-files', '-s').stdout.split('\n').filter((l) => l.startsWith('160000'));

for (const kind of ['folder', 'file']) {
  test(`a program in a nested repository's own config never runs, across three commits (nested .git ${kind})`, async (t) => {
    const { dir, base, marker } = scratch(t);
    const hive = await floor(dir, base);
    const root = hive.root();
    const nested = path.join(root, 'evidence', 'notes');
    nestedRepo(dir, nested, kind, marker);

    for (const edit of ['bbbb', 'cccc', 'dddd']) {
      // A same-size edit inside the nested repository, so a status run inside it would have something to filter.
      fs.writeFileSync(path.join(nested, 'f.txt'), `${edit}\n`);
      fs.writeFileSync(path.join(root, 'board.md'), `# ${edit}\n`);
      hive.commit(`hive: ${edit}`);
      await hive.commitsSettled();
      // Not left in the index after any commit, not even the one whose add first met it.
      assert.deepEqual(gitlinks(root, target(base, root)), [], `a nested repository stayed in the hive index after "${edit}"`);
    }

    assert.equal(fs.existsSync(marker), false, 'the nested repository\'s filter ran as the app');
    const gitDir = target(base, root);
    // Excluded once dropped, so later adds pass it by instead of recording it again.
    assert.equal(hive.logTail(200).filter((e) => e.kind === 'hive-nested-repos-dropped').length, 1);
    assert.match(git(root, '--git-dir', gitDir, 'show', 'HEAD:board.md').stdout, /dddd/, 'the hive\'s own changes stopped being committed');
  });
}

test('nested repositories the old repository had recorded are dropped at the move, before any add looks inside them', async (t) => {
  const { dir, base, marker } = scratch(t);
  // An existing hive, from before this change, whose index already holds a nested repository.
  const legacy = new HiveManager(() => dir);
  await legacy.ensureAgent({ id: 'god-1', name: 'Boss', provider: 'claude', cwd: dir, isGod: true });
  await legacy.commitsSettled();
  const root = legacy.root();
  const nested = path.join(root, 'evidence', 'notes');
  nestedRepo(dir, nested, 'folder', marker);
  git(root, 'add', '-A');
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'recorded a nested repository');
  assert.equal(gitlinks(root, path.join(root, '.git')).length, 1);
  fs.rmSync(marker, { force: true });

  const hive = new HiveManager(() => dir);
  hive.setGitDirBase?.(base);
  hive.ensureHive();
  fs.writeFileSync(path.join(nested, 'f.txt'), 'bbbb\n');
  hive.commit('hive: first commit of the new build');
  await hive.commitsSettled();

  assert.equal(fs.existsSync(marker), false, 'a carried nested repository\'s filter ran');
  assert.deepEqual(gitlinks(root, target(base, root)), []);
});

/** An existing hive from before this change: its repository inside the hive, with a commit. */
async function legacyHive(dir) {
  const legacy = new HiveManager(() => dir);
  await legacy.ensureAgent({ id: 'god-1', name: 'Boss', provider: 'claude', cwd: dir, isGod: true });
  await legacy.commitsSettled();
  return legacy.root();
}

function symlinksUnder(d) {
  const out = [];
  const walk = (p) => {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) { out.push(p); return; }
    if (st.isDirectory()) for (const n of fs.readdirSync(p)) walk(path.join(p, n));
  };
  walk(d);
  return out;
}

for (const entry of ['objects', 'objects/info', 'refs', 'info']) {
  test(`a symlink at ${entry}/ in the old repository never reaches the app's, and nothing an agent writes through it is served`, async (t) => {
    const { dir, base } = scratch(t);
    const root = await legacyHive(dir);
    // The agent moves that part of the repository into its own folder and leaves a link behind.
    const seat = path.join(root, 'agents', 'god-1', 'scratch', entry.replace('/', '-'));
    const inRepo = path.join(root, '.git', entry);
    fs.mkdirSync(inRepo, { recursive: true });
    fs.mkdirSync(path.dirname(seat), { recursive: true });
    fs.cpSync(inRepo, seat, { recursive: true });
    fs.rmSync(inRepo, { recursive: true, force: true });
    fs.symlinkSync(seat, inRepo);

    const hive = new HiveManager(() => dir);
    hive.setGitDirBase?.(base);
    hive.ensureHive();
    hive.commit('hive: first commit of the new build');
    await hive.commitsSettled();

    const gitDir = target(base, root);
    assert.deepEqual(symlinksUnder(gitDir), [], 'a symlink came into the app\'s repository');
    // After the move the agent points alternates, from wherever it can, at an object store of its own.
    const store = path.join(dir, 'agent-store');
    git(dir, 'init', '-q', store);
    const planted = git(store, 'hash-object', '-w', '--stdin').stdout.trim() || spawnSync(REAL_GIT, ['hash-object', '-w', '--stdin'], { cwd: store, input: 'planted-by-seat', encoding: 'utf8' }).stdout.trim();
    const objectsInfo = entry === 'objects' ? path.join(seat, 'info') : entry === 'objects/info' ? seat : null;
    if (objectsInfo) {
      fs.mkdirSync(objectsInfo, { recursive: true });
      fs.writeFileSync(path.join(objectsInfo, 'alternates'), `${path.join(store, '.git', 'objects')}\n`);
    }
    assert.notEqual(git(root, '--git-dir', gitDir, 'cat-file', '-e', planted).status, 0, 'the app\'s git served an object from the agent\'s store');
    assert.equal(hive.logTail(50).some((e) => e.kind === 'hive-git-dir' && e.action === 'refused-import'), true);
    assert.equal(fs.existsSync(`${gitDir}.refused`), true, 'the refused repository was not kept aside');
  });
}

test('an in-progress merge the old repository carried never makes the app\'s first commit a merge', async (t) => {
  const { dir, base } = scratch(t);
  const root = await legacyHive(dir);
  const tree = git(root, 'rev-parse', 'HEAD^{tree}').stdout.trim();
  const seatCommit = spawnSync(REAL_GIT, ['-c', 'user.name=s', '-c', 'user.email=s@s', 'commit-tree', tree, '-m', 'made by an agent'], { cwd: root, encoding: 'utf8' }).stdout.trim();
  fs.writeFileSync(path.join(root, '.git', 'MERGE_HEAD'), `${seatCommit}\n`);

  const hive = new HiveManager(() => dir);
  hive.setGitDirBase?.(base);
  hive.ensureHive();
  fs.writeFileSync(path.join(root, 'board.md'), '# after the move\n');
  hive.commit('hive: first commit of the new build');
  await hive.commitsSettled();

  const gitDir = target(base, root);
  assert.equal(git(root, '--git-dir', gitDir, 'rev-list', '--parents', '-n', '1', 'HEAD').stdout.trim().split(' ').length, 2, 'the first commit is a merge');
  assert.notEqual(git(root, '--git-dir', gitDir, 'merge-base', '--is-ancestor', seatCommit, 'HEAD').status, 0, 'the agent\'s commit is in the hive history');
});
