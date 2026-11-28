'use strict';

// This installation's machine id: made once in the app data folder, private, and read back the same. An id file that
// is not a private regular file holding one id, or one that cannot be made, gives no id.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { ensureMachineId, machineId, machineIdFile } = loadTs('src/core/machineId.ts');

function place(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-lock-machine-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the machine id is made once, private, and read back the same; it is never made by a read', (t) => {
  const dir = place(t);
  const file = path.join(dir, 'app', 'machine-id');
  assert.equal(machineId(file), null, 'a read makes nothing');
  assert.equal(fs.existsSync(file), false);
  const id = ensureMachineId(file);
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(ensureMachineId(file), id, 'made once');
  assert.equal(machineId(file), id);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['machine-id'], 'no temporary file is left');
});

test('an id file that is a link, readable by others or not an id gives no id, and is left alone', (t) => {
  const dir = place(t);
  const target = path.join(dir, 'target');
  fs.writeFileSync(target, `${'c'.repeat(32)}\n`, { mode: 0o600 });
  const link = path.join(dir, 'link-id');
  fs.symlinkSync(target, link);
  assert.equal(ensureMachineId(link), null, 'a link');
  const open = path.join(dir, 'open-id');
  fs.writeFileSync(open, `${'c'.repeat(32)}\n`);
  fs.chmodSync(open, 0o644);
  assert.equal(ensureMachineId(open), null, 'readable by others');
  const junk = path.join(dir, 'junk-id');
  fs.writeFileSync(junk, 'not an id\n', { mode: 0o600 });
  assert.equal(ensureMachineId(junk), null, 'not an id');
  assert.equal(fs.readFileSync(junk, 'utf8'), 'not an id\n');
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
});

test('an id that cannot be made gives no id', { skip: process.getuid && process.getuid() === 0 ? 'root can write anywhere' : false }, (t) => {
  const dir = place(t);
  const ro = path.join(dir, 'ro');
  fs.mkdirSync(ro, { mode: 0o500 });
  try {
    assert.equal(ensureMachineId(path.join(ro, 'machine-id')), null);
    assert.deepEqual(fs.readdirSync(ro), [], 'nothing is left behind');
  } finally {
    fs.chmodSync(ro, 0o700);
  }
});

test('the id file is in the app data folder', () => {
  assert.equal(machineIdFile('darwin', {}, '/Users/u'), '/Users/u/Library/Application Support/munder-difflin/machine-id');
});
