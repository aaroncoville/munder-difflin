'use strict';

// The floor-perf diagnostic (floorPerf.ts) reports, from inside the renderer,
// what the floor does per second and which containers make it draw, as a
// 'floor-perf' sample in the hive log — so a live floor can be read without
// a remote-debugging port. These pin the gate (off installs nothing), the
// counting (ticks, dirty ticks, renders, frames; culprits by description,
// top five; counters reset per window), the schedule (15 s for the first 20
// windows, 5 min after), teardown, and that the counter only reads
// Pixi's queues. Main's acceptance of the event is in floor-perf-event.test.cjs.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const PIXI = require('pixi.js');

const perf = loadTs('src/renderer/src/scene/office/floorPerf.ts');
const { FLOOR_PERF_KIND } = loadTs('src/shared/floorPerfEvent.ts');

/** A fake app: a ticker that records its callbacks, a real Pixi stage with a
 *  render group, a renderer description. */
function app() {
  const callbacks = [];
  const stage = new PIXI.Container();
  stage.enableRenderGroup();
  return {
    callbacks,
    ticker: {
      started: true,
      add(fn, _ctx, priority) { callbacks.push({ fn, priority }); },
      remove(fn) { const i = callbacks.findIndex((c) => c.fn === fn); if (i >= 0) callbacks.splice(i, 1); }
    },
    stage,
    renderer: { name: 'canvas', resolution: 1, width: 978, height: 693 }
  };
}

/** Injected clock, timers and rAF. */
function harness(a, extra = {}) {
  let t = 1000;
  const timers = [];
  let frames = [];
  const logged = [];
  const p = perf.createFloorPerf({
    app: a,
    characters: () => [{ id: 'god', status: 'idle', active: false, seated: true }],
    log: (s) => logged.push(s),
    now: () => t,
    schedule: (fn, ms) => { const h = { fn, ms, at: t + ms }; timers.push(h); return h; },
    cancel: (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); },
    requestFrame: (fn) => { const h = { fn }; frames.push(h); return h; },
    cancelFrame: (h) => { frames = frames.filter((f) => f !== h); },
    doc: { visibilityState: 'visible', hasFocus: () => true },
    ...extra
  });
  const tick = () => { for (const c of a.callbacks) c.fn(); };
  const frame = () => { const fs = frames; frames = []; for (const f of fs) f.fn(); };
  const advance = (ms) => { t += ms; };
  const fire = () => { const due = timers.filter((h) => h.at <= t); for (const h of due) { timers.splice(timers.indexOf(h), 1); h.fn(); } };
  return { p, tick, frame, advance, fire, timers, logged, get frames() { return frames; } };
}

test('the gate: the setting or a dev build; off by default', () => {
  perf.setFloorDiagnosticsPref(undefined);
  perf.setFloorDiagnosticsDev(false);
  assert.equal(perf.floorDiagnosticsPref(), false);
  assert.equal(perf.floorPerfEnabled(), false, 'production, setting off: nothing');
  perf.setFloorDiagnosticsDev(true);
  assert.equal(perf.floorPerfEnabled(), true, 'a dev build samples regardless');
  perf.setFloorDiagnosticsDev(false);
  assert.equal(perf.setFloorDiagnosticsPref(true), true);
  assert.equal(perf.floorPerfEnabled(), true, 'the setting turns it on in production');
  assert.equal(perf.setFloorDiagnosticsPref(true), false, 'unchanged');
  assert.equal(perf.setFloorDiagnosticsPref('yes'), true, 'junk is off');
  assert.equal(perf.floorDiagnosticsPref(), false);
  assert.equal(perf.floorPerfEnabled(), false);
});

test('installed: one counting callback after the simulation and before the paint, and a rAF loop', () => {
  const a = app();
  const h = harness(a);
  assert.equal(a.callbacks.length, 1);
  assert.equal(a.callbacks[0].priority, perf.COUNTER_PRIORITY);
  assert.ok(perf.COUNTER_PRIORITY < 0 && perf.COUNTER_PRIORITY > -25, 'between NORMAL (0) and LOW (-25)');
  assert.equal(h.frames.length, 1, 'one frame requested');
  h.p.dispose();
  assert.equal(a.callbacks.length, 0, 'dispose removes the callback');
  assert.equal(h.frames.length, 0, 'dispose cancels the frame');
  assert.equal(h.timers.length, 0, 'dispose cancels the timer');
  h.p.dispose();
});

test('a sample: rates over the window, dirty ticks, culprits by description, and a reset', () => {
  const a = app();
  const h = harness(a);
  const halo = new PIXI.Graphics(); halo.label = 'halo';
  const sprite = new PIXI.Sprite(PIXI.Texture.WHITE);
  const group = new PIXI.Container(); group.label = 'world';
  a.stage.addChild(group); group.addChild(halo); group.addChild(sprite);
  // Pixi's bookkeeping as the renderer leaves it after a draw.
  const pipe = { updateRenderable(r) { r.didViewUpdate = false; }, validateRenderable() { return false; } };
  const settle = () => {
    const rg = a.stage.renderGroup;
    rg.instructionSet.renderPipes = new Proxy({}, { get: () => pipe });
    PIXI.updateRenderGroupTransforms(rg);
    const q = rg.childrenRenderablesToUpdate; for (let i = 0; i < q.index; i++) { q.list[i].didViewUpdate = false; q.list[i] = null; } q.index = 0;
    for (const c of rg.getChildren()) if ('didViewUpdate' in c) c.didViewUpdate = false;
    rg.structureDidChange = false;
  };
  settle();
  // 30 ticks over 2 s: the halo's alpha changes on every tick, the sprite's
  // texture on every third, and 10 renders, 120 frames.
  for (let i = 0; i < 30; i++) {
    halo.alpha = 0.3 + (i % 2) * 0.1;
    if (i % 3 === 0) sprite.texture = new PIXI.Texture({ source: PIXI.Texture.WHITE.source, frame: new PIXI.Rectangle(i % 2, 0, 1, 1) });
    h.tick();
    if (i % 3 === 0) h.p.onRender();
    for (let f = 0; f < 4; f++) h.frame();
    settle();
  }
  h.advance(2000);
  const s = h.p.sample();
  assert.equal(s.kind, 'floor-perf');
  assert.equal(s.windowS, 2);
  assert.equal(s.ticks, 30);
  assert.equal(s.ticksPerSec, 15);
  assert.equal(s.dirtyTicks, 30);
  assert.equal(s.renders, 10);
  assert.equal(s.rendersPerSec, 5);
  assert.equal(s.rafPerSec, 60);
  assert.deepEqual(s.canvas, { width: 978, height: 693, resolution: 1 });
  assert.equal(s.renderer, 'canvas');
  assert.equal(s.visibility, 'visible');
  assert.equal(s.focus, true);
  assert.equal(s.tickerRunning, true);
  assert.deepEqual(s.characters, [{ id: 'god', status: 'idle', active: false, seated: true }]);
  assert.deepEqual(s.culprits, [
    { what: 'xform: Graphics#halo < Container#world < Container', ticks: 30 },
    { what: 'view: Sprite < Container#world < Container', ticks: 10 }
  ]);
  // The window is reset: a quiet second reports zeros and no culprits.
  for (let i = 0; i < 15; i++) { h.tick(); settle(); }
  h.advance(1000);
  const quiet = h.p.sample();
  assert.equal(quiet.ticks, 15);
  assert.equal(quiet.dirtyTicks, 0);
  assert.equal(quiet.renders, 0);
  assert.equal(quiet.rafPerSec, 0);
  assert.deepEqual(quiet.culprits, []);
  h.p.dispose();
});

test('the counter only reads: the queues are exactly as Pixi left them', () => {
  const a = app();
  const h = harness(a);
  const g = new PIXI.Graphics();
  a.stage.addChild(g);
  g.alpha = 0.5;
  const rg = a.stage.renderGroup;
  const before = JSON.stringify({
    s: rg.structureDidChange,
    x: Object.entries(rg.childrenToUpdate).map(([d, q]) => [d, q.index]),
    v: rg.childrenRenderablesToUpdate.index
  });
  h.tick(); h.tick();
  const after = JSON.stringify({
    s: rg.structureDidChange,
    x: Object.entries(rg.childrenToUpdate).map(([d, q]) => [d, q.index]),
    v: rg.childrenRenderablesToUpdate.index
  });
  assert.equal(after, before);
  h.p.dispose();
});

test('top five culprits, largest first; past 64 distinct ones the rest fold into "other"', () => {
  const m = new Map();
  for (let i = 0; i < 70; i++) m.set(`k${i}`, i % 7);
  assert.equal(perf.topCulprits(m).length, 5);
  assert.ok(perf.topCulprits(m).every((c, i, arr) => i === 0 || arr[i - 1].ticks >= c.ticks));
  const counts = new Map();
  const groupOf = (n) => ({
    structureDidChange: false,
    childrenToUpdate: { 1: { index: n, list: Array.from({ length: n }, (_, i) => ({ constructor: { name: `C${i}` }, label: null, parent: null })) } },
    childrenRenderablesToUpdate: { index: 0, list: [] },
    renderGroupChildren: []
  });
  assert.equal(perf.countCulprits(groupOf(80), counts), true);
  assert.equal(counts.size, perf.MAX_CULPRITS + 1);
  assert.equal(counts.get('other'), 80 - perf.MAX_CULPRITS);
  assert.equal(perf.countCulprits(groupOf(0), new Map()), false);
});

test('describeContainer: constructor, own label, two ancestors', () => {
  const root = { constructor: { name: 'Container' }, label: 'Container', parent: null };
  const mid = { constructor: { name: 'Container' }, label: 'world', parent: root };
  const leaf = { constructor: { name: 'Graphics' }, label: null, parent: mid };
  assert.equal(perf.describeContainer(leaf), 'Graphics < Container#world < Container');
  assert.equal(perf.describeContainer(leaf, 1), 'Graphics < Container#world');
  assert.equal(perf.describeContainer(leaf, 0), 'Graphics');
});

test('schedule: every 15 s for the first 20 samples, every 5 min after, logged through the sink', () => {
  assert.equal(perf.SAMPLE_EVERY_MS, 15_000);
  assert.equal(perf.LATE_SAMPLE_EVERY_MS, 300_000);
  assert.equal(perf.sampleIntervalMs(0), 15_000);
  assert.equal(perf.sampleIntervalMs(19), 15_000);
  assert.equal(perf.sampleIntervalMs(20), 300_000);
  const a = app();
  const h = harness(a);
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].ms, 15_000);
  for (let i = 0; i < 20; i++) { h.advance(15_000); h.fire(); }
  assert.equal(h.logged.length, 20);
  assert.equal(h.logged[0].kind, FLOOR_PERF_KIND);
  assert.equal(h.logged[0].windowS, 15);
  assert.equal(h.timers[0].ms, 300_000, 'after twenty samples the window is five minutes');
  h.advance(300_000); h.fire();
  assert.equal(h.logged.length, 21);
  assert.equal(h.logged[20].windowS, 300);
  h.p.dispose();
  h.advance(300_000); h.fire();
  assert.equal(h.logged.length, 21, 'nothing after dispose');
});

test('a sink that throws does not stop the sampler', () => {
  const a = app();
  let calls = 0;
  const h = harness(a, { log: () => { calls += 1; throw new Error('log full'); } });
  h.advance(15_000); h.fire();
  h.advance(15_000); h.fire();
  assert.equal(calls, 2);
  assert.equal(h.timers.length, 1, 're-armed after the throw');
  h.p.dispose();
});

test('a sampler without a cast carries its tags on every sample', () => {
  const a = app();
  let t = 0; const logged = [];
  const p = perf.createFloorPerf({
    app: a, tags: { scene: 'study', room: 'library', maxFPS: 6 }, log: (s) => logged.push(s),
    now: () => t, schedule: () => ({}), cancel: () => {}, requestFrame: () => ({}), cancelFrame: () => {},
    doc: { visibilityState: 'visible', hasFocus: () => true }
  });
  t = 15_000;
  const s = p.sample();
  assert.deepEqual(s.characters, []);
  assert.deepEqual(s.tags, { scene: 'study', room: 'library', maxFPS: 6 });
  p.dispose();
});
