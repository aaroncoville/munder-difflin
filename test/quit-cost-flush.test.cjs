'use strict';

// The app's will-quit handler writes the queued cost rows (HiveManager.flushCostLedger, bounded by its own deadline)
// before anything that can return early, so a second will-quit pass or an analytics flush cannot skip it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/** A source file without its comment lines, so a commented-out call does not count. */
const liveSource = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

test('will-quit flushes the cost queue first, with the default deadline', () => {
  const idx = liveSource('src/main/index.ts');
  const start = idx.indexOf("app.on('will-quit'");
  assert.ok(start >= 0, 'there is a will-quit handler');
  const body = idx.slice(start, idx.indexOf('\n});', start));
  const flush = body.indexOf('hive.flushCostLedger()');
  assert.ok(flush >= 0, 'it calls hive.flushCostLedger() with no argument');
  const early = body.indexOf('return');
  assert.ok(early < 0 || flush < early, 'the flush comes before any return');
});
