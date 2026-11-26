'use strict';

// updateTaskLedgerFile: read-modify-write of tasks.json under an exclusive lock
// file, written through a temporary file and a rename, so that more than one
// process can edit the ledger without losing each other's cards and no reader
// ever sees a half-written file.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const { updateTaskLedgerFile, TaskLedgerLockTimeout } = loadTs('src/core/taskLedgerFile.ts');

function hive(t, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-ledger-file-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'tasks.json');
  if (content !== undefined) fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  return { dir, file, lock: `${file}.lock` };
}

const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const ids = (file) => read(file).tasks.map((c) => c.id);
const leftovers = (dir) => fs.readdirSync(dir).filter((f) => f !== 'tasks.json');

/** A pid that belonged to a process that has already exited. */
function deadPid() {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
  return Number(r.stdout.toString());
}

function holdLock(lock, holder) {
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, host: os.hostname(), acquiredAt: new Date().toISOString(), ...holder }));
}

test('adds a card against the ledger read under the lock, and leaves no lock or temporary file', (t) => {
  const { dir, file } = hive(t, { tasks: [{ id: 'a', title: 'A' }] });
  const out = updateTaskLedgerFile(file, (current) => [...current, { id: 'b', title: 'B' }]);
  assert.deepEqual(ids(file), ['a', 'b']);
  assert.deepEqual(out.map((c) => c.id), ['a', 'b']);
  assert.deepEqual(leftovers(dir), []);
});

test('creates the ledger when there is none', (t) => {
  const { file } = hive(t);
  updateTaskLedgerFile(file, (current) => { assert.deepEqual(current, []); return [{ id: 'a' }]; });
  assert.deepEqual(ids(file), ['a']);
});

test('keeps unknown top-level keys and unknown card fields, in the existing JSON format', (t) => {
  const { file } = hive(t, { version: 3, tasks: [{ id: 'a', title: 'A', result: { deep: [1, 2] }, repo: 'x' }], notes: 'keep' });
  updateTaskLedgerFile(file, (current) => [{ id: 'a', title: 'A2' }, ...current.slice(1), { id: 'b' }],
    { now: () => new Date('2026-01-01T00:00:00.000Z') });
  const disk = fs.readFileSync(file, 'utf8');
  const parsed = JSON.parse(disk);
  assert.equal(parsed.version, 3);
  assert.equal(parsed.notes, 'keep');
  assert.deepEqual(Object.keys(parsed), ['version', 'tasks', 'notes']);
  assert.deepEqual(parsed.tasks[0].result, { deep: [1, 2] });
  assert.equal(parsed.tasks[0].repo, 'x');
  assert.equal(parsed.tasks[0].title, 'A2');
  assert.equal(disk, JSON.stringify(parsed, null, 2), 'two-space JSON with no trailing newline, as before');
});

test('replaces the file by rename, so a reader sees the old file or the new one, never a partial one', (t) => {
  const { dir, file } = hive(t, { tasks: [{ id: 'a' }] });
  const before = fs.statSync(file).ino;
  updateTaskLedgerFile(file, (current) => [...current, { id: 'b' }]);
  assert.notEqual(fs.statSync(file).ino, before, 'a new file was renamed over the old one, not written in place');
  assert.deepEqual(ids(file), ['a', 'b']);
  assert.deepEqual(leftovers(dir), []);
});

test('a mutate that returns null writes nothing and releases the lock', (t) => {
  const { dir, file } = hive(t, { tasks: [{ id: 'a' }] });
  const before = fs.statSync(file).ino;
  assert.equal(updateTaskLedgerFile(file, () => null), null);
  assert.equal(fs.statSync(file).ino, before);
  assert.deepEqual(leftovers(dir), []);
});

test('a mutate that throws leaves the ledger as it was and releases the lock', (t) => {
  const { dir, file } = hive(t, { tasks: [{ id: 'a' }] });
  assert.throws(() => updateTaskLedgerFile(file, () => { throw new Error('boom'); }), /boom/);
  assert.deepEqual(ids(file), ['a']);
  assert.deepEqual(leftovers(dir), []);
});

test('a lock held by a live process on this host is not broken: the writer waits, then fails clearly', (t) => {
  const { file, lock } = hive(t, { tasks: [{ id: 'a' }] });
  holdLock(lock);
  const started = Date.now();
  assert.throws(() => updateTaskLedgerFile(file, (c) => [...c, { id: 'b' }], { waitMs: 300 }),
    (e) => e instanceof TaskLedgerLockTimeout && /tasks\.json\.lock/.test(e.message) && new RegExp(`pid ${process.pid}`).test(e.message));
  assert.ok(Date.now() - started >= 300, 'it waited for the lock before giving up');
  assert.deepEqual(ids(file), ['a'], 'nothing was written');
  assert.ok(fs.existsSync(lock), "the holder's lock is left in place");
});

test('a fresh lock from another host is not broken either', (t) => {
  const { file, lock } = hive(t, { tasks: [] });
  holdLock(lock, { pid: deadPid(), host: 'some-other-host' });
  assert.throws(() => updateTaskLedgerFile(file, (c) => c, { waitMs: 200 }), TaskLedgerLockTimeout);
  assert.ok(fs.existsSync(lock));
});

test('a lock whose process has exited on this host is broken', (t) => {
  const { dir, file, lock } = hive(t, { tasks: [{ id: 'a' }] });
  holdLock(lock, { pid: deadPid() });
  updateTaskLedgerFile(file, (c) => [...c, { id: 'b' }], { waitMs: 300 });
  assert.deepEqual(ids(file), ['a', 'b']);
  assert.deepEqual(leftovers(dir), []);
});

test('a lock older than the stale bound is broken even when its process is alive', (t) => {
  const { file, lock } = hive(t, { tasks: [] });
  holdLock(lock, { acquiredAt: new Date(Date.now() - 60_000).toISOString() });
  updateTaskLedgerFile(file, (c) => [...c, { id: 'b' }], { waitMs: 300, staleMs: 30_000 });
  assert.deepEqual(ids(file), ['b']);
});

test('an unreadable ledger is refused by default, and treated as empty only when asked', (t) => {
  const { file } = hive(t, '{ "tasks": [ {"id": "a"} ');
  assert.throws(() => updateTaskLedgerFile(file, (c) => [...c, { id: 'b' }]), /tasks\.json/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ "tasks": [ {"id": "a"} ', 'the unreadable file is left alone');
  updateTaskLedgerFile(file, (c) => [...c, { id: 'b' }], { unreadable: 'empty' });
  assert.deepEqual(ids(file), ['b']);
});

test('two processes adding 50 cards each at the same time lose none', async (t) => {
  const { file } = hive(t, { tasks: [] });
  const N = 50;
  const startAt = Date.now() + 400;
  const script = `
    const loadTs = require(${JSON.stringify(path.join(__dirname, 'load-ts.cjs'))});
    const { updateTaskLedgerFile } = loadTs('src/core/taskLedgerFile.ts');
    const [file, who, n, startAt] = process.argv.slice(1);
    while (Date.now() < Number(startAt)) {}
    for (let i = 0; i < Number(n); i++) {
      updateTaskLedgerFile(file, (cur) => [...cur, { id: who + '-' + i }], { waitMs: 30000 });
    }`;
  const run = (who) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script, file, who, String(N), String(startAt)], { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`writer ${who} exited ${code}: ${err}`))));
  });
  await Promise.all([run('p'), run('q')]);
  const got = new Set(ids(file));
  const lost = [];
  for (const who of ['p', 'q']) for (let i = 0; i < N; i++) if (!got.has(`${who}-${i}`)) lost.push(`${who}-${i}`);
  assert.equal(got.size, 2 * N, `${lost.length} of ${2 * N} cards lost: ${lost.slice(0, 10).join(', ')}`);
});
