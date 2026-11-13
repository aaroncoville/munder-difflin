'use strict';

/**
 * A hive git command never outlives what the app believes about it: a lock is only treated as stale once no hive git
 * could still hold it, a timed-out command has exited before the next one starts, and quitting stops the queue and
 * any git still running.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const hiveCommit = loadTs('src/main/hiveCommit.ts');
const { allCommitsIdle, runGit, HIVE_GIT_TIMEOUT_MS } = hiveCommit;

const REAL_GIT = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();

function home(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'md-hive-quit-')));
  // Any fake git still hanging is killed first: until it exits, the commit it belongs to never settles.
  t.after(async () => { killFakeGits(dir); await allCommitsIdle(); fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

/** Whether `pid` is still running. A zombie (killed, not yet reaped by whoever inherited it) runs nothing. */
function running(pid) {
  try { process.kill(pid, 0); } catch { return false; }
  const state = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
  return state !== '' && !state.startsWith('Z');
}

function killFakeGits(dir) {
  for (const name of ['git-pids', 'child-pids']) {
    const pids = path.join(dir, name);
    if (!fs.existsSync(pids)) continue;
    for (const line of fs.readFileSync(pids, 'utf8').split('\n').filter(Boolean)) {
      try { process.kill(Number(line.split(' ')[0]), 'SIGKILL'); } catch { /* already gone */ }
    }
  }
}

/** A `git` first on PATH that records its pid, and when the command named by hang() runs, ignores SIGTERM and never
 *  finishes, as a git stuck on a huge index would. */
function fakeGit(t, dir) {
  const bin = path.join(dir, 'fake-bin');
  const pids = path.join(dir, 'git-pids');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'git'), [
    '#!/bin/sh',
    `echo "$$ $*" >> '${pids}'`,
    'case " $* " in *" ${FAKE_GIT_HANG:-<none>} "*) trap "" TERM; while :; do sleep 0.05; done ;; esac',
    // As `git commit` does when it runs gc or maintenance: start a child that inherits its output, then wait for it, or
    // exit and leave it running.
    `case "\${FAKE_GIT_CHILD:-}" in wait) sleep 30 & echo $! >> '${path.join(dir, 'child-pids')}'; wait; exit 0 ;; leave) sleep 30 & echo $! >> '${path.join(dir, 'child-pids')}'; exit 0 ;; esac`,
    `exec '${REAL_GIT}' "$@"`,
    ''
  ].join('\n'), { mode: 0o755 });
  const saved = { PATH: process.env.PATH, FAKE_GIT_HANG: process.env.FAKE_GIT_HANG, FAKE_GIT_CHILD: process.env.FAKE_GIT_CHILD };
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
  function started() {
    if (!fs.existsSync(pids)) return [];
    return fs.readFileSync(pids, 'utf8').split('\n').filter(Boolean).map((l) => Number(l.split(' ')[0]));
  }
  return {
    hang(command) { process.env.FAKE_GIT_HANG = command; },
    child(mode) { process.env.FAKE_GIT_CHILD = mode; },
    childrenAlive() {
      const file = path.join(dir, 'child-pids');
      if (!fs.existsSync(file)) return [];
      return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(Number).filter(running);
    },
    started,
    alive() { return started().filter(running); }
  };
}

async function floor(t, dir) {
  const hive = new HiveManager(() => dir);
  await hive.ensureAgent({ id: 'god-1', name: 'Boss', provider: 'claude', cwd: dir, isGod: true });
  await hive.commitsSettled();
  return hive;
}

function git(root, args) {
  const r = spawnSync(REAL_GIT, args, { cwd: root, encoding: 'utf8' });
  return { ok: r.status === 0, out: r.stdout.trim() };
}

function ageLock(root, ageMs) {
  const lock = path.join(root, '.git', 'index.lock');
  fs.writeFileSync(lock, '');
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(lock, when, when);
  return lock;
}

/** `promise`, or 'timeout' if it has not settled within `ms`: a regression here hangs, and should fail instead. */
const within = (promise, ms) => Promise.race([promise, new Promise((r) => setTimeout(() => r('timeout'), ms))]);

const waitUntil = async (check, ms = 5000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
};

test('an index.lock that a hive git still running could hold is never removed as stale', async (t) => {
  const dir = home(t);
  const hive = await floor(t, dir);
  const root = path.join(dir, 'hive');
  // The longest a hive git can live: its time limit, plus the grace it is given to exit before it is killed.
  const longest = HIVE_GIT_TIMEOUT_MS + (hiveCommit.HIVE_GIT_KILL_GRACE_MS ?? 0);
  const lock = ageLock(root, longest - 1000);
  fs.writeFileSync(path.join(root, 'board.md'), '# changed\n');

  hive.commit('hive: while another git holds the index');
  await hive.commitsSettled();

  assert.ok(fs.existsSync(lock), 'a lock a running git could hold was deleted');
  assert.equal(git(root, ['show', 'HEAD:board.md']).out.includes('# changed'), false);
});

test('an index.lock older than any hive git can run is removed, and the commit goes ahead', async (t) => {
  const dir = home(t);
  const hive = await floor(t, dir);
  const root = path.join(dir, 'hive');
  const lock = ageLock(root, 60 * 60 * 1000);
  fs.writeFileSync(path.join(root, 'board.md'), '# changed\n');

  hive.commit('hive: after a crash left a lock');
  await hive.commitsSettled();

  assert.equal(fs.existsSync(lock), false);
  assert.equal(git(root, ['show', 'HEAD:board.md']).out, '# changed');
});

test('a git that times out and ignores SIGTERM has exited by the time the runner resolves', async (t) => {
  const dir = home(t);
  const shim = fakeGit(t, dir);
  shim.hang('status');

  const started = Date.now();
  const result = await within(runGit(['status'], dir, 200, 300), 5000);

  assert.notEqual(result, 'timeout', 'the runner never resolved');
  assert.equal(result.ok, false);
  assert.match(result.err, /did not finish within 200 ms/);
  assert.equal(shim.started().length, 1);
  assert.deepEqual(shim.alive(), [], 'the timed-out git was still running when the next command could start');
  assert.ok(Date.now() - started < 3000);
});

test('quitting during a commit stops the git still running, waits for it, and takes no new commits', async (t) => {
  const dir = home(t);
  const shim = fakeGit(t, dir);
  const hive = await floor(t, dir);
  const root = path.join(dir, 'hive');
  shim.hang('commit');
  fs.writeFileSync(path.join(root, 'board.md'), '# changed\n');

  hive.commit('hive: in flight at quit');
  // Wait until that commit's own `git commit` is running (and hanging), not merely an earlier step.
  await waitUntil(() => shim.alive().length > 0 && fs.readFileSync(path.join(dir, 'git-pids'), 'utf8').includes(' commit -q -m hive: in flight at quit'));

  const started = Date.now();
  const stopped = await within(hive.stopCommits(200, 300), 5000);
  const took = Date.now() - started;

  assert.notEqual(stopped, 'timeout', 'quit did not finish within 5 s');
  assert.deepEqual(shim.alive(), [], 'a hive git outlived the quit');
  assert.ok(took < 3000, `quit waited ${took} ms`);
  const before = shim.started().length;
  hive.commit('hive: after quit');
  await within(hive.commitsSettled(), 2000);
  assert.equal(shim.started().length, before, 'a commit was started after quit');
});

test('quitting with no commit running returns at once', async (t) => {
  const dir = home(t);
  const hive = await floor(t, dir);
  const started = Date.now();
  await hive.stopCommits(5000, 5000);
  assert.ok(Date.now() - started < 200);
});

test('a timed-out git waiting on a child that holds its output is stopped with that child', async (t) => {
  const dir = home(t);
  const shim = fakeGit(t, dir);
  shim.child('wait');

  const started = Date.now();
  const result = await within(runGit(['commit'], dir, 300, 300), 5000);

  assert.notEqual(result, 'timeout', 'the runner waited for the child holding its output');
  assert.equal(result.ok, false);
  assert.ok(Date.now() - started < 3000, `resolved after ${Date.now() - started} ms`);
  assert.deepEqual(shim.alive(), []);
  assert.deepEqual(shim.childrenAlive(), [], 'the child outlived the git that started it');
});

test('a git that exits and leaves a child behind is not waited on, and the child is stopped', async (t) => {
  const dir = home(t);
  const shim = fakeGit(t, dir);
  shim.child('leave');

  const started = Date.now();
  const result = await within(runGit(['commit'], dir), 5000);

  assert.notEqual(result, 'timeout', 'the runner waited for a child of a git that had exited');
  assert.ok(Date.now() - started < 3000, `resolved after ${Date.now() - started} ms`);
  assert.deepEqual(shim.childrenAlive(), [], 'the child outlived the git that started it');
});

test('quitting while git waits on a child stops both, within the quit grace', async (t) => {
  const dir = home(t);
  const shim = fakeGit(t, dir);
  shim.child('wait');
  const queue = new hiveCommit.CommitQueue((root) => runGit(['commit'], root), { warn: () => {} });

  queue.request(dir, 'in flight');
  await waitUntil(() => shim.childrenAlive().length > 0);
  const started = Date.now();
  const closed = await within(queue.close(200, () => hiveCommit.stopRunningGits(300)), 5000);

  assert.notEqual(closed, 'timeout', 'quit waited on the child holding git output');
  assert.ok(Date.now() - started < 3000, `quit took ${Date.now() - started} ms`);
  assert.deepEqual(shim.alive(), []);
  assert.deepEqual(shim.childrenAlive(), []);
});
