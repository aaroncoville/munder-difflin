'use strict';

/**
 * An isolated agent worktree has no node_modules, so `npm run typecheck`
 * fails with `error TS2688: Cannot find type definition file for 'node'`.
 * linkWorktreeDeps symlinks the base checkout's node_modules into the worktree
 * so the toolchain is available without a full install.
 *
 * Real temp dirs — no mocks, because the teardown-safety invariant is what
 * git actually does to a directory containing a symlink.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { linkWorktreeDeps } = loadTs('src/main/worktreeDeps.ts');
const { removeWorktree } = loadTs('src/main/git.ts');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/** A throwaway repo with one commit on `main`, plus an empty worktrees root. */
function makeHarness() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-wt-deps-'));
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

test('symlink is created when base has node_modules and worktree does not', async () => {
  const { repo, wtRoot } = makeHarness();
  const baseNm = path.join(repo, 'node_modules');
  fs.mkdirSync(baseNm);
  fs.writeFileSync(path.join(baseNm, 'sentinel.txt'), 'base\n');

  const wtPath = path.join(wtRoot, 'agent-a');
  git(repo, 'worktree', 'add', '-q', wtPath, '-b', 'agent/agent-a', 'main');

  const res = await linkWorktreeDeps(repo, wtPath);

  assert.equal(res.ok, true);
  assert.equal(res.skipped, false);

  // lstat confirms the symlink entry exists (not just the target).
  const stat = fs.lstatSync(path.join(wtPath, 'node_modules'));
  assert.equal(stat.isSymbolicLink(), true, 'node_modules must be a symlink, not a real dir');

  // The symlink must resolve to the base checkout's node_modules.
  const target = fs.readlinkSync(path.join(wtPath, 'node_modules'));
  assert.equal(target, baseNm, 'symlink target must be base node_modules');

  // Reading through the link must work.
  assert.equal(
    fs.readFileSync(path.join(wtPath, 'node_modules', 'sentinel.txt'), 'utf8'),
    'base\n',
    'symlink must resolve to real content'
  );
});

test('skipped when base checkout has no node_modules', async () => {
  const { repo, wtRoot } = makeHarness();
  // Intentionally no node_modules in repo.
  const wtPath = path.join(wtRoot, 'agent-b');
  git(repo, 'worktree', 'add', '-q', wtPath, '-b', 'agent/agent-b', 'main');

  const res = await linkWorktreeDeps(repo, wtPath);

  assert.equal(res.ok, true);
  assert.equal(res.skipped, true);
  assert.equal(fs.existsSync(path.join(wtPath, 'node_modules')), false, 'nothing should be created');
});

test('skipped when worktree already has a node_modules entry', async () => {
  const { repo, wtRoot } = makeHarness();
  const baseNm = path.join(repo, 'node_modules');
  fs.mkdirSync(baseNm);

  const wtPath = path.join(wtRoot, 'agent-c');
  git(repo, 'worktree', 'add', '-q', wtPath, '-b', 'agent/agent-c', 'main');

  // Pre-create a real directory so there is already a node_modules entry.
  const existingNm = path.join(wtPath, 'node_modules');
  fs.mkdirSync(existingNm);
  fs.writeFileSync(path.join(existingNm, 'own.txt'), 'own\n');

  const res = await linkWorktreeDeps(repo, wtPath);

  assert.equal(res.ok, true);
  assert.equal(res.skipped, true);
  // Must not have replaced the existing directory with a symlink.
  assert.equal(fs.lstatSync(existingNm).isSymbolicLink(), false, 'existing entry must be untouched');
  assert.equal(fs.readFileSync(path.join(existingNm, 'own.txt'), 'utf8'), 'own\n');
});

test('teardown safety: git worktree remove does not follow the symlink and delete base node_modules', async () => {
  const { repo, wtRoot } = makeHarness();
  const baseNm = path.join(repo, 'node_modules');
  fs.mkdirSync(baseNm);
  // A real file we assert must survive teardown.
  const sentinel = path.join(baseNm, 'must-survive.txt');
  fs.writeFileSync(sentinel, 'still here\n');

  const wtPath = path.join(wtRoot, 'agent-d');
  git(repo, 'worktree', 'add', '-q', wtPath, '-b', 'agent/agent-d', 'main');

  const linkRes = await linkWorktreeDeps(repo, wtPath);
  assert.equal(linkRes.ok, true, 'precondition: dep-link succeeded');
  assert.equal(linkRes.skipped, false, 'precondition: symlink was created');

  // Tear down through the SAME code path production uses.
  const rmRes = await removeWorktree(repo, wtPath);
  assert.equal(rmRes.ok, true, `removeWorktree failed: ${rmRes.error ?? ''}`);

  assert.equal(fs.existsSync(wtPath), false, 'precondition: worktree directory is gone');

  // THE INVARIANT: the base node_modules and its contents survive teardown.
  assert.equal(
    fs.existsSync(baseNm), true,
    'base node_modules directory must survive worktree teardown'
  );
  assert.equal(
    fs.readFileSync(sentinel, 'utf8'), 'still here\n',
    'sentinel file must survive — if it is gone, git worktree remove followed the symlink'
  );
});

test('wiring: index.ts imports linkWorktreeDeps and calls it after recordWorktreeOrigin inside if(wt.ok)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');

  // Import must be present.
  assert.match(src, /from ['"]\.\/worktreeDeps['"]/, 'index.ts must import from ./worktreeDeps');

  // Call must be present.
  assert.match(src, /linkWorktreeDeps\(origCwd, wtPath\)/, 'index.ts must call linkWorktreeDeps(origCwd, wtPath)');

  // The call must follow recordWorktreeOrigin(wtPath, origCwd) — not lead it.
  const afterRecord = src.slice(src.indexOf('recordWorktreeOrigin(wtPath, origCwd)'));
  assert.match(afterRecord, /linkWorktreeDeps\(origCwd, wtPath\)/, 'linkWorktreeDeps must appear after recordWorktreeOrigin in index.ts');
});
