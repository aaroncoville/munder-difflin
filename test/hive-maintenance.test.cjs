'use strict';

/**
 * The hive repository is maintained by a job of its own, never by a commit: it runs only after the commit queue has
 * been idle for a while, at most once a day, one step at a time with no commit alongside, and quitting stops it.
 * Also here: what else a hive git must not do (run the owner's hooks), and failures it must report as what they are.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { removeDir } = require('./codex-test-home.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const { allCommitsIdle, runGit } = loadTs('src/main/hiveCommit.ts');

const REAL_GIT = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();

function running(pid) {
  try { process.kill(pid, 0); } catch { return false; }
  const state = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
  return state !== '' && !state.startsWith('Z');
}

function home(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'md-hive-maint-')));
  // Kill every fake git, again and again until the queue settles: a regression could keep starting new ones.
  t.after(async () => {
    const pids = path.join(dir, 'git-calls');
    for (let settled = false, i = 0; !settled && i < 40; i++) {
      if (fs.existsSync(pids)) {
        for (const line of fs.readFileSync(pids, 'utf8').split('\n').filter(Boolean)) {
          try { process.kill(Number(line.split(' ')[1]), 'SIGKILL'); } catch { /* gone */ }
        }
      }
      settled = await Promise.race([allCommitsIdle().then(() => true), new Promise((r) => setTimeout(() => r(false), 250))]);
    }
    // Never throws, so the PATH and FAKE_GIT_* restore registered after this still runs.
    await removeDir(dir, { waitForCommits: false });
  });
  return dir;
}

/**
 * A `git` first on PATH that logs "start <pid> <ms> <args>" and "end <pid> <ms>" for every call. FAKE_GIT_SLOW names a
 * git command to delay by a second, FAKE_GIT_HANG one that never finishes, and FAKE_GIT_FAIL_ONCE one that fails the
 * first time it runs (with "boom" on stderr).
 */
function fakeGit(t, dir) {
  const bin = path.join(dir, 'fake-bin');
  const log = path.join(dir, 'git-calls');
  const failed = path.join(dir, 'failed-once');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'git'), [
    '#!/bin/sh',
    `now() { perl -MTime::HiRes=time -e 'printf "%d", time*1000'; }`,
    `echo "start $$ $(now) $*" >> '${log}'`,
    `case " $* " in *" \${FAKE_GIT_FAIL_ONCE:-<none>} "*) if [ ! -e '${failed}' ]; then touch '${failed}'; echo boom >&2; echo "end $$ $(now)" >> '${log}'; exit 1; fi ;; esac`,
    `case " $* " in *" \${FAKE_GIT_HANG:-<none>} "*) trap "" TERM; while :; do sleep 0.05; done ;; esac`,
    `case " $* " in *" \${FAKE_GIT_SLOW:-<none>} "*) sleep 1 ;; esac`,
    `'${REAL_GIT}' "$@"; code=$?`,
    `echo "end $$ $(now)" >> '${log}'`,
    'exit $code',
    ''
  ].join('\n'), { mode: 0o755 });
  const keys = ['PATH', 'FAKE_GIT_FAIL_ONCE', 'FAKE_GIT_HANG', 'FAKE_GIT_SLOW'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const calls = () => {
    if (!fs.existsSync(log)) return [];
    const byPid = new Map();
    for (const line of fs.readFileSync(log, 'utf8').split('\n').filter(Boolean)) {
      const [kind, pid, at, ...args] = line.split(' ');
      if (kind === 'start') byPid.set(pid, { pid: Number(pid), start: Number(at), end: null, args: args.join(' ') });
      else if (byPid.has(pid)) byPid.get(pid).end = Number(at);
    }
    return [...byPid.values()];
  };
  return {
    set(name, value) { process.env[name] = value; },
    calls,
    alive: () => calls().map((c) => c.pid).filter(running)
  };
}

async function floor(t, dir, timing) {
  const hive = new HiveManager(() => dir);
  if (timing) hive.setMaintenanceTiming(timing);
  await hive.ensureAgent({ id: 'god-1', name: 'Boss', provider: 'claude', cwd: dir, isGod: true });
  await hive.commitsSettled();
  return hive;
}

const git = (root, ...args) => spawnSync(REAL_GIT, args, { cwd: root, encoding: 'utf8' }).stdout.trim();
const looseCount = (root) => Number(/^count: (\d+)/m.exec(git(root, 'count-objects', '-v'))[1]);
const maintenanceLog = (hive) => hive.logTail(500).filter((e) => e.kind === 'hive-maintenance');
const waitUntil = async (check, ms = 10000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
};

test('once the queue has been idle, maintenance packs the loose objects, logging each step with its duration', async (t) => {
  const dir = home(t);
  const hive = await floor(t, dir, { idleMs: 150, everyMs: 24 * 60 * 60 * 1000 });
  const root = hive.root();
  for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(root, `f${i}.md`), `v${i}`);
  hive.commit('hive: objects to pack');
  await hive.commitsSettled();
  const before = looseCount(root);
  assert.ok(before > 0);

  await waitUntil(() => maintenanceLog(hive).filter((e) => e.phase === 'end').length === 4);
  await hive.commitsSettled();

  assert.ok(looseCount(root) < before, `loose objects ${before} -> ${looseCount(root)}`);
  const ends = maintenanceLog(hive).filter((e) => e.phase === 'end');
  assert.deepEqual(ends.map((e) => e.task), ['loose-objects', 'prune-packed', 'commit-graph', 'pack-refs']);
  for (const e of ends) {
    assert.equal(e.ok, true, e.error);
    assert.equal(typeof e.durationMs, 'number');
  }
  assert.deepEqual(maintenanceLog(hive).filter((e) => e.phase === 'start').map((e) => e.task), ['loose-objects', 'prune-packed', 'commit-graph', 'pack-refs']);
});

test('maintenance never runs alongside a commit, and commits waiting for it go first between its steps', async (t) => {
  const dir = home(t);
  const shim = fakeGit(t, dir);
  const hive = await floor(t, dir, { idleMs: 150, everyMs: 24 * 60 * 60 * 1000 });
  shim.set('FAKE_GIT_SLOW', 'maintenance');

  await waitUntil(() => shim.calls().some((c) => c.args.includes('maintenance run')));
  for (let i = 0; i < 3; i++) {
    fs.writeFileSync(path.join(hive.root(), 'board.md'), `# ${i}\n`);
    hive.commit(`hive: during maintenance ${i}`);
  }
  await waitUntil(() => maintenanceLog(hive).filter((e) => e.phase === 'end').length === 4, 20000);
  await hive.commitsSettled();

  const calls = shim.calls();
  for (const a of calls) {
    for (const b of calls) {
      if (a === b || a.end === null || b.end === null) continue;
      assert.ok(a.end <= b.start || b.end <= a.start, `ran together: "${a.args}" and "${b.args}"`);
    }
  }
  // From the first maintenance step on: the commits that were waiting go next, before the remaining steps.
  const all = calls.map((c) => (c.args.includes('maintenance run') || c.args.includes('prune-packed') ? 'm' : c.args.includes(' commit ') ? 'c' : '')).filter(Boolean).join('');
  const order = all.slice(all.indexOf('m'));
  assert.match(order, /^mc/, `the waiting commit did not go next: ${order}`);
});

test('maintenance runs at most once a day', async (t) => {
  const dir = home(t);
  const shim = fakeGit(t, dir);
  const hive = await floor(t, dir, { idleMs: 100, everyMs: 24 * 60 * 60 * 1000 });
  await waitUntil(() => maintenanceLog(hive).filter((e) => e.phase === 'end').length === 4);
  await hive.commitsSettled();

  for (let i = 0; i < 3; i++) {
    hive.commit(`hive: later ${i}`);
    await hive.commitsSettled();
    await new Promise((r) => setTimeout(r, 300));
  }

  assert.equal(shim.calls().filter((c) => c.args.includes('maintenance run --task=loose-objects')).length, 1);
});

test('quitting stops a maintenance step that is running, and its git has exited', async (t) => {
  const dir = home(t);
  const shim = fakeGit(t, dir);
  const hive = await floor(t, dir, { idleMs: 100, everyMs: 24 * 60 * 60 * 1000 });
  shim.set('FAKE_GIT_HANG', 'maintenance');
  await waitUntil(() => shim.calls().some((c) => c.args.includes('maintenance run')));

  const started = Date.now();
  const stopped = await Promise.race([hive.stopCommits(200, 300).then(() => true), new Promise((r) => setTimeout(() => r(false), 5000))]);

  assert.ok(stopped, 'quit did not finish within 5 s');
  assert.ok(Date.now() - started < 3000);
  assert.deepEqual(shim.alive(), []);
  assert.equal(shim.calls().filter((c) => c.args.includes('maintenance run')).length, 1, 'a later step started after quit');
});

test('a hive git never runs the owner\'s own git hooks', async (t) => {
  const dir = home(t);
  const repo = path.join(dir, 'repo');
  const hooks = path.join(dir, 'owner-hooks');
  const marker = path.join(dir, 'hook-ran');
  fs.mkdirSync(repo);
  fs.mkdirSync(hooks);
  fs.writeFileSync(path.join(hooks, 'pre-commit'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  const globalConfig = path.join(dir, 'gitconfig');
  fs.writeFileSync(globalConfig, `[core]\n\thooksPath = ${hooks}\n[user]\n\tname = t\n\temail = t@t\n`);
  const saved = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  t.after(() => { if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = saved; });
  spawnSync(REAL_GIT, ['init', '-q'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'f'), 'v');

  await runGit(['add', '-A'], repo);
  const commit = await runGit(['commit', '-q', '-m', 'c'], repo);

  assert.equal(commit.ok, true, commit.err);
  assert.equal(fs.existsSync(marker), false, 'the owner\'s pre-commit hook ran on a hive commit');
  fs.writeFileSync(path.join(repo, 'g'), 'x');
  spawnSync(REAL_GIT, ['add', '-A'], { cwd: repo });
  spawnSync(REAL_GIT, ['commit', '-q', '-m', 'd'], { cwd: repo });
  assert.equal(fs.existsSync(marker), true, 'the control commit did not run the hook: the test would prove nothing');
});

test('agent files a failed untrack left tracked are untracked by the next commit', async (t) => {
  const dir = home(t);
  await floor(t, dir);
  const root = path.join(dir, 'hive');
  const junk = path.join(root, 'agents', 'god-1', '.nuget', 'pkg.nupkg');
  fs.mkdirSync(path.dirname(junk), { recursive: true });
  fs.writeFileSync(junk, 'package');
  git(root, 'add', '-f', '--', 'agents/god-1/.nuget');
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'old build tracked this');
  const shim = fakeGit(t, dir);
  shim.set('FAKE_GIT_FAIL_ONCE', 'rm');

  const hive = new HiveManager(() => dir);
  hive.setUntrackRetryDelays?.([0, 0]); // the retry is what is checked here, not its backoff
  hive.ensureHive();
  hive.commit('hive: the untrack fails');
  await hive.commitsSettled();
  assert.notEqual(git(root, 'ls-files', '--', 'agents/god-1/.nuget'), '', 'the first untrack was meant to fail');
  hive.commit('hive: next');
  await hive.commitsSettled();

  assert.equal(git(root, 'ls-files', '--', 'agents/god-1/.nuget'), '');
  assert.equal(fs.readFileSync(junk, 'utf8'), 'package');
});

test('a failed git init is reported as the hive repository not being created', async (t) => {
  const dir = home(t);
  const shim = fakeGit(t, dir);
  shim.set('FAKE_GIT_FAIL_ONCE', 'init');
  const warnings = [];
  const warn = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  t.after(() => { console.warn = warn; });

  const hive = new HiveManager(() => dir);
  hive.ensureHive();
  await hive.commitsSettled();

  const line = warnings.find((w) => w.includes('boom'));
  assert.ok(line, warnings.join('\n'));
  assert.match(line, /could not create the hive repository/);
  assert.doesNotMatch(line, /commit failed/);
});
