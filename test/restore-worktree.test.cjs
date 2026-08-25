'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const {
  restoreWorktreePlan,
  restoredWorktreeResult
} = loadTs('src/renderer/src/hooks/restoreWorktree.ts');
const { addWorktree, removeWorktree } = loadTs('src/main/git.ts');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function repoWithCommit(t) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'md-restore-worktree-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  git(repo, ['init', '-b', 'main']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'fixture\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'fixture']);
  return repo;
}

test('a missing saved worktree is recreated as an isolated spawn', () => {
  assert.deepEqual(restoreWorktreePlan('/repo', '/repo/.munder/agent-a', false), {
    cwd: '/repo',
    isolate: true,
    action: 'worktree missing — recreating'
  });
});

test('an existing saved worktree is resumed in place', () => {
  assert.deepEqual(restoreWorktreePlan('/repo', '/repo/.munder/agent-a', true), {
    cwd: '/repo/.munder/agent-a',
    isolate: false,
    action: 'starting up'
  });
});

test('a shared-cwd agent remains a non-isolated restore', () => {
  assert.deepEqual(restoreWorktreePlan('/repo', undefined, false), {
    cwd: '/repo',
    isolate: false,
    action: 'starting up'
  });
});

test('a recreated worktree path replaces the missing saved path', () => {
  assert.deepEqual(
    restoredWorktreeResult(
      restoreWorktreePlan('/repo', '/repo/.munder/old-agent-a', false),
      '/repo/.munder/new-agent-a',
      '/repo/.munder/old-agent-a'
    ),
    { action: 'worktree missing — recreating', worktreePath: '/repo/.munder/new-agent-a' }
  );
});

test('a failed worktree recreation is labelled as the base-repo fallback and does not retry', () => {
  assert.deepEqual(
    restoredWorktreeResult(
      restoreWorktreePlan('/repo', '/repo/.munder/old-agent-a', false),
      undefined,
      '/repo/.munder/old-agent-a'
    ),
    { action: 'worktree gone — using base repo', worktreePath: undefined }
  );
});

test('a removed agent worktree reattaches its surviving branch', async (t) => {
  const repo = repoWithCommit(t);
  const worktree = path.join(repo, '.hive-worktrees', 'agent-a');
  const first = await addWorktree(repo, worktree, 'main');
  assert.equal(first.ok, true);
  assert.equal((await removeWorktree(repo, worktree)).ok, true);

  const restored = await addWorktree(repo, worktree, 'main');
  assert.deepEqual(restored, { ok: true });
  assert.equal(git(worktree, ['branch', '--show-current']), 'agent/agent-a');
});

test('the restore spawn is wired to the worktree plan and its result', () => {
  // The plan helpers above are pure and covered; this pins the CALL SITE, which
  // would otherwise stay green if the hook ignored them and hardcoded isolation.
  const hookPath = path.join(__dirname, '..', 'src', 'renderer', 'src', 'hooks', 'useRestoreTeam.ts');
  const activeSource = fs
    .readFileSync(hookPath, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');

  // Bounded to the restore spawn call so a match somewhere else in the file
  // cannot stand in for the wiring under test.
  const start = activeSource.indexOf('window.cth.spawnPty(');
  const end = activeSource.indexOf('hive: {', start);
  assert.ok(start !== -1 && end > start, 'restore spawn call not found');
  const spawnArgs = activeSource.slice(start, end);

  assert.match(spawnArgs, /cwd: worktree\.cwd/);
  assert.doesNotMatch(spawnArgs, /cwd: a\.cwd/);
  assert.match(spawnArgs, /isolate: worktree\.isolate/);
  assert.match(activeSource, /restoredWorktreeResult\(/);
});
