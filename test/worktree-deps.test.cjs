'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const sourceAssert = require('./source-assert.cjs');

const { linkWorktreeDeps, unlinkWorktreeDeps } = loadTs('src/main/worktreeDeps.ts');
const { addWorktree: addWorktreeTS, removeWorktree } = loadTs('src/main/git.ts');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function makeHarness() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-worktree-deps-'));
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
  return { repo, wtRoot };
}

function addWorktree(repo, wtRoot, name) {
  const wtPath = path.join(wtRoot, name);
  git(repo, 'worktree', 'add', '-q', wtPath, '-b', `agent/${name}`, 'main');
  return wtPath;
}

test('gives a worktree a real node_modules whose entries link into the base', async () => {
  const { repo, wtRoot } = makeHarness();
  const baseNodeModules = path.join(repo, 'node_modules');
  fs.mkdirSync(path.join(baseNodeModules, 'pkg'), { recursive: true });
  fs.mkdirSync(path.join(baseNodeModules, '@scope', 'pkg'), { recursive: true });
  fs.mkdirSync(path.join(baseNodeModules, '.bin'));
  fs.writeFileSync(path.join(baseNodeModules, 'pkg', 'sentinel.txt'), 'base\n');
  fs.writeFileSync(path.join(baseNodeModules, '@scope', 'pkg', 'scoped.txt'), 'scoped\n');
  fs.writeFileSync(path.join(baseNodeModules, '.package-lock.json'), '{}');
  const wtPath = addWorktree(repo, wtRoot, 'agent-a');

  const result = await linkWorktreeDeps(repo, wtPath);

  assert.deepEqual(result, { ok: true, skipped: false });
  const worktreeNodeModules = path.join(wtPath, 'node_modules');
  assert.equal(fs.lstatSync(worktreeNodeModules).isSymbolicLink(), false, 'a link to the base directory is what npm ci empties');
  assert.equal(fs.lstatSync(worktreeNodeModules).isDirectory(), true);
  for (const entry of ['pkg', '@scope', '.bin']) {
    assert.equal(fs.lstatSync(path.join(worktreeNodeModules, entry)).isSymbolicLink(), true, entry);
  }
  assert.equal(fs.readFileSync(path.join(worktreeNodeModules, 'pkg', 'sentinel.txt'), 'utf8'), 'base\n');
  assert.equal(fs.readFileSync(path.join(worktreeNodeModules, '@scope', 'pkg', 'scoped.txt'), 'utf8'), 'scoped\n');
  assert.equal(fs.existsSync(path.join(worktreeNodeModules, '.package-lock.json')), false, 'a plain file is left out: a junction cannot point at one');
});

test('skips linking when the base checkout has no node_modules', async () => {
  const { repo, wtRoot } = makeHarness();
  const wtPath = addWorktree(repo, wtRoot, 'agent-b');

  const result = await linkWorktreeDeps(repo, wtPath);

  assert.deepEqual(result, { ok: true, skipped: true });
  assert.throws(() => fs.lstatSync(path.join(wtPath, 'node_modules')), /ENOENT/);
});

test('does not replace an existing worktree node_modules entry', async () => {
  const { repo, wtRoot } = makeHarness();
  fs.mkdirSync(path.join(repo, 'node_modules'));
  const wtPath = addWorktree(repo, wtRoot, 'agent-c');
  const worktreeNodeModules = path.join(wtPath, 'node_modules');
  fs.mkdirSync(worktreeNodeModules);
  fs.writeFileSync(path.join(worktreeNodeModules, 'own.txt'), 'own\n');

  const result = await linkWorktreeDeps(repo, wtPath);

  assert.deepEqual(result, { ok: true, skipped: true });
  assert.equal(fs.lstatSync(worktreeNodeModules).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(path.join(worktreeNodeModules, 'own.txt'), 'utf8'), 'own\n');
});

test('does not follow the dependency symlink when removing a worktree', async () => {
  const { repo, wtRoot } = makeHarness();
  const baseNodeModules = path.join(repo, 'node_modules');
  fs.mkdirSync(path.join(baseNodeModules, 'pkg'), { recursive: true });
  const sentinel = path.join(baseNodeModules, 'pkg', 'must-survive.txt');
  fs.writeFileSync(sentinel, 'still here\n');
  const wtPath = addWorktree(repo, wtRoot, 'agent-d');

  assert.deepEqual(await linkWorktreeDeps(repo, wtPath), { ok: true, skipped: false });
  assert.equal(fs.lstatSync(path.join(wtPath, 'node_modules', 'pkg')).isSymbolicLink(), true, 'a link must exist before removal');
  assert.deepEqual(await removeWorktree(repo, wtPath), { ok: true });

  assert.equal(fs.existsSync(wtPath), false);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'still here\n');
});

test('leaves a dangling worktree dependency symlink untouched', async () => {
  const { repo, wtRoot } = makeHarness();
  fs.mkdirSync(path.join(repo, 'node_modules'));
  const wtPath = addWorktree(repo, wtRoot, 'agent-e');
  const worktreeNodeModules = path.join(wtPath, 'node_modules');
  fs.symlinkSync('/does-not-exist', worktreeNodeModules);

  const result = await linkWorktreeDeps(repo, wtPath);

  assert.deepEqual(result, { ok: true, skipped: true });
  assert.equal(fs.readlinkSync(worktreeNodeModules), '/does-not-exist');
});

test('reports a failed link without throwing', async () => {
  const { repo } = makeHarness();
  fs.mkdirSync(path.join(repo, 'node_modules'));
  const notADirectory = path.join(repo, 'not-a-directory');
  fs.writeFileSync(notADirectory, 'file\n');

  const result = await linkWorktreeDeps(repo, notADirectory);

  assert.equal(result.ok, false);
  assert.match(result.error, /EEXIST|ENOTDIR/);
});

test('removes only the linked dependencies before checking worktree status', async () => {
  const { repo, wtRoot } = makeHarness();
  const baseNodeModules = path.join(repo, 'node_modules');
  fs.mkdirSync(path.join(baseNodeModules, 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(baseNodeModules, 'pkg', 'index.js'), 'base\n');
  const wtPath = addWorktree(repo, wtRoot, 'agent-f');
  const worktreeNodeModules = path.join(wtPath, 'node_modules');

  assert.deepEqual(await linkWorktreeDeps(repo, wtPath), { ok: true, skipped: false });
  assert.notEqual(git(wtPath, 'status', '--porcelain'), '', 'the unignored link makes the worktree dirty');

  assert.deepEqual(await unlinkWorktreeDeps(repo, wtPath), { ok: true, removed: true });
  assert.throws(() => fs.lstatSync(worktreeNodeModules), /ENOENT/);
  assert.equal(git(wtPath, 'status', '--porcelain'), '', 'removing the link restores a clean worktree');
  assert.equal(fs.readFileSync(path.join(baseNodeModules, 'pkg', 'index.js'), 'utf8'), 'base\n', 'the base dependencies must remain');
});

test('removing the links leaves whatever else the worktree put there, and a link it made elsewhere', async () => {
  const { repo, wtRoot } = makeHarness();
  const baseNodeModules = path.join(repo, 'node_modules');
  fs.mkdirSync(path.join(baseNodeModules, 'pkg'), { recursive: true });
  fs.mkdirSync(path.join(baseNodeModules, 'other'), { recursive: true });
  const wtPath = addWorktree(repo, wtRoot, 'agent-mixed');
  await linkWorktreeDeps(repo, wtPath);
  const worktreeNodeModules = path.join(wtPath, 'node_modules');
  fs.mkdirSync(path.join(worktreeNodeModules, 'own'));
  const elsewhere = path.join(repo, 'elsewhere');
  fs.mkdirSync(elsewhere);
  fs.symlinkSync(elsewhere, path.join(worktreeNodeModules, 'linked-elsewhere'));
  fs.rmSync(path.join(worktreeNodeModules, 'other'));
  fs.symlinkSync(path.join(baseNodeModules, 'pkg'), path.join(worktreeNodeModules, 'other'));

  assert.deepEqual(await unlinkWorktreeDeps(repo, wtPath), { ok: true, removed: true });

  assert.deepEqual(fs.readdirSync(worktreeNodeModules).sort(), ['linked-elsewhere', 'other', 'own'],
    'only a link from a name to the same name in the base is ours');
  assert.equal(fs.existsSync(path.join(baseNodeModules, 'pkg')), true);
});

test('removing the links works after the base entries they point at have gone', async () => {
  const { repo, wtRoot } = makeHarness();
  const baseNodeModules = path.join(repo, 'node_modules');
  fs.mkdirSync(path.join(baseNodeModules, 'pkg'), { recursive: true });
  const wtPath = addWorktree(repo, wtRoot, 'agent-gone');
  await linkWorktreeDeps(repo, wtPath);
  fs.rmSync(baseNodeModules, { recursive: true });

  assert.deepEqual(await unlinkWorktreeDeps(repo, wtPath), { ok: true, removed: true });
  assert.throws(() => fs.lstatSync(path.join(wtPath, 'node_modules')), /ENOENT/);
});

test('a worktree from before this change, with a link to the whole folder, still has it removed', async () => {
  const { repo, wtRoot } = makeHarness();
  const baseNodeModules = path.join(repo, 'node_modules');
  fs.mkdirSync(path.join(baseNodeModules, 'pkg'), { recursive: true });
  const wtPath = addWorktree(repo, wtRoot, 'agent-legacy');
  fs.symlinkSync(baseNodeModules, path.join(wtPath, 'node_modules'));

  assert.deepEqual(await unlinkWorktreeDeps(repo, wtPath), { ok: true, removed: true });
  assert.throws(() => fs.lstatSync(path.join(wtPath, 'node_modules')), /ENOENT/);
  assert.equal(fs.existsSync(path.join(baseNodeModules, 'pkg')), true);
});

test('does not remove an empty node_modules the worktree made itself', async () => {
  const { repo, wtRoot } = makeHarness();
  fs.mkdirSync(path.join(repo, 'node_modules'));
  const wtPath = addWorktree(repo, wtRoot, 'agent-empty');
  fs.mkdirSync(path.join(wtPath, 'node_modules'));
  assert.deepEqual(await unlinkWorktreeDeps(repo, wtPath), { ok: true, removed: false });
  assert.equal(fs.lstatSync(path.join(wtPath, 'node_modules')).isDirectory(), true);
});

test('does not remove a real worktree node_modules directory', async () => {
  const { repo, wtRoot } = makeHarness();
  fs.mkdirSync(path.join(repo, 'node_modules'));
  const wtPath = addWorktree(repo, wtRoot, 'agent-g');
  const worktreeNodeModules = path.join(wtPath, 'node_modules');
  fs.mkdirSync(worktreeNodeModules);
  const sentinel = path.join(worktreeNodeModules, 'must-survive.txt');
  fs.writeFileSync(sentinel, 'worktree dependencies\n');

  const result = await unlinkWorktreeDeps(repo, wtPath);
  assert.equal(fs.lstatSync(worktreeNodeModules).isDirectory(), true);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'worktree dependencies\n');
  assert.deepEqual(result, { ok: true, removed: false });
});

test('does not remove a worktree node_modules link to another directory', async () => {
  const { repo, wtRoot } = makeHarness();
  fs.mkdirSync(path.join(repo, 'node_modules'));
  const foreignNodeModules = path.join(repo, 'foreign-node-modules');
  fs.mkdirSync(foreignNodeModules);
  const sentinel = path.join(foreignNodeModules, 'must-survive.txt');
  fs.writeFileSync(sentinel, 'foreign dependencies\n');
  const wtPath = addWorktree(repo, wtRoot, 'agent-h');
  const worktreeNodeModules = path.join(wtPath, 'node_modules');
  fs.symlinkSync(foreignNodeModules, worktreeNodeModules);

  const result = await unlinkWorktreeDeps(repo, wtPath);
  assert.equal(fs.lstatSync(worktreeNodeModules).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(worktreeNodeModules), foreignNodeModules);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'foreign dependencies\n');
  assert.deepEqual(result, { ok: true, removed: false });
});

test('wires dependency linking into successful isolated worktree creation', () => {
  const src = sourceAssert.activeSource('src/main/index.ts');
  assert.match(src, /from ['"]\.\/worktreeDeps['"]/);
  const successBranch = sourceAssert.boundedSlice(src, 'if (wt.ok)', '} else {');
  assert.match(successBranch, /await linkWorktreeDeps\(origCwd, wtPath\)/);
});

test('removes linked dependencies before worker retention checks', () => {
  const src = sourceAssert.activeSource('src/main/index.ts');
  const beforeRetention = src.slice(0, src.indexOf('const work = await worktreeHasUnintegratedWork'));
  assert.match(beforeRetention, /await unlinkWorktreeDeps\(origCwd, wtPath\)/);
  const beforeGc = src.slice(0, src.indexOf('safe = await worktreeIsGcSafe'));
  assert.match(beforeGc, /await unlinkWorktreeDeps\(e\.origCwd, e\.wtPath\)/);
});

test('uses a Windows junction for the directory link', () => {
  const src = sourceAssert.activeSource('src/main/worktreeDeps.ts');
  assert.match(src, /process\.platform === ['"]win32['"] \? ['"]junction['"] :/);
});

test('recovers from a stale registration left by rm -rf instead of git worktree remove', async () => {
  // When a worktree directory is deleted with rm -rf the git registration in
  // .git/worktrees/ survives. Both addWorktree attempts fail because git sees
  // the path as still registered. prune before the retry clears the stale entry
  // so the recreation succeeds.
  const { repo, wtRoot } = makeHarness();
  const wtPath = addWorktree(repo, wtRoot, 'agent-prune');

  // Simulate rm -rf: remove the directory WITHOUT going through git.
  fs.rmSync(wtPath, { recursive: true, force: true });
  assert.equal(fs.existsSync(wtPath), false, 'directory must be gone');
  // Git still knows about it — the registration is now stale.
  const listBefore = git(repo, 'worktree', 'list', '--porcelain');
  assert.match(listBefore, /agent-prune/, 'stale registration must be present before prune');

  // Recreate via addWorktreeTS — must succeed even though the registration is stale.
  const result = await addWorktreeTS(repo, wtPath, 'main');
  assert.deepEqual(result, { ok: true }, 'addWorktree must succeed after pruning the stale entry');
  assert.equal(fs.existsSync(wtPath), true, 'worktree directory must exist after recreation');
});

// The property that matters, against real npm: `npm ci` empties node_modules by listing it and removing each entry.
// Through a link to the base folder, that listing is the base's, so the base is what gets emptied.
function npmFixture(t) {
  const { repo, wtRoot } = makeHarness();
  const npmEnv = { ...process.env, npm_config_cache: path.join(wtRoot, '.npm-cache'), npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' };
  const npm = (cwd, ...args) => execFileSync('npm', [...args, '--offline', '--silent'], { cwd, env: npmEnv, encoding: 'utf8' });
  const pkg = path.join(wtRoot, '.pkg');
  fs.mkdirSync(pkg);
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'leftish', version: '1.0.0', bin: { leftish: 'index.js' } }));
  fs.writeFileSync(path.join(pkg, 'index.js'), '#!/usr/bin/env node\nmodule.exports = 1;\n');
  npm(pkg, 'pack');
  fs.copyFileSync(path.join(pkg, 'leftish-1.0.0.tgz'), path.join(repo, 'leftish-1.0.0.tgz'));
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'base', version: '1.0.0', dependencies: { leftish: 'file:leftish-1.0.0.tgz' } }));
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules\n');
  npm(repo, 'install');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'add a dependency');
  const sentinel = path.join(repo, 'node_modules', 'leftish', 'SENTINEL');
  fs.writeFileSync(sentinel, 'the live install\n');
  t.after(() => fs.rmSync(path.dirname(repo), { recursive: true, force: true }));
  const snapshot = () => fs.readdirSync(path.join(repo, 'node_modules'), { recursive: true }).map(String).sort();
  return { repo, wtRoot, npm, sentinel, snapshot };
}

for (const command of [['ci'], ['install'], ['install', '--force']]) {
  test(`npm ${command.join(' ')} in a worktree leaves the base install untouched`, async (t) => {
    const { repo, wtRoot, npm, sentinel, snapshot } = npmFixture(t);
    const before = snapshot();
    const wtPath = addWorktree(repo, wtRoot, 'agent-npm');
    assert.deepEqual(await linkWorktreeDeps(repo, wtPath), { ok: true, skipped: false });

    npm(wtPath, ...command);

    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'the live install\n', 'the live install was changed through the worktree');
    assert.deepEqual(snapshot(), before);
    assert.equal(fs.lstatSync(path.join(wtPath, 'node_modules')).isDirectory(), true);
  });
}

test('npm ci in a worktree leaves it with its own real install', async (t) => {
  const { repo, wtRoot, npm } = npmFixture(t);
  const wtPath = addWorktree(repo, wtRoot, 'agent-own');
  await linkWorktreeDeps(repo, wtPath);
  npm(wtPath, 'ci');
  const installed = path.join(wtPath, 'node_modules', 'leftish');
  assert.equal(fs.lstatSync(installed).isSymbolicLink(), false);
  assert.equal(fs.existsSync(path.join(installed, 'SENTINEL')), false, 'not the base copy');
  assert.deepEqual(await unlinkWorktreeDeps(repo, wtPath), { ok: true, removed: false }, 'the worktree\'s own install is not ours to remove');
  assert.equal(fs.existsSync(installed), true);
});

test('code in a worktree resolves a linked dependency and its .bin entry', async (t) => {
  const { repo, wtRoot } = npmFixture(t);
  const wtPath = addWorktree(repo, wtRoot, 'agent-resolve');
  await linkWorktreeDeps(repo, wtPath);
  assert.equal(execFileSync(process.execPath, ['-e', "process.stdout.write(String(require('leftish')))"], { cwd: wtPath, encoding: 'utf8' }), '1');
  assert.equal(fs.existsSync(path.join(wtPath, 'node_modules', '.bin', 'leftish')), true);
});
