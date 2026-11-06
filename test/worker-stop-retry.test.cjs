'use strict';

/**
 * The schedule for retrying a worker's failed stop. The tick that applies it runs in
 * worker-stop-and-archive.test.cjs; this pins the numbers it is built from.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { STOP_RETRY_FIRST_MS, STOP_RETRY_MAX_MS, STUCK_NOTICE_EVERY_MS, stopFailedAgain, stopRetryDue } = loadTs('src/main/workerStopRetry.ts');

test('the delay doubles from the first and stays at the cap', () => {
  let retry;
  const now = 1_000_000;
  const delays = [];
  for (let i = 0; i < 12; i += 1) {
    ({ retry } = stopFailedAgain(retry, now));
    delays.push(retry.nextAttemptAt - now);
  }
  assert.equal(delays[0], STOP_RETRY_FIRST_MS);
  assert.equal(delays[1], STOP_RETRY_FIRST_MS * 2);
  assert.equal(delays[2], STOP_RETRY_FIRST_MS * 4);
  assert.equal(delays.at(-1), STOP_RETRY_MAX_MS);
  assert.deepEqual(delays, [...delays].sort((a, b) => a - b));
  assert.ok(delays.every((d) => d <= STOP_RETRY_MAX_MS));
});

test('the delay stays finite however long the failure lasts', () => {
  let retry;
  for (let i = 0; i < 5_000; i += 1) ({ retry } = stopFailedAgain(retry, 0));
  assert.equal(retry.nextAttemptAt, STOP_RETRY_MAX_MS);
  assert.equal(retry.failures, 5_000);
});

test('an attempt is due at its time, and a worker with no failure yet is due', () => {
  const { retry } = stopFailedAgain(undefined, 1000);
  assert.equal(stopRetryDue(retry, retry.nextAttemptAt - 1), false);
  assert.equal(stopRetryDue(retry, retry.nextAttemptAt), true);
  assert.equal(stopRetryDue(undefined, 0), true);
});

test('the notice period runs from the first failure and restarts at each notice', () => {
  const start = 1_000_000;
  let { retry, notify } = stopFailedAgain(undefined, start);
  assert.equal(notify, false, 'not on the first failure');
  ({ retry, notify } = stopFailedAgain(retry, start + STUCK_NOTICE_EVERY_MS - 1));
  assert.equal(notify, false);
  ({ retry, notify } = stopFailedAgain(retry, start + STUCK_NOTICE_EVERY_MS));
  assert.equal(notify, true);
  assert.equal(retry.firstFailedAt, start, 'still dated from the first failure');
  ({ retry, notify } = stopFailedAgain(retry, start + STUCK_NOTICE_EVERY_MS + 1));
  assert.equal(notify, false);
  ({ retry, notify } = stopFailedAgain(retry, start + STUCK_NOTICE_EVERY_MS * 2));
  assert.equal(notify, true);
});
