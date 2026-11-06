'use strict';
// When a worker ends, its branch can hold commits that exist nowhere but this
// machine. The notice to the orchestrator used to say only that committed work
// is "preserved", which does not tell anyone a push is still owed. The scan
// names those branches. These tests run it against real repositories with a
// bare remote, because what counts as "pushed" is git's answer and not ours.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const { unpushedWorkerBranches, describeUnpushed } = loadTs('src/main/workerUnpushed.ts');

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: GIT_ENV }).trim();

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'md-unpushed-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const remote = path.join(root, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote], { env: GIT_ENV });
  const repo = path.join(root, 'repo');
  execFileSync('git', ['clone', '-q', remote, repo], { env: GIT_ENV });
  const commit = (dir, message) => git(dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', message);
  commit(repo, 'base');
  git(repo, 'push', '-q', 'origin', 'HEAD:main');
  git(repo, 'branch', '--set-upstream-to=origin/main', 'main');
  const addWorktree = (name, ...flags) => {
    const dir = path.join(root, 'worktrees', name);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    git(repo, 'worktree', 'add', '-q', ...flags, dir, 'HEAD');
    return dir;
  };
  return { root, repo, commit, addWorktree };
}

test('a branch ahead of its upstream is named, with the upstream it is ahead of', async (t) => {
  const { commit, addWorktree } = fixture(t);
  const wt = addWorktree('w', '-b', 'agent/w');
  commit(wt, 'pushed');
  git(wt, 'push', '-q', '-u', 'origin', 'agent/w');
  assert.deepEqual(await unpushedWorkerBranches(wt, 'main'), [], 'fully pushed: nothing to report');
  commit(wt, 'after the push');
  const found = await unpushedWorkerBranches(wt, 'main');
  assert.deepEqual(found.map((b) => [b.branch, b.upstream, b.worktree]), [['agent/w', 'origin/agent/w', wt]]);
  assert.equal(found[0].tip, git(wt, 'rev-parse', '--short', 'HEAD'));
});

test('a branch with no upstream and commits on no remote is named', async (t) => {
  const { commit, addWorktree } = fixture(t);
  const wt = addWorktree('w', '-b', 'agent/w');
  commit(wt, 'never pushed');
  const found = await unpushedWorkerBranches(wt, 'main');
  assert.deepEqual(found.map((b) => [b.branch, b.upstream]), [['agent/w', null]]);
});

test('a branch with no upstream whose tip is on a remote branch is not named', async (t) => {
  const { commit, addWorktree } = fixture(t);
  const wt = addWorktree('w', '-b', 'agent/w');
  commit(wt, 'pushed under another name');
  git(wt, 'push', '-q', 'origin', 'HEAD:refs/heads/elsewhere');
  assert.deepEqual(await unpushedWorkerBranches(wt, 'main'), []);
});

test('a detached HEAD counts only when its commit is on no remote', async (t) => {
  const { commit, addWorktree } = fixture(t);
  const wt = addWorktree('w', '--detach');
  assert.deepEqual(await unpushedWorkerBranches(wt, 'main'), [], 'detached on a pushed commit is fine');
  commit(wt, 'detached work');
  const found = await unpushedWorkerBranches(wt, 'main');
  assert.deepEqual(found.map((b) => [b.branch, b.upstream]), [['HEAD', null]]);
  assert.match(describeUnpushed(found), /detached HEAD at [0-9a-f]+ /);
});

// A checkout's base branch can legitimately carry local-only commits. A worker
// cut from it that committed nothing has a tip "on no remote", but none of that
// is the worker's, and reporting it would cost a notice on every release.
test('a worker with no commits of its own on a local-only base is not named', async (t) => {
  const { repo, commit, addWorktree } = fixture(t);
  commit(repo, 'local only, on the base branch');
  const wt = addWorktree('w', '-b', 'agent/w');
  assert.deepEqual(await unpushedWorkerBranches(wt, 'main'), []);
  commit(wt, 'the worker\'s own');
  assert.deepEqual((await unpushedWorkerBranches(wt, 'main')).map((b) => b.branch), ['agent/w']);
});

test('a worktree directly under the worker\'s worktree is scanned too', async (t) => {
  const { repo, commit, addWorktree } = fixture(t);
  const wt = addWorktree('w', '-b', 'agent/w');
  const nested = path.join(wt, 'second');
  git(repo, 'worktree', 'add', '-q', '-b', 'agent/w2', nested, 'HEAD');
  commit(nested, 'nested work');
  const found = await unpushedWorkerBranches(wt, 'main');
  assert.deepEqual(found.map((b) => [b.branch, b.worktree]), [['agent/w2', nested]]);
});

// A submodule is detached by construction and its remote refs may never have been
// fetched, so without this every release would report it as unpushed work.
test('a submodule inside the worktree is not scanned, while a nested worktree beside it still is', async (t) => {
  const { root, repo, commit, addWorktree } = fixture(t);
  const lib = path.join(root, 'lib');
  execFileSync('git', ['init', '-q', '-b', 'main', lib], { env: GIT_ENV });
  commit(lib, 'lib');
  const wt = addWorktree('w', '-b', 'agent/w');
  git(wt, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'sub');
  git(wt, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'add submodule');
  git(wt, 'push', '-q', '-u', 'origin', 'agent/w');
  const sub = path.join(wt, 'sub');
  assert.ok(fs.statSync(path.join(sub, '.git')).isFile(), 'the fixture is a real submodule: .git is a file');
  // As in a real submodule: nothing fetched, and the superproject's base is no ref here.
  git(sub, 'checkout', '-q', '--detach');
  git(sub, 'branch', '-q', '-D', 'main');
  git(sub, 'remote', 'remove', 'origin');
  assert.equal(git(sub, 'branch', '-r', '--contains', 'HEAD'), '');
  assert.deepEqual(await unpushedWorkerBranches(wt, 'main'), [], 'detached, on no known remote, and still not the worker\'s branch');

  const nested = path.join(wt, 'second');
  git(repo, 'worktree', 'add', '-q', '-b', 'agent/w2', nested, 'HEAD');
  assert.ok(fs.statSync(path.join(nested, '.git')).isFile(), 'a linked worktree has a .git file too, so that cannot be the test');
  commit(nested, 'nested work');
  assert.deepEqual((await unpushedWorkerBranches(wt, 'main')).map((b) => b.worktree), [nested]);
});

test('no worktree, or one already gone, has nothing to report', async (t) => {
  const { root } = fixture(t);
  assert.deepEqual(await unpushedWorkerBranches(undefined, 'main'), []);
  assert.deepEqual(await unpushedWorkerBranches(path.join(root, 'gone'), 'main'), []);
});

test('git failing yields null, not a false all-clear', async (t) => {
  const { root } = fixture(t);
  const broken = path.join(root, 'broken');
  fs.mkdirSync(broken);
  fs.writeFileSync(path.join(broken, '.git'), 'gitdir: /nonexistent/path\n');
  assert.equal(await unpushedWorkerBranches(broken, 'main'), null);
  assert.match(describeUnpushed(null), /could not be read/);
});

// The scan runs in the main process. A synchronous git call on a stuck
// repository would freeze the whole app until its timeout.
test('a hung git neither blocks the event loop nor outlives its timeout', async (t) => {
  const { root, addWorktree } = fixture(t);
  const wt = addWorktree('w', '-b', 'agent/w');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  // Not `exec`: the sleep is a grandchild that survives the kill and keeps stdout
  // open, so a timeout that waits for the pipe to close would not end the scan.
  fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\nsleep 10\n', { mode: 0o755 });
  const realPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${realPath}`;
  t.after(() => { process.env.PATH = realPath; });

  let beats = 0;
  const beat = setInterval(() => { beats++; }, 10);
  const started = Date.now();
  const found = await unpushedWorkerBranches(wt, 'main', 200);
  clearInterval(beat);
  assert.equal(found, null, 'a timed-out git is an unknown, reported as such');
  assert.ok(Date.now() - started < 5_000, 'the timeout ended the scan');
  assert.ok(beats >= 5, `the event loop kept running during the scan (only ${beats} beats)`);
});

test('the wording says which worktrees were scanned, in every case', () => {
  const named = [
    { worktree: '/w/a', branch: 'agent/a', tip: 'abc1234', upstream: 'origin/agent/a' },
    { worktree: '/w/b', branch: 'agent/b', tip: 'def5678', upstream: null }
  ];
  const text = describeUnpushed(named);
  assert.match(text, /NOT pushed/);
  assert.match(text, /agent\/a at abc1234 in \/w\/a \(ahead of origin\/agent\/a\)/);
  assert.match(text, /agent\/b at def5678 in \/w\/b \(on no remote\)/);
  for (const found of [named, [], null]) {
    assert.match(describeUnpushed(found), /app-created worktree/);
    assert.match(describeUnpushed(found), /made elsewhere/, 'never an all-clear for worktrees it did not look at');
  }
});
