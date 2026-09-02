'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { workerExitEvent, WORKER_EXIT_LOG_KIND } = loadTs('src/main/workerExitLog.ts');

const SPAWNED_AT = 1_788_312_764_784;
const rec = (over = {}) => ({
  workerId: 'worker-codex-boot-test',
  command: 'claude -a never -s workspace-write',
  spawnedAt: SPAWNED_AT,
  ...over
});

test('a worker released on purpose is not reported as a death', () => {
  // Done-signal, idle reap and token-cap reap all set `releasing` before the
  // kill. Those are outcomes the log already carries; only an unasked-for exit
  // is news.
  assert.equal(workerExitEvent(rec({ releasing: true }), SPAWNED_AT + 900_000), null);
});

test('a worker whose process quit on its own is reported with the command line it was given', () => {
  // The whole point. A worker launched with a command line its CLI rejects dies
  // in a fraction of a second, and the archive line alone cannot say so — it
  // looks exactly like a worker that finished. The command line is what names
  // the cause, and it is the one thing nothing else in the log records.
  const e = workerExitEvent(rec(), SPAWNED_AT + 237);
  assert.equal(e.kind, WORKER_EXIT_LOG_KIND);
  assert.equal(e.agentId, 'worker-codex-boot-test');
  assert.equal(e.command, 'claude -a never -s workspace-write');
  assert.equal(e.uptimeMs, 237);
  assert.equal(e.releasedOnPurpose, false);
});

test('a worker that never recorded a command line still leaves a line', () => {
  const e = workerExitEvent(rec({ command: undefined }), SPAWNED_AT + 5);
  assert.ok(e, 'an unknown command line must not swallow the whole record');
  assert.equal(e.command, undefined);
  assert.equal(e.uptimeMs, 5);
});

test('a clock that went backwards does not report a negative lifetime', () => {
  assert.equal(workerExitEvent(rec(), SPAWNED_AT - 1000).uptimeMs, 0);
});
