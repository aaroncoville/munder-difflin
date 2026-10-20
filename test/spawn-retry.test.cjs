'use strict';

/**
 * spawnRetryReason — the one-retry decision for a PTY that dies right after
 * launch (see spawnRetry.ts for the 2026-10-20 god spawn it exists for).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { spawnRetryReason, SPAWN_RETRY_WINDOW_MS } = loadTs('src/main/spawnRetry.ts');

// The crash as recorded in hive/crashes/2026-10-20T18-39-48-574Z-god.log.
const EXECVP_TAIL = 'execvp(3) failed.: Permission denied\r\n';

test('repro: the god spawn that died on execvp Permission denied is retried', () => {
  assert.equal(
    spawnRetryReason({ exitCode: 1, signal: 0, uptimeMs: 444, tail: EXECVP_TAIL, alreadyRetried: false }),
    'exec-failed'
  );
});

test('an exec failure is retried however long the PTY lived', () => {
  assert.equal(
    spawnRetryReason({ exitCode: 1, signal: 0, uptimeMs: 30_000, tail: EXECVP_TAIL, alreadyRetried: false }),
    'exec-failed'
  );
  assert.equal(
    spawnRetryReason({ exitCode: 1, signal: 0, uptimeMs: 10, tail: 'posix_spawnp failed.: No such file or directory', alreadyRetried: false }),
    'exec-failed'
  );
});

test('any non-zero exit inside the launch window is retried, whatever it printed', () => {
  assert.equal(
    spawnRetryReason({ exitCode: 1, signal: 0, uptimeMs: SPAWN_RETRY_WINDOW_MS - 1, tail: 'error: unknown option', alreadyRetried: false }),
    'early-exit'
  );
  assert.equal(
    spawnRetryReason({ exitCode: 2, signal: 0, uptimeMs: 0, tail: '', alreadyRetried: false }),
    'early-exit'
  );
});

test('a non-zero exit after the launch window is a real failure, not a launch failure', () => {
  assert.equal(
    spawnRetryReason({ exitCode: 1, signal: 0, uptimeMs: SPAWN_RETRY_WINDOW_MS, tail: 'rate limited', alreadyRetried: false }),
    null
  );
});

test('a clean exit is never retried', () => {
  assert.equal(spawnRetryReason({ exitCode: 0, signal: 0, uptimeMs: 100, tail: '', alreadyRetried: false }), null);
});

test('a signal death is a chosen death, not a launch failure', () => {
  assert.equal(spawnRetryReason({ exitCode: 0, signal: 9, uptimeMs: 100, tail: EXECVP_TAIL, alreadyRetried: false }), null);
  assert.equal(spawnRetryReason({ exitCode: 1, signal: 15, uptimeMs: 100, tail: '', alreadyRetried: false }), null);
});

test('an unknown exit code is not second-guessed', () => {
  assert.equal(spawnRetryReason({ uptimeMs: 100, tail: EXECVP_TAIL, alreadyRetried: false }), null);
});

test('one retry per launch: the second identical death tears down', () => {
  assert.equal(
    spawnRetryReason({ exitCode: 1, signal: 0, uptimeMs: 444, tail: EXECVP_TAIL, alreadyRetried: true }),
    null
  );
});
