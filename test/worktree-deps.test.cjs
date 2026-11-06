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
  assert.equal(fs.lstatSync(path.join(worktreeNodeModules, 'pkg')).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(path.join(worktreeNodeModules, '@scope', 'pkg')).isSymbolicLink(), true);
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
// Through a link to the base folder, that listing is the base's, so the base is what gets emptied. The same goes for
// any folder npm writes inside: a linked @scope let `npm uninstall @scope/old` delete the base's package.
function npmFixture(t) {
  const { repo, wtRoot } = makeHarness();
  const npmEnv = { ...process.env, npm_config_cache: path.join(wtRoot, '.npm-cache'), npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' };
  const npm = (cwd, ...args) => execFileSync('npm', [...args, '--offline', '--silent'], { cwd, env: npmEnv, encoding: 'utf8' });
  const packed = (name, bin) => {
    const dir = fs.mkdtempSync(path.join(wtRoot, '.pkg-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...(bin ? { bin: { [bin]: 'index.js' } } : {}) }));
    fs.writeFileSync(path.join(dir, 'index.js'), '#!/usr/bin/env node\nmodule.exports = 1;\n');
    const file = npm(dir, 'pack').trim().split('\n').pop();
    return path.join(dir, file);
  };
  const vendor = path.join(repo, 'vendor');
  fs.mkdirSync(vendor);
  const dep = (name, bin) => {
    const file = packed(name, bin);
    fs.copyFileSync(file, path.join(vendor, path.basename(file)));
    return `file:vendor/${path.basename(file)}`;
  };
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({
    name: 'base', version: '1.0.0',
    dependencies: { leftish: dep('leftish', 'leftish'), '@scope/old': dep('@scope/old', 'scoped-old'), '@scope/kept': dep('@scope/kept') }
  }));
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules\n');
  npm(repo, 'install');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'add dependencies');
  const baseModules = path.join(repo, 'node_modules');
  for (const pkg of ['leftish', path.join('@scope', 'old'), path.join('@scope', 'kept')]) {
    fs.writeFileSync(path.join(baseModules, pkg, 'SENTINEL'), `the live install of ${pkg}\n`);
  }
  t.after(() => fs.rmSync(path.dirname(repo), { recursive: true, force: true }));
  // Every entry, what it is, and its content or target, without following links.
  const inventory = () => fs.readdirSync(baseModules, { recursive: true }).map(String).sort().map((rel) => {
    const full = path.join(baseModules, rel);
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) return `${rel} -> ${fs.readlinkSync(full)}`;
    return stat.isFile() ? `${rel} = ${fs.readFileSync(full, 'utf8')}` : `${rel}/`;
  });
  return { repo, wtRoot, npm, packed, inventory, baseModules };
}

const OPERATIONS = {
  'ci': (f) => f.npm(f.wt, 'ci'),
  'install': (f) => f.npm(f.wt, 'install'),
  'install --force': (f) => f.npm(f.wt, 'install', '--force'),
  'uninstall of a scoped package': (f) => f.npm(f.wt, 'uninstall', '@scope/old'),
  'uninstall of the last package left in a scope': (f) => f.npm(f.wt, 'uninstall', '@scope/old', '@scope/kept'),
  'uninstall of a package with a bin': (f) => f.npm(f.wt, 'uninstall', 'leftish'),
  'install of a new scoped package': (f) => f.npm(f.wt, 'install', f.packed('@scope/new')),
  'install of a package in a new scope': (f) => f.npm(f.wt, 'install', f.packed('@other/new')),
  'install of a new package with a bin': (f) => f.npm(f.wt, 'install', f.packed('with-bin', 'with-bin')),
  'update': (f) => f.npm(f.wt, 'update'),
  'prune': (f) => f.npm(f.wt, 'prune')
};

for (const [label, run] of Object.entries(OPERATIONS)) {
  test(`npm ${label} in a worktree leaves the base install exactly as it was`, async (t) => {
    const f = npmFixture(t);
    const before = f.inventory();
    f.wt = addWorktree(f.repo, f.wtRoot, 'agent-npm');
    assert.deepEqual(await linkWorktreeDeps(f.repo, f.wt), { ok: true, skipped: false });

    run(f);

    assert.deepEqual(f.inventory(), before, 'the live install was changed through the worktree');
    assert.equal(fs.lstatSync(path.join(f.wt, 'node_modules')).isSymbolicLink(), false);
  });
}

test('after npm in a worktree, its own view changed and the base did not', async (t) => {
  const f = npmFixture(t);
  const wt = addWorktree(f.repo, f.wtRoot, 'agent-view');
  await linkWorktreeDeps(f.repo, wt);
  f.npm(wt, 'uninstall', '@scope/old');
  assert.equal(fs.existsSync(path.join(wt, 'node_modules', '@scope', 'old')), false);
  assert.equal(fs.existsSync(path.join(f.baseModules, '@scope', 'old', 'SENTINEL')), true);
  f.npm(wt, 'install', f.packed('@scope/new'));
  assert.equal(fs.lstatSync(path.join(wt, 'node_modules', '@scope', 'new')).isSymbolicLink(), false);
  assert.equal(fs.existsSync(path.join(f.baseModules, '@scope', 'new')), false);
});

test('npm ci in a worktree leaves it with its own real install', async (t) => {
  const f = npmFixture(t);
  const wt = addWorktree(f.repo, f.wtRoot, 'agent-own');
  await linkWorktreeDeps(f.repo, wt);
  f.npm(wt, 'ci');
  const installed = path.join(wt, 'node_modules', 'leftish');
  assert.equal(fs.lstatSync(installed).isSymbolicLink(), false);
  assert.equal(fs.existsSync(path.join(installed, 'SENTINEL')), false, 'not the base copy');
  assert.equal(fs.lstatSync(path.join(wt, 'node_modules', '@scope', 'old')).isSymbolicLink(), false);
  assert.deepEqual(await unlinkWorktreeDeps(f.repo, wt), { ok: true, removed: false }, 'the worktree\'s own install is not ours to remove');
  assert.equal(fs.existsSync(installed), true);
});

test('code in a worktree resolves linked and scoped dependencies, and a .bin entry runs', async (t) => {
  const f = npmFixture(t);
  const wt = addWorktree(f.repo, f.wtRoot, 'agent-resolve');
  await linkWorktreeDeps(f.repo, wt);
  for (const name of ['leftish', '@scope/old', '@scope/kept']) {
    assert.equal(execFileSync(process.execPath, ['-e', `process.stdout.write(String(require('${name}')))`], { cwd: wt, encoding: 'utf8' }), '1', name);
  }
  assert.equal(fs.existsSync(path.join(wt, 'node_modules', '.bin', 'leftish')), true);
  execFileSync(path.join(wt, 'node_modules', '.bin', 'scoped-old'), [], { cwd: wt });
});

test('a scope and .bin are real folders in the worktree, with a link for each thing in them', async () => {
  const { repo, wtRoot } = makeHarness();
  const base = path.join(repo, 'node_modules');
  fs.mkdirSync(path.join(base, '@scope', 'a'), { recursive: true });
  fs.mkdirSync(path.join(base, '@scope', 'b'), { recursive: true });
  fs.mkdirSync(path.join(base, '.bin'));
  fs.symlinkSync('../@scope/a/index.js', path.join(base, '.bin', 'a'));
  fs.writeFileSync(path.join(base, '.bin', 'a.cmd'), 'a windows shim\n');
  const wt = addWorktree(repo, wtRoot, 'agent-scope');

  await linkWorktreeDeps(repo, wt);

  const here = path.join(wt, 'node_modules');
  for (const folder of ['@scope', '.bin']) {
    assert.equal(fs.lstatSync(path.join(here, folder)).isSymbolicLink(), false, `${folder} must not be a link npm can write through`);
    assert.equal(fs.lstatSync(path.join(here, folder)).isDirectory(), true);
  }
  assert.equal(fs.lstatSync(path.join(here, '@scope', 'a')).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(path.join(here, '.bin', 'a')).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(path.join(here, '.bin', 'a.cmd')).isSymbolicLink(), false, 'a plain file is copied: a junction cannot point at one');
  assert.equal(fs.readFileSync(path.join(here, '.bin', 'a.cmd'), 'utf8'), 'a windows shim\n');

  assert.deepEqual(await unlinkWorktreeDeps(repo, wt), { ok: true, removed: true });
  assert.throws(() => fs.lstatSync(here), /ENOENT/, 'and all of it comes out again, leaving nothing to look like work');
  assert.equal(fs.existsSync(path.join(base, '@scope', 'a')), true);
  assert.equal(fs.readFileSync(path.join(base, '.bin', 'a.cmd'), 'utf8'), 'a windows shim\n');
});

test('removing the links leaves what the worktree added inside a scope or .bin', async () => {
  const { repo, wtRoot } = makeHarness();
  const base = path.join(repo, 'node_modules');
  fs.mkdirSync(path.join(base, '@scope', 'a'), { recursive: true });
  fs.mkdirSync(path.join(base, '.bin'));
  fs.writeFileSync(path.join(base, '.bin', 'a.cmd'), 'base shim\n');
  const wt = addWorktree(repo, wtRoot, 'agent-scope-own');
  await linkWorktreeDeps(repo, wt);
  const here = path.join(wt, 'node_modules');
  fs.mkdirSync(path.join(here, '@scope', 'own'));
  fs.writeFileSync(path.join(here, '.bin', 'a.cmd'), 'changed by the worktree\n');

  assert.deepEqual(await unlinkWorktreeDeps(repo, wt), { ok: true, removed: true });

  assert.deepEqual(fs.readdirSync(path.join(here, '@scope')), ['own']);
  assert.equal(fs.readFileSync(path.join(here, '.bin', 'a.cmd'), 'utf8'), 'changed by the worktree\n');
});

test('a failed setup leaves nothing that looks finished, and a later run builds the whole view', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async (t) => {
  const { repo, wtRoot } = makeHarness();
  const base = path.join(repo, 'node_modules');
  fs.mkdirSync(path.join(base, 'aaa-before'), { recursive: true });
  fs.mkdirSync(path.join(base, '@scope', 'a'), { recursive: true });
  fs.mkdirSync(path.join(base, 'zzz-after'), { recursive: true });
  const scope = path.join(base, '@scope');
  fs.chmodSync(scope, 0o000);
  t.after(() => fs.chmodSync(scope, 0o755));
  const wt = addWorktree(repo, wtRoot, 'agent-partial');

  const failed = await linkWorktreeDeps(repo, wt);

  assert.equal(failed.ok, false);
  assert.throws(() => fs.lstatSync(path.join(wt, 'node_modules')), /ENOENT/, 'a partial view would be skipped by every later run');
  assert.deepEqual(fs.readdirSync(wt).filter((n) => n.includes('node_modules')), [], 'and nothing of its own is left');

  fs.chmodSync(scope, 0o755);
  assert.deepEqual(await linkWorktreeDeps(repo, wt), { ok: true, skipped: false });
  assert.deepEqual(fs.readdirSync(path.join(wt, 'node_modules')).sort(), ['@scope', 'aaa-before', 'zzz-after']);
  assert.deepEqual(fs.readdirSync(path.join(wt, 'node_modules', '@scope')), ['a']);
});

// The staging folder sits beside node_modules, where no ignore rule covers it and a repository can have anything.
for (const name of ['.node_modules.partial', '.node_modules.abc123', '.node_modules.']) {
  test(`setup leaves a committed folder named ${name} alone`, async () => {
    const { repo, wtRoot } = makeHarness();
    fs.mkdirSync(path.join(repo, 'node_modules', 'pkg'), { recursive: true });
    fs.mkdirSync(path.join(repo, name, 'tracked'), { recursive: true });
    fs.writeFileSync(path.join(repo, name, 'tracked', 'KEEP.txt'), 'the repository\'s file\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'a folder of that name');
    const wt = addWorktree(repo, wtRoot, 'agent-tracked');

    assert.deepEqual(await linkWorktreeDeps(repo, wt), { ok: true, skipped: false }, 'it sidesteps the name');

    assert.equal(fs.readFileSync(path.join(wt, name, 'tracked', 'KEEP.txt'), 'utf8'), 'the repository\'s file\n');
    assert.equal(git(wt, 'status', '--porcelain'), '?? node_modules/', 'nothing tracked changed');
    assert.equal(fs.lstatSync(path.join(wt, 'node_modules', 'pkg')).isSymbolicLink(), true);
  });
}

// Runs a setup that dies between building and moving into place, without its cleanup, so the leftover is the real one.
async function crashedSetup(t, repo, wt) {
  const fsp = require('node:fs/promises');
  const { rename, rm } = fsp;
  fsp.rename = async () => { throw new Error('crashed'); };
  fsp.rm = async () => { throw new Error('crashed'); };
  t.after(() => { fsp.rename = rename; fsp.rm = rm; });
  const result = await linkWorktreeDeps(repo, wt);
  fsp.rename = rename;
  fsp.rm = rm;
  assert.equal(result.ok, false);
  return fs.readdirSync(wt).filter((n) => n.startsWith('.node_modules.'));
}

test('a later setup clears what a crashed one left, and builds the whole view', async (t) => {
  const { repo, wtRoot } = makeHarness();
  fs.mkdirSync(path.join(repo, 'node_modules', 'pkg'), { recursive: true });
  const wt = addWorktree(repo, wtRoot, 'agent-crash');
  const leftovers = await crashedSetup(t, repo, wt);
  assert.equal(leftovers.length, 1, 'the crash left its staging folder');

  assert.deepEqual(await linkWorktreeDeps(repo, wt), { ok: true, skipped: false });

  assert.deepEqual(fs.readdirSync(wt).filter((n) => n.includes('node_modules')), ['node_modules']);
  assert.equal(fs.existsSync(path.join(repo, 'node_modules', 'pkg')), true, 'clearing the leftovers did not follow a link');
  assert.equal(git(wt, 'status', '--porcelain'), '?? node_modules/');
});

test('what a crash left in a worktree for another base is not ours to clear', async (t) => {
  const { repo, wtRoot } = makeHarness();
  fs.mkdirSync(path.join(repo, 'node_modules', 'pkg'), { recursive: true });
  const wt = addWorktree(repo, wtRoot, 'agent-forged');
  const [leftover] = await crashedSetup(t, repo, wt);
  // The stamp names the base it was built for, which a committed copy of the folder would not.
  const other = path.join(wtRoot, 'other-base');
  fs.mkdirSync(path.join(other, 'node_modules', 'pkg'), { recursive: true });

  assert.deepEqual(await linkWorktreeDeps(other, wt), { ok: true, skipped: false });

  assert.equal(fs.existsSync(path.join(wt, leftover)), true);
});

test('a folder that only resembles a stamped leftover survives', async () => {
  const { repo, wtRoot } = makeHarness();
  fs.mkdirSync(path.join(repo, 'node_modules', 'pkg'), { recursive: true });
  const wt = addWorktree(repo, wtRoot, 'agent-resembles');
  const dir = path.join(wt, '.node_modules.lookalike');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, '.staging'), 'not what setup writes\n');
  fs.writeFileSync(path.join(dir, 'KEEP.txt'), 'mine\n');
  fs.writeFileSync(path.join(wt, '.node_modules.a-file'), 'a plain file\n');

  assert.deepEqual(await linkWorktreeDeps(repo, wt), { ok: true, skipped: false });

  assert.equal(fs.readFileSync(path.join(dir, 'KEEP.txt'), 'utf8'), 'mine\n');
  assert.equal(fs.readFileSync(path.join(wt, '.node_modules.a-file'), 'utf8'), 'a plain file\n');
});

test('the finished node_modules carries no staging stamp', async () => {
  const { repo, wtRoot } = makeHarness();
  fs.mkdirSync(path.join(repo, 'node_modules', 'pkg'), { recursive: true });
  const wt = addWorktree(repo, wtRoot, 'agent-stamp');
  await linkWorktreeDeps(repo, wt);
  assert.deepEqual(fs.readdirSync(path.join(wt, 'node_modules')), ['pkg']);
});
