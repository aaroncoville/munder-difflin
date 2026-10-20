'use strict';

/**
 * MemoryReflector: backoff for a summarize failure that repeats verbatim.
 *
 * On 2026-10-20 the god agent's memory.md crossed the condense trigger while
 * every hidden session failed the same way ('no assistant response found in
 * transcript'); the autonomous scan then spawned a hidden claude — two, with
 * the transcript-race retry — every 30-minute tick, six ticks in a row, each
 * a model call and a CPU burst on a loaded machine for an outcome that was
 * never going to change. After SUMMARIZE_BACKOFF_AFTER identical failures the
 * scan now waits one interval, doubling per further identical failure up to
 * six hours, and writes ONE `condense-backoff` line per window instead of an
 * abort per tick. The streak ends on any other outcome, a manual condense, or
 * the file growing materially.
 *
 * hiddenClaude.ts is stubbed the same way reflect.test.cjs stubs it; the
 * clock is injected so the schedule is asserted in minutes, not wall time.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const HIDDEN = 'src/main/hiddenClaude.ts';
const MIN = 60_000;
const INTERVAL = 30 * MIN;
const NO_RESPONSE = { ok: false, error: 'no assistant response found in transcript (transcript file was never written)' };
const TRUST_DIALOG = { ok: false, error: 'workspace trust dialog blocked the session (cwd is not a trusted Claude Code directory)' };
const GOOD = { ok: true, text: JSON.stringify({ condensed: 'a short summary', hoist: [] }) };

const pad = (label, bytes) => `${label}${'x'.repeat(Math.max(0, bytes - label.length))}`;
const section = (heading, bodyBytes) => `## ${heading}\n${pad('body', bodyBytes)}\n`;
function fixture(sections) {
  return [
    '# Memory — test agent\n',
    '## 📌 Durable facts (pinned — never condensed)\n\nfact one\n',
    '## Recent\n',
    ...sections
  ].join('\n');
}

/** A fresh reflector over a fresh temp home, with a scripted hidden session,
 *  a captured log, and a clock the test moves by hand. */
function harness() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-reflect-backoff-'));
  const dir = path.join(home, 'hive', 'agents', 'god');
  fs.mkdirSync(dir, { recursive: true });
  const mem = path.join(dir, 'memory.md');
  fs.writeFileSync(mem, fixture([section('old one', 300), section('old two', 300), section('newest', 300)]), 'utf8');

  const state = { calls: 0, respond: NO_RESPONSE, now: 1_800_000_000_000, log: [] };
  loadTs.reset();
  loadTs.stub(HIDDEN, { runHiddenClaude: async () => { state.calls += 1; return state.respond; } });
  const { MemoryReflector } = loadTs('src/main/reflect.ts');
  const reflector = new MemoryReflector(
    () => home,
    () => 'claude',
    () => ({}),
    () => ({
      enabled: true, intervalMs: INTERVAL, byteTriggerPct: 0, sectionTrigger: 50,
      recentKeep: 1, minBytes: 50, keepBudgetPct: 25
    }),
    (e) => state.log.push(e),
    () => state.now
  );
  const tick = async (onlyId) => (await reflector.reflectNow(onlyId))[0];
  const backoffs = () => state.log.filter((e) => e.kind === 'condense-backoff');
  const aborts = () => state.log.filter((e) => e.kind === 'condense-abort');
  return { state, mem, tick, backoffs, aborts };
}

test('repro + fix: the same failure every tick stops spawning a hidden session after two, then backs off exponentially to a 6 h cap', async () => {
  const { state, tick, backoffs, aborts } = harness();

  // Tick 1: fails, with the transcript-race retry — two hidden sessions.
  let r = await tick();
  assert.equal(r.reason, 'summarize-failed');
  assert.equal(state.calls, 2);
  assert.equal(backoffs().length, 0, 'a single failure is not yet a streak');

  // Tick 2, one interval later: fails identically — the streak is two, the
  // window opens for one interval, and exactly one line says so.
  state.now += INTERVAL;
  r = await tick();
  assert.equal(r.reason, 'summarize-failed');
  assert.equal(state.calls, 4);
  assert.equal(backoffs().length, 1);
  assert.deepEqual(
    { failures: backoffs()[0].failures, backoffMs: backoffs()[0].backoffMs, reason: backoffs()[0].reason, agentId: backoffs()[0].agentId },
    { failures: 2, backoffMs: INTERVAL, reason: 'summarize-failed', agentId: 'god' }
  );
  assert.match(backoffs()[0].detail, /no assistant response found in transcript/);
  assert.equal(aborts().length, 2);

  // Inside the window: no hidden session, no abort line, no second backoff line.
  state.now += INTERVAL - MIN;
  r = await tick();
  assert.equal(r.reason, 'summarize-backoff');
  assert.equal(state.calls, 4, 'nothing was spawned inside the window');
  assert.equal(aborts().length, 2);
  assert.equal(backoffs().length, 1);

  // The window has passed: one more try, which fails the same way, so the
  // next window is twice as long.
  state.now += MIN;
  r = await tick();
  assert.equal(r.reason, 'summarize-failed');
  assert.equal(state.calls, 6);
  assert.equal(backoffs().length, 2);
  assert.equal(backoffs()[1].failures, 3);
  assert.equal(backoffs()[1].backoffMs, 2 * INTERVAL);

  state.now += 2 * INTERVAL - MIN;
  assert.equal((await tick()).reason, 'summarize-backoff');
  assert.equal(state.calls, 6);

  // Keep failing: 4 h, then the cap, then the cap again.
  const expected = [4 * INTERVAL, 8 * INTERVAL, 6 * 60 * MIN, 6 * 60 * MIN];
  for (const backoffMs of expected) {
    state.now += backoffs()[backoffs().length - 1].backoffMs;
    assert.equal((await tick()).reason, 'summarize-failed');
    assert.equal(backoffs()[backoffs().length - 1].backoffMs, backoffMs);
  }
  assert.equal(backoffs().length, 2 + expected.length);
  assert.equal(aborts().length, backoffs().length + 1, 'one abort line per attempt, never per skipped tick');
});

test('a different failure text is a new streak, not a continuation', async () => {
  const { state, tick, backoffs } = harness();
  await tick();
  state.now += INTERVAL;
  await tick();
  assert.equal(backoffs().length, 1);

  state.now += INTERVAL;
  state.respond = TRUST_DIALOG;
  const r = await tick();
  assert.equal(r.reason, 'summarize-failed');
  assert.equal(backoffs().length, 1, 'the first trust-dialog failure does not extend the transcript streak');
});

test('a response ends the streak: the next failure counts from one again', async () => {
  const { state, tick, backoffs } = harness();
  await tick();
  state.now += INTERVAL;
  await tick();
  assert.equal(backoffs().length, 1);

  state.now += INTERVAL;
  state.respond = GOOD;
  const r = await tick();
  assert.equal(r.condensed, true);

  // Condensed files are below the trigger here, so grow it back over the floor.
  state.now += INTERVAL;
  state.respond = NO_RESPONSE;
  const again = await tick();
  // Either the file no longer needs condensing (fine) or it failed once; what
  // must not happen is a backoff window opening on the first failure.
  assert.notEqual(again?.reason, 'summarize-backoff');
  assert.equal(backoffs().length, 1);
});

test('a manual condense ignores the window', async () => {
  const { state, tick } = harness();
  await tick();
  state.now += INTERVAL;
  await tick();
  state.now += MIN;
  assert.equal((await tick()).reason, 'summarize-backoff');
  const calls = state.calls;
  const r = await tick('god');
  assert.equal(r.reason, 'summarize-failed');
  assert.equal(state.calls, calls + 2, 'the manual call spawned its hidden session');
});

test('a file that grew past the size it failed at gets a fresh try inside the window, and the streak starts over', async () => {
  const { state, mem, tick, backoffs } = harness();
  await tick();
  state.now += INTERVAL;
  await tick();
  assert.equal(backoffs().length, 1);
  state.now += MIN;
  assert.equal((await tick()).reason, 'summarize-backoff');

  // More than NOT_SMALLER_BACKOFF_GROWTH (10%) larger than the failing size.
  fs.appendFileSync(mem, section('a lot more', 400), 'utf8');
  const calls = state.calls;
  let r = await tick();
  assert.equal(r.reason, 'summarize-failed');
  assert.equal(state.calls, calls + 2);
  // A different case: this failure is the FIRST of a new streak, so no window
  // opens and no backoff line is written for it.
  assert.equal(backoffs().length, 1);
  state.now += MIN;
  r = await tick();
  assert.equal(r.reason, 'summarize-failed', 'not backed off: the streak restarted at one');
  assert.equal(state.calls, calls + 4);
  // ...and its second failure is what opens the next window, counted from one.
  assert.equal(backoffs().length, 2);
  assert.equal(backoffs()[1].failures, 2);
  assert.equal(backoffs()[1].backoffMs, INTERVAL);
});

test('growth resets a one-failure streak too (no window open yet)', async () => {
  const { state, mem, tick, backoffs } = harness();
  await tick(); // count one, notBefore 0
  // More than 10% larger than the failing size.
  fs.appendFileSync(mem, section('a lot more', 400), 'utf8');
  state.now += INTERVAL;
  assert.equal((await tick()).reason, 'summarize-failed');
  // Without the reset this second identical failure would be the streak's
  // second and open a window; with it, it is the first of a new streak.
  assert.equal(backoffs().length, 0);
  state.now += INTERVAL;
  await tick();
  assert.equal(backoffs().length, 1);
  assert.equal(backoffs()[0].failures, 2);
});

test('growth resets a streak whose window has already expired', async () => {
  const { state, mem, tick, backoffs } = harness();
  await tick();
  state.now += INTERVAL;
  await tick();
  assert.equal(backoffs().length, 1); // window: one interval
  state.now += 2 * INTERVAL; // well past it
  fs.appendFileSync(mem, section('a lot more', 400), 'utf8');
  assert.equal((await tick()).reason, 'summarize-failed');
  // Without the reset this would be failure three (a 2-interval window);
  // with it, the first of a new streak: no new line.
  assert.equal(backoffs().length, 1);
  state.now += INTERVAL;
  await tick();
  assert.equal(backoffs().length, 2);
  assert.equal(backoffs()[1].failures, 2);
  assert.equal(backoffs()[1].backoffMs, INTERVAL);
});

test('a response that exists but breaks the frame is "bad-framing": no backoff, and it ends a no-response streak', async () => {
  const { state, tick, backoffs, aborts } = harness();
  // Two no-response failures open a window...
  await tick();
  state.now += INTERVAL;
  await tick();
  assert.equal(backoffs().length, 1);

  // ...then, once it has passed, the model answers with a broken frame: the
  // CONDENSED marker is there but HOIST and END are missing.
  state.now += INTERVAL;
  state.respond = { ok: true, text: '<<<CONDENSED>>>\nhalf an answer with no closing markers' };
  const calls = state.calls;
  let r = await tick();
  assert.equal(r.reason, 'bad-framing');
  assert.equal(state.calls, calls + 1, 'a framing failure is not the transcript race; no second spawn');
  assert.equal(aborts()[aborts().length - 1].reason, 'bad-framing');
  assert.equal(backoffs().length, 1, 'no backoff window for a response that came back');

  // The streak ended: the next no-response failure counts from one again.
  state.now += INTERVAL;
  state.respond = NO_RESPONSE;
  r = await tick();
  assert.equal(r.reason, 'summarize-failed');
  assert.equal(backoffs().length, 1);
  state.now += INTERVAL;
  await tick();
  assert.equal(backoffs().length, 2);
  assert.equal(backoffs()[1].failures, 2);
});
