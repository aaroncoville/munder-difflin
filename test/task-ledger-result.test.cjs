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

test('the three task IPC handlers answer through one shared queue of retried writes', () => {
  const main = sourceAssert.activeSource('src/main/index.ts');
  const handler = (channel, next) => sourceAssert.boundedSlice(main, `ipcMain.handle('${channel}'`, `ipcMain.handle('${next}'`);
  assert.equal((main.match(/\bserialTaskWrites\(\)/g) || []).length, 1, 'one queue, made once');
  assert.match(main, /^const taskWrites = serialTaskWrites\(\);$/m, 'made at module level, not per call');
  assert.match(handler('hive:addTask', 'hive:patchTask'), /return taskWrites\(\s*'addTask',\s*\(\)\s*=>\s*hive\.addTask\(/);
  assert.match(handler('hive:patchTask', 'hive:deleteTask'), /return taskWrites\(\s*'patchTask',\s*\(\)\s*=>\s*hive\.patchTask\(/);
  assert.match(handler('hive:deleteTask', 'hive:setArchived'), /return taskWrites\(\s*'deleteTask',\s*\(\)\s*=>\s*hive\.deleteTask\(/);
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

// A write that found the ledger busy waits without holding its place, so a later
// edit of the same card could land first and then be overwritten by the earlier
// one. The task IPC handlers share one queue, so each write, retries included,
// finishes before the next one starts.

const { serialTaskWrites } = loadTs('src/main/taskLedgerResult.ts');

test('a busy write retried later cannot land after a later write to the same card', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-ledger-order-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'tasks.json');
  fs.writeFileSync(file, JSON.stringify({ tasks: [{ id: 'c', status: 'todo' }] }));
  const lock = `${file}.lock`;
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, host: os.hostname(), acquiredAt: new Date().toISOString(), token: 'other' }));
  const move = (status) => () => updateTaskLedgerFile(file, (cards) => cards.map((c) => (c.id === 'c' ? { ...c, status } : c)), { waitMs: 20 }) !== null;
  const status = () => JSON.parse(fs.readFileSync(file, 'utf8')).tasks[0].status;

  const writes = serialTaskWrites();
  let wake = null;
  const sleep = () => new Promise((resolve) => { wake = resolve; });
  // Move A finds the ledger busy and pauses before trying again.
  const a = writes('patchTask', move('doing'), { sleep, log: () => {} });
  for (let i = 0; i < 1000 && !wake; i++) await new Promise((r) => setImmediate(r));
  assert.ok(wake, 'move A found the ledger busy and is waiting to try again');
  // The holder lets go, and move B is issued after A.
  fs.unlinkSync(lock);
  const b = writes('patchTask', move('done'), { log: () => {} });
  await new Promise((r) => setTimeout(r, 50));
  wake();
  assert.deepEqual(await a, { ok: true });
  assert.deepEqual(await b, { ok: true });
  assert.equal(status(), 'done', 'the later move B is the one the ledger keeps');
});

test('a write that fails, or rejects, does not stop the writes queued after it', async () => {
  const writes = serialTaskWrites();
  const failed = writes('deleteTask', () => { throw new Error('disk on fire'); }, { log: () => {} });
  const rejected = writes('patchTask', () => { throw busy(); }, { sleep: async () => { throw new Error('no timer'); }, log: () => {} });
  const last = writes('addTask', () => true);
  assert.deepEqual(await failed, { ok: false, error: 'disk on fire' });
  await assert.rejects(rejected, /no timer/);
  assert.deepEqual(await last, { ok: true });
});

// The queue must not grow without bound, and against a holder that keeps the
// lock, each queued edit must not spend its own few seconds of retries.

test('once an edit gives up on a busy ledger, the edits queued behind it fail at once with the same error', async () => {
  const writes = serialTaskWrites();
  const pauses = [];
  const sleep = async (ms) => { pauses.push(ms); };
  let later = 0;
  const first = writes('patchTask', () => { throw busy(); }, { delaysMs: [10, 20], sleep, log: () => {} });
  const behind = [1, 2, 3].map(() => writes('patchTask', () => { later++; throw busy(); }, { delaysMs: [10, 20], sleep, log: () => {} }));
  const given = await first;
  assert.equal(given.ok, false);
  assert.match(given.error, /busy/);
  for (const answer of await Promise.all(behind)) assert.deepEqual(answer, given, 'answered with the same busy error');
  assert.equal(later, 0, 'the edits queued behind it were not tried');
  assert.deepEqual(pauses, [10, 20], 'only the first edit paused');
  // An edit made after the failure is tried as usual.
  assert.deepEqual(await writes('addTask', () => true), { ok: true });
});

test('at most 50 edits are held; past that an edit is answered busy at once', async () => {
  const writes = serialTaskWrites();
  let release = null;
  let first = true;
  const running = writes('patchTask', () => { if (first) { first = false; throw busy(); } return true; },
    { delaysMs: [1], sleep: () => new Promise((resolve) => { release = resolve; }), log: () => {} });
  for (let i = 0; i < 1000 && !release; i++) await new Promise((r) => setImmediate(r));
  assert.ok(release, 'the first edit is waiting to try again');
  let wrote = 0;
  const queued = Array.from({ length: 60 }, () => writes('addTask', () => { wrote++; return true; }));
  const settled = new Set();
  queued.forEach((p, i) => p.then(() => settled.add(i)));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual([...settled].sort((a, b) => a - b), Array.from({ length: 11 }, (_, i) => 49 + i),
    'the edits past the 50th are answered at once; the others wait their turn');
  for (const answer of await Promise.all(queued.slice(49))) {
    assert.equal(answer.ok, false);
    assert.match(answer.error, /busy/);
  }
  release();
  assert.deepEqual(await running, { ok: true });
  for (const answer of await Promise.all(queued.slice(0, 49))) assert.deepEqual(answer, { ok: true });
  assert.equal(wrote, 49, 'only the edits that were held were written');
  assert.deepEqual(await writes('addTask', () => true), { ok: true }, 'the queue takes edits again once it drains');
});

// On a volume that cannot make hard links the ledger lock cannot be taken
// safely, so task ledger writes are refused there. The window must be told
// why, and the ledger must be left exactly as it was.

test('on a volume without hard links, an edit from the window answers ok: false with the reason and writes nothing', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-ledger-nolink-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'tasks.json');
  fs.writeFileSync(file, JSON.stringify({ tasks: [{ id: 'a', status: 'todo' }] }, null, 2));
  const before = fs.readFileSync(file);
  const link = () => { throw Object.assign(new Error('EPERM: operation not permitted, link'), { code: 'EPERM' }); };
  const lines = [];
  const writes = serialTaskWrites();
  const answer = await writes('patchTask',
    () => updateTaskLedgerFile(file, (cards) => cards.map((c) => ({ ...c, status: 'done' })), { waitMs: 50, link }) !== null,
    { sleep: async () => { throw new Error('must not pause: this is not a busy ledger'); }, log: (l) => lines.push(l) });
  assert.equal(answer.ok, false);
  assert.match(answer.error, /does not support hard links/);
  assert.match(answer.error, /task ledger writes are disabled/);
  assert.equal(lines.length, 1, 'the failure is logged once');
  assert.ok(fs.readFileSync(file).equals(before), 'tasks.json is byte for byte as it was');
  assert.deepEqual(fs.readdirSync(dir), ['tasks.json'], 'no lock or temporary file is left');
});
