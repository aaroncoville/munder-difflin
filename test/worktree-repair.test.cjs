'use strict';

/**
 * An isolated agent's worktree is force-removed by teardownPty when its PTY
 * dies, but the agent record (and the hive roster) keeps that worktree path as
 * its cwd. The next restart / model change therefore spawned into a directory
 * that no longer exists and died with `cwd does not exist: …` — hit by four
 * agents in one night.
 *
 * The spawn path now REPAIRS that: it recreates the worktree with
 * `git worktree add`, checked out on the agent's own `agent/<id>` branch (so no
 * committed work is lost), pruning git's stale registration first.
 *
 * Real git, real temp repos — no mocks, since the whole point is what git does.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const {
  recordWorktreeOrigin, lookupWorktreeOrigin, repairMissingWorktree
} = loadTs('src/main/worktreeRepair.ts');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/** A throwaway repo with one commit on `main`, plus an empty worktrees root
 *  standing in for `<harnessHome>/worktrees`. */
function makeHarness() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-wt-'));
  const repo = path.join(home, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(repo, 'README.md'), 'base\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  const wtRoot = path.join(home, 'worktrees');
  fs.mkdirSync(wtRoot);
  return { home, repo, wtRoot };
}

test('origins survive a round-trip through the worktrees-root sidecar', () => {
  const { repo, wtRoot } = makeHarness();
  const wtPath = path.join(wtRoot, 'agent-a');

  assert.equal(lookupWorktreeOrigin(wtPath), null, 'nothing recorded yet');
  recordWorktreeOrigin(wtPath, repo);
  assert.equal(lookupWorktreeOrigin(wtPath), repo);

  // A second agent must not clobber the first.
  const other = path.join(wtRoot, 'agent-b');
  recordWorktreeOrigin(other, repo);
  assert.equal(lookupWorktreeOrigin(wtPath), repo);
  assert.equal(lookupWorktreeOrigin(other), repo);
});

test('a deleted worktree is recreated on its agent branch, keeping the branch\'s commits', async () => {
  const { repo, wtRoot } = makeHarness();
  const wtPath = path.join(wtRoot, 'agent-a');
  git(repo, 'worktree', 'add', '-q', wtPath, '-b', 'agent/agent-a', 'main');
  recordWorktreeOrigin(wtPath, repo);

  // The agent committed work, then teardownPty force-removed its worktree.
  fs.writeFileSync(path.join(wtPath, 'work.txt'), 'agent work\n');
  git(wtPath, 'add', '-A');
  git(wtPath, 'commit', '-q', '-m', 'agent work');
  git(repo, 'worktree', 'remove', '--force', wtPath);
  assert.equal(fs.existsSync(wtPath), false, 'precondition: the worktree is gone');

  const res = await repairMissingWorktree(wtPath);

  assert.equal(res.ok, true, res.ok ? '' : res.error);
  assert.equal(res.branch, 'agent/agent-a');
  assert.equal(fs.existsSync(wtPath), true, 'the worktree directory is back');
  assert.equal(git(wtPath, 'rev-parse', '--abbrev-ref', 'HEAD'), 'agent/agent-a');
  assert.equal(
    fs.readFileSync(path.join(wtPath, 'work.txt'), 'utf8'), 'agent work\n',
    'the branch\'s committed work must come back with it'
  );
});

test('a stale git registration left by a hand-deleted directory is pruned, not fatal', async () => {
  const { repo, wtRoot } = makeHarness();
  const wtPath = path.join(wtRoot, 'agent-a');
  git(repo, 'worktree', 'add', '-q', wtPath, '-b', 'agent/agent-a', 'main');
  recordWorktreeOrigin(wtPath, repo);

  // rm -rf, so git still lists the worktree and `worktree add` would refuse.
  fs.rmSync(wtPath, { recursive: true, force: true });
  assert.match(git(repo, 'worktree', 'list'), /agent-a/, 'precondition: git still lists it');

  const res = await repairMissingWorktree(wtPath);

  assert.equal(res.ok, true, res.ok ? '' : res.error);
  assert.equal(git(wtPath, 'rev-parse', '--abbrev-ref', 'HEAD'), 'agent/agent-a');
});

test('a worktree whose agent branch is gone too is recreated off the repo\'s base branch', async () => {
  const { repo, wtRoot } = makeHarness();
  const wtPath = path.join(wtRoot, 'agent-c');
  recordWorktreeOrigin(wtPath, repo); // never existed on disk; no agent/agent-c branch

  const res = await repairMissingWorktree(wtPath);

  assert.equal(res.ok, true, res.ok ? '' : res.error);
  assert.equal(git(wtPath, 'rev-parse', '--abbrev-ref', 'HEAD'), 'agent/agent-c');
  assert.equal(
    git(wtPath, 'rev-parse', 'HEAD'), git(repo, 'rev-parse', 'main'),
    'a fresh agent branch starts at the base branch'
  );
});

test('an unknown source repo fails with the exact command that fixes it by hand', async () => {
  const { wtRoot } = makeHarness();
  const wtPath = path.join(wtRoot, 'agent-z'); // nothing ever recorded

  const res = await repairMissingWorktree(wtPath);

  assert.equal(res.ok, false);
  assert.match(res.error, /agent-z/, 'the error names the missing worktree');
  assert.match(res.error, /git -C .* worktree add/, 'the error names the fix command');
});

test('repair is a no-op when the worktree is still on disk', async () => {
  const { repo, wtRoot } = makeHarness();
  const wtPath = path.join(wtRoot, 'agent-a');
  git(repo, 'worktree', 'add', '-q', wtPath, '-b', 'agent/agent-a', 'main');
  recordWorktreeOrigin(wtPath, repo);
  fs.writeFileSync(path.join(wtPath, 'uncommitted.txt'), 'do not lose me\n');

  const res = await repairMissingWorktree(wtPath);

  assert.equal(res.ok, true);
  assert.equal(
    fs.readFileSync(path.join(wtPath, 'uncommitted.txt'), 'utf8'), 'do not lose me\n',
    'a live worktree must never be touched'
  );
});
