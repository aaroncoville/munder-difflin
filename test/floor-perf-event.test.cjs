'use strict';

// The renderer's one write into the hive log: a 'floor-perf' sample
// (shared/floorPerfEvent.ts, handled by main's 'hive:logEvent'). The log is
// the hive's record, so main accepts that kind only, drops a renderer ts
// (appendLog stamps its own) and refuses anything over the size cap.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { acceptFloorPerfEvent, utf8Bytes, FLOOR_PERF_KIND, FLOOR_PERF_MAX_BYTES } = loadTs('src/shared/floorPerfEvent.ts');

test('the cap is in UTF-8 bytes, as the log is written, not UTF-16 code units', () => {
  assert.equal(utf8Bytes('abc'), 3);
  assert.equal(utf8Bytes('é'), 2);
  assert.equal(utf8Bytes('\u{1F525}'), 4, 'a fire emoji is four bytes and two code units');
  // 3,000 emoji: 6,000 code units (under the cap by that measure), 12,000 bytes.
  const emoji = { kind: FLOOR_PERF_KIND, pad: '\u{1F525}'.repeat(3000) };
  assert.ok(JSON.stringify(emoji).length < FLOOR_PERF_MAX_BYTES);
  assert.ok(utf8Bytes(JSON.stringify(emoji)) > FLOOR_PERF_MAX_BYTES);
  assert.equal(acceptFloorPerfEvent(emoji), null, 'over the cap in bytes');
  const ascii = { kind: FLOOR_PERF_KIND, pad: 'x'.repeat(FLOOR_PERF_MAX_BYTES - 100) };
  assert.ok(acceptFloorPerfEvent(ascii), 'under the cap in bytes');
});

test("main accepts only a 'floor-perf' object under the size cap, and stamps ts itself", () => {
  assert.equal(acceptFloorPerfEvent(null), null);
  assert.equal(acceptFloorPerfEvent('floor-perf'), null);
  assert.equal(acceptFloorPerfEvent([]), null);
  assert.equal(acceptFloorPerfEvent({ kind: 'message', body: 'x' }), null, 'only the one kind');
  assert.equal(acceptFloorPerfEvent({ body: 'x' }), null);
  const ok = acceptFloorPerfEvent({ kind: FLOOR_PERF_KIND, ts: 1, rendersPerSec: 0 });
  assert.deepEqual(ok, { kind: FLOOR_PERF_KIND, rendersPerSec: 0 }, 'the renderer ts is dropped');
  const big = { kind: FLOOR_PERF_KIND, pad: 'x'.repeat(FLOOR_PERF_MAX_BYTES) };
  assert.equal(acceptFloorPerfEvent(big), null, 'over the cap');
  const cyc = { kind: FLOOR_PERF_KIND }; cyc.self = cyc;
  assert.equal(acceptFloorPerfEvent(cyc), null, 'unserialisable');
  // A realistic sample (five culprits, a dozen characters) fits with room.
  const sample = {
    kind: FLOOR_PERF_KIND, windowS: 15, rendersPerSec: 0, ticksPerSec: 15, rafPerSec: 60, dirtyTicks: 0, ticks: 225, renders: 0,
    canvas: { width: 1600, height: 900, resolution: 1 }, renderer: 'canvas', visibility: 'visible', focus: true, tickerRunning: true,
    cast: { total: 12, active: 0, seated: 12, byStatus: { idle: 12, working: 0, thinking: 0, waiting: 0, blocked: 0, compacting: 0, looping: 0, success: 0, ghost: 0, other: 0 } },
    culprits: Array.from({ length: 5 }, (_, i) => ({ what: `xform: Graphics#halo-${i} < Container#world < Container`, ticks: 225 }))
  };
  assert.ok(JSON.stringify(acceptFloorPerfEvent(sample)).length < FLOOR_PERF_MAX_BYTES / 2);
});
