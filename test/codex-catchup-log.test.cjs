'use strict';

/**
 * The catch-up summary is read from Codex's own debug log, through a database
 * opener the caller supplies. The real opener is a native module built for
 * Electron, which cannot load under node --test, so these tests hand in a
 * stand-in: that is how the query, its bounds and its failure handling are
 * checked here at all.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { lastCatchupAt, CATCHUP_ROW_BOUND } = loadTs('src/main/codexCatchupLog.ts');

const PROMPT = '%Write a brief catch-up for a user returning to this Codex task%';

/** A stand-in database answering the query with `tsSeconds`, recording what it saw. */
function fakeDb(tsSeconds, seen = {}) {
  return {
    prepare(sql) {
      seen.sql = sql;
      return { get(...params) { seen.params = params; return { ts: tsSeconds }; } };
    },
    close() { seen.closed = true; }
  };
}

test('the latest catch-up summary is read from the log in the home it is given', () => {
  const seen = {};
  const opened = [];
  const at = lastCatchupAt('/homes/owner/.codex', 5_000_000_000, (file) => {
    opened.push(file);
    return fakeDb(4_999_000, seen);
  });
  assert.equal(at, 4_999_000 * 1000);
  assert.deepEqual(opened, [path.join('/homes/owner/.codex', 'logs_2.sqlite')]);
  assert.equal(seen.closed, true);
});

test('the query is bounded by rows as well as by time', () => {
  // A time window alone bounds nothing on a busy log: it is the newest rows,
  // by rowid, that cap how much a single read can scan.
  const seen = {};
  lastCatchupAt('/h', 5_000_000_000, () => fakeDb(4_999_000, seen));
  assert.deepEqual(seen.params, [CATCHUP_ROW_BOUND, 5_000_000 - 24 * 3600, 5_000_000, PROMPT]);
  assert.match(seen.sql, /rowid > \(SELECT max\(rowid\) FROM logs\) - \?/);
  assert.match(seen.sql, /\+ts > \? AND \+ts <= \?/);
  assert.ok(CATCHUP_ROW_BOUND > 0 && CATCHUP_ROW_BOUND <= 50_000, String(CATCHUP_ROW_BOUND));
});

test('a log that cannot be opened or queried reads as unknown, and is still closed', () => {
  assert.equal(lastCatchupAt('/h', 1e12, () => { throw new Error('unable to open database file'); }), null);

  const seen = {};
  const broken = { prepare() { throw new Error('no such table: logs'); }, close() { seen.closed = true; } };
  assert.equal(lastCatchupAt('/h', 1e12, () => broken), null);
  assert.equal(seen.closed, true);
});

test('a log with no catch-up summary in range reads as unknown', () => {
  assert.equal(lastCatchupAt('/h', 1e12, () => fakeDb(null)), null);
  assert.equal(lastCatchupAt('/h', 1e12, () => ({ prepare: () => ({ get: () => undefined }), close() {} })), null);
});
