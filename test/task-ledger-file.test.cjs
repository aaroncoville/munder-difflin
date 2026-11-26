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

test('a lock from another host older than the stale bound is broken', (t) => {
  const { file, lock } = hive(t, { tasks: [] });
  holdLock(lock, { host: 'some-other-host', acquiredAt: new Date(Date.now() - 60_000).toISOString() });
  updateTaskLedgerFile(file, (c) => [...c, { id: 'b' }], { waitMs: 300, staleMs: 30_000 });
  assert.deepEqual(ids(file), ['b']);
});

test('a lock on this host whose running holder cannot be checked (no start time recorded) is broken only on the much longer bound', (t) => {
  const { file, lock } = hive(t, { tasks: [] });
  holdLock(lock, { acquiredAt: new Date(Date.now() - 60_000).toISOString() });
  assert.throws(() => updateTaskLedgerFile(file, (c) => [...c, { id: 'b' }], { waitMs: 200, staleMs: 30_000 }), TaskLedgerLockTimeout);
  assert.deepEqual(ids(file), []);
  updateTaskLedgerFile(file, (c) => [...c, { id: 'b' }], { waitMs: 200, staleMs: 30_000, liveStaleMs: 50_000 });
  assert.deepEqual(ids(file), ['b']);
});

/** The lock record a real writer in this process puts in the lock, read while it holds the lock. */
function ownRecord(t) {
  const { file, lock } = hive(t, { tasks: [] });
  let record = null;
  updateTaskLedgerFile(file, (c) => { record = JSON.parse(fs.readFileSync(lock, 'utf8')); return c; });
  return record;
}

test('a live holder on this host is never broken, however old its lock', (t) => {
  const { started } = ownRecord(t);
  assert.equal(typeof started, 'string', 'the lock record names when its holder started');
  const { file, lock } = hive(t, { tasks: [] });
  holdLock(lock, { started, acquiredAt: new Date(Date.now() - 3_600_000).toISOString() });
  assert.throws(() => updateTaskLedgerFile(file, (c) => [...c, { id: 'b' }], { waitMs: 200, staleMs: 1_000, liveStaleMs: 2_000 }),
    TaskLedgerLockTimeout);
  assert.deepEqual(ids(file), [], 'nothing was written');
  assert.ok(fs.existsSync(lock), "the live holder's lock is left in place");
});

test('a lock whose pid is alive but belongs to a later process (pid reused) is broken', (t) => {
  const { started } = ownRecord(t);
  // Same pid, same way of reading a start time, a start time this process does not have.
  const reused = `${started.slice(0, started.indexOf(':') + 1)}not when this process started`;
  const { dir, file, lock } = hive(t, { tasks: [] });
  holdLock(lock, { started: reused, acquiredAt: new Date(Date.now() - 60_000).toISOString() });
  updateTaskLedgerFile(file, (c) => [...c, { id: 'b' }], { waitMs: 300, staleMs: 30_000 });
  assert.deepEqual(ids(file), ['b']);
  assert.deepEqual(leftovers(dir), []);
});

test('a holder paused between its ownership check and its rename keeps the lock, so no card is lost', async (t) => {
  const { dir, file, lock } = hive(t, { tasks: [{ id: 'seed' }] });
  const sync = fs.mkdtempSync(path.join(os.tmpdir(), 'md-ledger-sync-'));
  t.after(() => fs.rmSync(sync, { recursive: true, force: true }));
  // A takes the lock, prepares its ledger, finds the lock still its own, and stops just before the rename.
  const child = spawn(process.execPath, ['-e', `
    const fs = require('node:fs'); const path = require('node:path');
    const loadTs = require(${JSON.stringify(path.join(__dirname, 'load-ts.cjs'))});
    const { updateTaskLedgerFile } = loadTs('src/core/taskLedgerFile.ts');
    const [file, sync] = process.argv.slice(1);
    const nap = new Int32Array(new SharedArrayBuffer(4));
    updateTaskLedgerFile(file, (cur) => [...cur, { id: 'a' }], { hooks: { afterOwnershipCheck: () => {
      fs.writeFileSync(path.join(sync, 'a-checked'), '');
      while (!fs.existsSync(path.join(sync, 'a-go'))) Atomics.wait(nap, 0, 0, 5);
    } } });`, file, sync], { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  const done = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  t.after(() => child.kill());
  assert.ok(await waitForFile(path.join(sync, 'a-checked'), 10_000), err);
  // B arrives once A's lock is past every age bound B uses.
  await new Promise((r) => setTimeout(r, 300));
  assert.throws(() => updateTaskLedgerFile(file, (c) => [...c, { id: 'b' }], { waitMs: 200, staleMs: 50, liveStaleMs: 100 }),
    (e) => e instanceof TaskLedgerLockTimeout
      && new RegExp(`pid ${child.pid}\\b`).test(e.message)
      && e.message.includes(os.hostname())
      && /held for \d+(\.\d+)? s/.test(e.message),
    'B is told the ledger is busy, and by whom');
  fs.writeFileSync(path.join(sync, 'a-go'), '');
  assert.equal(await done, 0, err);
  assert.deepEqual(ids(file), ['seed', 'a'], "A's write landed");
  updateTaskLedgerFile(file, (c) => [...c, { id: 'b' }], { waitMs: 2_000 });
  assert.deepEqual(ids(file), ['seed', 'a', 'b'], 'no card was lost');
  assert.ok(!fs.existsSync(lock));
  assert.deepEqual(leftovers(dir), []);
});

test('an unreadable ledger is refused by default, and treated as empty only when asked', (t) => {
  const { file } = hive(t, '{ "tasks": [ {"id": "a"} ');
  assert.throws(() => updateTaskLedgerFile(file, (c) => [...c, { id: 'b' }]), /tasks\.json/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ "tasks": [ {"id": "a"} ', 'the unreadable file is left alone');
  updateTaskLedgerFile(file, (c) => [...c, { id: 'b' }], { unreadable: 'empty' });
  assert.deepEqual(ids(file), ['b']);
});

test('valid JSON of the wrong shape is refused by default and left as it is, and treated as empty only when asked', (t) => {
  for (const text of ['[{"id":"legacy"}]', '{"tasks":{"x":1}}', '{"tasks":"a"}', '{"tasks":null}', 'null', '42', '"tasks"']) {
    const { dir, file } = hive(t, text);
    assert.throws(() => updateTaskLedgerFile(file, (c) => [...c, { id: 'b' }]), /tasks\.json is not a task ledger/, text);
    assert.equal(fs.readFileSync(file, 'utf8'), text, `${text} is left alone`);
    assert.deepEqual(leftovers(dir), [], `${text}: no lock or temporary file is left`);
    updateTaskLedgerFile(file, (c) => [...c, { id: 'b' }], { unreadable: 'empty' });
    assert.deepEqual(ids(file), ['b'], text);
  }
});

test('an object without a tasks list is a ledger with no cards yet', (t) => {
  const { file } = hive(t, { version: 2 });
  updateTaskLedgerFile(file, (c) => [...c, { id: 'a' }]);
  assert.deepEqual(read(file).version, 2);
  assert.deepEqual(ids(file), ['a']);
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

// Runs updateTaskLedgerFile in a child process that stops at each named step
// until the test lets it go, so the order of two writers' steps is fixed.
// Steps: 'break' (a lock was judged stale), 'record' (about to make the lock
// its own, after breaking one) and 'mutate' (holding the lock). Each step stops
// once. On entering
// mutate the writer records whether the other writer was holding at that moment.
const STEPPED_WRITER = `
  const fs = require('node:fs'); const path = require('node:path');
  const loadTs = require(${JSON.stringify(path.join(__dirname, 'load-ts.cjs'))});
  const { updateTaskLedgerFile } = loadTs('src/core/taskLedgerFile.ts');
  const [file, sync, who, other, opts] = process.argv.slice(1);
  const nap = new Int32Array(new SharedArrayBuffer(4));
  const flag = (name) => path.join(sync, name);
  const seen = new Set();
  const stop = (step) => {
    if (seen.has(step)) return;
    seen.add(step);
    fs.writeFileSync(flag(who + '-at-' + step), '');
    while (!fs.existsSync(flag(who + '-go-' + step))) Atomics.wait(nap, 0, 0, 5);
  };
  updateTaskLedgerFile(file, (cur) => {
    const otherHolding = fs.existsSync(flag(other + '-in')) && !fs.existsSync(flag(other + '-out'));
    fs.writeFileSync(flag(who + '-in'), String(otherHolding));
    stop('mutate');
    fs.writeFileSync(flag(who + '-out'), '');
    return [...cur, { id: who }];
  }, { waitMs: 30000, ...JSON.parse(opts || '{}'), hooks: { beforeBreak: () => stop('break'), beforeLockRecorded: () => { if (seen.has('break')) stop('record'); } } });`;

function steppedWriter(t, file, sync, who, other, opts = {}) {
  const child = spawn(process.execPath, ['-e', STEPPED_WRITER, file, sync, who, other, JSON.stringify(opts)],
    { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  const done = new Promise((resolve, reject) => child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`writer ${who} exited ${code}: ${err}`)))));
  t.after(() => child.kill());
  return {
    done,
    go: (step) => fs.writeFileSync(path.join(sync, `${who}-go-${step}`), ''),
    reached: (step, ms = 10_000) => waitForFile(path.join(sync, `${who}-${step === 'in' ? 'in' : `at-${step}`}`), ms)
  };
}

async function waitForFile(p, ms) {
  const until = Date.now() + ms;
  while (!fs.existsSync(p)) {
    if (Date.now() > until) return false;
    await new Promise((r) => setTimeout(r, 5));
  }
  return true;
}

test('two writers breaking the same empty stale lock never both hold the lock', async (t) => {
  const { dir, file, lock } = hive(t, { tasks: [] });
  const sync = fs.mkdtempSync(path.join(os.tmpdir(), 'md-ledger-sync-'));
  t.after(() => fs.rmSync(sync, { recursive: true, force: true }));
  // A writer that died after creating the lock and before recording itself in it.
  fs.writeFileSync(lock, '');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, old, old);

  const a = steppedWriter(t, file, sync, 'a', 'b');
  const b = steppedWriter(t, file, sync, 'b', 'a');
  // Both judge the empty lock stale.
  assert.ok(await a.reached('break'));
  assert.ok(await b.reached('break'));
  // A breaks it and is about to make the lock its own.
  a.go('break');
  assert.ok(await a.reached('record'));
  // B acts on its earlier judgement, then takes the lock and holds it.
  b.go('break');
  assert.ok(await b.reached('record'));
  b.go('record');
  assert.ok(await b.reached('in'));
  // A finishes taking the lock while B holds it.
  a.go('record');
  await a.reached('in', 1500);
  b.go('mutate');
  assert.ok(await a.reached('in'));
  a.go('mutate');
  await Promise.all([a.done, b.done]);

  assert.equal(fs.readFileSync(path.join(sync, 'a-in'), 'utf8'), 'false', 'A entered its update while B held the lock');
  assert.equal(fs.readFileSync(path.join(sync, 'b-in'), 'utf8'), 'false', 'B entered its update while A held the lock');
  assert.deepEqual(ids(file).sort(), ['a', 'b']);
  assert.deepEqual(leftovers(dir), []);
});

test('a breaker removes only the very lock it judged stale, even when another has the same content', (t) => {
  const { file, lock } = hive(t, { tasks: [] });
  fs.writeFileSync(lock, '');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, old, old);
  let fresh = null;
  const hooks = {
    beforeBreak: () => {
      if (fresh) return;
      // Between the judgement and the break, another writer replaced the stale lock with a fresh one
      // that has the same (empty) content.
      fs.unlinkSync(lock);
      fs.writeFileSync(lock, '');
      fresh = fs.statSync(lock).ino;
    }
  };
  assert.throws(() => updateTaskLedgerFile(file, (c) => [...c, { id: 'b' }], { waitMs: 200, hooks }), TaskLedgerLockTimeout);
  assert.equal(fs.statSync(lock).ino, fresh, 'the fresh lock is still in place');
  assert.deepEqual(ids(file), [], 'nothing was written');
});

test('a breaker leaves a lock that has the judged file\'s inode but another holder\'s token', (t) => {
  const { file, lock } = hive(t, { tasks: [] });
  holdLock(lock, { pid: deadPid(), token: 'dead-holder' });
  let rewritten = false;
  const hooks = {
    beforeBreak: () => {
      if (rewritten) return;
      rewritten = true;
      // The judged lock was replaced by a live holder's lock on a file with the same device and inode (an
      // inode number reused at once, here made by writing the file in place).
      fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, host: os.hostname(), acquiredAt: new Date().toISOString(), token: 'live-holder' }));
    }
  };
  assert.throws(() => updateTaskLedgerFile(file, (c) => [...c, { id: 'b' }], { waitMs: 200, hooks }), TaskLedgerLockTimeout);
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).token, 'live-holder', "the live holder's lock is still in place");
  assert.deepEqual(ids(file), [], 'nothing was written');
});

test('a lock never exists without its record', (t) => {
  const { file, lock } = hive(t, { tasks: [] });
  const records = [];
  const look = () => { if (fs.existsSync(lock)) records.push(fs.readFileSync(lock, 'utf8')); };
  updateTaskLedgerFile(file, (c) => { look(); return [...c, { id: 'a' }]; }, { hooks: { beforeLockRecorded: look } });
  assert.ok(records.length > 0);
  for (const text of records) assert.equal(typeof JSON.parse(text).token, 'string', `lock seen as ${JSON.stringify(text)}`);
});

test('a live holder slower than the stale bound is not broken, so a second writer loses nothing', async (t) => {
  const { dir, file } = hive(t, { tasks: [] });
  const sync = fs.mkdtempSync(path.join(os.tmpdir(), 'md-ledger-sync-'));
  t.after(() => fs.rmSync(sync, { recursive: true, force: true }));
  // The slow holder takes the lock and pauses inside its update for three times the stale bound.
  const child = spawn(process.execPath, ['-e', `
    const fs = require('node:fs'); const path = require('node:path');
    const loadTs = require(${JSON.stringify(path.join(__dirname, 'load-ts.cjs'))});
    const { updateTaskLedgerFile } = loadTs('src/core/taskLedgerFile.ts');
    const [file, sync] = process.argv.slice(1);
    updateTaskLedgerFile(file, (cur) => {
      fs.writeFileSync(path.join(sync, 'holding'), '');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 900);
      return [...cur, { id: 'slow' }];
    }, { staleMs: 300 });`, file, sync], { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  const done = new Promise((resolve) => child.on('exit', (code) => resolve({ code, err })));
  t.after(() => child.kill());
  assert.ok(await waitForFile(path.join(sync, 'holding'), 10_000));
  await new Promise((r) => setTimeout(r, 450));
  let second = 'written';
  try {
    updateTaskLedgerFile(file, (c) => [...c, { id: 'fast' }], { staleMs: 300, waitMs: 10_000 });
  } catch (e) {
    second = `refused: ${e.message}`;
  }
  const slow = await done;
  const cards = ids(file);
  // Neither writer may report a card as written that the ledger then does not hold.
  if (second === 'written') assert.ok(cards.includes('fast'), `the second writer's card was lost: ${cards}`);
  if (slow.code === 0) assert.ok(cards.includes('slow'), `the slow holder's card was lost: ${cards}`);
  assert.deepEqual(cards.sort(), ['fast', 'slow'], `second writer ${second}; slow holder exited ${slow.code} ${slow.err}`);
  assert.deepEqual(leftovers(dir), []);
});

test('a writer whose lock was taken from it while it worked writes nothing and says so', (t) => {
  const { file, lock } = hive(t, { tasks: [{ id: 'a' }] });
  assert.throws(() => updateTaskLedgerFile(file, (c) => {
    // Another writer broke this writer's lock and took its own.
    fs.unlinkSync(lock);
    holdLock(lock, { token: 'someone-else' });
    return [...c, { id: 'b' }];
  }), (e) => /no longer holds/.test(e.message) && /tasks\.json\.lock/.test(e.message));
  assert.deepEqual(ids(file), ['a'], 'nothing was written');
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).token, 'someone-else', "the other writer's lock is left in place");
});

test('a lock put back in place by a breaker that took it aside by mistake is still its holder\'s', (t) => {
  const { dir, file, lock } = hive(t, { tasks: [] });
  updateTaskLedgerFile(file, (c) => {
    fs.renameSync(lock, `${lock}.stale-test`);
    fs.linkSync(`${lock}.stale-test`, lock);
    fs.unlinkSync(`${lock}.stale-test`);
    return [...c, { id: 'a' }];
  });
  assert.deepEqual(ids(file), ['a']);
  assert.deepEqual(leftovers(dir), []);
});

/** Makes fs.writeSync write at most `max` bytes per call, as a blocking write to a regular file may.
 *  Armed from inside mutate, so only the ledger's own write is affected, not the lock's. */
function shortWrites(t, max) {
  const real = fs.writeSync;
  t.after(() => { fs.writeSync = real; });
  const restore = () => { fs.writeSync = real; };
  const arm = () => { fs.writeSync = function (fd, data, offset, length, position) {
    const buf = typeof data === 'string' ? Buffer.from(data) : data;
    const off = typeof data !== 'string' && typeof offset === 'number' ? offset : 0;
    const len = typeof data !== 'string' && typeof length === 'number' ? length : buf.length - off;
    if (max === 0) return 0;
    return real.call(fs, fd, buf, off, Math.min(max, len), typeof data !== 'string' ? position : null);
  }; };
  return { arm, restore };
}

test('a write that completes only part of the ledger at a time still writes all of it', (t) => {
  const { dir, file } = hive(t, { tasks: [{ id: 'a', title: 'x'.repeat(500) }] });
  const short = shortWrites(t, 64);
  updateTaskLedgerFile(file, (c) => { short.arm(); return [...c, { id: 'b', title: 'y'.repeat(500) }]; });
  short.restore();
  assert.deepEqual(ids(file), ['a', 'b']);
  assert.deepEqual(leftovers(dir), []);
});

test('a write that stops making progress leaves the ledger as it was', (t) => {
  const { dir, file } = hive(t, { tasks: [{ id: 'a' }] });
  const before = fs.readFileSync(file, 'utf8');
  const short = shortWrites(t, 0);
  assert.throws(() => updateTaskLedgerFile(file, (c) => { short.arm(); return [...c, { id: 'b' }]; }), /tasks\.json/);
  short.restore();
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.deepEqual(leftovers(dir), []);
});

test('the ledger keeps its file mode when it is replaced', (t) => {
  const { file } = hive(t, { tasks: [] });
  fs.chmodSync(file, 0o600);
  updateTaskLedgerFile(file, (c) => [...c, { id: 'a' }]);
  assert.deepEqual(ids(file), ['a']);
  assert.equal((fs.statSync(file).mode & 0o7777).toString(8), '600');
});

test('leftover lock, break-aside and temporary files older than a minute are swept; fresh ones are kept', (t) => {
  const { dir, file } = hive(t, { tasks: [] });
  const dead = deadPid();
  const names = [`.tasks.json.tmp-${dead}-aaaaaa`, 'tasks.json.lock.stale-aaaaaa', `.tasks.json.lock.tmp-${dead}-aaaaaa`];
  const old = new Date(Date.now() - 2 * 60_000);
  for (const name of names) {
    fs.writeFileSync(path.join(dir, `${name}-old`), 'x');
    fs.utimesSync(path.join(dir, `${name}-old`), old, old);
    fs.writeFileSync(path.join(dir, `${name}-new`), 'x');
  }
  // Not ours: left alone whatever its age.
  fs.writeFileSync(path.join(dir, 'notes.tmp-1'), 'x');
  fs.utimesSync(path.join(dir, 'notes.tmp-1'), old, old);
  updateTaskLedgerFile(file, (c) => [...c, { id: 'a' }]);
  assert.deepEqual(leftovers(dir).sort(), [...names.map((n) => `${n}-new`), 'notes.tmp-1'].sort());
});

test("a waiter's lock record is not swept while its process runs, however long it has waited", (t) => {
  const { dir, file } = hive(t, { tasks: [] });
  // A writer in a process that is still running, waiting longer than a minute for the lock.
  const waiting = `.tasks.json.lock.tmp-${process.pid}-bbbbbb`;
  fs.writeFileSync(path.join(dir, waiting), 'x');
  const old = new Date(Date.now() - 2 * 60_000);
  fs.utimesSync(path.join(dir, waiting), old, old);
  updateTaskLedgerFile(file, (c) => [...c, { id: 'a' }]);
  assert.deepEqual(leftovers(dir), [waiting]);
});

test('the wait for the lock ends on time even when the wall clock runs backwards', (t) => {
  const { file, lock } = hive(t, { tasks: [] });
  holdLock(lock);
  // The child's wall clock runs backwards from the moment it starts; with a wall-clock deadline the
  // wait would never end.
  const r = spawnSync(process.execPath, ['-e', `
    const loadTs = require(${JSON.stringify(path.join(__dirname, 'load-ts.cjs'))});
    const { updateTaskLedgerFile, TaskLedgerLockTimeout } = loadTs('src/core/taskLedgerFile.ts');
    const real = Date.now; const start = real();
    Date.now = () => start - 2 * (real() - start);
    try { updateTaskLedgerFile(process.argv[1], (c) => c, { waitMs: 300 }); process.exit(2); }
    catch (e) { process.exit(e instanceof TaskLedgerLockTimeout ? 0 : 3); }`, file],
  { cwd: path.join(__dirname, '..'), timeout: 5_000 });
  assert.equal(r.signal, null, 'the writer was still waiting after 5 s');
  assert.equal(r.status, 0, r.stderr.toString());
});
