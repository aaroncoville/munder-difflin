'use strict';

// The app's cost rows queue for the ledger: rows are written only through the locked append, several under one hold,
// never waiting for the lock on the app's thread; rows that cannot be written stay queued in order and are tried again
// later with back-off; one timer attempt writes at most `perTick` rows; a failure is reported once, a recovery once;
// a full queue drops its oldest row and says so; flush stops at one deadline for the whole queue.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { CostLedgerQueue } = loadTs('src/core/costLedgerQueue.ts');

/** A queue whose timers run only when the test says, and whose append fails while `busy` is set. `step` is how many
 *  rows one append writes at most (all it is given by default), and `cost` how far the clock moves per append. */
function rig({ cap, perTick, step = Infinity, cost = 0, failCost } = {}) {
  const written = [];
  const reports = [];
  const timers = [];
  const calls = [];
  const clock = { t: 0 };
  const state = { busy: false };
  const q = new CostLedgerQueue({
    append: (rows, waitMs) => {
      calls.push({ rows: rows.length, waitMs, at: clock.t });
      if (state.busy) { clock.t += failCost ?? waitMs; throw new Error('could not lock cost-ledger.jsonl.lock'); }
      clock.t += cost;
      const n = Math.min(step, rows.length);
      for (const r of rows.slice(0, n)) written.push(r.n);
      return n;
    },
    report: (e) => reports.push(e),
    cap, perTick, retryMs: [10, 20, 40],
    setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
    clearTimer: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
    now: () => clock.t,
  });
  const tick = () => { const t = timers.shift(); assert.ok(t, 'an attempt is due'); t.fn(); return t.ms; };
  return { q, written, reports, timers, calls, state, tick, clock };
}

test('a row is written at once when the lock is free, without waiting for it', () => {
  const r = rig();
  r.q.push({ n: 1 });
  assert.deepEqual(r.written, [1]);
  assert.deepEqual(r.calls.map((c) => c.waitMs), [0]);
  assert.equal(r.q.size, 0);
  assert.deepEqual(r.reports, []);
});

test('rows that cannot be written stay queued, the rows behind wait, and they are retried with back-off until they land, in order', () => {
  const r = rig();
  r.state.busy = true;
  r.q.push({ n: 1 });
  r.q.push({ n: 2 });
  assert.deepEqual(r.written, []);
  assert.equal(r.q.size, 2);
  assert.equal(r.calls.length, 1, 'a row pushed behind a failed one does not try on its own');
  assert.equal(r.tick(), 10);
  assert.equal(r.tick(), 20);
  assert.equal(r.tick(), 40);
  r.state.busy = false;
  assert.equal(r.tick(), 40, 'the last wait repeats');
  assert.deepEqual(r.written, [1, 2]);
  assert.equal(r.calls.at(-1).rows, 2, 'both rows went in one append');
  assert.equal(r.q.size, 0);
  assert.equal(r.timers.length, 0);
  assert.ok(r.calls.every((c) => c.waitMs === 0), 'no attempt on the timer waited for the lock');
});

test('one timer attempt writes at most perTick rows; the rest follow on later ticks', () => {
  const r = rig({ perTick: 25 });
  r.state.busy = true;
  for (let n = 1; n <= 60; n++) r.q.push({ n });
  r.state.busy = false;
  r.tick();
  assert.equal(r.written.length, 25);
  assert.equal(r.tick(), 0, 'the next batch is due at once, on a later tick');
  assert.equal(r.written.length, 50);
  r.tick();
  assert.equal(r.written.length, 60);
  assert.ok(r.calls.slice(1).every((c) => c.rows <= 25));
  assert.equal(r.timers.length, 0);
});

test('a failure is reported once when it starts, and once more when rows are written again', () => {
  const r = rig();
  r.state.busy = true;
  r.q.push({ n: 1 });
  r.tick(); r.tick();
  r.q.push({ n: 2 });
  assert.deepEqual(r.reports, [{ kind: 'failing', reason: 'could not lock cost-ledger.jsonl.lock', queued: 1 }]);
  r.state.busy = false;
  r.tick();
  assert.deepEqual(r.reports.map((e) => e.kind), ['failing', 'recovered']);
});

test('a full queue drops its oldest row and says so, and says how many when it recovers', () => {
  const r = rig({ cap: 2 });
  r.state.busy = true;
  for (const n of [1, 2, 3, 4]) r.q.push({ n });
  assert.equal(r.q.size, 2);
  assert.deepEqual(r.reports.map((e) => e.kind), ['failing', 'dropped']);
  r.state.busy = false;
  r.tick();
  assert.deepEqual(r.written, [3, 4]);
  assert.deepEqual(r.reports.slice(2), [{ kind: 'dropped', count: 2 }, { kind: 'recovered' }]);
});

test('flush writes what is queued, all at once when it can, and leaves no attempt pending', () => {
  const r = rig();
  r.state.busy = true;
  for (let n = 1; n <= 40; n++) r.q.push({ n });
  r.state.busy = false;
  assert.equal(r.q.flush(1000), 0);
  assert.equal(r.written.length, 40);
  assert.equal(r.calls.at(-1).rows, 40, 'one append for the whole queue');
  assert.equal(r.timers.length, 0);
});

test('flush stops at one deadline for the whole queue, each attempt waiting no longer than what is left', () => {
  // Each append takes 400 ms and writes one row: three attempts fit in 1,000 ms, and the rest are left.
  const r = rig({ step: 1, cost: 400 });
  r.state.busy = true;
  for (let n = 1; n <= 10; n++) r.q.push({ n });
  r.state.busy = false;
  r.clock.t = 0;
  r.calls.length = 0;
  assert.equal(r.q.flush(1000), 7);
  assert.deepEqual(r.calls.map((c) => c.waitMs), [1000, 600, 200]);
  assert.ok(r.clock.t <= 1200);
  assert.equal(r.timers.length, 0, 'no attempt is left pending after a flush');
});

test('flush behind a lock that stays held returns once its deadline has passed, with every row still queued', () => {
  const r = rig();
  r.state.busy = true;
  for (let n = 1; n <= 1000; n++) r.q.push({ n });
  r.clock.t = 0;
  r.calls.length = 0;
  assert.equal(r.q.flush(1000), 1000);
  assert.equal(r.calls.length, 1, 'one attempt, which used the whole deadline waiting');
  assert.equal(r.clock.t, 1000);
  assert.equal(r.timers.length, 0);
});
