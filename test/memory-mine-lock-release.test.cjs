'use strict';

/**
 * T-065 QA — the two palace single-writer paths that fail SILENTLY.
 *
 * memory-mine-serialization.test.cjs proves the lock SERIALIZES two writers.
 * It never proves the lock is RELEASED when a mine goes wrong, and it never
 * exercises more than a pair. Both gaps fail without an error:
 *
 * (1) RELEASE ON THROW. `mineAgent` is documented never to reject, but both
 *     call sites nonetheless release in a `finally`. If that finally ever went
 *     away, nothing would crash: `acquireMineLock` would simply wait forever,
 *     and every future palace write — the background loop AND every reaped
 *     worker's retain — would stop. The palace would quietly stop learning.
 *
 * (2) THE QUEUE BEYOND A PAIR. releaseMineLock's contract is that exactly ONE
 *     woken waiter wins the re-check and "the rest queue again". With two
 *     writers there is only ever ONE waiter parked, so the whole re-check is
 *     vacuous: a release that wakes only the head of the queue, or an
 *     acquireMineLock that re-checks with `if` rather than `while`, passes the
 *     existing suite 3-of-3 while dropping or trampling every writer past the
 *     second. Verified — both mutations are green there and red here.
 *
 * Both suites assert ORDER — start/end events — never merely that the calls
 * came back. A concurrency test that only checks completion proves nothing.
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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-lockrel-home-'));
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

/** Let every already-queued microtask AND timer callback run, so a "did it
 *  start?" assertion cannot pass merely because the scheduler was behind. */
const settle = () => new Promise((r) => setTimeout(r, 20));

// ── (1) the lock must survive a mine that throws ────────────────────────────

test('a mineNow pass whose mine THROWS still leaves the lock free', async (t) => {
  const { memory } = makeManager(t);

  memory.mineAgent = async () => { throw new Error('mempalace exploded mid-pass'); };

  await assert.rejects(
    memory.mineNow(),
    /mempalace exploded mid-pass/,
    'the throw must surface, not be swallowed'
  );

  // THE PROPERTY: the next writer gets straight through. A leaked lock makes
  // mineNow early-return and retainWorker wait out its whole timeout — both
  // silent, and between them that is every palace write on the floor.
  const events = [];
  memory.mineAgent = async (dir, id) => { events.push(`start:${id}`); events.push(`end:${id}`); return true; };
  memory.lastMined.clear();

  await memory.mineNow();
  assert.deepEqual(
    events, ['start:worker-a', 'end:worker-a'],
    'the guard stayed held after a throwing mine — the background loop is dead'
  );

  const { agentDir } = makeManager(t, 'worker-b');
  assert.equal(
    await memory.retainWorker('worker-reaped', agentDir, 500), true,
    'a waiting writer never got the lock back after a throwing mineNow pass'
  );
  assert.deepEqual(
    events,
    ['start:worker-a', 'end:worker-a', 'start:worker-reaped', 'end:worker-reaped'],
    'the retain must have actually mined, strictly after the loop pass'
  );
});

test('a retainWorker whose mine THROWS still leaves the lock free', async (t) => {
  const { memory, agentDir } = makeManager(t);

  memory.mineAgent = async () => { throw new Error('mempalace exploded mid-retain'); };

  // retainWorker converts a throw into false — the caller keeps the scratch dir.
  assert.equal(
    await memory.retainWorker('worker-doomed', agentDir, 5000), false,
    'a mine that throws must report failure so the scratch dir is preserved'
  );

  const events = [];
  memory.mineAgent = async (dir, id) => { events.push(`start:${id}`); events.push(`end:${id}`); return true; };
  memory.lastMined.clear();

  // Both kinds of consumer must get the lock back: mineNow, which BAILS when it
  // is held, and retainWorker, which WAITS. A leak is invisible to each of them
  // in a different way, so assert both.
  await memory.mineNow();
  assert.deepEqual(
    events, ['start:worker-a', 'end:worker-a'],
    'the guard stayed held after a throwing retain — mineNow now bails forever'
  );

  assert.equal(
    await memory.retainWorker('worker-next', agentDir, 500), true,
    'the next retain waited out its timeout — the guard was never released'
  );
  assert.deepEqual(
    events,
    ['start:worker-a', 'end:worker-a', 'start:worker-next', 'end:worker-next'],
    'the following retain must have mined, strictly after the loop pass'
  );
});

// ── (2) the waiter queue past a pair ────────────────────────────────────────

test('four queued retainWorkers each run alone, and every one of them runs', async (t) => {
  // The existing suite only ever has ONE waiter parked, so it cannot see:
  //   - a release that wakes just the head (waiters 2..N lost forever, each
  //     caller timing out and refusing to delete its scratch dir), nor
  //   - an acquire whose re-check is an `if` instead of a `while`, which lets
  //     every woken waiter barge straight in together — two writers in the
  //     palace at once, the exact failure this lock exists to prevent.
  // Both are invisible with two writers and caught here. (A release that fails
  // to CLEAR the queue is by contrast benign: the stale resolvers it re-calls
  // are already settled, and settling twice is a no-op — so this test does not
  // claim to catch that, and does not.)
  const { memory, agentDir } = makeManager(t);

  const events = [];
  let live = 0;
  memory.mineAgent = async (dir, id) => {
    live += 1;
    assert.equal(live, 1, `two palace writers were live at once (${id} joined an open mine)`);
    events.push(`start:${id}`);
    await settle();      // hold the lock open long enough for the others to queue
    events.push(`end:${id}`);
    live -= 1;
    return true;
  };

  const ids = ['reap-1', 'reap-2', 'reap-3', 'reap-4'];
  // Timeout is generous enough for four serialized mines but finite, so a LOST
  // waiter comes back false instead of hanging the suite.
  const results = await Promise.all(ids.map((id) => memory.retainWorker(id, agentDir, 3000)));

  assert.deepEqual(
    results, [true, true, true, true],
    'a queued retain never got the lock — its worker memory is lost and its scratch dir stays forever'
  );

  // THE PROPERTY: strict start/end pairing. Any overlap, any writer that ran
  // twice, and any writer that never ran shows up here.
  assert.equal(events.length, ids.length * 2, `expected ${ids.length} serialized mines, got: ${events.join(' ')}`);
  const ran = [];
  for (let i = 0; i < events.length; i += 2) {
    const [startTag, id] = events[i].split(':');
    assert.equal(startTag, 'start', `writes interleaved: ${events.join(' ')}`);
    assert.equal(events[i + 1], `end:${id}`, `${id}'s mine was interrupted by another writer: ${events.join(' ')}`);
    ran.push(id);
  }
  assert.deepEqual([...ran].sort(), [...ids].sort(), `every queued retain must mine exactly once, got: ${ran.join(' ')}`);

  // And the queue must be empty and the lock free once they have all drained.
  memory.lastMined.clear();
  await memory.mineNow();
  assert.equal(events[events.length - 1], 'end:worker-a', 'the lock was not free after the queue drained');
});
