'use strict';

// The floor draws only when something changed. Pixi's TickerPlugin rendered
// the stage every tick, so on the reduced path a floor of people sitting
// still was rasterised fifteen times a second for nothing — on a software GPU,
// a full redraw each time. The ticker still advances the simulation; the draw
// waits for Pixi's own change queues to hold something. These pin the planner
// (full path draws every tick; reduced draws on change, on invalidation, and
// never faster than the cap), the queue check against the REAL Pixi scene
// graph (a position that moves, a frame that changes, a Graphics redraw, a
// visibility flip — and not a property set to the value it already has, nor
// an idle animation whose frame index does not move), and that the floor
// takes the TickerPlugin's render off the ticker and drives its own.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const PIXI = require('pixi.js');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const {
  sceneChangedSinceRender, shouldRenderNow, minRenderIntervalMs, createRenderOnChange, DEFAULT_REPORT_EVERY_MS
} = loadTs('src/renderer/src/scene/office/renderOnChange.ts');
const { REDUCED_MOTION_MAX_FPS } = loadTs('src/renderer/src/scene/office/officeMotion.ts');
const { Camera } = loadTs('src/renderer/src/scene/office/Camera.ts');

// --- the planner ---------------------------------------------------------------------

const plan = (over) => shouldRenderNow({
  mode: 'reduced', changed: false, invalidated: false, now: 1000, lastRenderAt: null, maxFPS: 15, ...over
});

test('the full path draws every tick, changed or not', () => {
  assert.equal(plan({ mode: 'full' }), true);
  assert.equal(plan({ mode: 'full', lastRenderAt: 999, maxFPS: 0 }), true);
});

test('the reduced path draws on a change or an invalidation, and otherwise not', () => {
  assert.equal(plan({}), false, 'nothing changed');
  assert.equal(plan({ changed: true }), true);
  assert.equal(plan({ invalidated: true }), true, 'a cleared canvas must be redrawn');
});

test('the reduced path never draws faster than the cap; the full path has none', () => {
  assert.equal(minRenderIntervalMs(15), 1000 / 15);
  assert.equal(minRenderIntervalMs(0), 0);
  assert.equal(plan({ changed: true, lastRenderAt: 1000 - 50 }), false, '50 ms after the last draw at 15 fps');
  assert.equal(plan({ changed: true, lastRenderAt: 1000 - 70 }), true, 'a frame and a bit later');
  assert.equal(plan({ changed: true, lastRenderAt: 1000 - 100, maxFPS: 10 }), true, 'exactly one frame later');
  assert.equal(plan({ changed: true, lastRenderAt: 1000 - 99, maxFPS: 10 }), false);
  assert.equal(plan({ changed: true, lastRenderAt: 1000 - 50, maxFPS: 0 }), true, 'uncapped');
});

// --- the runtime ---------------------------------------------------------------------

function runtime({ mode = 'reduced', maxFPS = REDUCED_MOTION_MAX_FPS, reportEveryMs = 0 } = {}) {
  const calls = { render: 0, changed: 0 };
  const lines = [];
  let changed = false;
  const r = createRenderOnChange({
    render: () => { calls.render += 1; },
    changed: () => { calls.changed += 1; return changed; },
    decision: () => ({ mode, maxFPS }),
    log: (m) => lines.push(m),
    reportEveryMs
  });
  return { r, calls, lines, setChanged(v) { changed = v; } };
}

test('no render call when nothing changed; one when a change is queued; invalidate forces one', () => {
  const f = runtime();
  for (let i = 0; i < 15; i++) f.r.step(i * 1000 / 15);
  assert.equal(f.calls.render, 0, 'drew an unchanged scene');
  assert.equal(f.r.ticks, 15);
  f.setChanged(true);
  assert.equal(f.r.step(2000), true);
  assert.equal(f.calls.render, 1);
  f.setChanged(false);
  assert.equal(f.r.step(3000), false);
  f.r.invalidate();
  assert.equal(f.r.step(4000), true, 'a resize cleared the canvas and nothing redrew it');
  assert.equal(f.r.step(5000), false, 'the invalidation must be consumed by the draw');
  assert.equal(f.r.renders, 2);
});

test('with a change every millisecond, at most 15 renders land in a second', () => {
  const f = runtime();
  f.setChanged(true);
  for (let t = 0; t < 1000; t += 1) f.r.step(t);
  assert.equal(f.calls.render, 15);
  assert.equal(f.r.ticks, 1000);
});

test('the full path renders every tick and never reads the queues', () => {
  const f = runtime({ mode: 'full', maxFPS: 0 });
  for (let t = 0; t < 100; t += 1) f.r.step(t);
  assert.equal(f.calls.render, 100);
  assert.equal(f.calls.changed, 0);
});

test('a live mode change takes effect on the next tick', () => {
  let mode = 'full';
  const calls = { render: 0 };
  const r = createRenderOnChange({
    render: () => { calls.render += 1; }, changed: () => false,
    decision: () => ({ mode, maxFPS: mode === 'full' ? 0 : 15 }), reportEveryMs: 0
  });
  r.step(0); r.step(16);
  assert.equal(calls.render, 2);
  mode = 'reduced';
  r.step(100); r.step(200);
  assert.equal(calls.render, 2, 'the reduced path drew an unchanged scene');
});

test('the rate line reports renders per tick once per period, on the reduced path only', () => {
  assert.equal(DEFAULT_REPORT_EVERY_MS, 60_000);
  const f = runtime({ reportEveryMs: 1000 });
  f.r.step(0);
  for (let t = 100; t <= 1000; t += 100) { f.setChanged(t === 500); f.r.step(t); }
  assert.equal(f.lines.length, 1, 'expected exactly one report at the period');
  assert.match(f.lines[0], /^\[office\] rendered 1 of 10 ticks in the last 1 s \(1\.0 renders\/s\)$/);
  const g = runtime({ mode: 'full', maxFPS: 0, reportEveryMs: 1000 });
  for (let t = 0; t <= 2000; t += 100) g.r.step(t);
  assert.deepEqual(g.lines, [], 'the full path has nothing to report');
});

// --- the queue check against the real scene graph ---------------------------------------
//
// A stage with a render group, as the renderer leaves it after a draw. `settle`
// does to the bookkeeping what RenderGroupSystem does on a render, minus the
// drawing: runs Pixi's own transform update (which drains childrenToUpdate and
// clears didChange), drains the renderables queue, and clears the structure
// flag. The pipes it hands Pixi only clear the view flag, as the real ones do.

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
  // A structure rebuild collects every renderable afresh, which is where a
  // view's flag is cleared (ViewContainer.collectRenderables) — a sprite is
  // born with it set, by its constructor's texture assignment.
  if (rebuild) for (const c of rg.getChildren()) if ('didViewUpdate' in c) c.didViewUpdate = false;
  rg.structureDidChange = false;
  assert.equal(sceneChangedSinceRender(rg), false, 'settle must leave the stage clean');
}
const frame = (x) => new PIXI.Texture({ source: PIXI.Texture.WHITE.source, frame: new PIXI.Rectangle(x, 0, 1, 1) });

test('a stage never rendered is a change; a settled one is not', () => {
  const s = stage();
  assert.equal(sceneChangedSinceRender(undefined), true, 'no render group yet');
  assert.equal(sceneChangedSinceRender(s.renderGroup), true, 'a fresh render group has its structure to build');
  settle(s);
});

test('moving a sprite is a change; setting its position to where it is, is not', () => {
  const s = stage();
  const world = new PIXI.Container();
  const sp = new PIXI.Sprite(frame(0));
  world.addChild(sp);
  s.addChild(world);
  settle(s);
  sp.x = sp.x; sp.y = sp.y;
  sp.position.set(sp.x, sp.y);
  sp.alpha = sp.alpha;
  sp.zIndex = sp.zIndex;
  world.scale.set(world.scale.x);
  assert.equal(sceneChangedSinceRender(s.renderGroup), false, 'same values queued a change');
  sp.x += 1;
  assert.equal(sceneChangedSinceRender(s.renderGroup), true);
  settle(s);
  world.x += 0.001;
  assert.equal(sceneChangedSinceRender(s.renderGroup), true, 'the camera moving the world is a change');
  settle(s);
  sp.alpha = 0.5;
  assert.equal(sceneChangedSinceRender(s.renderGroup), true);
  settle(s);
  sp.zIndex = 42;
  assert.equal(sceneChangedSinceRender(s.renderGroup), true, 'a depth change is a structure change');
});

test('a change queued across many unrendered ticks is queued once, not once per tick', () => {
  const s = stage();
  const sp = new PIXI.Sprite(frame(0));
  s.addChild(sp);
  settle(s);
  for (let i = 0; i < 1000; i++) { sp.x += 1; sp.texture = frame(i % 2); }
  const rg = s.renderGroup;
  assert.equal(rg.childrenRenderablesToUpdate.index, 1);
  assert.equal(rg.childrenToUpdate[1].index, 1);
  settle(s);
});

test('a frame change, a Graphics redraw and a visibility flip are changes', () => {
  const s = stage();
  const a = frame(0), b = frame(1);
  const anim = new PIXI.AnimatedSprite({ textures: [a, b, a, b], autoUpdate: false });
  anim.animationSpeed = 0.06;
  const g = new PIXI.Graphics().rect(0, 0, 4, 4).fill(0xffffff);
  s.addChild(anim); s.addChild(g);
  settle(s);
  anim.texture = anim.texture;
  assert.equal(sceneChangedSinceRender(s.renderGroup), false, 'the same texture again is not a change');
  anim.texture = b;
  assert.equal(sceneChangedSinceRender(s.renderGroup), true);
  settle(s);
  g.clear().rect(0, 0, 4, 4).fill(0xffffff);
  assert.equal(sceneChangedSinceRender(s.renderGroup), true, 'a Graphics redrawn is a change even to the same shape');
  settle(s);
  g.visible = false;
  assert.equal(sceneChangedSinceRender(s.renderGroup), true);
  settle(s);
  s.removeChild(g);
  assert.equal(sceneChangedSinceRender(s.renderGroup), true);
  settle(s);
});

test('an idle animation counts only when its frame index moves', () => {
  const s = stage();
  const a = frame(0), b = frame(1);
  // The floor's idle pose is one frame (CharacterSprite ANIM_FRAMES.idle).
  const idle = new PIXI.AnimatedSprite({ textures: [a], autoUpdate: false });
  idle.animationSpeed = 0.08; idle.play();
  s.addChild(idle);
  settle(s);
  for (let i = 0; i < 600; i++) idle.update({ deltaTime: 4 });
  assert.equal(sceneChangedSinceRender(s.renderGroup), false, 'a one-frame idle advanced the queue');

  // Typing is four frames at 0.06/frame: at 15 fps (deltaTime 4) the index
  // moves every ~4 ticks, and only those ticks are changes.
  const typing = new PIXI.AnimatedSprite({ textures: [a, b, a, b], autoUpdate: false });
  typing.animationSpeed = 0.06; typing.play();
  s.addChild(typing);
  settle(s);
  let changes = 0;
  for (let i = 0; i < 150; i++) {
    typing.update({ deltaTime: 4 });
    if (sceneChangedSinceRender(s.renderGroup)) { changes += 1; settle(s); }
  }
  // 150 ticks at 15 fps = 10 s; 0.06 * 60 = 3.6 frames/s → 36 changes, give or take one.
  assert.ok(changes >= 34 && changes <= 38, `expected ~36 frame changes in 10 s, got ${changes}`);
});

test('an idle floor settles: after the camera lands, the reduced path stops drawing', () => {
  // Twelve seated characters in one-frame idle poses under a fitted camera,
  // ticked at 15 fps for a minute. The camera's lerp converges to the fit in
  // a few seconds and from then on no tick queues anything.
  const s = stage();
  const world = new PIXI.Container();
  s.addChild(world);
  const cast = [];
  for (let i = 0; i < 12; i++) {
    const c = new PIXI.Container();
    const sp = new PIXI.AnimatedSprite({ textures: [frame(0)], autoUpdate: false });
    sp.play(); c.addChild(sp); c.position.set(40 * i, 100); world.addChild(c); cast.push(sp);
  }
  const cam = new Camera(world);
  cam.setMapSize(640, 480); cam.setViewSize(1600, 900);
  const paint = createRenderOnChange({
    render: () => settle(s),
    changed: () => sceneChangedSinceRender(s.renderGroup),
    decision: () => ({ mode: 'reduced', maxFPS: 15 }), reportEveryMs: 0
  });
  const dt = 1 / 15;
  let rendersInLast30s = 0;
  for (let tick = 0; tick < 60 * 15; tick++) {
    cam.update(dt);
    for (const sp of cast) sp.update({ deltaTime: 4 });
    const drew = paint.step(tick * 1000 / 15);
    if (tick >= 30 * 15 && drew) rendersInLast30s += 1;
  }
  assert.ok(paint.renders > 1, 'the camera pan was never drawn');
  assert.equal(rendersInLast30s, 0, `an idle floor was still drawn ${rendersInLast30s} times in its second half-minute`);
  // For the record: how long the settle took, in draws.
  console.log(`# idle floor: ${paint.renders} draws in 60 s at 15 fps, all in the first ${(paint.renders / 15).toFixed(1)} s`);
});

// --- wiring ----------------------------------------------------------------------------

test('OfficeFloor takes the TickerPlugin render off the ticker and drives its own after the simulation', () => {
  const src = strip(read('src/renderer/src/scene/office/OfficeFloor.tsx'));
  assert.match(src, /app\.ticker\.remove\(app\.render, app\);/, 'the plugin render must come off or every tick still draws');
  const i = src.indexOf('const paint = createRenderOnChange({');
  assert.ok(i > 0);
  const call = src.slice(i, src.indexOf('});', i));
  // The paint draws, then tells the floor-perf diagnostic (floorPerf.ts).
  assert.match(call, /render: \(\) => \{ app\.render\(\); perf\?\.onRender\(\); \},/);
  assert.match(call, /changed: \(\) => sceneChangedSinceRender\(app\.stage\.renderGroup\),/);
  assert.match(call, /decision: \(\) => gateRef\.current\?\.decision \?\? motion/, 'the decision must be the live one');
  assert.match(src, /app\.renderer\.on\('resize', paint\.invalidate\);/, 'a resize clears the canvas; it must force a draw');
  assert.match(src, /app\.ticker\.add\(\(tk: Ticker\) => \{ paint\.step\(tk\.lastTime\); \}, undefined, UPDATE_PRIORITY\.LOW\);/);
});
