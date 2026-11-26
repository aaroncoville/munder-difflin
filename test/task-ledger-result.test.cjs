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

test('the three task IPC handlers answer through taskWriteResultWithRetry', () => {
  const main = sourceAssert.activeSource('src/main/index.ts');
  const handler = (channel, next) => sourceAssert.boundedSlice(main, `ipcMain.handle('${channel}'`, `ipcMain.handle('${next}'`);
  assert.match(handler('hive:addTask', 'hive:patchTask'), /taskWriteResultWithRetry\(\s*'addTask',\s*\(\)\s*=>\s*hive\.addTask\(/);
  assert.match(handler('hive:patchTask', 'hive:deleteTask'), /taskWriteResultWithRetry\(\s*'patchTask',\s*\(\)\s*=>\s*hive\.patchTask\(/);
  assert.match(handler('hive:deleteTask', 'hive:setArchived'), /taskWriteResultWithRetry\(\s*'deleteTask',\s*\(\)\s*=>\s*hive\.deleteTask\(/);
});

// The app waits only 250 ms for tasks.json.lock, because that wait blocks the
// Electron main thread. A writer that holds the lock a little longer (a CLI
// edit, a slow disk) is not a failure the user should see: the IPC handlers
// try again after a pause that does not block, and give up only when the
// ledger stays busy for a few seconds.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { taskWriteResultWithRetry } = loadTs('src/main/taskLedgerResult.ts');
const { updateTaskLedgerFile } = loadTs('src/core/taskLedgerFile.ts');

const busy = () => new TaskLedgerLockTimeout('/h/tasks.json.lock', 250, 'pid 4242 on some-host since 2026-11-26T00:00:00.000Z');

test('a busy ledger is tried again, without blocking, until the holder lets go', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-ledger-retry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'tasks.json');
  fs.writeFileSync(file, JSON.stringify({ tasks: [] }));
  // Another live process on this host holds the lock, and lets it go 400 ms later.
  fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: process.pid, host: os.hostname(), acquiredAt: new Date().toISOString(), token: 'other' }));
  setTimeout(() => fs.unlinkSync(`${file}.lock`), 400);

  const lines = [];
  let attempts = 0;
  const result = await taskWriteResultWithRetry('addTask', () => {
    attempts++;
    return updateTaskLedgerFile(file, (c) => [...c, { id: 'a' }], { waitMs: 50 }) !== null;
  }, { log: (l) => lines.push(l) });

  assert.deepEqual(result, { ok: true });
  assert.ok(attempts > 1, `expected the write to be tried more than once, got ${attempts}`);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).tasks.map((c) => c.id), ['a']);
  assert.deepEqual(lines, [], 'a busy spell that ends within the budget is not a failure');
});

test('a ledger that stays busy past the budget gives up with the busy error', async () => {
  const lines = [];
  const pauses = [];
  let attempts = 0;
  const result = await taskWriteResultWithRetry('patchTask', () => { attempts++; throw busy(); }, {
    delaysMs: [50, 100, 200],
    sleep: async (ms) => { pauses.push(ms); },
    log: (l) => lines.push(l)
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /busy/);
  assert.equal(attempts, 4, 'one attempt, then one after each pause');
  assert.deepEqual(pauses, [50, 100, 200]);
  assert.equal(lines.length, 1, 'the failure is logged once, at the end');
  assert.match(lines[0], /pid 4242 on some-host/);
});

test('the default pauses add up to about three seconds, growing each time', async () => {
  const pauses = [];
  await taskWriteResultWithRetry('addTask', () => { throw busy(); }, { sleep: async (ms) => { pauses.push(ms); }, log: () => {} });
  const total = pauses.reduce((a, b) => a + b, 0);
  assert.ok(pauses.length >= 3, `expected several pauses, got ${pauses}`);
  for (let i = 1; i < pauses.length; i++) assert.ok(pauses[i] > pauses[i - 1], `pauses should grow: ${pauses}`);
  assert.ok(total >= 1000 && total <= 3000, `pauses total ${total} ms`);
});

test('a failure other than a busy ledger is not tried again', async () => {
  const lines = [];
  let attempts = 0;
  const result = await taskWriteResultWithRetry('deleteTask', () => {
    attempts++;
    throw new Error('/h/tasks.json is not valid JSON, so it was left as it is');
  }, { sleep: async () => { throw new Error('must not pause'); }, log: (l) => lines.push(l) });
  assert.equal(attempts, 1);
  assert.deepEqual(result, { ok: false, error: '/h/tasks.json is not valid JSON, so it was left as it is' });
  assert.equal(lines.length, 1);
});

test('a write that finds nothing to do is not tried again', async () => {
  let attempts = 0;
  const result = await taskWriteResultWithRetry('patchTask', () => { attempts++; return false; }, { sleep: async () => { throw new Error('must not pause'); } });
  assert.deepEqual(result, { ok: false });
  assert.equal(attempts, 1);
});
