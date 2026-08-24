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
