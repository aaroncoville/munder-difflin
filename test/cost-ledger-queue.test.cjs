'use strict';

// The app's cost rows queue for the ledger: each row is written only through the locked append, never waiting for the
// lock on the app's thread; a row that cannot be written stays at the head (the rows behind it wait) and is tried again
// later with back-off; a failure is reported once, a recovery once; a full queue drops its oldest row and says so.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { CostLedgerQueue } = loadTs('src/core/costLedgerQueue.ts');

/** A queue whose timers run only when the test says, and whose append fails while `busy` is set. */
function rig({ cap } = {}) {
  const written = [];
  const reports = [];
  const timers = [];
  const waits = [];
  const state = { busy: false };
  const q = new CostLedgerQueue({
    append: (row, waitMs) => { waits.push(waitMs); if (state.busy) throw new Error('could not lock cost-ledger.jsonl.lock'); written.push(row.n); },
    report: (e) => reports.push(e),
    cap, retryMs: [10, 20, 40],
    setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
    clearTimer: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
  });
  const tick = () => { const t = timers.shift(); assert.ok(t, 'a retry is due'); t.fn(); return t.ms; };
  return { q, written, reports, timers, waits, state, tick };
}

test('a row is written at once when the lock is free, without waiting for it', () => {
  const r = rig();
  r.q.push({ n: 1 });
  assert.deepEqual(r.written, [1]);
  assert.deepEqual(r.waits, [0]);
  assert.equal(r.q.size, 0);
  assert.deepEqual(r.reports, []);
});

test('a row that cannot be written stays queued, the rows behind it wait, and it is retried with back-off until it lands, in order', () => {
  const r = rig();
  r.state.busy = true;
  r.q.push({ n: 1 });
  r.q.push({ n: 2 });
  assert.deepEqual(r.written, []);
  assert.equal(r.q.size, 2);
  assert.equal(r.waits.length, 1, 'a row pushed behind a failed one does not try on its own');
  assert.equal(r.tick(), 10);
  assert.equal(r.tick(), 20);
  assert.equal(r.tick(), 40);
  r.state.busy = false;
  assert.equal(r.tick(), 40, 'the last wait repeats');
  assert.deepEqual(r.written, [1, 2]);
  assert.equal(r.q.size, 0);
  assert.equal(r.timers.length, 0);
  assert.ok(r.waits.every((w) => w === 0), 'no attempt waited for the lock');
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

test('flush writes what is queued now, may wait for the lock, and says how many rows are left', () => {
  const r = rig();
  r.state.busy = true;
  r.q.push({ n: 1 });
  r.q.push({ n: 2 });
  assert.equal(r.q.flush(500), 2, 'still busy: both left');
  assert.equal(r.waits.at(-1), 500);
  r.state.busy = false;
  assert.equal(r.q.flush(500), 0);
  assert.deepEqual(r.written, [1, 2]);
  assert.equal(r.timers.length, 0, 'no retry is left pending');
});
