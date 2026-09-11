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
/** Workers whose terminal is still open this beat. */
const LIVE = new Set(['alice', 'bob']);
const NONE = new Set();

/** A stall that has been written once, for tests about how it ends. */
function writtenStall() {
  const log = new WakeSkipLog();
  log.observe([skip('not-quiet')], 0, LIVE);
  assert.equal(log.observe([skip('not-quiet')], WAKE_SKIP_DWELL_MS, LIVE).length, 1);
  return log;
}

test('mail delivered within the dwell leaves no trace', () => {
  const log = new WakeSkipLog();
  assert.deepEqual(log.observe([skip('not-quiet')], 0, LIVE), []);
  assert.deepEqual(log.observe([skip('not-quiet')], WAKE_SKIP_DWELL_MS - 1, LIVE), []);
  assert.deepEqual(log.observe([nudged()], WAKE_SKIP_DWELL_MS - 1, LIVE), []);
  assert.deepEqual(log.recordDelivery('alice', true, WAKE_SKIP_DWELL_MS), []);
});

test('a stall is written once it has lasted the dwell, not on every beat', () => {
  const log = new WakeSkipLog();
  const lines = [];
  for (let t = 0; t <= WAKE_SKIP_DWELL_MS + 5 * BEAT; t += BEAT) {
    lines.push(...log.observe([skip('not-quiet')], t, LIVE));
  }
  assert.equal(lines.length, 1);
  assert.equal(lines[0].state, 'not-quiet');
  assert.equal(lines[0].stalledMs, WAKE_SKIP_DWELL_MS);
});

test('the stall line carries the gate, the silence and the undelivered mail', () => {
  const log = new WakeSkipLog();
  log.observe([skip('not-quiet', { quietMs: 3_100, inboxIds: ['m0', 'm1'], newIds: ['m1'] })], 0, LIVE);
  const [line] = log.observe(
    [skip('not-quiet', { quietMs: 2_900, inboxIds: ['m0', 'm1'], newIds: ['m1'] })], WAKE_SKIP_DWELL_MS, LIVE
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
    lines.push(...log.observe([skip('not-quiet', { quietMs: t % 12_000 })], t, LIVE));
  }
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.map((l) => l.stalledMs),
    [WAKE_SKIP_DWELL_MS, WAKE_SKIP_DWELL_MS + WAKE_SKIP_RELOG_MS, WAKE_SKIP_DWELL_MS + 2 * WAKE_SKIP_RELOG_MS]);
});

test('once written, a change of gate or new undelivered mail is written at once', () => {
  const log = writtenStall();
  const changed = log.observe([skip('cooldown')], WAKE_SKIP_DWELL_MS + BEAT, LIVE);
  assert.equal(changed.length, 1);
  assert.equal(changed[0].state, 'cooldown');
  const more = log.observe([skip('cooldown', { inboxIds: ['m1', 'm2'], newIds: ['m1', 'm2'] })], WAKE_SKIP_DWELL_MS + 2 * BEAT, LIVE);
  assert.equal(more.length, 1);
  assert.deepEqual(more[0].newIds, ['m1', 'm2']);
  // The stall is still dated from its first beat, not from the latest change.
  assert.equal(more[0].stalledMs, WAKE_SKIP_DWELL_MS + 2 * BEAT);
});

test('a written stall is resolved only once the nudge has actually been submitted', () => {
  const log = writtenStall();
  // Deciding to nudge is not delivering: the terminal write can still fail.
  assert.deepEqual(log.observe([nudged()], WAKE_SKIP_DWELL_MS + BEAT, LIVE), []);
  assert.deepEqual(log.recordDelivery('alice', true, WAKE_SKIP_DWELL_MS + BEAT + 140), [{
    kind: 'worker-wake-skip',
    agentId: 'alice',
    state: 'resolved',
    via: 'nudged',
    stalledMs: WAKE_SKIP_DWELL_MS + BEAT + 140
  }]);
  assert.deepEqual(log.recordDelivery('alice', true, WAKE_SKIP_DWELL_MS + 2 * BEAT), []);
});

test('a nudge that fails to reach the terminal is written, and the stall stays open', () => {
  const log = writtenStall();
  log.observe([nudged()], WAKE_SKIP_DWELL_MS + BEAT, LIVE);
  assert.deepEqual(log.recordDelivery('alice', false, WAKE_SKIP_DWELL_MS + BEAT + 140), [{
    kind: 'worker-wake-skip',
    agentId: 'alice',
    state: 'nudge-failed',
    stalledMs: WAKE_SKIP_DWELL_MS + BEAT + 140
  }]);
  // Still open: a later, successful submission resolves it.
  const [line] = log.recordDelivery('alice', true, WAKE_SKIP_DWELL_MS + 3 * BEAT);
  assert.equal(line.state, 'resolved');
  assert.equal(line.via, 'nudged');
});

test('a nudge decided but never acknowledged does not resolve the stall', () => {
  const log = writtenStall();
  log.observe([nudged()], WAKE_SKIP_DWELL_MS + BEAT, LIVE);
  // The watchdog now counts the mail as announced, so it has nothing new to say…
  assert.deepEqual(log.observe([skip('already-announced', { newIds: [] })], WAKE_SKIP_DWELL_MS + 2 * BEAT, LIVE), []);
  // …but the stall is only closed by something observed: here, the inbox emptying.
  const [line] = log.observe([], WAKE_SKIP_DWELL_MS + 3 * BEAT, LIVE);
  assert.equal(line.state, 'resolved');
  assert.equal(line.via, 'drained');
});

test('a written stall that ends because the inbox drained says so', () => {
  const log = writtenStall();
  const lines = log.observe([], WAKE_SKIP_DWELL_MS + BEAT, LIVE);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].state, 'resolved');
  assert.equal(lines[0].via, 'drained');
});

test('a written stall whose terminal is gone is not reported as drained', () => {
  const log = writtenStall();
  assert.deepEqual(log.observe([], WAKE_SKIP_DWELL_MS + BEAT, NONE), [{
    kind: 'worker-wake-skip',
    agentId: 'alice',
    state: 'terminal-lost',
    stalledMs: WAKE_SKIP_DWELL_MS + BEAT
  }]);
});

test('mail already announced is never reported as a stall', () => {
  // The worker was woken for this mail and is working on it — not a stall of
  // the wake path, however long the turn runs.
  const log = new WakeSkipLog();
  for (let t = 0; t <= 2 * WAKE_SKIP_DWELL_MS; t += BEAT) {
    assert.deepEqual(log.observe([skip('not-quiet', { newIds: [] })], t, LIVE), []);
  }
});

test('each worker is tracked on its own', () => {
  const log = new WakeSkipLog();
  log.observe([skip('not-quiet'), skip('not-quiet', { agentId: 'bob' })], 0, LIVE);
  const lines = log.observe([skip('not-quiet'), nudged({ agentId: 'bob' })], WAKE_SKIP_DWELL_MS, LIVE);
  assert.deepEqual(lines.map((l) => [l.agentId, l.state]), [['alice', 'not-quiet']]);
});

test('a long backlog is counted in full but named only in part', () => {
  const ids = Array.from({ length: WAKE_SKIP_MAX_IDS + 15 }, (_, i) => `m${i}`);
  const log = new WakeSkipLog();
  log.observe([skip('not-quiet', { inboxIds: ids, newIds: ids })], 0, LIVE);
  const [line] = log.observe([skip('not-quiet', { inboxIds: ids, newIds: ids })], WAKE_SKIP_DWELL_MS, LIVE);
  assert.equal(line.pending, ids.length);
  assert.equal(line.newIds.length, WAKE_SKIP_MAX_IDS);
});

test('a wall clock stepped backwards never yields a negative duration', () => {
  // Reviewer's probe: stall from 1,000,000, written at 1,300,000, then the
  // clock is set back to 900,000 before the worker disappears.
  const log = new WakeSkipLog();
  log.observe([skip('not-quiet')], 1_000_000, LIVE);
  assert.equal(log.observe([skip('not-quiet')], 1_300_000, LIVE).length, 1);
  const [line] = log.observe([], 900_000, NONE);
  assert.equal(line.state, 'terminal-lost');
  assert.ok(line.stalledMs >= 0, `stalledMs ${line.stalledMs}`);
});

test('a rollback does not silence a stall until the old clock catches up', () => {
  const log = new WakeSkipLog();
  log.observe([skip('not-quiet')], 1_000_000, LIVE);
  assert.equal(log.observe([skip('not-quiet')], 1_300_000, LIVE).length, 1);
  // Set back a whole relog interval: the stall must be written again one
  // interval after the rollback, not one interval after the old clock.
  const back = 1_300_000 - WAKE_SKIP_RELOG_MS;
  assert.deepEqual(log.observe([skip('not-quiet')], back, LIVE), []);
  assert.equal(log.observe([skip('not-quiet')], back + WAKE_SKIP_RELOG_MS, LIVE).length, 1);
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

test('the wake beat nudges first, then writes what the skip log produces', () => {
  // Comments are blanked, so a call that has been commented out cannot pass.
  const src = sourceAssert.activeSource('src/main/index.ts');
  const body = sourceAssert.boundedSlice(src, 'function runWorkerWakeBeat(): void {', 'function armAlwaysOnBeats(): void {');
  assert.match(body, /workerWake\.decideWithReasons\(facts, now\)/);
  assert.match(body, /const live = new Set\(facts\.map\(\(f\) => f\.agentId\)\)/);
  assert.match(body, /wakeSkipLog\.observe\(verdicts, now, live\)/);
  assert.match(body, /nudgeWorker\(ptyId, ids, \(submitted\) =>/);
  assert.match(body, /wakeSkipLog\.recordDelivery\(agentId, submitted, Date\.now\(\)\)/);
  assert.match(body, /enrichStallLines\(/);
  assert.match(body, /hive\.appendLog\(/);
  // No diagnostic read may run before a nudge is typed.
  assert.ok(body.indexOf('nudgeWorker(ptyId, ids') < body.indexOf('enrichStallLines('),
    'every nudge is submitted before any stall line is enriched');
  // Enrichment is DEFERRED onto a timer keyed to the same submit delay, so the
  // pending Enter (scheduled first, during the nudge loop) fires before any
  // synchronous diagnostic read runs — a slow reader cannot postpone a submit.
  assert.match(body, /setTimeout\(\(\) => \{[\s\S]*?enrichStallLines\(/);
  assert.match(body, /\}, NUDGE_SUBMIT_DELAY_MS\);/);
});

test('the nudge reports whether its submission reached the terminal', () => {
  const src = sourceAssert.activeSource('src/main/index.ts');
  const body = sourceAssert.boundedSlice(src, 'function nudgeWorker(', 'function runWorkerWakeBeat(): void {');
  assert.match(body, /onOutcome\?\.\(false\)/);
  assert.match(body, /onOutcome\?\.\(ok\)/);
  assert.match(body, /\}, NUDGE_SUBMIT_DELAY_MS\);/);
});

test('the stall readings resolve the worker\'s home through the one shared record', () => {
  // The resolver itself is tested behaviourally with every reader; this pins
  // that the beat hands those readers the shared record, within the budget.
  const src = sourceAssert.activeSource('src/main/index.ts');
  const body = sourceAssert.boundedSlice(src, 'function runWorkerWakeBeat(): void {', 'function armAlwaysOnBeats(): void {');
  assert.match(body, /codexHomes\.homeOf\(agentId, nominalHome\(agentId\)\)/);
  assert.match(body, /codexAgentActiveAt\(agentId, codexHomes, nominalHome\(agentId\), now, codexActivityCache\)/);
  assert.match(body, /lastCatchupAt\(home, now, openCodexLogDb\)/);
  assert.match(body, /limitMs: STALL_ENRICH_BUDGET_MS/);
});
