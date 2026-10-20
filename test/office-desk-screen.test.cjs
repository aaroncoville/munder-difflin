'use strict';

// The desk monitors' screen-life animation (scrolling lines, blinking cursor)
// was redrawn every tick while its owner sat at the desk. A Graphics redraw is
// a change the reduced path has to render (office-render-on-change), so one
// seated agent kept a 15 fps floor drawing fifteen times a second, and three
// seated agents with three private clocks changed on different ticks. The
// animation now steps on a 4 Hz beat shared by every monitor: at most four
// redraws a second for all of them together, on the same ticks, and none at
// all between beats. These pin that against the real Pixi Graphics.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const PIXI = require('pixi.js');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const { DeskScreen, SCREEN_BEAT_S } = loadTs('src/renderer/src/scene/office/DeskScreen.ts');

/** A map with no monitor art: the screen is just its animation Graphics. */
const noMap = { tileSize: 16, textureForGid: () => null };

/** A screen whose redraws are counted: each one starts with a clear(). */
function screen() {
  const s = new DeskScreen(noMap, { x: 0, y: 0 });
  const g = s.container.children.find((c) => c instanceof PIXI.Graphics);
  assert.ok(g, 'no animation Graphics on the screen');
  let redraws = 0;
  const clear = g.clear.bind(g);
  g.clear = () => { redraws += 1; return clear(); };
  return { s, get redraws() { return redraws; } };
}

const DT = 1 / 15;
const tick = (n, fn) => { for (let i = 0; i < n; i++) { DeskScreen.advance(DT); fn(i); } };

test('the beat is 4 Hz and a lit screen redraws at most four times a second, never between beats', () => {
  assert.equal(SCREEN_BEAT_S, 0.25);
  const a = screen();
  a.s.setOn(true);
  const start = DeskScreen.clock;
  let last = 0;
  tick(150, () => {
    a.s.update();
    const beat = Math.floor(DeskScreen.clock / SCREEN_BEAT_S);
    const beatAtStart = Math.floor(start / SCREEN_BEAT_S);
    // Never more redraws than beats seen (the first beat counts).
    assert.ok(a.redraws <= beat - beatAtStart + 1, `tick: ${a.redraws} redraws over ${beat - beatAtStart + 1} beats`);
    last = a.redraws;
  });
  assert.ok(last >= 38 && last <= 41, `expected ~40 redraws in 10 s at 4 Hz, got ${last}`);
});

test('an unlit screen never redraws; lighting it resets the phase, cutting it clears once', () => {
  const a = screen();
  tick(30, () => a.s.update());
  assert.equal(a.redraws, 0);
  a.s.setOn(true);
  a.s.update();
  assert.equal(a.redraws, 1, 'the first update after lighting must draw');
  a.s.setOn(false);
  assert.equal(a.redraws, 2, 'cutting the screen must clear it');
  assert.equal(a.s.container.visible, false);
  tick(30, () => a.s.update());
  assert.equal(a.redraws, 2);
});

test('monitors lit at different moments redraw on the same ticks', () => {
  const a = screen(); const b = screen();
  a.s.setOn(true); a.s.update();
  tick(7, () => { a.s.update(); });
  // The first update after lighting draws whatever the beat; from then on
  // both follow the shared beat exactly, each with its own phase.
  b.s.setOn(true); b.s.update();
  const ticksA = [], ticksB = [];
  tick(60, (i) => {
    const ra = a.redraws, rb = b.redraws;
    a.s.update(); b.s.update();
    if (a.redraws > ra) ticksA.push(i);
    if (b.redraws > rb) ticksB.push(i);
  });
  assert.ok(ticksA.length >= 14 && ticksA.length <= 17, `a: ${ticksA.length} redraws in 4 s`);
  assert.deepEqual(ticksA, ticksB, 'two monitors stepped on different ticks');
});

test('without the floor advancing the shared clock, nothing moves', () => {
  const a = screen();
  a.s.setOn(true);
  for (let i = 0; i < 50; i++) a.s.update();
  assert.equal(a.redraws, 1);
});

test('the floor advances the beat once per tick, before any screen, and screens take no dt', () => {
  const src = strip(read('src/renderer/src/scene/office/OfficeFloor.tsx'));
  const i = src.indexOf('const updateDeskLife = (dt: number): void => {');
  assert.ok(i > 0);
  const body = src.slice(i, src.indexOf('for (const [id, rt] of runtimes)', i));
  assert.match(body, /DeskScreen\.advance\(dt\);/, 'the beat must advance before the loop over screens');
  assert.equal((src.match(/DeskScreen\.advance\(/g) ?? []).length, 1, 'advance once per tick, not once per screen');
  assert.match(src, /rt\.screen\.update\(\);/);
  assert.doesNotMatch(src, /rt\.screen\.update\(dt\)/);
});
