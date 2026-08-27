'use strict';
/**
 * Candlelight, dust and hearth-smoke over the painted rooms.
 *
 * Everything worth pinning about the ambiance layer is arithmetic, so it lives
 * in `ambiance.ts` and is tested here without pixi anywhere near the process.
 * What the pixi shell adds is a canvas and a ticker; what it must NOT add is a
 * way to click on it, which is the one assertion in this file about the scene
 * rather than the maths.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const read = (p) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const A = loadTs('src/renderer/src/scene/study/ambiance.ts');
const VIEW = { w: 400, h: 200 };

test('a room seeded the same way settles the same way', () => {
  // Motes reseeded on every render is a strobe, not dust. The seed has to be a
  // property of the ROOM, so this is what makes that checkable.
  const a = A.seedMotes(7, 10, VIEW);
  const b = A.seedMotes(7, 10, VIEW);
  assert.deepEqual(a, b);
  assert.notDeepEqual(A.seedMotes(8, 10, VIEW), a, 'every room got identical dust');
  assert.equal(a.length, 10);
});

test('motes are dealt inside the panel and stay there', () => {
  const motes = A.seedMotes(3, A.MOTE_CAP, VIEW);
  const inside = (m) => m.x >= 0 && m.x <= VIEW.w && m.y >= 0 && m.y <= VIEW.h;
  assert.ok(motes.every(inside), 'seeded outside the panel');
  // A thousand steps is far longer than a mote's drift across the panel, so
  // anything that leaks rather than wraps has left by now.
  for (let i = 0; i < 1000; i++) A.driftMotes(motes, 16, VIEW);
  assert.ok(motes.every(inside), 'a mote drifted off its own panel');
  assert.ok(motes.every((m) => Number.isFinite(m.x) && Number.isFinite(m.y)), 'NaN drift');
});

test('the caps are caps', () => {
  assert.ok(A.MOTE_CAP > 0 && A.MOTE_CAP <= 64, 'MOTE_CAP is not a cap');
  assert.equal(A.seedMotes(1, A.MOTE_CAP * 10, VIEW).length, A.MOTE_CAP);
  assert.ok(A.GLOW_CAP > 0 && A.GLOW_CAP <= 32);
  assert.equal(A.lightsFor(new Array(100).fill({ x: 0.5, y: 0.5 })).length, A.GLOW_CAP);
});

test('a candle flickers — inside a band, and never steadily', () => {
  const samples = [];
  for (let t = 0; t < 4000; t += 37) samples.push(A.flicker(t, 0));
  assert.ok(samples.every((v) => v >= 0.5 && v <= 1), 'flicker left its band');
  assert.ok(new Set(samples.map((v) => v.toFixed(3))).size > 20, 'the candle is a light bulb');
  // Two candles in the same room flickering in lockstep read as one flicker
  // applied to the room, which is the thing that looks fake.
  const other = [];
  for (let t = 0; t < 4000; t += 37) other.push(A.flicker(t, 1));
  assert.notDeepEqual(other, samples, 'every candle flickers in step');
});

test('the layer is off when it must be off', () => {
  assert.equal(A.ambianceEnabled({ reducedMotion: true, visible: true }), false);
  assert.equal(A.ambianceEnabled({ reducedMotion: false, visible: false }), false);
  assert.equal(A.ambianceEnabled({ reducedMotion: true, visible: false }), false);
  assert.equal(A.ambianceEnabled({ reducedMotion: false, visible: true }), true);
});

test('the ambiance slot is filled, and is still not clickable', () => {
  const scene = strip(read('src/renderer/src/scene/study/StudyScene.tsx'));
  assert.match(scene, /AmbianceLayer/, 'the slot M2 reserved is still empty');
  // The input contract. Every card, every room and every commission in the
  // Study is a DOM element UNDER this canvas; a canvas that took pointer
  // events would swallow the lot, and the scene would look fine while nothing
  // in it could be clicked.
  const slot = scene.match(/data-study-slot="ambiance"[\s\S]{0,400}?\}\}/);
  assert.ok(slot, 'the ambiance slot is gone');
  assert.match(slot[0], /pointerEvents:\s*'none'/, 'the ambiance canvas can be clicked');
});

test('pixi is loaded lazily, so the office floor never pays for it', () => {
  const layer = strip(read('src/renderer/src/scene/study/AmbianceLayer.tsx'));
  assert.doesNotMatch(layer, /^import .*from 'pixi\.js'/m,
    'pixi is imported at module scope — every theme now bundles it eagerly');
  assert.match(layer, /import\(\s*'pixi\.js'\s*\)/, 'pixi is never actually loaded');
});

test('pixi failing to load costs the room its ambiance and nothing else', async () => {
  // The layer loads pixi with a dynamic import and initialises WebGL, and both
  // can reject — a missing chunk on a patched install, a machine with no
  // working GL context. Ambiance is decoration over a room that is already
  // correct without it, so the only right answer is to have no ambiance. An
  // unhandled rejection instead reaches the window as an error nobody can act
  // on, and under a strict handler takes the renderer down with it.
  const { startAmbiance } = loadTs('src/renderer/src/scene/study/AmbianceLayer.tsx');

  const seen = [];
  const onUnhandled = (reason) => seen.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    assert.doesNotThrow(() => startAmbiance(async () => {
      throw new Error('Failed to fetch dynamically imported module: pixi.js');
    }), 'the failure escaped synchronously');
    // Two turns: one for the rejection to settle, one for node to decide it
    // was nobody's business.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(seen, [], 'the pixi failure surfaced as an unhandled rejection');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('the layer starts pixi through the handler, not around it', () => {
  // A catch that the effect does not go through is a catch on nothing.
  const layer = strip(read('src/renderer/src/scene/study/AmbianceLayer.tsx'));
  assert.match(layer, /startAmbiance\(/, 'the effect does not start pixi through the handler');
  assert.doesNotMatch(layer, /void\s*\(async/,
    'a bare fire-and-forget async body is back, with no rejection handler on it');
});

test('a build that fails after constructing still destroys what it constructed', async () => {
  // Constructing a pixi Application allocates, and `init` allocates the canvas
  // and the GL context before it can reject. A handle published only after the
  // last line of setup is a handle nobody holds while any of that can fail, so
  // the silent catch above swallows the failure and the context leaks — once
  // per room, per retry, per resize.
  const { buildOrDestroy } = loadTs('src/renderer/src/scene/study/AmbianceLayer.tsx');

  let destroyed = 0;
  const application = { destroy: () => { destroyed++; } };
  let held = null;

  await assert.rejects(
    buildOrDestroy(() => application, (h) => { held = h; }, async () => {
      throw new Error('WebGL unsupported');
    }),
    /WebGL unsupported/,
    'the failure stopped travelling, so the caller can no longer decline it'
  );
  assert.equal(destroyed, 1, 'the constructed application outlived the failure');

  // The unmount that lands between the rejection and the catch is the race the
  // guard exists for: both paths reach the same resource, and destroying a
  // pixi Application twice is its own error.
  held.release();
  assert.equal(destroyed, 1, 'cleanup racing the failure destroyed it twice');
});

test('a build that succeeds keeps its application until cleanup asks for it', async () => {
  const { buildOrDestroy } = loadTs('src/renderer/src/scene/study/AmbianceLayer.tsx');

  let destroyed = 0;
  const application = { destroy: () => { destroyed++; } };
  let held = null;

  await buildOrDestroy(() => application, (h) => { held = h; }, async () => {});
  assert.equal(destroyed, 0, 'a working build was torn down anyway — no ambiance at all');
  held.release();
  held.release();
  assert.equal(destroyed, 1, 'cleanup running twice destroyed the application twice');
});

test('the layer has exactly one place that destroys the application', () => {
  // Exactly-once is only enforceable through a single guarded call site; a
  // second `.destroy(` in this file is a path that can double up or be missed.
  const layer = strip(read('src/renderer/src/scene/study/AmbianceLayer.tsx'));
  assert.match(layer, /buildOrDestroy\(/,
    'the effect constructs pixi outside the guard that destroys it on failure');
  assert.equal((layer.match(/\.destroy\(/g) ?? []).length, 1,
    'destruction has more than one call site again');
});

test('an unmount during init waits for pixi before destroying it', async () => {
  // A pixi Application only has a renderer once `init` has resolved, and its
  // `destroy` goes straight through that renderer — so destroying one while
  // `init` is still in flight throws, and the throw comes out of React's
  // cleanup, where a decoration failing takes the unmount down with it. The
  // fake below is that shape and nothing else: its `destroy` throws until the
  // flag `init` sets is set.
  const { buildOrDestroy } = loadTs('src/renderer/src/scene/study/AmbianceLayer.tsx');

  let destroyed = 0;
  let attached = 0;
  const application = {
    ready: false,
    destroy() {
      if (!this.ready) throw new TypeError("Cannot read properties of undefined (reading 'destroy')");
      destroyed++;
    }
  };
  let finishInit;
  const initialising = new Promise((resolve) => { finishInit = resolve; });
  let held = null;

  const built = buildOrDestroy(() => application, (h) => { held = h; }, async (app, owned) => {
    const wanted = await owned.initialize(async () => {
      await initialising;
      app.ready = true;
    });
    if (!wanted) return;
    attached++;
  });

  // The unmount lands while init is still in flight — the whole window this
  // guard exists for.
  assert.doesNotThrow(() => held.release(), 'cleanup threw destroying a half-built application');
  assert.equal(destroyed, 0, 'destroyed before it could survive being destroyed');

  finishInit();
  await built;
  assert.equal(destroyed, 1, 'the application init finished building was never destroyed');
  assert.equal(attached, 0, 'an application nobody was waiting for was attached and started');

  held.release();
  assert.equal(destroyed, 1, 'a later cleanup destroyed it a second time');
});

test('an init that rejects reports its own failure, not a destroy on nothing', async () => {
  // `init` allocating the GL context and then failing leaves an application
  // that never got a renderer. Destroying it there throws a TypeError from
  // inside the cleanup path, and that TypeError is what the caller sees
  // instead of the WebGL failure that actually happened.
  const { buildOrDestroy } = loadTs('src/renderer/src/scene/study/AmbianceLayer.tsx');

  let destroyed = 0;
  const application = {
    ready: false,
    destroy() {
      if (!this.ready) throw new TypeError("Cannot read properties of undefined (reading 'destroy')");
      destroyed++;
    }
  };
  let held = null;

  await assert.rejects(
    buildOrDestroy(() => application, (h) => { held = h; }, async (_app, owned) => {
      await owned.initialize(async () => { throw new Error('WebGL unsupported'); });
      throw new Error('setup ran on an application that never initialised');
    }),
    /WebGL unsupported/,
    'destroying a half-built application masked the failure that caused it'
  );
  assert.equal(destroyed, 0, 'an application with no renderer was destroyed through anyway');
  assert.doesNotThrow(() => held.release(), 'cleanup after a failed init threw');
});

test('the layer initialises pixi through the guard, not around it', () => {
  // `application.init` awaited directly leaves the release with nothing valid
  // to destroy for the entire time it is in flight, which is the window an
  // unmount is most likely to land in.
  const layer = strip(read('src/renderer/src/scene/study/AmbianceLayer.tsx'));
  assert.match(layer, /initialize\(\s*\(\)\s*=>\s*application\.init\(/,
    'init is awaited outside the guard that defers destruction until it settles');
});

test('the hearth breathes rather than blinks', () => {
  // The hearth used to be the candle curve on a hard-edged disc: alpha swinging
  // 0.5 → 1.0 is a two-to-one change in brightness, and on a shape with an edge
  // that reads as a circle being switched on and off rather than as a fire.
  // A fire's light moves, but it moves a LITTLE, and it never goes out.
  const samples = [];
  for (let t = 0; t < 20000; t += 16.7) samples.push(A.hearthFlicker(t));
  assert.ok(samples.every((v) => v >= 0.78 && v <= 1),
    `the hearth left its band (${Math.min(...samples).toFixed(3)}..${Math.max(...samples).toFixed(3)})`);
  assert.ok(Math.min(...samples) < 0.88, 'the hearth is a lamp, not a fire');

  // No step between two frames big enough to read as a flash. This is the
  // assertion the old behaviour fails on hardest, and it is a property of the
  // curve rather than of how it happens to be drawn.
  let jump = 0;
  for (let i = 1; i < samples.length; i++) jump = Math.max(jump, Math.abs(samples[i] - samples[i - 1]));
  assert.ok(jump <= 0.012, `the hearth jumped ${jump.toFixed(4)} between two frames`);
});

test('the hearth never settles into a period you can count', () => {
  // Superposed sinusoids at unrelated frequencies. One period that repeats
  // inside twenty seconds is a loop the eye finds, and once found the fire
  // stops being a fire.
  const at = (t) => A.hearthFlicker(t);
  for (let period = 200; period <= 20000; period += 200) {
    let same = true;
    for (let t = 0; t < 4000 && same; t += 97) {
      if (Math.abs(at(t) - at(t + period)) > 1e-3) same = false;
    }
    assert.ok(!same, `the hearth repeats every ${period}ms`);
  }
});

test('a glow has a soft edge, because a hard one is a sticker', () => {
  // The falloff is built as nested rings rather than one filled circle: this is
  // what makes it a glow and not a disc of colour, and it is arithmetic, so it
  // is pinned here rather than eyeballed in a canvas.
  const rings = A.glowRings(40);
  assert.ok(rings.length >= 5, 'too few steps to read as a falloff');
  for (let i = 1; i < rings.length; i++) {
    assert.ok(rings[i].r < rings[i - 1].r, 'the rings are not nested outside-in');
    assert.ok(rings[i].alpha > rings[i - 1].alpha, 'the falloff does not fall off');
  }
  assert.equal(rings[0].r, 40, 'the outermost ring is not the radius asked for');
  assert.ok(rings[0].alpha <= 0.05, 'the outer edge is visible as an edge');
  // Additive blending sums these, so the sum is the brightness at the centre.
  const centre = rings.reduce((s, x) => s + x.alpha, 0);
  assert.ok(centre > 0.3 && centre <= 1, `the centre sums to ${centre.toFixed(3)}`);
});

test('the hearth throws further than the firebox it sits in', () => {
  assert.ok(A.HEARTH_SPREAD > 1.5,
    'the hearth glow is no wider than a candle — it cannot read as a fire lighting a room');
});

test('the hearth is drawn as a glow, and driven by its own curve', () => {
  const layer = strip(read('src/renderer/src/scene/study/AmbianceLayer.tsx'));
  assert.match(layer, /glowRings\(/, 'the glows are still single filled discs');
  assert.match(layer, /hearthFlicker\(/, 'the hearth still flickers on the candle curve');
  // An ember core under the halo: the hearth is the one light in the room with
  // a source you can see, and a flat wash over it loses that.
  assert.match(layer, /EMBER/, 'the hearth has no ember tint');
});
