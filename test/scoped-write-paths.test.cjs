'use strict';
/**
 * How the scoped-roots write check reads the paths a protected call names.
 *
 * A protected call is allowed only when every path it names is inside the seat's roots, grants or temp folders. A call
 * whose paths cannot be read is refused rather than allowed: an edit tool call with no recognised path field (a field
 * renamed by a later CLI version would otherwise turn the check off without a sign), or a relative path with no
 * working folder in the hook call to read it against.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { codexTestBase } = require('./codex-test-home.cjs');

const { refusedWrite } = loadTs('src/core/writeRoots.ts');

function floor(t) {
  const base = codexTestBase(t, 'mdwp-');
  const root = path.join(base, 'h', 'hive');
  const work = path.join(base, 'work');
  for (const d of [path.join(root, 'agents', 'me', 'nested'), path.join(root, 'agents', 'other'), path.join(root, 'evidence'), work]) fs.mkdirSync(d, { recursive: true });
  const ctx = (cwd = work) => ({ root, agentId: 'me', isGod: false, cwd, grants: [], temp: [] });
  return { base, root, work, ctx, me: path.join(root, 'agents', 'me'), other: path.join(root, 'agents', 'other') };
}

test('an edit tool call with no recognised path field is refused', (t) => {
  const f = floor(t);
  for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
    assert.equal(refusedWrite(tool, { content: 'x' }, f.ctx()), 'unknown', `${tool} with no path`);
    assert.equal(refusedWrite(tool, { filePath: path.join(f.other, 'm.md'), content: 'x' }, f.ctx()), 'unknown', `${tool} with a renamed field`);
    assert.equal(refusedWrite(tool, undefined, f.ctx()), 'unknown', `${tool} with no input`);
  }
  assert.equal(refusedWrite('Write', { file_path: path.join(f.me, 'm.md'), content: 'x' }, f.ctx()), null, 'a recognised field inside the roots');
});

test('a relative path is read against the hook call\'s working folder, never the one the seat was spawned in', (t) => {
  const f = floor(t);
  const nested = path.join(f.me, 'nested');
  const evidence = path.join(f.root, 'evidence');
  // Spawned in a folder nested in its own folder, the CLI has since moved to evidence/: ../tasks.json is the hive's.
  assert.equal(refusedWrite('Write', { file_path: '../tasks.json' }, f.ctx(nested), evidence), 'tasks.json');
  assert.equal(refusedWrite('Write', { file_path: '../tasks.json' }, f.ctx(nested), nested), null, 'read against the call\'s folder, it is the seat\'s own');
  assert.equal(refusedWrite('apply_patch', { input: '*** Update File: ../agents/other/m.md\n' }, f.ctx(), evidence), 'other agent folder');
  assert.equal(refusedWrite('apply_patch', { input: '*** Add File: src/a.ts\n' }, f.ctx(), f.work), null);
});

test('a relative path with no working folder in the hook call is refused', (t) => {
  const f = floor(t);
  for (const cwd of [undefined, '', 'relative/dir', 42]) {
    assert.equal(refusedWrite('Write', { file_path: 'src/a.ts' }, f.ctx(), cwd), 'unknown', `call cwd ${JSON.stringify(cwd)}`);
    assert.equal(refusedWrite('apply_patch', { input: '*** Add File: src/a.ts\n' }, f.ctx(), cwd), 'unknown', `patch, call cwd ${JSON.stringify(cwd)}`);
  }
  assert.equal(refusedWrite('Write', { file_path: path.join(f.work, 'a.ts') }, f.ctx()), null, 'an absolute path needs no working folder');
});

test('a write to an existing file with more than one hard link is refused, in every root', (t) => {
  const f = floor(t);
  const outside = path.join(f.base, 'outside.txt');
  fs.writeFileSync(outside, 'theirs');
  const tmp = path.join(f.base, 'tmp');
  fs.mkdirSync(tmp);
  const c = { ...f.ctx(), temp: [tmp] };
  for (const dir of [f.me, path.join(f.root, 'evidence'), f.work, tmp]) {
    const alias = path.join(dir, 'alias.txt');
    fs.linkSync(outside, alias);
    for (const tool of ['Write', 'Edit', 'MultiEdit']) assert.equal(refusedWrite(tool, { file_path: alias }, c), 'hard link', `${tool} in ${dir}`);
    assert.equal(refusedWrite('apply_patch', { input: `*** Update File: ${alias}\n` }, c), 'hard link', `patch in ${dir}`);
    const plain = path.join(dir, 'plain.txt');
    fs.writeFileSync(plain, 'mine');
    assert.equal(refusedWrite('Write', { file_path: plain }, c), null, `a file with one link in ${dir}`);
    assert.equal(refusedWrite('Write', { file_path: path.join(dir, 'new.txt') }, c), null, `a new file in ${dir}`);
    fs.rmSync(alias);
  }
});
