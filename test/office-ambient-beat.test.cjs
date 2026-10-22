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

test('the beat is 4 Hz: a step function of the clock, exact at the beat boundaries', () => {
  beat.resetAmbientClock();
  assert.equal(beat.BEATS_PER_SECOND, 4);
  assert.equal(beat.BEAT_S, 0.25);
  assert.equal(beat.ambientClock(), 0);
  assert.equal(beat.ambientBeat(), 0);
  const seen = new Set();
  for (let i = 0; i < 150; i++) {
    beat.advanceAmbientClock(DT);
    const b = beat.ambientBeat();
    assert.ok(Number.isInteger(b));
    assert.equal(beat.ambientBeatTime(), b * 0.25, 'beat time is the start of the beat');
    assert.ok(beat.ambientBeatTime() <= beat.ambientClock() + 1e-9);
    assert.ok(beat.ambientClock() - beat.ambientBeatTime() < 0.25, 'the remainder stays inside the beat');
    seen.add(b);
  }
  // 150 ticks of 1/15 s sum to 9.999999999999984 as floats; the beat must
  // not be left one short at the ten-second mark.
  assert.equal(beat.ambientBeat(), 40, 'beat 40 after exactly ten simulated seconds');
  assert.ok(Math.abs(beat.ambientClock() - 10) < 1e-9, `clock ${beat.ambientClock()}`);
  assert.equal(seen.size, 41, 'beats 0..40 in 10 s');
});

test('the clock only moves when advanced, ignores a non-positive dt, and reset starts it over', () => {
  beat.resetAmbientClock();
  for (let i = 0; i < 20; i++) assert.equal(beat.ambientBeat(), 0);
  beat.advanceAmbientClock(0);
  beat.advanceAmbientClock(-1);
  beat.advanceAmbientClock(NaN);
  assert.equal(beat.ambientClock(), 0);
  beat.advanceAmbientClock(1);
  assert.equal(beat.ambientBeat(), 4);
  assert.equal(beat.ambientClock(), 1);
  beat.resetAmbientClock();
  assert.equal(beat.ambientClock(), 0);
  assert.equal(beat.ambientBeat(), 0);
});

test('ambientFrame: the beat while animating, STILL_FRAME while holding, below any beat', () => {
  beat.resetAmbientClock();
  assert.ok(beat.STILL_FRAME < -1, 'below the "never drawn" marker');
  assert.equal(beat.ambientFrame(false), beat.STILL_FRAME);
  assert.equal(beat.ambientFrame(true), 0);
  beat.advanceAmbientClock(0.5);
  assert.equal(beat.ambientFrame(true), 2);
  assert.equal(beat.ambientFrame(false), beat.STILL_FRAME);
});

test('the floor starts the clock over for every scene it builds', () => {
  const fs = require('node:fs'); const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/scene/office/OfficeFloor.tsx'), 'utf8');
  const i = src.indexOf('const runtimes = new Map<string, Runtime>();');
  assert.ok(i > 0);
  const near = src.slice(i, i + 600);
  assert.match(near, /resetAmbientClock\(\);/, 'reset must sit with the scene setup, once per build');
  assert.equal((src.match(/resetAmbientClock\(/g) ?? []).length, 1);
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
