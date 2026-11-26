'use strict';

// HiveManager's task-ledger writes go through updateTaskLedgerFile: they take
// tasks.json.lock, edit the ledger as it is on disk under that lock, and replace
// the file by rename. So the app's own writes cannot interleave with another
// process's, and a card that process adds is not lost to the app's write.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const loadTs = require('./load-ts.cjs');
const { allCommitsIdle } = loadTs('src/core/hiveCommit.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-ledger-lock-'));
  t.after(async () => { await allCommitsIdle(); fs.rmSync(home, { recursive: true, force: true }); });
  const hive = new HiveManager(() => home);
  hive.ensureHive();
  return { hive, file: path.join(hive.root(), 'tasks.json') };
}

const card = (id) => ({ id, title: id, status: 'todo', createdAt: '2026-11-26T00:00:00.000Z' });
const ids = (file) => JSON.parse(fs.readFileSync(file, 'utf8')).tasks.map((c) => c.id);

function child(t, script, args) {
  const proc = spawn(process.execPath, ['-e', script, ...args], { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  proc.stderr.on('data', (d) => { err += d; });
  const done = new Promise((resolve, reject) => proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`child exited ${code}: ${err}`)))));
  t.after(() => proc.kill());
  return { proc, done };
}

test('writeTasks waits for a lock another process holds, then writes', async (t) => {
  const { hive, file } = floor(t);
  const lock = `${file}.lock`;
  // The child takes the lock, reports it, holds it for 400 ms and releases it.
  const { proc, done } = child(t, `
    const fs = require('node:fs'); const os = require('node:os');
    const lock = process.argv[1];
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, host: os.hostname(), acquiredAt: new Date().toISOString() }), { flag: 'wx' });
    process.stdout.write('held\\n');
    setTimeout(() => { fs.unlinkSync(lock); process.exit(0); }, 400);`, [lock]);
  await new Promise((resolve) => proc.stdout.once('data', resolve));
  const started = Date.now();
  hive.writeTasks([card('a')]);
  const waited = Date.now() - started;
  await done;
  assert.ok(waited >= 250, `writeTasks returned after ${waited} ms, while the lock was still held`);
  assert.deepEqual(ids(file), ['a']);
  assert.equal(fs.existsSync(lock), false, 'the lock is released');
});

test('writeTasks replaces tasks.json by rename and keeps its other top-level keys', (t) => {
  const { hive, file } = floor(t);
  fs.writeFileSync(file, JSON.stringify({ version: 2, tasks: [card('a')], owner: 'god' }, null, 2));
  const before = fs.statSync(file).ino;
  hive.writeTasks([card('a'), card('b')]);
  assert.notEqual(fs.statSync(file).ino, before, 'written to a new file and renamed, not in place');
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(disk.tasks.map((c) => c.id), ['a', 'b']);
  assert.equal(disk.version, 2);
  assert.equal(disk.owner, 'god');
});

test('addTask from the app and another process adding cards at the same time lose none', async (t) => {
  const { hive, file } = floor(t);
  const N = 40;
  const startAt = Date.now() + 1500;
  const { done } = child(t, `
    const loadTs = require(${JSON.stringify(path.join(__dirname, 'load-ts.cjs'))});
    const { updateTaskLedgerFile } = loadTs('src/core/taskLedgerFile.ts');
    const [file, n, startAt] = process.argv.slice(1);
    while (Date.now() < Number(startAt)) {}
    for (let i = 0; i < Number(n); i++) updateTaskLedgerFile(file, (cur) => [...cur, { id: 'svc-' + i }], { waitMs: 30000 });`,
  [file, String(N), String(startAt)]);
  while (Date.now() < startAt) { /* start together */ }
  for (let i = 0; i < N; i++) assert.equal(hive.addTask(card(`app-${i}`)), true);
  await done;
  const got = new Set(ids(file));
  const lost = [];
  for (const who of ['app', 'svc']) for (let i = 0; i < N; i++) if (!got.has(`${who}-${i}`)) lost.push(`${who}-${i}`);
  assert.deepEqual(lost, [], `${lost.length} of ${2 * N} cards lost`);
});
