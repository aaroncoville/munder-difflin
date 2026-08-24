'use strict';

/**
 * T-065 — every palace write must go through the SAME single-writer guard.
 *
 * memory.ts states the invariant itself: "The palace permits a single writer,
 * so mines MUST be serialized — firing them concurrently makes all but one fail
 * with 'held by another writer'." mineNow() honours it via `this.mining`.
 * retainWorker() called mineAgent DIRECTLY and never touched `mining`, so it
 * neither waited for an in-flight pass nor blocked one from starting during its
 * own. The GC sweep that calls retainWorker runs every 60 s and the background
 * mine loop every 10 min: the overlap is a matter of time, not luck, and the
 * loser of the race is a mine that silently fails — on the retain path, that is
 * a reaped worker's memory lost right before its scratch dir is deleted.
 *
 * retainWorker must NOT early-return the way mineNow does (returning false
 * would defer scratch deletion forever on a busy floor). It must WAIT for the
 * in-flight pass, then take the lock itself, bounded by its 30 s timeout.
 *
 * These tests assert SERIALIZATION, not completion: the second writer must not
 * BEGIN before the first has FINISHED.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { MemoryManager } = loadTs('src/main/memory.ts');

/** A manager over a temp home holding one hive agent with a memory.md to mine. */
function makeManager(t, agentId = 'worker-a') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-serial-home-'));
  const agentDir = path.join(home, 'hive', 'agents', agentId);
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'memory.md'), '## Notes\nSomething worth keeping.\n');

  const memory = new MemoryManager(() => home, () => ({ enabled: true, model: 'minilm' }));
  memory.bin = () => '/fake/bin/mempalace'; // never probe the real PATH
  t.after(() => {
    memory.stop();
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* already gone */ }
  });
  return { memory, home, agentDir, agentId };
}

/** A promise plus its resolver, so a test can hold a mine open on purpose. */
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

/** Let every already-queued microtask AND timer callback run. Without this a
 *  "did the second writer start?" assertion could pass merely because the
 *  scheduler had not got round to it yet — which would prove nothing. */
const settle = () => new Promise((r) => setTimeout(r, 20));

test('retainWorker WAITS for an in-flight mineNow pass instead of writing over it', async (t) => {
  const { memory, agentDir } = makeManager(t);

  // Every palace write records when it starts and when it ends. Serialized
  // writes interleave as start/end/start/end; concurrent writes as start/start.
  const events = [];
  const loopMine = deferred();
  memory.mineAgent = async (dir, id) => {
    events.push(`start:${id}`);
    if (id === 'worker-a') await loopMine.promise; // the background pass hangs on purpose
    events.push(`end:${id}`);
    return true;
  };

  const loopPass = memory.mineNow();          // background mine loop takes the lock
  await settle();
  assert.deepEqual(events, ['start:worker-a'], 'the mine loop must be mid-pass before we race it');

  const retain = memory.retainWorker('worker-reaped', agentDir, 5000); // GC sweep, 60 s tick
  await settle();

  // THE PROPERTY: the retain mine must not have BEGUN while the loop's is open.
  assert.deepEqual(
    events,
    ['start:worker-a'],
    'retainWorker started a second palace writer while the mine loop held the lock'
  );

  loopMine.resolve();          // the background pass finishes
  const retained = await retain;
  await loopPass;

  assert.deepEqual(
    events,
    ['start:worker-a', 'end:worker-a', 'start:worker-reaped', 'end:worker-reaped'],
    'the retain mine must run strictly AFTER the in-flight pass ends'
  );
  assert.equal(retained, true, 'waiting for the lock must still retain the worker, not give up on it');
});

test('mineNow does not open a second writer while retainWorker holds the lock', async (t) => {
  const { memory, agentDir } = makeManager(t);

  const events = [];
  const retainMine = deferred();
  memory.mineAgent = async (dir, id) => {
    events.push(`start:${id}`);
    if (id === 'worker-reaped') await retainMine.promise;
    events.push(`end:${id}`);
    return true;
  };

  const retain = memory.retainWorker('worker-reaped', agentDir, 5000); // GC sweep takes the lock first
  await settle();
  assert.deepEqual(events, ['start:worker-reaped'], 'the retain mine must be in flight before we race it');

  const loopPass = memory.mineNow();  // the 10-minute interval fires mid-retain
  await settle();

  assert.deepEqual(
    events,
    ['start:worker-reaped'],
    'mineNow opened a second palace writer while retainWorker was mining'
  );

  retainMine.resolve();
  assert.equal(await retain, true);
  await loopPass;
});

test('a retainWorker that times out waiting for the lock leaves it free for the next writer', async (t) => {
  // The wait is bounded by retainWorker's own timeout. Abandoning the wait must
  // not leave the guard stuck true — that would silently stop every future mine,
  // which is the exact failure mode mineAgent's hard kill-timer exists to avoid.
  const { memory, agentDir } = makeManager(t);

  const events = [];
  const loopMine = deferred();
  memory.mineAgent = async (dir, id) => {
    events.push(`start:${id}`);
    if (id === 'worker-a') await loopMine.promise;
    events.push(`end:${id}`);
    return true;
  };

  const loopPass = memory.mineNow();
  await settle();

  const retained = await memory.retainWorker('worker-impatient', agentDir, 50);
  assert.equal(retained, false, 'a retain that never got the lock must report failure — keep the scratch dir');
  assert.deepEqual(events, ['start:worker-a'], 'the abandoned retain must never have mined');

  loopMine.resolve();
  await loopPass;
  await settle(); // the abandoned waiter is woken by the release; let it unwind

  // The lock must be free again: a fresh writer gets straight through.
  memory.lastMined.clear();
  await memory.mineNow();
  assert.deepEqual(
    events,
    ['start:worker-a', 'end:worker-a', 'start:worker-a', 'end:worker-a'],
    'the guard stayed held after an abandoned wait — all future mines are dead'
  );
});
