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

const { refusedWrite } = loadTs('src/main/writeRoots.ts');

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
