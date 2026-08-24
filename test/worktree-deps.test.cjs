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

// NOTE: This test checks ONLY that an uncommented import and an uncommented call exist
// and that the call appears after recordWorktreeOrigin in the source. It does NOT verify
// the call is inside `if(wt.ok)` — that would require AST parsing. A previous version of
// this test used raw source regexes that matched commented-out lines, so a `// DISABLED`
// comment still made it green. The fix: strip line-comment lines before matching.
test('wiring: index.ts has uncommented import from ./worktreeDeps and uncommented call to linkWorktreeDeps(origCwd, wtPath) after recordWorktreeOrigin', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');

  // Strip lines whose first non-whitespace character is `//`.
  // This catches `// DISABLED await linkWorktreeDeps(...)` but NOT inline `/* */`
  // block comments — those are rare enough in this codebase that we accept the gap.
  const active = src.split('\n').filter(l => !l.trimStart().startsWith('//')).join('\n');

  // Import must be present and uncommented.
  assert.match(active, /from ['"]\.\/worktreeDeps['"]/, 'index.ts must import from ./worktreeDeps (uncommented)');

  // Call must be present and uncommented.
  assert.match(active, /linkWorktreeDeps\(origCwd, wtPath\)/, 'index.ts must have an uncommented call to linkWorktreeDeps(origCwd, wtPath)');

  // The uncommented call must follow recordWorktreeOrigin(wtPath, origCwd) — not lead it.
  const afterRecord = active.slice(active.indexOf('recordWorktreeOrigin(wtPath, origCwd)'));
  assert.match(afterRecord, /linkWorktreeDeps\(origCwd, wtPath\)/, 'linkWorktreeDeps must appear after recordWorktreeOrigin in index.ts (uncommented)');
});

// ─── Edge-case battery ────────────────────────────────────────────────────────

test('edge: base node_modules is itself a symlink — symlink is still created in worktree', async () => {
  const { repo, wtRoot } = makeHarness();

  // The base node_modules is a symlink pointing to a real directory elsewhere.
  const realNm = path.join(repo, 'real-nm');
  fs.mkdirSync(realNm);
  fs.writeFileSync(path.join(realNm, 'sentinel.txt'), 'real\n');
  const baseNm = path.join(repo, 'node_modules');
  fs.symlinkSync(realNm, baseNm);

  const wtPath = path.join(wtRoot, 'agent-sym-base');
  git(repo, 'worktree', 'add', '-q', wtPath, '-b', 'agent/sym-base', 'main');

  const res = await linkWorktreeDeps(repo, wtPath);
  assert.equal(res.ok, true);
  assert.equal(res.skipped, false);

  const wtNm = path.join(wtPath, 'node_modules');
  assert.equal(fs.lstatSync(wtNm).isSymbolicLink(), true, 'wt node_modules must be a symlink');
  // Reading through the chain of symlinks must reach real content.
  assert.equal(fs.readFileSync(path.join(wtNm, 'sentinel.txt'), 'utf8'), 'real\n');
});

test('edge: broken symlink already exists at wt/node_modules — skipped without error', async () => {
  const { repo, wtRoot } = makeHarness();
  const baseNm = path.join(repo, 'node_modules');
  fs.mkdirSync(baseNm);

  const wtPath = path.join(wtRoot, 'agent-broken-sym');
  git(repo, 'worktree', 'add', '-q', wtPath, '-b', 'agent/broken-sym', 'main');

  // Plant a dangling symlink at wt/node_modules (points nowhere).
  const wtNm = path.join(wtPath, 'node_modules');
  fs.symlinkSync('/nonexistent-target-that-does-not-exist', wtNm);
  assert.equal(fs.existsSync(wtNm), false, 'precondition: dangling symlink resolves to nothing');
  assert.equal(fs.lstatSync(wtNm).isSymbolicLink(), true, 'precondition: lstat sees the symlink');

  const res = await linkWorktreeDeps(repo, wtPath);

  // lstat succeeds on a dangling symlink, so the function must skip — not clobber.
  assert.equal(res.ok, true);
  assert.equal(res.skipped, true);
  // Must still be the same dangling symlink (not replaced).
  assert.equal(fs.lstatSync(wtNm).isSymbolicLink(), true, 'entry must still be a symlink');
  assert.equal(fs.readlinkSync(wtNm), '/nonexistent-target-that-does-not-exist', 'symlink target must be unchanged');
});

test('edge: wtDir is a FILE not a directory — returns ok:false', async () => {
  const { repo } = makeHarness();
  const baseNm = path.join(repo, 'node_modules');
  fs.mkdirSync(baseNm);

  // wtDir is a file, not a directory.
  const wtFile = path.join(repo, 'not-a-dir.txt');
  fs.writeFileSync(wtFile, 'I am a file\n');

  const res = await linkWorktreeDeps(repo, wtFile);

  assert.equal(res.ok, false, 'must return ok:false when wtDir is a file');
  assert.ok(res.error, 'must include an error message');
});

test('edge: concurrent calls race to link the same worktree — state ends correct, no data loss', async () => {
  const { repo, wtRoot } = makeHarness();
  const baseNm = path.join(repo, 'node_modules');
  fs.mkdirSync(baseNm);
  fs.writeFileSync(path.join(baseNm, 'sentinel.txt'), 'base\n');

  const wtPath = path.join(wtRoot, 'agent-race');
  git(repo, 'worktree', 'add', '-q', wtPath, '-b', 'agent/race', 'main');

  // Fire two concurrent link attempts on the same target.
  const [r1, r2] = await Promise.all([
    linkWorktreeDeps(repo, wtPath),
    linkWorktreeDeps(repo, wtPath),
  ]);

  // At least one must have succeeded (created the symlink).
  const succeeded = [r1, r2].filter(r => r.ok && !r.skipped);
  assert.ok(succeeded.length >= 1, `at least one call must have created the symlink; got r1=${JSON.stringify(r1)} r2=${JSON.stringify(r2)}`);

  // The resulting symlink must point at the correct target and resolve to real content.
  const wtNm = path.join(wtPath, 'node_modules');
  assert.equal(fs.lstatSync(wtNm).isSymbolicLink(), true, 'node_modules must be a symlink after race');
  assert.equal(fs.readFileSync(path.join(wtNm, 'sentinel.txt'), 'utf8'), 'base\n', 'content must be reachable');
});

// ─── Cleanup-path inventory ───────────────────────────────────────────────────

test('cleanup-path audit: no rmSync in src/ ever operates on a wtPath variable', () => {
  // All worktree removal is through git worktree remove (removeWorktree in git.ts).
  // The two rmSync(dir, recursive) calls in index.ts operate on:
  //   • removeWorkerScratch: hive/agents/<workerId>  — gated to agentsRoot only
  //   • reset path: hive.root() and memory.palacePath()
  // Worktrees live under harnessHome/worktrees/, which is disjoint from hive.root().
  // This grep asserts no direct rmSync(wtPath, ...) call exists anywhere.
  const srcDir = path.join(__dirname, '..', 'src');
  function walk(dir) {
    const files = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) files.push(...walk(p));
      else if (entry.name.endsWith('.ts') || entry.name.endsWith('.cjs')) files.push(p);
    }
    return files;
  }
  const hits = [];
  for (const file of walk(srcDir)) {
    const src = fs.readFileSync(file, 'utf8');
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (/rmSync\s*\(\s*wtPath/.test(lines[i])) {
        hits.push(`${file}:${i + 1}: ${lines[i].trim()}`);
      }
    }
  }
  assert.deepEqual(hits, [], `rmSync(wtPath, ...) found — these would bypass git worktree remove:\n${hits.join('\n')}`);
});
