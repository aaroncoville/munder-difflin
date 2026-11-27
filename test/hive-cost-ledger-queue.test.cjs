'use strict';

// HiveManager.appendCostLedger writes the app's cost rows only under cost-ledger.jsonl.lock, the lock headless runs
// hold for their own rows, and never waits for it on the app's thread: a row it cannot write now is queued and
// written later, never appended around the lock. A linked ledger is refused, not written through. Rows still queued
// when the app quits are flushed, or reported when they cannot be.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { allCommitsIdle } = loadTs('src/core/hiveCommit.ts');
const { HiveManager } = loadTs('src/main/hive.ts');
const { recordHeadlessCost } = loadTs('src/core/headlessStream.ts');
const { defaultStartTime } = loadTs('src/core/fileLock.ts');

function floor(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'md-cost-queue-')));
  const hive = new HiveManager(() => home);
  hive.ensureHive();
  t.after(async () => { hive.flushCostLedger(0); await allCommitsIdle(); fs.rmSync(home, { recursive: true, force: true }); });
  return { hive, home, root: hive.root(), ledger: path.join(hive.root(), 'cost-ledger.jsonl') };
}

const sample = (agentId) => ({ agentId, sessionId: 's1', ts: 1, input: 1, output: 2, cacheRead: 0, cacheCreation: 0, model: 'm', usd: 0.01 });
const lines = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
const agents = (file) => lines(file).map((l) => JSON.parse(l).agent_id);
const logged = (root) => (fs.existsSync(path.join(root, 'log.jsonl')) ? lines(path.join(root, 'log.jsonl')).map((l) => JSON.parse(l)) : []);
const until = async (ok, ms = 3000) => { const end = Date.now() + ms; while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 20)); return ok(); };

const RUN = {
  ok: true, outcome: 'success', exitCode: 0, signal: null, result: 'ok', sessionId: 'sess-h', totalCostUsd: 0.5, subtype: 'success',
  error: null, stdout: `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'sess-h', total_cost_usd: 0.5, usage: {} })}\n`,
  stderr: '', argv: ['claude', '-p', '--model', 'haiku', 'x'], cwd: '/w', settingsFile: '/s.json', outputFile: null, timedOut: false, killSignal: null,
};

test('a free lock: the app row is written at once, on a line of its own after an unterminated tail', (t) => {
  const { hive, ledger } = floor(t);
  fs.writeFileSync(ledger, '{"agent_id":"x","usd":1}');
  hive.appendCostLedger(sample('a'));
  assert.deepEqual(agents(ledger), ['x', 'a']);
  assert.equal(fs.existsSync(`${ledger}.lock`), false);
});

test('an app row arriving while a headless row is part-way written under the lock waits for it, and every line parses', async (t) => {
  const { hive, root, ledger } = floor(t);
  let calls = 0;
  // The headless append writes its row 12 bytes at a time; after its first write, the app appends a row.
  const writeSync = (fd, buf, off, len) => {
    const n = fs.writeSync(fd, buf, off, Math.min(12, len));
    if (calls++ === 0) hive.appendCostLedger(sample('app'));
    return n;
  };
  const c = recordHeadlessCost(root, 'ag1', RUN, 5, { writeSync });
  assert.equal(c.costRecorded, true, c.costReason);
  assert.deepEqual(agents(ledger), ['ag1'], 'the app row was not written into the headless row');
  assert.ok(await until(() => agents(ledger).length === 2), 'the queued app row is written once the lock is free');
  assert.deepEqual(agents(ledger), ['ag1', 'app']);
});

test('a linked ledger: the app row is not written through the link, stays queued, and the failure is logged once', async (t) => {
  const { hive, home, root, ledger } = floor(t);
  const outside = path.join(home, 'outside.jsonl');
  fs.writeFileSync(outside, '');
  fs.symlinkSync(outside, ledger);
  hive.appendCostLedger(sample('a'));
  hive.appendCostLedger(sample('b'));
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(fs.readFileSync(outside, 'utf8'), '', 'nothing reached the link\'s target');
  const failing = logged(root).filter((e) => e.event === 'cost-ledger-append-failing');
  assert.equal(failing.length, 1, JSON.stringify(logged(root)));
  assert.equal(failing[0].queued, 1);
  fs.rmSync(ledger);
  assert.equal(hive.flushCostLedger(), 0);
  assert.deepEqual(agents(ledger), ['a', 'b']);
  assert.ok(logged(root).some((e) => e.event === 'cost-ledger-append-recovered'));
});

test('quitting with rows queued behind a held lock: they are flushed once it is free, and reported when they cannot be', (t) => {
  const { hive, root, ledger } = floor(t);
  const lock = `${ledger}.lock`;
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, host: os.hostname(), acquiredAt: new Date().toISOString(), token: 'held' }));
  hive.appendCostLedger(sample('a'));
  assert.equal(fs.existsSync(ledger), false, 'nothing was written around the lock');
  assert.equal(hive.flushCostLedger(50), 1);
  assert.ok(logged(root).some((e) => e.event === 'cost-ledger-unflushed' && e.rows === 1), JSON.stringify(logged(root)));
  fs.rmSync(lock);
  assert.equal(hive.flushCostLedger(50), 0);
  assert.deepEqual(agents(ledger), ['a']);
});

const heldBy = (lock, more = {}) => fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, host: os.hostname(), acquiredAt: new Date().toISOString(), token: 'held', ...more }));

test('pushing a row never waits for a held lock', (t) => {
  const { hive, ledger } = floor(t);
  heldBy(`${ledger}.lock`);
  const started = performance.now();
  for (let i = 0; i < 5; i++) hive.appendCostLedger(sample(`a${i}`));
  const took = performance.now() - started;
  assert.ok(took < 100, `five pushes behind a held lock took ${Math.round(took)} ms`);
  assert.equal(fs.existsSync(ledger), false);
});

test('quitting with a full queue behind a held lock returns within the quit deadline and reports every row left', (t) => {
  const { hive, root, ledger } = floor(t);
  heldBy(`${ledger}.lock`);
  for (let i = 0; i < 1000; i++) hive.appendCostLedger(sample(`a${i}`));
  const started = performance.now();
  const left = hive.flushCostLedger();
  const took = performance.now() - started;
  assert.equal(left, 1000);
  assert.ok(took < 1300, `the flush took ${Math.round(took)} ms`);
  assert.ok(logged(root).some((e) => e.event === 'cost-ledger-unflushed' && e.rows === 1000));
});

test('quitting with a full queue and the lock free writes every row in one go, well within the deadline', (t) => {
  const { hive, ledger } = floor(t);
  const lock = `${ledger}.lock`;
  heldBy(lock);
  for (let i = 0; i < 1000; i++) hive.appendCostLedger(sample(`a${i}`));
  fs.rmSync(lock);
  const started = performance.now();
  assert.equal(hive.flushCostLedger(), 0);
  const took = performance.now() - started;
  assert.ok(took < 1000, `the flush took ${Math.round(took)} ms`);
  assert.equal(lines(ledger).length, 1000);
});

test('pushing a row breaks an old lock whose pid another running process now has (needs ps for start times)', (t) => {
  if (defaultStartTime(process.pid, 1000) === null) { t.skip('start times cannot be read here'); return; }
  const { hive, ledger } = floor(t);
  heldBy(`${ledger}.lock`, { started: 'ps:an earlier process', acquiredAt: new Date(Date.now() - 3_600_000).toISOString() });
  hive.appendCostLedger(sample('a'));
  assert.deepEqual(agents(ledger), ['a']);
});

test('pushing a row reads start times within its own budget, so it breaks an old lock whose pid another process now has (no ps needed)', (t) => {
  const { hive, ledger } = floor(t);
  // Start times as the reader would give them: this process started at "ps:this process"; a reader given no budget
  // is never asked.
  hive.costLedgerStartTime = (pid, timeoutMs) => (pid === process.pid && timeoutMs > 0 ? 'ps:this process' : null);
  heldBy(`${ledger}.lock`, { started: 'ps:an earlier process', acquiredAt: new Date(Date.now() - 3_600_000).toISOString() });
  hive.appendCostLedger(sample('a'));
  assert.deepEqual(agents(ledger), ['a']);
});

test('rows queued for two hive folders (around a switch of hive) each go to their own folder\'s ledger', (t) => {
  const homes = [0, 1].map(() => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'md-cost-switch-'))));
  let current = homes[0];
  const hive = new HiveManager(() => current);
  t.after(async () => { hive.flushCostLedger(0); await allCommitsIdle(); for (const h of homes) fs.rmSync(h, { recursive: true, force: true }); });
  hive.ensureHive();
  const first = path.join(hive.root(), 'cost-ledger.jsonl');
  heldBy(`${first}.lock`);
  hive.appendCostLedger(sample('a'));
  current = homes[1];
  hive.ensureHive();
  const second = path.join(hive.root(), 'cost-ledger.jsonl');
  hive.appendCostLedger(sample('b'));
  fs.rmSync(`${first}.lock`);
  assert.equal(hive.flushCostLedger(), 0);
  assert.deepEqual(agents(first), ['a']);
  assert.deepEqual(agents(second), ['b']);
});

test('the cost rows\' write status says when appends are failing and why, is sent to the window once, and clears on recovery', (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'md-cost-status-')));
  const seen = [];
  const hive = new HiveManager(() => home, (channel, payload) => { if (channel === 'hive:costLedgerStatus') seen.push(payload); });
  hive.ensureHive();
  t.after(async () => { hive.flushCostLedger(0); await allCommitsIdle(); fs.rmSync(home, { recursive: true, force: true }); });
  const ledger = path.join(hive.root(), 'cost-ledger.jsonl');
  assert.deepEqual(hive.costLedgerStatus(), { failing: null, queued: 0 });
  const outside = path.join(home, 'outside.jsonl');
  fs.writeFileSync(outside, '');
  fs.symlinkSync(outside, ledger);
  hive.appendCostLedger(sample('a'));
  hive.appendCostLedger(sample('b'));
  const status = hive.costLedgerStatus();
  assert.match(status.failing ?? '', /ELOOP|link/);
  assert.equal(status.queued, 2);
  assert.equal(seen.length, 1, 'the window was told of the failure once');
  assert.equal(seen[0].failing, status.failing);
  fs.rmSync(ledger);
  assert.equal(hive.flushCostLedger(), 0);
  assert.deepEqual(hive.costLedgerStatus(), { failing: null, queued: 0 });
  assert.deepEqual(seen.at(-1), { failing: null, queued: 0 });
  assert.equal(seen.length, 2);
});
