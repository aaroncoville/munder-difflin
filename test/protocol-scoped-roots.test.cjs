'use strict';
/**
 * The hive protocol tells agents how commands run when scoped write roots are on: only a short list may run outside the
 * sandbox, and only when the command starts with one of them, so a test run has to be written without a leading `cd`.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { withSeatSettings } = require('./seat-settings-dir.cjs');
const { allCommitsIdle } = loadTs('src/core/hiveCommit.ts');

const { HiveManager } = loadTs('src/main/hive.ts');

const EXCLUDED = ['npm run test:focused', 'npm run build', 'npm run typecheck', 'git fetch *', 'git worktree add *', 'git worktree remove *', 'gh pr *', 'gh api *', 'glab mr *', 'glab api *', 'npm --prefix * run test:focused', 'npm --prefix * run build', 'npm --prefix * run typecheck'];

test('PROTOCOL.md says which commands may run outside the sandbox under scoped roots, and how to write them', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-protocol-scoped-'));
  t.after(async () => { await allCommitsIdle(); fs.rmSync(home, { recursive: true, force: true }); });
  const hive = withSeatSettings(new HiveManager(() => home));
  hive.ensureHive();
  const text = fs.readFileSync(path.join(home, 'hive', 'PROTOCOL.md'), 'utf8');
  const at = text.indexOf('## When scoped write roots are on');
  assert.ok(at !== -1, 'the section is there');
  const section = text.slice(at, text.indexOf('\n## ', at + 1) === -1 ? undefined : text.indexOf('\n## ', at + 1));
  for (const c of EXCLUDED) assert.ok(section.includes(`\`${c}\``), c);
  assert.ok(section.includes('`npm --prefix <dir> run test:focused`'), 'the form to use');
  assert.ok(section.includes('`cd <dir> && npm run'), 'the form that stays sandboxed');
  for (const s of ['`cd`', 'redirect', '`$(...)`']) assert.ok(section.includes(s), s);
  assert.ok(section.split('\n').length <= 12, 'a few lines');
});
