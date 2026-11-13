'use strict';

/**
 * Hive commits run in the background, one at a time, and only record hive state inside agent folders.
 *
 * A slow git is simulated with a `git` on PATH that sleeps before running the real one, so these tests measure what a
 * caller waits for, and what reaches the repository, without needing gigabytes of files.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { allCommitsIdle } = loadTs('src/main/hiveCommit.ts');

const { HiveManager } = loadTs('src/main/hive.ts');
const { CommitQueue, combineMessages } = loadTs('src/main/hiveCommit.ts');

const REAL_GIT = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();

function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-hive-commit-'));
  t.after(async () => { await allCommitsIdle(); fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

/** Put a `git` first on PATH that logs each call and sleeps `delay` seconds before running the real git, or, when
 *  only() names a git command, before that command alone. */
function slowGit(t, dir) {
  const bin = path.join(dir, 'slow-bin');
  const log = path.join(dir, 'git-calls.log');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\necho "$*" >> '${log}'\ncase " $* " in *" \${SLOW_GIT_ONLY:-} "*) sleep "\${SLOW_GIT_DELAY:-0}" ;; esac\nexec '${REAL_GIT}' "$@"\n`, { mode: 0o755 });
  const saved = { PATH: process.env.PATH, SLOW_GIT_DELAY: process.env.SLOW_GIT_DELAY, SLOW_GIT_ONLY: process.env.SLOW_GIT_ONLY };
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
  return {
    setDelay(seconds) { process.env.SLOW_GIT_DELAY = String(seconds); },
    only(command) { process.env.SLOW_GIT_ONLY = command; },
    commits() {
      if (!fs.existsSync(log)) return 0;
      return fs.readFileSync(log, 'utf8').split('\n').filter((l) => / commit -q -m /.test(` ${l}`)).length;
    }
  };
}

async function floor(t, dir) {
  const hive = new HiveManager(() => dir);
  t.after(() => hive.commitsSettled());
  await hive.ensureAgent({ id: 'god-1', name: 'Boss', provider: 'claude', cwd: dir, isGod: true });
  await hive.ensureAgent({ id: 'worker-1', name: 'Helper', provider: 'claude', cwd: dir });
  await hive.commitsSettled();
  return hive;
}

function git(root, args) {
  const r = spawnSync(REAL_GIT, args, { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

test('a commit returns without waiting for a slow git, and lands once git finishes', async (t) => {
  const dir = home(t);
  const shim = slowGit(t, dir);
  const hive = await floor(t, dir);
  const root = path.join(dir, 'hive');
  const before = git(root, ['rev-parse', 'HEAD']);
  shim.setDelay(1);

  const started = Date.now();
  hive.send({ to: 'god-1', act: 'inform', subject: 'hello', body: 'world' }, 'worker-1');
  const waited = Date.now() - started;

  assert.ok(waited < 500, `send waited ${waited} ms for git`);
  await hive.commitsSettled();
  assert.notEqual(git(root, ['rev-parse', 'HEAD']), before);
});

test('twenty commits requested while git is slow run as at most two', async (t) => {
  const dir = home(t);
  const shim = slowGit(t, dir);
  const hive = await floor(t, dir);
  const root = path.join(dir, 'hive');
  const already = shim.commits();
  shim.setDelay(0.3);

  const started = Date.now();
  for (let i = 0; i < 20; i++) {
    fs.writeFileSync(path.join(root, 'board.md'), `# board ${i}\n`);
    hive.commit(`hive: change ${i}`);
  }
  const waited = Date.now() - started;
  await hive.commitsSettled();

  assert.ok(waited < 500, `twenty requests waited ${waited} ms`);
  assert.ok(shim.commits() - already <= 2, `ran ${shim.commits() - already} commits`);
  assert.equal(git(root, ['show', 'HEAD:board.md']), '# board 19', 'the last change is committed');
  assert.equal(git(root, ['status', '--porcelain', '--', 'board.md']), '');
});

test('a commit still waiting when commits are turned off does not run', async (t) => {
  const dir = home(t);
  const shim = slowGit(t, dir);
  const hive = await floor(t, dir);
  const root = path.join(dir, 'hive');
  shim.only('commit');
  shim.setDelay(1);

  fs.writeFileSync(path.join(root, 'board.md'), '# first\n');
  hive.commit('hive: first');
  await new Promise((r) => setTimeout(r, 400)); // the first commit has staged its change and is inside `git commit`
  fs.writeFileSync(path.join(root, 'board.md'), '# second\n');
  hive.commit('hive: second');
  hive.setGitCommitsDisabled(true);
  await hive.commitsSettled();

  assert.equal(git(root, ['show', 'HEAD:board.md']), '# first', 'the commit already running finishes');
  assert.equal(git(root, ['status', '--porcelain', '--', 'board.md']), 'M board.md', 'the waiting one never runs');
});

test('inside an agent folder only memory, identity and the ignore file are committed', async (t) => {
  const dir = home(t);
  const hive = await floor(t, dir);
  const root = path.join(dir, 'hive');
  const agent = path.join(root, 'agents', 'worker-1');
  fs.mkdirSync(path.join(agent, 'c35-probe', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(agent, 'c35-probe', 'nested', 'blob.bin'), 'x');
  fs.writeFileSync(path.join(agent, 'notes.txt'), 'scratch');
  fs.writeFileSync(path.join(agent, 'memory.md'), '# remembered\n');
  fs.writeFileSync(path.join(root, 'board.md'), '# board changed\n');

  hive.commit('hive: test');
  await hive.commitsSettled();

  const tracked = git(root, ['ls-files']).split('\n');
  const inAgent = tracked.filter((p) => p.startsWith('agents/worker-1/')).sort();
  assert.deepEqual(inAgent, ['agents/worker-1/.gitignore', 'agents/worker-1/identity.md', 'agents/worker-1/memory.md']);
  assert.equal(git(root, ['show', 'HEAD:agents/worker-1/memory.md']), '# remembered');
  assert.equal(git(root, ['show', 'HEAD:board.md']), '# board changed');
});

test('agent files committed before the allowlist stop being tracked and stay on disk', async (t) => {
  const dir = home(t);
  await floor(t, dir);
  const root = path.join(dir, 'hive');
  const junk = path.join(root, 'agents', 'worker-1', '.nuget', 'packages', 'pkg.nupkg');
  fs.mkdirSync(path.dirname(junk), { recursive: true });
  fs.writeFileSync(junk, 'package');
  git(root, ['add', '-f', '--', 'agents/worker-1/.nuget']);
  git(root, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'old build tracked this']);

  const hive = new HiveManager(() => dir);
  hive.ensureHive();
  hive.commit('hive: next');
  await hive.commitsSettled();

  assert.equal(git(root, ['ls-files', '--', 'agents/worker-1/.nuget']), '');
  assert.equal(fs.readFileSync(junk, 'utf8'), 'package');
  assert.notEqual(git(root, ['ls-files', '--', 'agents/worker-1/memory.md']), '');
});

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test('requests made while a commit runs are folded into one follow-up commit', async () => {
  const gates = [];
  const runs = [];
  const queue = new CommitQueue((root, message) => {
    runs.push({ root, message });
    const gate = deferred();
    gates.push(gate);
    return gate.promise;
  });

  queue.request('/hive', 'first');
  for (let i = 0; i < 5; i++) queue.request('/hive', `later ${i}`);
  assert.equal(runs.length, 1);

  gates[0].resolve({ ok: true, out: '', err: '' });
  await new Promise((r) => setImmediate(r));
  assert.equal(runs.length, 2);
  assert.equal(runs[1].message, combineMessages(['later 0', 'later 1', 'later 2', 'later 3', 'later 4']));

  gates[1].resolve({ ok: true, out: '', err: '' });
  await queue.idle();
  assert.equal(runs.length, 2);
});

test('a run of failures is reported once with git\'s error, and once when commits recover', async () => {
  const lines = [];
  const failing = [];
  const recovered = [];
  let fail = true;
  const queue = new CommitQueue(async () => (fail ? { ok: false, out: '', err: 'fatal: Unable to create index.lock: File exists' } : { ok: true, out: '', err: '' }), {
    warn: (l) => lines.push(l),
    onFailing: (n, e) => failing.push([n, e]),
    onRecovered: (n) => recovered.push(n)
  });

  for (let i = 0; i < 6; i++) { queue.request('/hive', `m${i}`); await queue.idle(); }
  assert.equal(lines.length, 2, lines.join('\n'));
  assert.match(lines[0], /index\.lock: File exists/);
  assert.match(lines[1], /3 hive commits in a row have failed.*index\.lock/);
  assert.deepEqual(failing, [[3, 'fatal: Unable to create index.lock: File exists']]);
  assert.equal(queue.consecutiveFailures(), 6);

  fail = false;
  queue.request('/hive', 'ok');
  await queue.idle();
  assert.deepEqual(recovered, [6]);
  assert.equal(lines.length, 3);
  assert.equal(queue.consecutiveFailures(), 0);
});

test('a commit job that throws counts as a failure and the queue keeps going', async () => {
  const lines = [];
  let calls = 0;
  const queue = new CommitQueue(async () => {
    calls++;
    if (calls === 1) throw new Error('spawn git ENOENT');
    return { ok: true, out: '', err: '' };
  }, { warn: (l) => lines.push(l) });

  queue.request('/hive', 'a');
  await queue.idle();
  queue.request('/hive', 'b');
  await queue.idle();

  assert.equal(calls, 2);
  assert.match(lines[0], /spawn git ENOENT/);
  assert.equal(queue.consecutiveFailures(), 0);
});

test('creating the hive repository does not wait for git either', async (t) => {
  const dir = home(t);
  const shim = slowGit(t, dir);
  shim.only('init');
  shim.setDelay(1);
  const hive = new HiveManager(() => dir);
  t.after(() => hive.commitsSettled());

  const started = Date.now();
  hive.ensureHive();
  const waited = Date.now() - started;
  await hive.commitsSettled();

  assert.ok(waited < 500, `preparing the hive waited ${waited} ms for git init`);
  assert.match(git(path.join(dir, 'hive'), ['log', '-1', '--format=%s']), /hive: init/);
});
