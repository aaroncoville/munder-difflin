'use strict';

/**
 * The inbox-wake watchdog decides on every beat whether to type a wake nudge
 * into an idle worker. When it declined, it said nothing: a worker could sit on
 * undelivered mail for hours and leave no trace of which guard held it.
 *
 * These tests pin the reason each verdict now carries, and how often a stall is
 * written to the hive log — once it has lasted a while, again when it changes
 * or keeps going, and once when it ends. A healthy floor writes nothing.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const sourceAssert = require('./source-assert.cjs');

const {
  WorkerWakeWatchdog,
  WakeSkipLog,
  WORKER_WAKE_IDLE_MS,
  WORKER_WAKE_COOLDOWN_MS,
  WAKE_SKIP_DWELL_MS,
  WAKE_SKIP_RELOG_MS,
  WAKE_SKIP_MAX_IDS
} = loadTs('src/main/workerWake.ts');
const { codexStallFacts } = loadTs('src/main/codexActivity.ts');

const NOW = 1_000_000;
const BEAT = 15_000;

function fact(overrides = {}) {
  return {
    agentId: 'alice',
    ptyId: 'pty-alice',
    lastOutputAt: NOW - WORKER_WAKE_IDLE_MS - 1,
    inboxIds: ['mail-1'],
    autoDeliveryPaused: false,
    paused: false,
    halted: false,
    ...overrides
  };
}

function watchdog(spawnedAt = 0) {
  const w = new WorkerWakeWatchdog();
  w.noteSpawn('pty-alice', spawnedAt);
  return w;
}

function only(verdicts) {
  assert.equal(verdicts.length, 1);
  return verdicts[0];
}

// ─── decideWithReasons ────────────────────────────────────────────────────────

test('an idle worker with new mail is nudged, and the verdict says so', () => {
  const v = only(watchdog().decideWithReasons([fact()], NOW));
  assert.equal(v.nudge, true);
  assert.equal(v.reason, undefined);
  assert.deepEqual(v.newIds, ['mail-1']);
});

test('each guard that holds a nudge names itself', () => {
  const cases = [
    ['paused', fact({ autoDeliveryPaused: true })],
    ['paused', fact({ paused: true })],
    ['paused', fact({ halted: true })],
    ['no-output-yet', fact({ lastOutputAt: 0 })],
    ['not-quiet', fact({ lastOutputAt: NOW - 1_000 })]
  ];
  for (const [reason, f] of cases) {
    const v = only(watchdog().decideWithReasons([f], NOW));
    assert.equal(v.nudge, false, reason);
    assert.equal(v.reason, reason);
  }
});

test('the boot grace is named when it is what holds the nudge', () => {
  const v = only(watchdog(NOW - 1_000).decideWithReasons([fact()], NOW));
  assert.equal(v.reason, 'boot-grace');
});

test('a pending permission prompt is named as the hold', () => {
  const w = watchdog();
  w.noteHook('alice', 'Notification', 'Claude needs your permission to use Bash.', NOW - 1_000);
  assert.equal(only(w.decideWithReasons([fact()], NOW)).reason, 'hitl');
});

test('mail already announced is named, and so is the cooldown', () => {
  const announced = watchdog();
  assert.equal(only(announced.decideWithReasons([fact()], NOW)).nudge, true);
  const later = NOW + WORKER_WAKE_COOLDOWN_MS + 1;
  assert.equal(
    only(announced.decideWithReasons([fact({ lastOutputAt: later - WORKER_WAKE_IDLE_MS - 1 })], later)).reason,
    'already-announced'
  );

  const cooling = watchdog();
  cooling.decideWithReasons([fact()], NOW);
  const soon = NOW + 1_000;
  assert.equal(
    only(cooling.decideWithReasons(
      [fact({ inboxIds: ['mail-1', 'mail-2'], lastOutputAt: soon - WORKER_WAKE_IDLE_MS - 1 })], soon
    )).reason,
    'cooldown'
  );
});

test('the verdict carries how long the terminal has been silent', () => {
  assert.equal(only(watchdog().decideWithReasons([fact({ lastOutputAt: NOW - 3_000 })], NOW)).quietMs, 3_000);
  assert.equal(only(watchdog().decideWithReasons([fact({ lastOutputAt: 0 })], NOW)).quietMs, null);
});

test('the verdict separates mail still to announce from mail already announced', () => {
  const w = watchdog();
  w.decideWithReasons([fact()], NOW);
  const t = NOW + WORKER_WAKE_COOLDOWN_MS + 1;
  const v = only(w.decideWithReasons([fact({ inboxIds: ['mail-1', 'mail-2'], lastOutputAt: t - 1_000 })], t));
  assert.equal(v.reason, 'not-quiet');
  assert.deepEqual(v.inboxIds, ['mail-1', 'mail-2']);
  assert.deepEqual(v.newIds, ['mail-2']);
});

test('workers with nothing to wake for are not assessed at all', () => {
  const w = watchdog();
  w.noteSpawn('pty-god', 0);
  const v = w.decideWithReasons([
    fact({ inboxIds: [] }),
    fact({ agentId: 'god', isGod: true, ptyId: 'pty-god' }),
    fact({ agentId: 'nobody', ptyId: undefined })
  ], NOW);
  assert.deepEqual(v, []);
});

test('decide() nudges exactly the workers decideWithReasons marks for a nudge', () => {
  const facts = [fact(), fact({ agentId: 'bob', ptyId: 'pty-bob', lastOutputAt: NOW - 1 })];
  const a = watchdog(); a.noteSpawn('pty-bob', 0);
  const b = watchdog(); b.noteSpawn('pty-bob', 0);
  const viaDecide = a.decide(facts, NOW);
  assert.deepEqual(viaDecide, ['alice']);
  assert.deepEqual(viaDecide, b.decideWithReasons(facts, NOW).filter((v) => v.nudge).map((v) => v.agentId));
});

// ─── WakeSkipLog ─────────────────────────────────────────────────────────────

function skip(reason, overrides = {}) {
  return { agentId: 'alice', nudge: false, reason, quietMs: 4_000, inboxIds: ['m1'], newIds: ['m1'], ...overrides };
}
function nudged(overrides = {}) {
  return { agentId: 'alice', nudge: true, quietMs: 20_000, inboxIds: ['m1'], newIds: ['m1'], ...overrides };
}

test('mail delivered within the dwell leaves no trace', () => {
  const log = new WakeSkipLog();
  assert.deepEqual(log.observe([skip('not-quiet')], 0), []);
  assert.deepEqual(log.observe([skip('not-quiet')], WAKE_SKIP_DWELL_MS - 1), []);
  assert.deepEqual(log.observe([nudged()], WAKE_SKIP_DWELL_MS - 1), []);
});

test('a stall is written once it has lasted the dwell, not on every beat', () => {
  const log = new WakeSkipLog();
  const lines = [];
  for (let t = 0; t <= WAKE_SKIP_DWELL_MS + 5 * BEAT; t += BEAT) {
    lines.push(...log.observe([skip('not-quiet')], t));
  }
  assert.equal(lines.length, 1);
  assert.equal(lines[0].state, 'not-quiet');
  assert.equal(lines[0].stalledMs, WAKE_SKIP_DWELL_MS);
});

test('the stall line carries the gate, the silence and the undelivered mail', () => {
  const log = new WakeSkipLog();
  log.observe([skip('not-quiet', { quietMs: 3_100, inboxIds: ['m0', 'm1'], newIds: ['m1'] })], 0);
  const [line] = log.observe(
    [skip('not-quiet', { quietMs: 2_900, inboxIds: ['m0', 'm1'], newIds: ['m1'] })], WAKE_SKIP_DWELL_MS
  );
  assert.deepEqual(line, {
    kind: 'worker-wake-skip',
    agentId: 'alice',
    state: 'not-quiet',
    quietMs: 2_900,
    idleMs: WORKER_WAKE_IDLE_MS,
    pending: 2,
    newIds: ['m1'],
    stalledMs: WAKE_SKIP_DWELL_MS
  });
});

test('a stall that persists is written again every relog interval, with fresh readings', () => {
  const log = new WakeSkipLog();
  const lines = [];
  for (let t = 0; t <= WAKE_SKIP_DWELL_MS + 2 * WAKE_SKIP_RELOG_MS; t += BEAT) {
    lines.push(...log.observe([skip('not-quiet', { quietMs: t % 12_000 })], t));
  }
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.map((l) => l.stalledMs),
    [WAKE_SKIP_DWELL_MS, WAKE_SKIP_DWELL_MS + WAKE_SKIP_RELOG_MS, WAKE_SKIP_DWELL_MS + 2 * WAKE_SKIP_RELOG_MS]);
});

test('once written, a change of gate or new undelivered mail is written at once', () => {
  const log = new WakeSkipLog();
  log.observe([skip('not-quiet')], 0);
  assert.equal(log.observe([skip('not-quiet')], WAKE_SKIP_DWELL_MS).length, 1);
  const changed = log.observe([skip('cooldown')], WAKE_SKIP_DWELL_MS + BEAT);
  assert.equal(changed.length, 1);
  assert.equal(changed[0].state, 'cooldown');
  const more = log.observe([skip('cooldown', { inboxIds: ['m1', 'm2'], newIds: ['m1', 'm2'] })], WAKE_SKIP_DWELL_MS + 2 * BEAT);
  assert.equal(more.length, 1);
  assert.deepEqual(more[0].newIds, ['m1', 'm2']);
  // The stall is still dated from its first beat, not from the latest change.
  assert.equal(more[0].stalledMs, WAKE_SKIP_DWELL_MS + 2 * BEAT);
});

test('the end of a written stall is written once, naming how it ended', () => {
  const log = new WakeSkipLog();
  log.observe([skip('not-quiet')], 0);
  log.observe([skip('not-quiet')], WAKE_SKIP_DWELL_MS);
  assert.deepEqual(log.observe([nudged()], WAKE_SKIP_DWELL_MS + BEAT), [{
    kind: 'worker-wake-skip',
    agentId: 'alice',
    state: 'resolved',
    via: 'nudged',
    stalledMs: WAKE_SKIP_DWELL_MS + BEAT
  }]);
  assert.deepEqual(log.observe([nudged()], WAKE_SKIP_DWELL_MS + 2 * BEAT), []);
});

test('a written stall that ends because the inbox drained says so', () => {
  const log = new WakeSkipLog();
  log.observe([skip('not-quiet')], 0);
  log.observe([skip('not-quiet')], WAKE_SKIP_DWELL_MS);
  const lines = log.observe([], WAKE_SKIP_DWELL_MS + BEAT);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].state, 'resolved');
  assert.equal(lines[0].via, 'drained');
});

test('mail already announced is never reported as a stall', () => {
  // The worker was woken for this mail and is working on it — not a stall of
  // the wake path, however long the turn runs.
  const log = new WakeSkipLog();
  for (let t = 0; t <= 2 * WAKE_SKIP_DWELL_MS; t += BEAT) {
    assert.deepEqual(log.observe([skip('not-quiet', { newIds: [] })], t), []);
  }
});

test('each worker is tracked on its own', () => {
  const log = new WakeSkipLog();
  log.observe([skip('not-quiet'), skip('not-quiet', { agentId: 'bob' })], 0);
  const lines = log.observe([skip('not-quiet'), nudged({ agentId: 'bob' })], WAKE_SKIP_DWELL_MS);
  assert.deepEqual(lines.map((l) => [l.agentId, l.state]), [['alice', 'not-quiet']]);
});

test('a long backlog is counted in full but named only in part', () => {
  const ids = Array.from({ length: WAKE_SKIP_MAX_IDS + 15 }, (_, i) => `m${i}`);
  const log = new WakeSkipLog();
  log.observe([skip('not-quiet', { inboxIds: ids, newIds: ids })], 0);
  const [line] = log.observe([skip('not-quiet', { inboxIds: ids, newIds: ids })], WAKE_SKIP_DWELL_MS);
  assert.equal(line.pending, ids.length);
  assert.equal(line.newIds.length, WAKE_SKIP_MAX_IDS);
});

// ─── Codex facts on a stall line ─────────────────────────────────────────────

test('Codex facts date the last rollout and the last catch-up summary', () => {
  assert.deepEqual(codexStallFacts(100_000, 190_000, 200_000, BEAT),
    { rolloutAgeMs: 100_000, catchupAgoMs: 10_000, catchupInLastBeat: true });
  assert.deepEqual(codexStallFacts(100_000, 150_000, 200_000, BEAT),
    { rolloutAgeMs: 100_000, catchupAgoMs: 50_000, catchupInLastBeat: false });
  assert.deepEqual(codexStallFacts(100_000, 200_000 - BEAT, 200_000, BEAT),
    { rolloutAgeMs: 100_000, catchupAgoMs: BEAT, catchupInLastBeat: false });
  assert.deepEqual(codexStallFacts(null, null, 200_000, BEAT),
    { rolloutAgeMs: null, catchupAgoMs: null, catchupInLastBeat: false });
});

// ─── Wiring ──────────────────────────────────────────────────────────────────

test('the wake beat writes what the skip log produces, with Codex facts attached', () => {
  // Comments are blanked, so a call that has been commented out cannot pass.
  const src = sourceAssert.activeSource('src/main/index.ts');
  const body = sourceAssert.boundedSlice(src, 'function runWorkerWakeBeat(): void {', 'function armAlwaysOnBeats(): void {');
  assert.match(body, /workerWake\.decideWithReasons\(facts, now\)/);
  assert.match(body, /wakeSkipLog\.observe\(verdicts, now\)/);
  assert.match(body, /hive\.appendLog\(/);
  assert.match(body, /codexStallFacts\(/);
});
