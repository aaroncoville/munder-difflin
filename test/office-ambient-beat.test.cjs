'use strict';

// One clock for the floor's ambient effects (ambientBeat.ts). The monitors'
// screen-life already stepped on a shared 4 Hz beat (office-desk-screen); the
// halo pulse, the steam off a parked cup and the status glyphs each ran off a
// private per-tick timer and redrew every tick, so one idle god at his desk
// kept a 15 fps floor rasterising fifteen times a second for nothing. The
// beat is now a module every ambient effect reads, so together they queue at
// most four redraws a second, on the same ticks. These pin the clock itself
// and that DeskScreen rides it rather than a clock of its own.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const beat = loadTs('src/renderer/src/scene/office/ambientBeat.ts');
const { DeskScreen, SCREEN_BEAT_S } = loadTs('src/renderer/src/scene/office/DeskScreen.ts');

const DT = 1 / 15;

test('the beat is 4 Hz: a step function of the clock, so reads within a beat agree', () => {
  beat.resetAmbientClock();
  assert.equal(beat.BEATS_PER_SECOND, 4);
  assert.equal(beat.BEAT_S, 0.25);
  assert.equal(beat.ambientClock(), 0);
  assert.equal(beat.ambientBeat(), 0);
  const seen = new Set();
  for (let i = 0; i < 150; i++) {
    beat.advanceAmbientClock(DT);
    const b = beat.ambientBeat();
    assert.equal(b, Math.floor(beat.ambientClock() / 0.25));
    assert.equal(beat.ambientBeatTime(), b * 0.25, 'beat time is the start of the beat');
    assert.ok(beat.ambientBeatTime() <= beat.ambientClock());
    seen.add(b);
  }
  assert.ok(Math.abs(beat.ambientClock() - 10) < 1e-9);
  // 10 s at 4 Hz: beats 0..39 or 0..40 depending on float accumulation.
  assert.ok(seen.size >= 40 && seen.size <= 41, `${seen.size} distinct beats in 10 s`);
});

test('the clock only moves when advanced, and reset starts it over', () => {
  beat.resetAmbientClock();
  for (let i = 0; i < 20; i++) assert.equal(beat.ambientBeat(), 0);
  beat.advanceAmbientClock(1);
  assert.equal(beat.ambientBeat(), 4);
  beat.resetAmbientClock();
  assert.equal(beat.ambientClock(), 0);
});

test('DeskScreen steps on the shared beat, not a clock of its own', () => {
  beat.resetAmbientClock();
  assert.equal(SCREEN_BEAT_S, beat.BEAT_S);
  DeskScreen.advance(0.5);
  assert.equal(beat.ambientClock(), 0.5, 'DeskScreen.advance must advance the shared clock');
  assert.equal(DeskScreen.clock, beat.ambientClock());
  beat.advanceAmbientClock(0.25);
  assert.equal(DeskScreen.clock, 0.75, 'the screen reads the shared clock');
});
