'use strict';

/**
 * T-048 — a reaped worker's memory must reach durable storage BEFORE its
 * scratch dir (HIVE_ROOT/agents/<id>) is deleted.
 *
 * Bug: gcPreservedWorktrees calls removeWorkerScratch — which deletes
 * HIVE_ROOT/agents/<id> — while the mine loop's 10-minute interval hasn't
 * fired yet. A reaped worker (token-cap or idle) loses everything it wrote
 * to memory.md the moment the GC sweep runs (~60 s after teardown).
 *
 * Fix: MemoryManager.retainWorker(workerId, agentDir) mines the agent
 * synchronously so its notes reach the palace before the caller deletes the
 * directory. gcPreservedWorktrees calls it on BOTH removal paths.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { MemoryManager } = loadTs('src/main/memory.ts');

/** Build a MemoryManager whose CLI we control and whose mineAgent we can spy on. */
function makeManager(t, { home, agentDir }) {
  const memory = new MemoryManager(() => home, () => ({ enabled: true, model: 'minilm' }));
  memory.bin = () => '/fake/bin/mempalace'; // avoid probing real PATH
  t.after(() => {
    memory.stop();
    try { fs.rmSync(agentDir, { recursive: true, force: true }); } catch { /* already gone */ }
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* already gone */ }
  });
  return memory;
}

test('retainWorker mines a worker\'s memory before the scratch directory is removed', async (t) => {
  // ── REAP SCENARIO ────────────────────────────────────────────────────────
  // Worker hit its token cap → reaped → gcPreservedWorktrees sees its git
  // worktree is gone → calls removeWorkerScratch → deletes HIVE_ROOT/agents/<id>.
  // The mine loop's 10-minute interval hasn't fired → the worker's memory.md
  // vanishes before it ever reaches the palace. T-039 is the real example.
  //
  // retainWorker is the one-shot mine that the GC sweep calls before deleting
  // the scratch. THIS TEST FAILS on the current code because retainWorker does
  // not yet exist on MemoryManager.
  // ─────────────────────────────────────────────────────────────────────────

  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-retain-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-home-'));
  const memoryMd = path.join(agentDir, 'memory.md');

  fs.writeFileSync(
    memoryMd,
    '## Worker T-039\nRoot cause: orphaned session row in auth table.\nNext: investigate lock contention.\n'
  );

  const memory = makeManager(t, { home, agentDir });

  // Spy on mineAgent to verify (a) it is called, (b) memory.md exists at call time.
  const log = [];
  memory.mineAgent = async (dir, id) => {
    log.push({ dir, id, memoryExists: fs.existsSync(path.join(dir, 'memory.md')) });
    // Do not spawn the fake CLI — we are testing the call, not the palace.
  };

  // retainWorker does not exist on current code — this line throws TypeError → RED.
  await memory.retainWorker('worker-t039-reaped', agentDir);

  // (1) Mine must have been called — this is how memory survives teardown.
  assert.equal(log.length, 1, 'retainWorker must invoke mineAgent exactly once');
  assert.equal(log[0].id, 'worker-t039-reaped', 'mine must target the reaped worker id');
  assert.equal(log[0].dir, agentDir, 'mine must target the worker scratch dir');

  // (2) memory.md must still exist at mine time — caller removes scratch AFTER this.
  assert.equal(log[0].memoryExists, true, 'memory.md must exist when mineAgent is called — the delete comes after');

  // (3) retainWorker must not delete the scratch itself (that is the caller's job).
  assert.ok(fs.existsSync(memoryMd), 'retainWorker must leave the scratch dir intact for the caller to remove');
});

test('retainWorker is a no-op when the worker has no memory.md', async (t) => {
  // Guard: if a reaped worker never wrote to memory.md there is nothing to mine.
  // Calling retainWorker must not throw, spawn the CLI, or create files.
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-retain-empty-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-home-empty-'));

  const memory = makeManager(t, { home, agentDir });

  const log = [];
  memory.mineAgent = async (dir, id) => { log.push({ dir, id }); };

  await memory.retainWorker('worker-no-memory', agentDir);

  assert.equal(log.length, 0, 'no mine when there is no memory.md to retain');
});

test('retainWorker is a no-op when memory is not active (no CLI or disabled)', async (t) => {
  // If mempalace is not installed, retainWorker degrades to a silent no-op
  // just like the regular mine loop does — never throw.
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-retain-nobin-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-home-nobin-'));

  fs.writeFileSync(path.join(agentDir, 'memory.md'), '## Notes\nFoo\n');

  const memory = makeManager(t, { home, agentDir });
  memory.bin = () => null; // no CLI installed

  const log = [];
  memory.mineAgent = async (dir, id) => { log.push({ dir, id }); };

  await memory.retainWorker('worker-no-cli', agentDir);

  assert.equal(log.length, 0, 'retainWorker must not crash when mempalace is absent');
});

// ── god's T-048 review steer ─────────────────────────────────────────────────
// "On retain failure or timeout, DO NOT DELETE. Keep the scratch dir and leave
// the entry for a later sweep. Failing toward KEEPING the directory is
// consistent with the surrounding fail-safe code."
//
// retainWorker must return boolean — true = retained (or no-op), false = failed.
// The GC caller checks the return value; a false stops it from calling
// removeWorkerScratch. The two tests below are RED on the current code because
// (1) retainWorker returns void not boolean, and (2) the timeout is not bounded.
// ─────────────────────────────────────────────────────────────────────────────

test('retainWorker returns true when mine succeeds (caller may then remove scratch)', async (t) => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-retain-ok-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-home-ok-'));
  fs.writeFileSync(path.join(agentDir, 'memory.md'), '## Notes\nAll good.\n');

  const memory = makeManager(t, { home, agentDir });
  // Must resolve TRUE: mineAgent now reports outcome, and a stub returning
  // undefined would read as failure — which is the contract working as intended.
  memory.mineAgent = async () => true;

  const ok = await memory.retainWorker('worker-ok', agentDir);

  // THIS LINE FAILS on current code: retainWorker returns undefined, not true.
  assert.equal(ok, true, 'retainWorker must return true on success so the caller knows it may delete');
});

test('retainWorker returns false when mine throws — scratch dir must NOT be removed', async (t) => {
  // This is the key safety property: if the mine fails (palace locked, CLI
  // crash, or timeout), the GC sweep must leave the scratch dir alone and retry
  // on the next tick, exactly like the surrounding fail-safe code does for
  // removeWorktree errors and gc-safe check failures.
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-retain-fail-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-home-fail-'));
  const memoryMd = path.join(agentDir, 'memory.md');
  fs.writeFileSync(memoryMd, '## Worker notes\nImportant findings — must not be lost.\n');

  const memory = makeManager(t, { home, agentDir });
  // Simulate a failing mine (palace locked, CLI crash, etc.)
  memory.mineAgent = async () => { throw new Error('palace write lock held by another process'); };

  const retained = await memory.retainWorker('worker-mine-fails', agentDir);

  // retainWorker must return false — THIS FAILS on current code (returns void).
  assert.equal(retained, false, 'retainWorker must return false when mine throws');

  // The scratch dir must still exist. In the real GC code, the caller checks the
  // return value and skips removeWorkerScratch when it is false — so the directory
  // survives for the next sweep to retry. We assert the file is still intact here
  // to make the expected contract explicit.
  assert.ok(fs.existsSync(memoryMd), 'memory.md must be intact after a failed retain — never silently discard');
});

test('retainWorker returns false when mine times out — scratch dir survives the bounded wait', async (t) => {
  // The mine loop uses MINE_TIMEOUT_MS (10 min) because first runs download the
  // embedding model. retainWorker runs on the GC sweep path (inside the worker
  // tick); it must use a MUCH shorter cap so a slow/hung CLI never stalls worker
  // processing for minutes. On timeout, return false (keep for next sweep).
  //
  // retainWorker accepts an optional timeoutMs parameter so tests can exercise
  // the timeout path without waiting 30 s. We pass 50 ms here.
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-retain-timeout-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-home-timeout-'));
  const memoryMd = path.join(agentDir, 'memory.md');
  fs.writeFileSync(memoryMd, '## Notes\nDo not stall the worker tick.\n');

  const memory = makeManager(t, { home, agentDir });
  // Simulate a mine that never resolves (hung CLI).
  memory.mineAgent = () => new Promise(() => { /* never resolves */ });

  // retainWorker must return false — THIS FAILS on current code (void + no timeout).
  const retained = await memory.retainWorker('worker-hung-mine', agentDir, 50);

  assert.equal(retained, false, 'retainWorker must return false when the mine times out');
  assert.ok(fs.existsSync(memoryMd), 'memory.md must survive a timeout — never delete after a stall');
});

// ── the failure that actually happens (god, round 3) ────────────────────────
// The earlier failure tests stubbed mineAgent to THROW. The real mineAgent never
// throws: on a non-zero exit or a spawn error it logs and RESOLVES. So a stub that
// throws exercises behaviour production does not have, and the likeliest real
// failure — mempalace exiting non-zero — sailed through as "retained" and deleted
// the memory anyway. mineAgent now resolves false on those paths, and retainWorker
// reads the boolean rather than merely surviving the timeout race.

function setup(t) {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-retain-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-home-'));
  fs.writeFileSync(path.join(agentDir, 'memory.md'), '## notes\nsomething worth keeping\n');
  return { agentDir, home, memory: makeManager(t, { home, agentDir }) };
}

test('retainWorker returns false when the mine RESOLVES failure (non-zero exit), not only when it hangs', async (t) => {
  const { agentDir, memory } = setup(t);
  // Exactly what the real mineAgent now does on a bad exit code or spawn error.
  memory.mineAgent = async () => false;

  const retained = await memory.retainWorker('worker-mine-exits-nonzero', agentDir);
  assert.equal(retained, false, 'a mine that RESOLVES failure must not report safe-to-delete');
  assert.ok(fs.existsSync(path.join(agentDir, 'memory.md')), 'memory.md must survive a failed mine');
});

test('retainWorker still returns true on a clean mine', async (t) => {
  const { agentDir, memory } = setup(t);
  memory.mineAgent = async () => true;
  assert.equal(await memory.retainWorker('worker-mine-ok', agentDir), true,
    'a clean mine must report safe-to-delete, or nothing would ever be reclaimed');
});
