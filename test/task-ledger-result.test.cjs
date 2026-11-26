'use strict';

// The renderer's task IPC (hive:addTask, hive:patchTask, hive:deleteTask) answers
// { ok, error? }. A task-ledger write that fails, most often because another
// process holds tasks.json.lock, must come back as { ok: false, error } with a
// log line naming the holder, not as a rejected invoke.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const sourceAssert = require('./source-assert.cjs');

const { taskWriteResult } = loadTs('src/main/taskLedgerResult.ts');
const { TaskLedgerLockTimeout } = loadTs('src/core/taskLedgerFile.ts');

test('a write that succeeds or finds nothing to do passes its answer through', () => {
  const lines = [];
  assert.deepEqual(taskWriteResult('addTask', () => true, (l) => lines.push(l)), { ok: true });
  assert.deepEqual(taskWriteResult('addTask', () => false, (l) => lines.push(l)), { ok: false });
  assert.deepEqual(lines, []);
});

test('a busy lock becomes { ok: false, error } and a log line naming the holder', () => {
  const lines = [];
  const result = taskWriteResult('patchTask', () => {
    throw new TaskLedgerLockTimeout('/h/tasks.json.lock', 250, 'pid 4242 on some-host since 2026-11-26T00:00:00.000Z');
  }, (l) => lines.push(l));
  assert.equal(result.ok, false);
  assert.match(result.error, /busy/);
  assert.match(result.error, /try again/i);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /patchTask/);
  assert.match(lines[0], /pid 4242 on some-host/);
});

test('any other failure of the write also becomes { ok: false, error }', () => {
  const lines = [];
  const result = taskWriteResult('deleteTask', () => { throw new Error('/h/tasks.json is not valid JSON, so it was left as it is'); }, (l) => lines.push(l));
  assert.deepEqual(result, { ok: false, error: '/h/tasks.json is not valid JSON, so it was left as it is' });
  assert.equal(lines.length, 1);
});

test('the three task IPC handlers answer through taskWriteResult', () => {
  const main = sourceAssert.activeSource('src/main/index.ts');
  const handler = (channel, next) => sourceAssert.boundedSlice(main, `ipcMain.handle('${channel}'`, `ipcMain.handle('${next}'`);
  assert.match(handler('hive:addTask', 'hive:patchTask'), /taskWriteResult\(\s*'addTask',\s*\(\)\s*=>\s*hive\.addTask\(/);
  assert.match(handler('hive:patchTask', 'hive:deleteTask'), /taskWriteResult\(\s*'patchTask',\s*\(\)\s*=>\s*hive\.patchTask\(/);
  assert.match(handler('hive:deleteTask', 'hive:setArchived'), /taskWriteResult\(\s*'deleteTask',\s*\(\)\s*=>\s*hive\.deleteTask\(/);
});
