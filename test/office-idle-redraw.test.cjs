'use strict';

// An idle floor must queue nothing for the renderer. The floor draws only
// when Pixi has a change queued (office-render-on-change), so what an idle
// floor costs is decided by which effects touch the scene graph when nobody
// is doing anything. Measured on WSLg before this: the god, seated at his
// desk with the focus halo on for as long as the app runs, had the halo's
// alpha and scale rewritten by a sinusoid on every tick, so a 15 fps floor
// was rasterised fifteen times a second with nothing happening — ~2 cores,
// whether or not any terminal was streaming. A cup parked on a desk redrew
// its steam every tick for ever; a blocked agent's "!" redrew every tick,
// blinking or not. These pin the three against the real Character and the
// real Pixi queues: parked at the desk, the halo holds steady and nothing is
// queued; working, it pulses; the cup steams on the shared 4 Hz beat and
// goes cold; a glyph redraws only when its frame changes.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const PIXI = require('pixi.js');

// AnimatedSprite.play() books the shared ticker, which wants rAF; the name
// tag's Text measures itself through Pixi's DOM adapter, which wants a canvas
// context CLASS (for feature detection on its prototype) and an instance that
// can measure text. Neither draws anything here.
globalThis.requestAnimationFrame ??= () => 0;
globalThis.cancelAnimationFrame ??= () => {};
class FakeContext2D {
  measureText(t) {
    const width = t.length * 4;
    return { width, actualBoundingBoxLeft: 0, actualBoundingBoxRight: width, actualBoundingBoxAscent: 5, actualBoundingBoxDescent: 1, fontBoundingBoxAscent: 5, fontBoundingBoxDescent: 1 };
  }
  fillText() {} strokeText() {} save() {} restore() {} clearRect() {} fillRect() {}
  getImageData() { return { data: new Uint8ClampedArray(4) }; }
}
FakeContext2D.prototype.letterSpacing = '';
FakeContext2D.prototype.font = '';
const fakeCanvas = { width: 1, height: 1, style: {}, getContext: () => new FakeContext2D() };
PIXI.DOMAdapter.set({
  createCanvas: () => fakeCanvas,
  getCanvasRenderingContext2D: () => FakeContext2D,
  getWebGLRenderingContext: () => null,
  getNavigator: () => ({ userAgent: 'node', gpu: null }),
  getBaseUrl: () => '',
  getFontFaceSet: () => null,
  fetch: () => Promise.reject(new Error('no fetch in tests')),
  parseXML: () => null
});

const beat = loadTs('src/renderer/src/scene/office/ambientBeat.ts');
const { sceneChangedSinceRender } = loadTs('src/renderer/src/scene/office/renderOnChange.ts');
const {
  Character, isActiveStatus, statusGlyphFrame, CUP_STEAM_S,
  GLOW_STEADY_ALPHA, GLOW_STEADY_SCALE, GLOW_PULSE_MIN_ALPHA, GLOW_PULSE_ALPHA_RANGE
} = loadTs('src/renderer/src/scene/office/Character.ts');

/* ─── A stage as the renderer leaves it after a draw (office-render-on-change) */
const pipe = { updateRenderable(r) { r.didViewUpdate = false; }, validateRenderable() { return false; } };
const pipes = new Proxy({}, { get: () => pipe });
function stage() {
  const s = new PIXI.Container();
  s.enableRenderGroup();
  return s;
}
function settle(s) {
  const rg = s.renderGroup;
  rg.instructionSet.renderPipes = pipes;
  const rebuild = rg.structureDidChange;
  PIXI.updateRenderGroupTransforms(rg);
  const q = rg.childrenRenderablesToUpdate;
  for (let i = 0; i < q.index; i++) { q.list[i].didViewUpdate = false; q.list[i] = null; }
  q.index = 0;
  if (rebuild) for (const c of rg.getChildren()) if ('didViewUpdate' in c) c.didViewUpdate = false;
  rg.structureDidChange = false;
  assert.equal(sceneChangedSinceRender(rg), false, 'settle must leave the stage clean');
}

/* ─── A character on a 10×10 map of 16 px tiles, born at its desk ─────────── */
const TS = 16;
const map = {
  tileSize: TS, width: 10, height: 10,
  tileToPixel: (x, y) => ({ x: x * TS, y: y * TS }),
  pixelToTile: (x, y) => ({ x: Math.floor(x / TS), y: Math.floor(y / TS) }),
  isWalkable: () => true
};
const frames = Array.from({ length: 3 }, () => Array.from({ length: 3 }, () => PIXI.Texture.WHITE));
function character(s) {
  const c = new Character({ agentId: 'a', displayName: 'A', mapRenderer: map, frames, seatTile: { x: 2, y: 2 }, glowColor: 0xff0000 });
  c.show(s);
  return c;
}

const DT = 1 / 15;
/** Tick the floor as OfficeFloor does: beat, then the character; count the
 *  ticks on which the stage has a change queued, settling after each. */
function run(s, c, ticks) {
  let dirty = 0;
  for (let i = 0; i < ticks; i++) {
    beat.advanceAmbientClock(DT);
    c.update(DT);
    if (sceneChangedSinceRender(s.renderGroup)) dirty += 1;
    settle(s);
  }
  return dirty;
}
/** The halo Graphics: the circle added to the stage first by show(). */
const halo = (s) => s.children.find((ch) => ch instanceof PIXI.Graphics);

test('statuses: working, thinking and compacting are active; parked and away are not', () => {
  for (const st of ['working', 'thinking', 'compacting']) assert.equal(isActiveStatus(st), true, st);
  for (const st of ['idle', 'waiting', 'success', 'blocked', 'looping', 'ghost', undefined]) assert.equal(isActiveStatus(st), false, String(st));
});

test('parked at the desk with the halo on, a settled character queues nothing', () => {
  beat.resetAmbientClock();
  const s = stage();
  const c = character(s);
  c.sitAtDesk(true);
  c.setActive(false);
  run(s, c, 30); // fade-in (0.5 s) and the seat slide settle
  assert.equal(c.isSittingAtDesk(), true);
  const g = halo(s);
  assert.ok(g, 'no halo on the stage');
  assert.ok(Math.abs(g.alpha - GLOW_STEADY_ALPHA) < 1e-9, `halo held at the steady alpha, got ${g.alpha}`);
  assert.ok(Math.abs(g.scale.x - GLOW_STEADY_SCALE) < 1e-9);
  assert.equal(run(s, c, 150), 0, 'an idle god at his desk kept the floor drawing 15 times a second');
});

test('working, the halo pulses: a change on every tick, within the pulse range', () => {
  beat.resetAmbientClock();
  const s = stage();
  const c = character(s);
  c.sitAtDesk(true);
  c.setActive(true);
  run(s, c, 30);
  const g = halo(s);
  let lo = Infinity, hi = -Infinity;
  const dirty = run(s, c, 30);
  for (let i = 0; i < 30; i++) { beat.advanceAmbientClock(DT); c.update(DT); lo = Math.min(lo, g.alpha); hi = Math.max(hi, g.alpha); settle(s); }
  assert.equal(dirty, 30, 'the pulse must move the halo every tick');
  assert.ok(lo >= GLOW_PULSE_MIN_ALPHA - 1e-9 && hi <= GLOW_PULSE_MIN_ALPHA + GLOW_PULSE_ALPHA_RANGE + 1e-9, `pulse ${lo}..${hi}`);
  assert.ok(hi - lo > 0.1, 'the pulse must actually pulse');
  // Back to parked: the halo settles to the steady value and the queue empties.
  c.setActive(false);
  run(s, c, 2);
  assert.equal(run(s, c, 60), 0);
  assert.ok(Math.abs(g.alpha - GLOW_STEADY_ALPHA) < 1e-9);
});

test('a parked cup steams on the shared 4 Hz beat, then goes cold and is left alone', () => {
  beat.resetAmbientClock();
  const s = stage();
  const c = character(s);
  c.sitAtDesk(true);
  c.setActive(false);
  run(s, c, 30);
  c.setCupSpot({ x: 40, y: 40 });
  c.setCupOnDesk(true);
  const steaming = run(s, c, 150); // 10 s
  assert.ok(steaming >= 39 && steaming <= 42, `steam at 4 Hz: ~40 redraws in 10 s, got ${steaming} (was 150)`);
  // Run the clock to just short of cold, then over it.
  const left = CUP_STEAM_S - 10 - 1;
  for (let i = 0; i < left * 15; i++) { beat.advanceAmbientClock(DT); c.update(DT); settle(s); }
  const cooling = run(s, c, 45); // the last second of steam + the cold frame
  assert.ok(cooling >= 4 && cooling <= 6, `the last steam frames and one cold draw, got ${cooling}`);
  assert.equal(run(s, c, 150), 0, 'a cold cup must queue nothing');
  c.setCupOnDesk(false);
  assert.equal(run(s, c, 1), 1, 'clearing the cup is a change');
  assert.equal(run(s, c, 30), 0);
});

test('status glyph frames: the blocked "!" blinks at 2.5 Hz, the looping ring steps at 8 Hz', () => {
  const changes = (glyph, seconds) => {
    let last = statusGlyphFrame(glyph, 0), n = 0;
    for (let i = 1; i <= seconds * 15; i++) { const f = statusGlyphFrame(glyph, i * DT); if (f !== last) { n += 1; last = f; } }
    return n;
  };
  assert.ok(changes('blocked', 10) >= 24 && changes('blocked', 10) <= 26, `blocked: ${changes('blocked', 10)} changes in 10 s`);
  assert.ok(changes('looping', 10) >= 78 && changes('looping', 10) <= 81, `looping: ${changes('looping', 10)} changes in 10 s`);
  assert.equal(statusGlyphFrame('none', 3), -1);
  assert.deepEqual([0, 0.39, 0.4, 0.79, 0.8].map((t) => statusGlyphFrame('blocked', t)), [0, 0, 1, 1, 0]);
});

test('a blocked agent redraws its "!" on each blink, not every tick', () => {
  beat.resetAmbientClock();
  const s = stage();
  const c = character(s);
  run(s, c, 30);
  c.setStatusGlyph('blocked');
  const dirty = run(s, c, 150);
  assert.ok(dirty >= 25 && dirty <= 27, `~25 redraws in 10 s at 2.5 Hz, got ${dirty} (was 150)`);
  c.setStatusGlyph('none');
  assert.equal(run(s, c, 1), 1, 'clearing the glyph is a change');
  assert.equal(run(s, c, 30), 0);
});

/* ─── Round 2: the whole idle scene, not one character ─────────────────────
 *
 * The ASK ME board's attention pulse was rebuilt every tick while a question
 * waited for the human, which on a live floor is nearly always, so it alone
 * held the floor at 15 renders/s with every avatar parked. And a working
 * agent never typed: applySitPose always chose the one-frame idle pose. The
 * harness below ticks a scene the way OfficeFloor does — beat, camera,
 * character, monitor, board — and pins the ceiling: parked, with an open ask,
 * nothing is queued; working, the avatar types and the effects run. */

const { Camera } = loadTs('src/renderer/src/scene/office/Camera.ts');
const { DeskScreen } = loadTs('src/renderer/src/scene/office/DeskScreen.ts');
const {
  askBoardFrame, paintAskBoard, STILL_FRAME, ASK_STEADY_ALPHA, ASK_PULSE_MIN_ALPHA, ASK_PULSE_ALPHA_RANGE
} = loadTs('src/renderer/src/scene/office/askBoard.ts');

/** The avatar's AnimatedSprite, for the frames it is playing. */
const avatar = (c) => c.sprite.container.children.find((ch) => ch instanceof PIXI.AnimatedSprite);

function scene({ askCount = 2 } = {}) {
  beat.resetAmbientClock();
  const s = stage();
  const world = new PIXI.Container();
  s.addChild(world);
  const camera = new Camera(world);
  camera.setMapSize(map.width * TS, map.height * TS);
  camera.setViewSize(320, 240);
  const c = character(world);
  const screen = new DeskScreen({ tileSize: TS, textureForGid: () => null }, { x: 2, y: 0 });
  world.addChild(screen.container);
  const askG = new PIXI.Graphics();
  world.addChild(askG);
  let paints = 0;
  const clear = askG.clear.bind(askG);
  askG.clear = () => { paints += 1; return clear(); };
  const board = {
    askCount, frame: NaN,
    draw() {
      const f = askBoardFrame(this.askCount, c.isActive());
      if (f === this.frame) return;
      this.frame = f;
      paintAskBoard(askG, this.askCount, f === STILL_FRAME ? null : beat.ambientBeatTime());
    },
    get paints() { return paints; }
  };
  board.draw();
  // One tick, in the floor's order; returns whether the stage had a change.
  const tick = () => {
    beat.advanceAmbientClock(DT);
    camera.update(DT);
    c.update(DT);
    screen.setOn(c.isSittingAtDesk());
    screen.update(c.isActive());
    board.draw();
    const dirty = sceneChangedSinceRender(s.renderGroup);
    settle(s);
    return dirty;
  };
  const run = (n) => { let d = 0; for (let i = 0; i < n; i++) if (tick()) d += 1; return d; };
  return { s, c, screen, board, camera, run };
}

test('ask board frames: the beat only while questions wait AND someone is working', () => {
  beat.resetAmbientClock();
  beat.advanceAmbientClock(0.5);
  assert.equal(askBoardFrame(0, false), STILL_FRAME);
  assert.equal(askBoardFrame(0, true), STILL_FRAME, 'no questions, no pulse');
  assert.equal(askBoardFrame(3, false), STILL_FRAME, 'nobody working: hold the attention frame');
  assert.equal(askBoardFrame(3, true), 2);
  assert.ok(Math.abs(ASK_STEADY_ALPHA - (ASK_PULSE_MIN_ALPHA + ASK_PULSE_ALPHA_RANGE / 2)) < 1e-12);
});

test('paintAskBoard: a frame is a function of the count and the pulse time', () => {
  const g = new PIXI.Graphics();
  const strokes = [];
  const stroke = g.stroke.bind(g);
  g.stroke = (style) => { strokes.push(style.alpha); return stroke(style); };
  paintAskBoard(g, 0, null);
  assert.equal(strokes.length, 0, 'no questions: no attention ring');
  paintAskBoard(g, 2, null);
  assert.equal(strokes.length, 1);
  assert.ok(Math.abs(strokes[0] - ASK_STEADY_ALPHA) < 1e-12, 'held: the steady alpha');
  paintAskBoard(g, 2, 0);
  paintAskBoard(g, 2, 0.25);
  paintAskBoard(g, 2, 0);
  assert.equal(strokes[1], strokes[3], 'same pulse time, same frame');
  assert.notEqual(strokes[1], strokes[2]);
  for (const a of strokes) assert.ok(a >= ASK_PULSE_MIN_ALPHA - 1e-12 && a <= ASK_PULSE_MIN_ALPHA + ASK_PULSE_ALPHA_RANGE + 1e-12);
});

test('a parked scene with an open ask queues nothing: still halo, still monitor, held board, settled camera', () => {
  const sc = scene({ askCount: 2 });
  sc.c.sitAtDesk(true);
  sc.c.setActive(false);
  sc.run(45); // fade-in, seat slide, camera lerp
  assert.equal(sc.c.isSittingAtDesk(), true);
  assert.equal(sc.c.getAnimation(), 'idle', 'parked: the one-frame seated pose');
  assert.equal(avatar(sc.c).textures.length, 1);
  assert.equal(sc.screen.container.visible, true, 'the monitor is lit while seated');
  assert.equal(sc.board.frame, STILL_FRAME, 'the ask board holds its attention frame');
  const paintsBefore = sc.board.paints;
  assert.equal(sc.run(150), 0, 'ten seconds parked: nothing queued');
  assert.equal(sc.board.paints, paintsBefore, 'the board was not repainted');
});
