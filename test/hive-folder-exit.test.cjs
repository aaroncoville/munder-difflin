'use strict';

/**
 * Resetting the app and moving its data folder copy or delete the hive folder and then exit through app.exit, which
 * skips will-quit. A hive commit can be running at that moment, so both must stop it, and wait for its git to exit,
 * before the first copy or delete.
 *
 * The real handlers are taken from index.ts and run against a real hive whose `git commit` never finishes.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const { allCommitsIdle } = loadTs('src/main/hiveCommit.ts');

const REAL_GIT = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();

/** The IPC handlers registered for `channels`, and the named top-level functions, as source. */
function liveSource(channels, functions) {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'src/main/index.ts'), 'utf8');
  const tree = ts.createSourceFile('index.ts', source, ts.ScriptTarget.ES2022, true);
  const handlers = {};
  const fns = [];
  const visit = (n) => {
    if (ts.isCallExpression(n) && n.expression.getText(tree) === 'ipcMain.handle' && ts.isStringLiteral(n.arguments[0]) && channels.includes(n.arguments[0].text)) {
      handlers[n.arguments[0].text] = n.arguments[1].getText(tree);
    }
    if (ts.isFunctionDeclaration(n) && n.name && functions.includes(n.name.text)) fns.push(n.getText(tree));
    ts.forEachChild(n, visit);
  };
  visit(tree);
  for (const c of channels) assert.ok(handlers[c], `index.ts registers ${c}`);
  const body = `${fns.join('\n')}\n({ ${channels.map((c) => `${JSON.stringify(c)}: ${handlers[c]}`).join(', ')} })`;
  return ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}

function running(pid) {
  try { process.kill(pid, 0); } catch { return false; }
  const state = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
  return state !== '' && !state.startsWith('Z');
}

/** A hive under `dir` whose next `git commit` hangs, ignoring SIGTERM, with that commit in flight. */
async function hiveWithCommitInFlight(t, dir) {
  const bin = path.join(dir, 'fake-bin');
  const pids = path.join(dir, 'git-pids');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'git'), [
    '#!/bin/sh',
    `echo "$$ $*" >> '${pids}'`,
    'case " $* " in *" ${FAKE_GIT_HANG:-<none>} "*) trap "" TERM; while :; do sleep 0.05; done ;; esac',
    `exec '${REAL_GIT}' "$@"`,
    ''
  ].join('\n'), { mode: 0o755 });
  const saved = { PATH: process.env.PATH, FAKE_GIT_HANG: process.env.FAKE_GIT_HANG };
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  const started = () => (fs.existsSync(pids) ? fs.readFileSync(pids, 'utf8').split('\n').filter(Boolean).map((l) => Number(l.split(' ')[0])) : []);
  t.after(async () => {
    for (const pid of started()) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await allCommitsIdle();
  });

  const hive = new HiveManager(() => dir);
  await hive.ensureAgent({ id: 'god-1', name: 'Boss', provider: 'claude', cwd: dir, isGod: true });
  await hive.commitsSettled();
  process.env.FAKE_GIT_HANG = 'commit';
  fs.writeFileSync(path.join(hive.root(), 'board.md'), '# changed\n');
  hive.commit('hive: in flight');
  const end = Date.now() + 5000;
  while (!(fs.existsSync(pids) && fs.readFileSync(pids, 'utf8').includes(' commit -q -m hive: in flight'))) {
    assert.ok(Date.now() < end, 'the commit never started');
    await new Promise((r) => setTimeout(r, 20));
  }
  return { hive, gitsRunning: () => started().filter(running) };
}

const noop = () => {};
const quiet = { log: noop, warn: noop, error: noop };

function stubs(hive, events) {
  return {
    hive,
    allowQuit: false,
    clearMissionTimers: noop, clearContextTimers: noop, stopWebhookDoneObserver: noop, stopEphemeralWorkerWatcher: noop,
    integrationBroker: { stop: noop }, hookServer: { stop: noop }, telemetry: { stop: noop }, stopSlackServer: noop,
    stopWebhookServer: noop, memory: { stop: noop, palacePath: () => null }, reflector: { stop: noop }, persist: { close: noop },
    heavyLock: { agentsGone: noop }, ptyToAgent: new Map(), ptyManager: { killAll: noop }, roster: { archive: noop },
    resetConfig: noop, writeConfig: noop, bootstrapHiveServices: noop, startSlackServer: noop, reconcileWebhookServer: noop,
    app: { relaunch: () => events.push({ what: 'relaunch' }), exit: () => events.push({ what: 'exit' }) },
    console: quiet
  };
}

const within = (promise, ms) => Promise.race([promise, new Promise((r) => setTimeout(() => r('timeout'), ms))]);

test('a full reset stops a running hive commit, and its git has exited, before the hive folder is deleted', async (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'md-reset-')));
  const { hive, gitsRunning } = await hiveWithCommitInFlight(t, dir);
  t.after(async () => { await allCommitsIdle(); fs.rmSync(dir, { recursive: true, force: true }); });
  const events = [];
  const context = {
    ...stubs(hive, events),
    rmSync: (target) => events.push({ what: 'rm', target, gitsRunning: gitsRunning() })
  };
  const handlers = vm.runInNewContext(liveSource(['app:resetAll'], ['stopHiveCommits']), context);

  const done = await within(Promise.resolve(handlers['app:resetAll']()), 10000);

  assert.notEqual(done, 'timeout', 'the reset never finished');
  const firstRm = events.find((e) => e.what === 'rm');
  assert.equal(firstRm.target, hive.root());
  assert.deepEqual(firstRm.gitsRunning, [], 'the hive folder was deleted under a running git');
  assert.ok(events.findIndex((e) => e.what === 'exit') > events.indexOf(firstRm));
});

test('moving the data folder stops a running hive commit, and its git has exited, before the hive is copied', async (t) => {
  const oldHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'md-move-old-')));
  const newHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'md-move-new-')));
  const { hive, gitsRunning } = await hiveWithCommitInFlight(t, oldHome);
  t.after(async () => {
    await allCommitsIdle();
    for (const d of [oldHome, newHome]) fs.rmSync(d, { recursive: true, force: true });
  });
  const events = [];
  const context = {
    ...stubs(hive, events),
    resolve: path.resolve, join: path.join, sep: path.sep, existsSync: fs.existsSync, expandTilde: (p) => p,
    readConfig: () => ({ harnessHome: oldHome }), ensureHarnessHome: () => ({ ok: true }),
    cpSync: (src, to) => events.push({ what: 'copy', src, gitsRunning: gitsRunning() })
  };
  const handlers = vm.runInNewContext(liveSource(['config:changeHome'], ['stopHiveCommits']), context);

  const done = await within(handlers['config:changeHome'](null, { newHome, mode: 'move' }), 10000);

  assert.notEqual(done, 'timeout', 'the move never finished');
  const hiveCopy = events.find((e) => e.what === 'copy' && e.src === path.join(oldHome, 'hive'));
  assert.ok(hiveCopy, 'the hive was not copied');
  assert.deepEqual(hiveCopy.gitsRunning, [], 'the hive was copied while a git was writing into it');
  assert.ok(events.findIndex((e) => e.what === 'exit') > events.indexOf(hiveCopy));
});

test('a move whose copy fails goes on committing in the old folder', async (t) => {
  const oldHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'md-move-fail-')));
  t.after(async () => { await allCommitsIdle(); fs.rmSync(oldHome, { recursive: true, force: true }); });
  const hive = new HiveManager(() => oldHome);
  await hive.ensureAgent({ id: 'god-1', name: 'Boss', provider: 'claude', cwd: oldHome, isGod: true });
  await hive.commitsSettled();
  const events = [];
  const context = {
    ...stubs(hive, events),
    resolve: path.resolve, join: path.join, sep: path.sep, existsSync: fs.existsSync, expandTilde: (p) => p,
    readConfig: () => ({ harnessHome: oldHome }), ensureHarnessHome: () => ({ ok: true }),
    cpSync: () => { throw new Error('disk full'); }
  };
  const handlers = vm.runInNewContext(liveSource(['config:changeHome'], ['stopHiveCommits']), context);
  const newHome = path.join(os.tmpdir(), `md-move-target-${process.pid}`);

  const result = await handlers['config:changeHome'](null, { newHome, mode: 'move' });

  assert.equal(result.ok, false);
  const before = spawnSync(REAL_GIT, ['rev-parse', 'HEAD'], { cwd: hive.root(), encoding: 'utf8' }).stdout.trim();
  fs.writeFileSync(path.join(hive.root(), 'board.md'), '# after a failed move\n');
  hive.commit('hive: after a failed move');
  await hive.commitsSettled();
  assert.notEqual(spawnSync(REAL_GIT, ['rev-parse', 'HEAD'], { cwd: hive.root(), encoding: 'utf8' }).stdout.trim(), before);
});
