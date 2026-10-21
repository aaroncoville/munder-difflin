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
// Seeds `react` in the require cache, so it has to come before any component
// module is loaded — including the one this file loads for its pure exports.
const { mount } = require('./render-hooks.cjs');

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
  assert.equal(A.ambianceEnabled({ reducedMotion: true, visible: true, attended: true }), false);
  assert.equal(A.ambianceEnabled({ reducedMotion: false, visible: false, attended: true }), false);
  assert.equal(A.ambianceEnabled({ reducedMotion: true, visible: false, attended: true }), false);
  assert.equal(A.ambianceEnabled({ reducedMotion: false, visible: true, attended: false }), false, 'unattended: the candles go out');
  assert.equal(A.ambianceEnabled({ reducedMotion: false, visible: true, attended: true }), true);
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

/**
 * Mount the real layer over a real room, with a pixi that only writes things
 * down.
 *
 * The arithmetic above is checked without pixi anywhere near the process, and
 * that is most of what ambiance is — but a pure-function test cannot see which
 * light the layer decides is which, and a source grep goes green on a call
 * that is present and wired to the wrong thing. So this drives the actual
 * component: a stand-in `pixi.js` records every circle drawn, where it was
 * put, what colour it was filled and how bright it is on a given frame.
 */
function recordingPixi() {
  const record = { graphics: [], ticks: [], destroyed: 0 };

  class Graphics {
    constructor() {
      this.fills = [];
      this.positioned = false;
      this.at = { x: 0, y: 0 };
      this.alpha = 1;
      this.blendMode = null;
      this.factor = 1;
      this.pending = 0;
      this.position = { set: (x, y) => { this.positioned = true; this.at = { x, y }; } };
      this.scale = { set: (s) => { this.factor = s; } };
      record.graphics.push(this);
    }
    circle(_x, _y, r) { this.pending = r; return this; }
    fill(style) { this.fills.push({ r: this.pending, ...style }); return this; }
    clear() { this.fills = []; return this; }
  }

  class Application {
    constructor() {
      const children = [];
      this.stage = { eventMode: null, children, addChild: (c) => children.push(c) };
      this.canvas = { style: {} };
      this.ticker = { add: (fn) => record.ticks.push(fn) };
    }
    async init(options) { this.options = options; }
    destroy() { record.destroyed++; }
  }

  return { record, module: { __esModule: true, Application, Graphics } };
}

/** Draw one room through the real layer and hand back what pixi was told. */
async function paint(room, view) {
  const { record, module } = recordingPixi();
  const pixi = require.resolve('pixi.js');
  const had = require.cache[pixi];
  require.cache[pixi] = { id: pixi, filename: pixi, loaded: true, exports: module };
  // `devicePixelRatio` is read straight off `window` while pixi initialises.
  const hadWindow = 'window' in globalThis;
  const previousWindow = globalThis.window;
  globalThis.window = { devicePixelRatio: 1 };
  try {
    const { AmbianceLayer } = loadTs('src/renderer/src/scene/study/AmbianceLayer.tsx');
    const layer = mount(AmbianceLayer, { room, view });
    // React attaches refs before it runs effects; the host cannot, so the host
    // element is handed over and the effects asked for again.
    layer.tree.props.ref.current = { appendChild() {} };
    layer.render();
    const cleanups = layer.runEffects();
    // The dynamic import of pixi and `init` are each a turn of the microtask
    // queue; a few more than needed costs nothing.
    for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
    return {
      record,
      glows: record.graphics.filter((g) => g.positioned && g.label !== 'mote'),
      tick: record.ticks[0],
      stop: () => cleanups.forEach((fn) => fn && fn())
    };
  } finally {
    globalThis.window = previousWindow;
    if (!hadWindow) delete globalThis.window;
    if (had) require.cache[pixi] = had;
    else delete require.cache[pixi];
  }
}

test('the house paints exactly one fire, and it is painted on the hearth', async () => {
  // The hearth used to be a ROOM, and the layer gave the fire treatment to the
  // first light of the room whose kind was `hearth`. Once the plan could stand
  // an anchor inside somebody else's room the hearth became a prop, no room
  // has that kind any more, and the test that a room-kind check is what picks
  // the fire is the test that no fire is painted at all.
  const { loadRoomManifest, anchorSeat } = loadTs('src/renderer/src/scene/study/roomManifest.ts');
  const load = loadRoomManifest();
  assert.equal(load.ok, true, load.ok ? '' : `room.json does not validate: ${load.error}`);
  const manifest = load.manifest;

  const view = { w: 520, h: 223 };
  const fires = [];
  const candles = [];
  for (const room of manifest.rooms) {
    const painted = await paint(room, view);
    // 1000ms in: far enough from t=0 that the two curves have parted.
    painted.tick({ deltaMS: 1000 });
    painted.glows.forEach((g, i) => {
      const hearth = Math.abs(g.alpha - A.hearthFlicker(1000)) < 1e-9;
      (hearth ? fires : candles).push({ room, glow: g, index: i });
    });
    painted.stop();
  }

  assert.ok(candles.length > 0, 'no room in the house lit a candle');
  assert.equal(fires.length, 1,
    `the house painted ${fires.length} fires — every glow it drew is on the candle curve`);

  const [fire] = fires;
  // Where the fire is drawn is the whole point: the hearth is wherever the
  // plan stands it, as a room of its own or as a prop on somebody's wall, and
  // the light has to follow it there.
  const seat = anchorSeat(manifest, 'hearth');
  assert.equal(fire.room.id, seat.room.id,
    `the fire burns in ${fire.room.id} and the hearth stands in ${seat.room.id}`);
  const berth = seat.berth;
  assert.ok(berth, 'the hearth has nowhere to stand');
  assert.ok(
    fire.glow.at.x >= berth.x * view.w && fire.glow.at.x <= (berth.x + berth.w) * view.w
    && fire.glow.at.y >= berth.y * view.h && fire.glow.at.y <= (berth.y + berth.h) * view.h,
    `the fire is drawn at (${fire.glow.at.x.toFixed(1)}, ${fire.glow.at.y.toFixed(1)}), `
    + 'outside the hearth it is supposed to be burning in'
  );

  // A fire is not a big candle, and this is what the ambiance layer does about
  // it that is visible in the drawing rather than in the curve: it throws
  // further, and it has a hotter core the candles have no equivalent of.
  const reach = (g) => Math.max(...g.fills.map((f) => f.r));
  const candleReach = Math.max(...candles.map((c) => reach(c.glow)));
  assert.ok(reach(fire.glow) > candleReach,
    'the fire throws no further than a candle — it cannot read as lighting a room');
  const colours = (g) => new Set(g.fills.map((f) => f.color));
  const candleColours = new Set(candles.flatMap((c) => [...colours(c.glow)]));
  const fireOnly = [...colours(fire.glow)].filter((c) => !candleColours.has(c));
  assert.equal(fireOnly.length, 2,
    'the fire is drawn in the candles\' own colours — no deeper light, no ember under it');
});

test('a glow knows whether it is a flame or a fire, and the cap still caps', () => {
  const candle = { x: 0.1, y: 0.2, kind: 'candle' };
  const fire = { x: 0.3, y: 0.4, kind: 'hearth' };
  assert.deepEqual(A.glowsFor([candle, fire]), [
    { x: 0.1, y: 0.2, hearth: false },
    { x: 0.3, y: 0.4, hearth: true }
  ]);
  // Classifying does not buy a light an exemption from the cap: a room that
  // marks more lights than it can afford still draws only what it can afford,
  // and a fire marked past the cap is simply not drawn.
  const many = [...new Array(A.GLOW_CAP).fill(candle), fire];
  const drawn = A.glowsFor(many);
  assert.equal(drawn.length, A.GLOW_CAP, 'classifying the lights lost the cap on them');
  assert.equal(drawn.some((g) => g.hearth), false, 'a light past the cap was drawn anyway');
});

// The layer's frame cap and resolution come from the office's motion decision:
// on a software GPU (or with the OS asking for less motion) six frames a second
// at 1x, where each frame is a full Canvas2D raster of a panel-sized layer; a
// real GPU keeps the uncapped layer at device pixels it has always had.
test('ambianceMotion: six frames a second at half resolution on the reduced path, uncapped at dpr on the full one', () => {
  const A = loadTs('src/renderer/src/scene/study/ambiance.ts');
  assert.equal(A.AMBIANCE_REDUCED_FPS, 6);
  assert.equal(A.AMBIANCE_REDUCED_RESOLUTION, 0.5);
  assert.deepEqual(A.ambianceMotion('reduced', 2), { maxFPS: 6, resolution: 0.5 });
  assert.deepEqual(A.ambianceMotion('full', 2), { maxFPS: 0, resolution: 2 });
  assert.deepEqual(A.ambianceMotion('full', 0), { maxFPS: 0, resolution: 1 });
});

/* ─── Behaviour: caps, attention and teardown, driven through the real layer
 *
 * The stand-in pixi above is extended with a ticker that remembers its cap
 * and a destroy count; a fake window and document carry focus, visibility
 * and listeners; timers are captured. The host runs every effect it is asked
 * to, so `settle()` does what React does: re-run the layer's effect (cleanup
 * first) only when the layer's render changed between on and off. */

function stagePixi() {
  const record = { apps: [], ticks: [], inits: [], destroyed: 0, geometry: 0 };
  class Graphics {
    constructor() {
      this.alpha = 1; this.blendMode = null; this.label = null;
      this.position = { set: (x, y) => { this.x = x; this.y = y; } };
      this.scale = { set: (v) => { this.factor = v; } };
    }
    circle() { record.geometry += 1; return this; }
    fill() { record.geometry += 1; return this; }
    clear() { record.geometry += 1; return this; }
  }
  class Application {
    constructor() {
      const children = [];
      this.stage = { eventMode: null, children, addChild: (c) => children.push(c) };
      this.canvas = { style: {} };
      this.render = () => {};
      this.ticker = { maxFPS: 0, add: (fn) => record.ticks.push(fn), remove: () => {} };
      record.apps.push(this);
    }
    // Pixi 8's sizing, enough of it to tell (AbstractRenderer, ViewSystem):
    // renderer.width/height are the LOGICAL size (the view texture's frame),
    // canvas.width/height the backing pixels (logical x resolution), and the
    // element's CSS size is the logical size only with autoDensity — without
    // it the element takes the backing size.
    async init(options) {
      this.options = options; record.inits.push(options);
      const res = options.resolution ?? 1;
      this.renderer = { name: 'canvas', resolution: res, width: options.width, height: options.height };
      this.canvas.width = options.width * res; this.canvas.height = options.height * res;
      const css = options.autoDensity ? { w: options.width, h: options.height } : { w: this.canvas.width, h: this.canvas.height };
      this.canvas.style.width = `${css.w}px`; this.canvas.style.height = `${css.h}px`;
    }
    destroy() { this.dead = true; record.destroyed += 1; }
  }
  return { record, module: { __esModule: true, Application, Graphics, UPDATE_PRIORITY: { LOW: -25 } } };
}

/** Mount the real layer in a fake browser; returns the controls. */
async function house(room, view, { focused = true, hidden = false, shown = true, reduced = false, mode = 'reduced' } = {}) {
  const { record, module } = stagePixi();
  const pixi = require.resolve('pixi.js');
  const hadPixi = require.cache[pixi];
  require.cache[pixi] = { id: pixi, filename: pixi, loaded: true, exports: module };
  const listeners = new Map();
  const win = {
    devicePixelRatio: 2,
    matchMedia: () => ({ matches: reduced, addEventListener() {}, removeEventListener() {} }),
    addEventListener: (t, fn) => listeners.set('window:' + t, fn),
    removeEventListener: (t) => listeners.delete('window:' + t),
    cth: { hiveLogEvent: async () => true }
  };
  const doc = {
    get hidden() { return hidden; },
    hasFocus: () => focused,
    addEventListener: (t, fn) => listeners.set('document:' + t, fn),
    removeEventListener: (t) => listeners.delete('document:' + t)
  };
  const timers = [];
  const real = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, window: globalThis.window, document: globalThis.document, now: Date.now };
  let now = 1_000_000;
  globalThis.setTimeout = (fn, ms) => { const h = { fn, ms }; timers.push(h); return h; };
  globalThis.clearTimeout = (h) => { const k = timers.indexOf(h); if (k >= 0) timers.splice(k, 1); };
  globalThis.window = win; globalThis.document = doc; Date.now = () => now;
  const shownMod = loadTs('src/renderer/src/scene/windowShown.ts');
  // Through the path main's minimise/restore IPC takes, which notifies.
  shownMod.resetWindowShown();
  shownMod.applyWindowVisibility({ shown });
  // The reduced path unless a test says otherwise: node's WebGL probe says
  // 'unknown', which 'auto' treats as hardware.
  const { setOfficeMotionPref } = loadTs('src/renderer/src/scene/office/officeMotion.ts');
  setOfficeMotionPref(mode);
  const settleTurns = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
  let layer;
  try {
    const { AmbianceLayer } = loadTs('src/renderer/src/scene/study/AmbianceLayer.tsx');
    // trackDeps: only the effect whose deps changed re-runs, as in React —
    // the attention and visibility hooks keep their listeners and timers
    // across the layer going on and off. The host cannot attach refs, so the
    // host element is handed over and the main effect gets its real first
    // run through a render + runEffects (its deps include the ref-less run).
    layer = mount(AmbianceLayer, { room, view }, { trackDeps: true, deferEffects: true });
    if (layer.tree) layer.tree.props.ref.current = { appendChild() {} };
    layer.runEffects();
    await settleTurns();
  } catch (e) { restore(); throw e; }
  function restore() {
    globalThis.setTimeout = real.setTimeout; globalThis.clearTimeout = real.clearTimeout;
    globalThis.window = real.window; globalThis.document = real.document; Date.now = real.now;
    if (hadPixi) require.cache[pixi] = hadPixi; else delete require.cache[pixi];
    shownMod.resetWindowShown();
    setOfficeMotionPref('auto');
  }
  /** Re-render and let the host re-run only the effects whose deps changed. */
  const settle = async () => {
    layer.render();
    if (layer.tree) layer.tree.props.ref.current = { appendChild() {} };
    layer.runEffects();
    await settleTurns();
  };
  const live = () => record.apps.filter((a) => !a.dead);
  return {
    record, timers, listeners,
    live, on: () => layer.tree !== null,
    async blur() { focused = false; now += 1; listeners.get('window:blur')?.(); await settle(); },
    async focus() { focused = true; listeners.get('window:focus')?.(); await settle(); },
    async elapse(ms) { now += ms; for (const h of timers.splice(0)) h.fn(); await settle(); },
    async hide() { hidden = true; listeners.get('document:visibilitychange')?.(); await settle(); },
    async show() { hidden = false; listeners.get('document:visibilitychange')?.(); await settle(); },
    async minimise() { shownMod.applyWindowVisibility({ shown: false }); await settle(); },
    async restoreWindow() { shownMod.applyWindowVisibility({ shown: true }); await settle(); },
    unmount() { layer.unmount(); restore(); }
  };
}

const A_ROOM = { id: 'library', lightPoints: [{ x: 0.2, y: 0.3, kind: 'candle' }, { x: 0.7, y: 0.4, kind: 'candle' }], binding: 'cloth' };
const A_VIEW = { x: 0, y: 0, w: 640, h: 360 };

test('a lit room: one Application, capped and at the reduced resolution, the CSS size kept; a tick moves motes without rebuilding geometry', async () => {
  const h = await house(A_ROOM, A_VIEW);
  try {
    assert.equal(h.on(), true);
    assert.equal(h.live().length, 1, 'one Application for the room');
    const [app] = h.live();
    assert.equal(app.ticker.maxFPS, 6, 'the reduced cap');
    assert.equal(app.options.resolution, 0.5, 'the reduced resolution');
    assert.equal(app.options.autoDensity, true, 'autoDensity keeps the CSS size at the logical size');
    assert.deepEqual([app.renderer.width, app.renderer.height], [640, 360], 'the logical size is the panel');
    assert.deepEqual([app.canvas.width, app.canvas.height], [320, 180], 'the backing store is half the panel');
    assert.deepEqual([app.canvas.style.width, app.canvas.style.height], ['640px', '360px'], 'the CSS size is still the panel');
    assert.equal(h.record.ticks.length, 1);
    const motes = app.stage.children.filter((g) => g.label === 'mote');
    assert.equal(motes.length, 24, 'one Graphics per mote');
    const before = h.record.geometry;
    const was = motes.map((m) => [m.x, m.y]);
    for (let i = 0; i < 30; i++) h.record.ticks[0]({ deltaMS: 1000 / 6 });
    assert.equal(h.record.geometry, before, 'thirty ticks rebuilt no geometry (no clear/circle/fill)');
    assert.ok(motes.some((m, i) => m.x !== was[i][0] || m.y !== was[i][1]), 'the motes moved');
  } finally { h.unmount(); }
});

test('the full path keeps the uncapped layer at device pixels', async () => {
  const h = await house(A_ROOM, A_VIEW, { mode: 'full' });
  try {
    const [app] = h.live();
    assert.equal(app.ticker.maxFPS, 0);
    assert.equal(app.options.resolution, 2);
    assert.equal(app.options.autoDensity, true);
    assert.deepEqual([app.renderer.width, app.renderer.height], [640, 360], 'logical');
    assert.deepEqual([app.canvas.width, app.canvas.height], [1280, 720], 'device pixels');
    assert.deepEqual([app.canvas.style.width, app.canvas.style.height], ['640px', '360px']);
  } finally { h.unmount(); }
});

test('unattended: the layer goes out after the grace and relights on focus, one destroy and one rebuild', async () => {
  const h = await house(A_ROOM, A_VIEW);
  try {
    assert.equal(h.live().length, 1);
    await h.blur();
    assert.equal(h.on(), true, 'inside the grace the candles stay lit');
    assert.equal(h.timers.length, 1, 'the grace timer is armed');
    await h.elapse(30_000);
    assert.equal(h.on(), false, 'grace over: off');
    assert.equal(h.live().length, 0, 'the Application was destroyed');
    assert.equal(h.record.destroyed, 1);
    assert.equal(h.timers.length, 0, 'no timer left running while off');
    await h.focus();
    assert.equal(h.on(), true, 'focus relights the room');
    assert.equal(h.live().length, 1, 'exactly one new Application');
    assert.equal(h.record.apps.length, 2);
    assert.equal(h.live()[0].ticker.maxFPS, 6, 'the rebuilt layer is capped too');
  } finally { h.unmount(); }
});

test('hidden or minimised: off at once, back when shown, no leak either way', async () => {
  const h = await house(A_ROOM, A_VIEW);
  try {
    await h.hide();
    assert.equal(h.on(), false); assert.equal(h.live().length, 0);
    await h.show();
    assert.equal(h.on(), true); assert.equal(h.live().length, 1);
    await h.minimise();
    assert.equal(h.on(), false, 'a minimised window (main says so) is not shown'); assert.equal(h.live().length, 0);
    await h.restoreWindow();
    assert.equal(h.on(), true); assert.equal(h.live().length, 1);
    assert.equal(h.record.destroyed, 2);
    assert.equal(h.record.apps.length, 3);
  } finally { h.unmount(); }
});

test('unmounting while paused leaves nothing behind: no Application, no timer, no listener', async () => {
  const h = await house(A_ROOM, A_VIEW);
  await h.blur();
  await h.elapse(30_000);
  assert.equal(h.live().length, 0);
  h.unmount();
  assert.equal(h.live().length, 0);
  assert.equal(h.timers.length, 0, 'a timer outlived the layer');
  assert.equal(h.listeners.size, 0, `listeners outlived the layer: ${[...h.listeners.keys()].join(', ')}`);
});

test('with diagnostics on, the layer runs a floor-perf sampler that dies with the layer', async () => {
  const perf = loadTs('src/renderer/src/scene/office/floorPerf.ts');
  perf.setFloorDiagnosticsPref(true);
  const h = await house(A_ROOM, A_VIEW);
  try {
    assert.equal(h.record.ticks.length, 3, 'the ambiance tick, the counting callback and the wrapped render');
    const sampler = h.timers.filter((x) => x.ms === 15_000);
    assert.equal(sampler.length, 1, 'one sample timer, fifteen seconds');
    h.unmount();
    assert.equal(h.timers.filter((x) => x.ms === 15_000).length, 0, 'the sampler timer outlived the layer');
  } finally { perf.setFloorDiagnosticsPref(false); }
});

test('unmounting while lit destroys the Application exactly once', async () => {
  const h = await house(A_ROOM, A_VIEW);
  assert.equal(h.live().length, 1);
  h.unmount();
  assert.equal(h.record.destroyed, 1);
  assert.equal(h.timers.length, 0);
  assert.equal(h.listeners.size, 0);
});

test('the Study holds its desks still when nobody is watching, not only under reduced motion', () => {
  const src = read('src/renderer/src/scene/study/StudyScene.tsx');
  assert.match(src, /const awake = visible && attended;/);
  assert.match(src, /still=\{reducedMotion \|\| !awake\}/);
  assert.doesNotMatch(src, /still=\{reducedMotion\}/);
});
