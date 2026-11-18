'use strict';
/**
 * No unsandboxed retry for Claude seats under scoped roots, except a short list of commands.
 *
 * Claude's Bash tool can rerun a command with the sandbox off (dangerouslyDisableSandbox) when the sandbox blocks it,
 * which walks straight past narrowed write roots. With the scopedRoots setting on, the seat's generated settings turn
 * that retry off and name the few commands that may still run outside the sandbox (the test suite, the build, the
 * type check, and the git and forge commands that need the network or the repository's own git folder). The rest of
 * the sandbox block is unchanged. Off (the default), the settings are as before.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { codexTestBase, jailHome } = require('./codex-test-home.cjs');
const { withSeatSettings } = require('./seat-settings-dir.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

const EXCLUDED = ['npm run test:focused', 'npm run build', 'npm run typecheck', 'git fetch *', 'git worktree add *', 'git worktree remove *', 'gh pr *', 'gh api *', 'glab mr *', 'glab api *', 'npm --prefix * run test:focused', 'npm --prefix * run build', 'npm --prefix * run typecheck'];

function floor(t) {
  const base = codexTestBase(t, 'mdsh-');
  jailHome(t, base);
  const harness = path.join(base, 'h');
  const work = path.join(base, 'work');
  for (const d of [harness, work]) fs.mkdirSync(d, { recursive: true });
  const hive = withSeatSettings(new HiveManager(() => harness));
  hive.ensureHive();
  return { harness, work, hive, root: hive.root() };
}

const spawn = (f, id, scopedRoots, isGod = false) => f.hive.ensureAgent({ id, name: id, provider: 'claude', cwd: isGod ? f.harness : f.work, isGod }, { spawnId: `pty-${id}`, ...(scopedRoots === undefined ? {} : { scopedRoots }) });
const settingsOf = (inj) => JSON.parse(fs.readFileSync(inj.args[inj.args.indexOf('--settings') + 1], 'utf8'));

test('flag off: the launch line and the sandbox block are as before', async (t) => {
  const f = floor(t);
  for (const [id, flag] of [['o0', undefined], ['o1', false]]) {
    const inj = await spawn(f, id, flag);
    assert.deepEqual(inj.args.filter((a, i) => i % 2 === 0), ['--append-system-prompt', '--settings'], id);
    const s = settingsOf(inj);
    assert.deepEqual(Object.keys(s.sandbox), ['enabled', 'filesystem'], id);
    assert.deepEqual(s.sandbox.filesystem, { allowWrite: [path.join(f.root, 'agents', id), f.root] }, id);
  }
});

test('flag on: no unsandboxed retry, and exactly the listed commands may run outside the sandbox', async (t) => {
  const f = floor(t);
  for (const [id, isGod] of [['a1', false], ['g1', true]]) {
    const s = settingsOf(await spawn(f, id, true, isGod));
    assert.equal(s.sandbox.allowUnsandboxedCommands, false, id);
    assert.deepEqual(s.sandbox.excludedCommands, EXCLUDED, id);
    assert.equal(s.sandbox.enabled, true, id);
    assert.ok(Array.isArray(s.sandbox.filesystem.allowWrite) && s.sandbox.filesystem.allowWrite.length > 0, id);
    assert.deepEqual(Object.keys(s.sandbox).sort(), ['allowUnsandboxedCommands', 'enabled', 'excludedCommands', 'filesystem'], id);
  }
});
