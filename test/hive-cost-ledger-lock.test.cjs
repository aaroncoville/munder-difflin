'use strict';

// HiveManager.appendCostLedger takes cost-ledger.jsonl.lock, the lock headless runs hold for their own rows, so
// an app row and a headless row cannot interleave. The ledger is the only durable cost record, so an app row is
// never dropped for want of the lock: when it cannot be had within the app's short wait, the row is appended
// as it was before the lock existed.

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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-cost-lock-'));
  t.after(async () => { await allCommitsIdle(); fs.rmSync(home, { recursive: true, force: true }); });
  const hive = new HiveManager(() => home);
  hive.ensureHive();
  return { hive, ledger: path.join(hive.root(), 'cost-ledger.jsonl') };
}

const sample = (agentId) => ({ agentId, sessionId: 's1', ts: 1, input: 1, output: 2, cacheRead: 0, cacheCreation: 0, model: 'm', usd: 0.01 });
const rows = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('appendCostLedger waits for a ledger lock another process holds, then appends', async (t) => {
  const { hive, ledger } = floor(t);
  const lock = `${ledger}.lock`;
  // The child takes the lock, reports it, holds it for 120 ms and releases it.
  const proc = spawn(process.execPath, ['-e', `
    const fs = require('node:fs'); const os = require('node:os');
    const lock = process.argv[1];
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, host: os.hostname(), acquiredAt: new Date().toISOString(), token: 't' }), { flag: 'wx' });
    process.stdout.write('held\\n');
    setTimeout(() => { fs.unlinkSync(lock); process.exit(0); }, 120);`, lock], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => proc.kill());
  const done = new Promise((resolve) => proc.on('exit', resolve));
  await new Promise((resolve) => proc.stdout.once('data', resolve));
  const started = Date.now();
  hive.appendCostLedger(sample('a'));
  const waited = Date.now() - started;
  await done;
  assert.ok(waited >= 60, `appendCostLedger returned after ${waited} ms, while the lock was still held`);
  assert.deepEqual(rows(ledger).map((r) => r.agent_id), ['a']);
  assert.equal(fs.existsSync(lock), false, 'the lock is released');
});

test('appendCostLedger starts its row on a fresh line after an unterminated tail', (t) => {
  const { hive, ledger } = floor(t);
  fs.writeFileSync(ledger, '{"agent_id":"x","usd":1}');
  hive.appendCostLedger(sample('a'));
  assert.deepEqual(rows(ledger).map((r) => r.agent_id), ['x', 'a']);
});

test('appendCostLedger still appends its row when the lock stays held past its wait', (t) => {
  const { hive, ledger } = floor(t);
  const lock = `${ledger}.lock`;
  const live = JSON.stringify({ pid: process.pid, host: os.hostname(), acquiredAt: new Date().toISOString(), token: 'held' });
  fs.writeFileSync(lock, live);
  hive.appendCostLedger(sample('a'));
  assert.deepEqual(rows(ledger).map((r) => r.agent_id), ['a']);
  assert.equal(fs.readFileSync(lock, 'utf8'), live, 'the holder\'s lock is left alone');
});
