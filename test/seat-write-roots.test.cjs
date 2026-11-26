'use strict';
// A scoped seat is granted its own folder, the hive's evidence/ folder and a working folder outside the hive
// (writeRoots.ts seatRoots). evidence/ is granted only while it is a real folder: every agent could write the hive
// root, so a link planted at evidence/ would otherwise carry the write grant wherever it points.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { seatWriteRoots } = loadTs('src/core/writeRoots.ts');

function hive(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mdswr-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'hive');
  fs.mkdirSync(path.join(root, 'agents', 'ag1'), { recursive: true });
  return { base, root, own: path.join(root, 'agents', 'ag1') };
}

test('Given a real evidence/ folder, when the seat roots are computed, then evidence/ is granted', (t) => {
  const h = hive(t);
  fs.mkdirSync(path.join(h.root, 'evidence'));
  assert.deepEqual(seatWriteRoots({ root: h.root, agentId: 'ag1', isGod: false, cwd: '' }), [h.own, path.join(h.root, 'evidence')]);
});

test('Given evidence/ is a link to a folder outside the hive, when the seat roots are computed, then it is not granted', (t) => {
  const h = hive(t);
  const elsewhere = path.join(h.base, 'elsewhere');
  fs.mkdirSync(elsewhere);
  fs.symlinkSync(elsewhere, path.join(h.root, 'evidence'));
  assert.deepEqual(seatWriteRoots({ root: h.root, agentId: 'ag1', isGod: false, cwd: '' }), [h.own]);
});
