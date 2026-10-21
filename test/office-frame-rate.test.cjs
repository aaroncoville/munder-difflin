'use strict';

// The floor's two per-FRAME constants, made per-second, so the reduced path
// (15 fps, officeMotion.ts) runs the same simulation as the full one and not a
// slower, quieter copy of it: the camera's lerp, and the café's roll to strike
// up a chat. Pinned numerically at 15 against 60.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const { smoothingFactor, perTickChance, effectiveFrames, REFERENCE_FPS } =
  loadTs('src/renderer/src/scene/office/frameRate.ts');
// Camera's only pixi import is a type, so it loads with no pixi in the process.
const { Camera, LERP_SPEED } = loadTs('src/renderer/src/scene/office/Camera.ts');

const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);

test('at the reference rate the per-frame constant is itself', () => {
  assert.equal(REFERENCE_FPS, 60);
  close(smoothingFactor(0.08, 1 / 60), 0.08, 1e-12, 'lerp at 60');
  close(perTickChance(0.004, 1 / 60), 0.004, 1e-12, 'chance at 60');
  assert.equal(smoothingFactor(0.08, 0), 0, 'a zero-length tick moves nothing');
  assert.equal(perTickChance(0.004, -1), 0, 'a negative tick rolls nothing');
});

test('one second of lerp covers the same ground at 15 fps as at 60', () => {
  // What remains of the gap after a second at each rate.
  const remain = (fps) => {
    let x = 0;
    for (let i = 0; i < fps; i++) x += (1 - x) * smoothingFactor(LERP_SPEED, 1 / fps);
    return 1 - x;
  };
  const at60 = remain(60);
  const at15 = remain(15);
  close(at60, 0.92 ** 60, 1e-12, 'the 60 fps path changed');
  close(at15, at60, 1e-9, 'a pan takes a different time at 15 fps');
  // And the per-tick constant on its own would not: four times the frames
  // of ground per second at 60.
  const naive15 = 1 - (1 - (1 - 0.92 ** 15));
  assert.ok(naive15 > at15 * 2, 'the fixed per-tick lerp was already rate-independent?');
});

test('the camera pans to the same place after a second at 15 fps and at 60', () => {
  const pan = (fps) => {
    const container = { x: 0, y: 0, scale: { set() {} } };
    const cam = new Camera(container);
    cam.setMapSize(4000, 4000);
    cam.setViewSize(800, 600);
    cam.focusOn(3000, 2500, 2);
    for (let i = 0; i < fps; i++) cam.update(1 / fps);
    return { x: container.x, y: container.y };
  };
  const a = pan(60), b = pan(15);
  close(a.x, b.x, 1e-6, 'x');
  close(a.y, b.y, 1e-6, 'y');
  assert.notEqual(a.x, 0, 'the camera never moved');
});

// --- the nudge ------------------------------------------------------------------------
//
// nudgeToward is measured on the camera's own position (`currentX`), not on the
// container it drives: a FITTED camera — the only kind the floor has, it never
// calls focusOn — is pinned by the map-edge clamp, because the fit zoom makes
// one axis exactly the view and the other smaller, and both branches of the
// clamp then centre the container whatever the camera's position is. So the
// container shows nothing of a nudge, fixed or broken; the position does.
//
// The camera is settled first (run until it stops moving to within 1e-6), so a
// sample measures the nudge and not the fit still converging. And the test
// carries its own mutants, built through the frameRate seam: a per-tick push
// (effectiveFrames → 1, the code before this fix) and no push at all
// (effectiveFrames → 0). The guard proves the measurement can tell them apart.

const FRAME_RATE = 'src/renderer/src/scene/office/frameRate.ts';
const CAMERA = 'src/renderer/src/scene/office/Camera.ts';

/** Camera built against a frameRate whose effectiveFrames is `mutant`, or the
 *  real one when no mutant is given. */
function cameraWith(mutant) {
  const real = loadTs.fresh(FRAME_RATE);
  if (mutant) loadTs.stub(FRAME_RATE, { ...real, effectiveFrames: mutant });
  try { return loadTs.fresh(CAMERA).Camera; } finally { loadTs.fresh(FRAME_RATE); }
}

/** Run a fitted camera to rest, then nudge it and sample its x every `everyMs`
 *  for `seconds` at `fps`. Returns displacements from the rest position. */
function nudgePath(CameraClass, fps, seconds, everyMs) {
  const container = { x: 0, y: 0, scale: { set() {} } };
  const cam = new CameraClass(container);
  cam.setMapSize(4000, 4000);
  cam.setViewSize(800, 600);
  cam.fitToScreen();
  let settled = false;
  for (let i = 0; i < 10_000 && !settled; i++) {
    const [x, y, z] = [cam.currentX, cam.currentY, cam.currentZoom];
    cam.update(1 / 60);
    settled = Math.abs(cam.currentX - x) < 1e-6 && Math.abs(cam.currentY - y) < 1e-6
      && Math.abs(cam.currentZoom - z) < 1e-6;
  }
  assert.ok(settled, 'the camera never came to rest');
  const home = cam.currentX;
  cam.nudgeToward(3000, 2000, 1200);
  const samples = [];
  const stepMs = 1000 / fps;
  for (let i = 1; i <= fps * seconds; i++) {
    cam.update(1 / fps);
    if (Math.round(i * stepMs) % everyMs === 0) samples.push(cam.currentX - home);
  }
  return samples;
}

test('a nudge covers the same ground per second at 15 fps as at 60', () => {
  // One frame's push at the reference rate; at 15 fps, what four per-frame
  // pushes leave standing once the lerp has eaten at the first three.
  close(effectiveFrames(LERP_SPEED, 1 / 60), 1, 1e-12, 'one frame is one push');
  close(effectiveFrames(LERP_SPEED, 1 / 15), (1 - 0.92 ** 4) / 0.08, 1e-12, 'four frames, decayed');
  assert.ok(effectiveFrames(LERP_SPEED, 1 / 15) < 4, 'plain velocity × dt would overshoot');
  assert.equal(effectiveFrames(0, 1 / 15), 4, 'with nothing decaying it is the frame count');
  assert.equal(effectiveFrames(LERP_SPEED, 0), 0);
  assert.equal(effectiveFrames(LERP_SPEED, -1), 0);

  // Every 200 ms over 2 s: 1.2 s of nudge, then the lerp bringing it home.
  const at60 = nudgePath(Camera, 60, 2, 200);
  const at15 = nudgePath(Camera, 15, 2, 200);
  assert.equal(at60.length, 10);
  assert.equal(at15.length, 10);
  const peak = Math.max(...at60.map(Math.abs));
  assert.ok(peak > 5, `the nudge never moved the camera (${peak}px)`);
  // What is left is the ease sampled once per tick instead of once per frame,
  // which leaves the coarser tick pushing a little less: under 3% of the peak,
  // measured, so 4% here. A per-tick push is off by 4x (next test).
  for (let i = 0; i < at60.length; i++) {
    close(at15[i], at60[i], peak * 0.04, `sample ${i} (${(i + 1) * 200} ms)`);
  }
});

test('mutation guard: the nudge measurement tells a per-tick push and no push from the fix', () => {
  const at60 = nudgePath(Camera, 60, 2, 200);
  const peak = Math.max(...at60.map(Math.abs));

  // The code before the fix: one push per tick. At 15 fps that is a quarter
  // of the pushes per second, and the path must say so — by more than 3x.
  const PerTick = cameraWith(() => 1);
  const perTick15 = nudgePath(PerTick, 15, 2, 200);
  const perTickPeak = Math.max(...perTick15.map(Math.abs));
  assert.ok(perTickPeak > 0, 'the per-tick mutant did not move at all');
  assert.ok(peak > 3 * perTickPeak,
    `a per-tick push at 15 fps should fall short of the 60 fps path by >3x (${peak} vs ${perTickPeak})`);
  // …and at 60 fps the per-tick mutant IS the fixed path, which is the point:
  // the fix changed nothing at the reference rate.
  const perTick60 = nudgePath(PerTick, 60, 2, 200);
  for (let i = 0; i < at60.length; i++) close(perTick60[i], at60[i], 1e-9, `per-tick at 60, sample ${i}`);

  // No push: a settled camera stays put. "Put" is a thousandth of a pixel —
  // the lerp goes on converging below the 1e-6-per-frame rest threshold, and
  // that residue adds up to a few millionths over two seconds; the nudge it
  // must not show is three thousand pixels.
  const NoNudge = cameraWith(() => 0);
  for (const fps of [15, 60]) {
    for (const d of nudgePath(NoNudge, fps, 2, 200)) {
      assert.ok(Math.abs(d) < 1e-3, `the nudge-disabled mutant moved ${d}px at ${fps} fps`);
    }
  }
});

test('the chance of a café chat in any given second is the same at 15 fps as at 60', () => {
  const p60 = 0.004;
  const quietSecond = (fps) => (1 - perTickChance(p60, 1 / fps)) ** fps;
  close(quietSecond(60), (1 - p60) ** 60, 1e-12, 'the 60 fps path changed');
  close(quietSecond(15), quietSecond(60), 1e-12, 'table-mates chat at a different rate at 15 fps');
  close(quietSecond(144), quietSecond(60), 1e-12, 'or at 144');
});

test('the floor rolls the chat through perTickChance and lerps through smoothingFactor', () => {
  const floor = strip(read('src/renderer/src/scene/office/OfficeFloor.tsx'));
  assert.match(floor, /Math\.random\(\) < perTickChance\(CAFE_CHAT_CHANCE_PER_FRAME, dt\)/);
  assert.doesNotMatch(floor, /Math\.random\(\) < 0\.004/, 'the per-tick roll is back');
  assert.match(read('src/renderer/src/scene/office/OfficeFloor.tsx'), /const CAFE_CHAT_CHANCE_PER_FRAME = 0\.004;/);
  const camera = strip(read('src/renderer/src/scene/office/Camera.ts'));
  assert.match(camera, /const k = smoothingFactor\(LERP_SPEED, dt\);/);
  assert.doesNotMatch(camera, /\* LERP_SPEED;/, 'a per-tick lerp is back');
  assert.match(camera, /const push = ease \* effectiveFrames\(LERP_SPEED, dt\);/);
  assert.doesNotMatch(camera, /nudgeOffset[XY] \* ease;/, 'a per-tick nudge is back');
});

// An exponential lerp never arrives: after a pan it kept writing the world's
// position by a millionth of a pixel a tick for seconds — invisible under
// roundPixels, but a change the floor renders every tick (renderOnChange.ts).
// Within SNAP_PX / SNAP_ZOOM of the target it lands exactly and stops writing.
test('the camera lands on its target and stops moving, within a couple of seconds', () => {
  const { SNAP_PX, SNAP_ZOOM } = loadTs('src/renderer/src/scene/office/Camera.ts');
  assert.ok(SNAP_PX > 0 && SNAP_PX <= 0.01 && SNAP_ZOOM > 0 && SNAP_ZOOM <= 1e-4);
  const container = { x: 0, y: 0, scale: { set(v) { this.x = v; }, x: 1 } };
  const cam = new Camera(container);
  cam.setMapSize(640, 480);
  cam.setViewSize(320, 240);
  cam.focusOn(400, 300, 2);
  let landedAt = -1;
  for (let i = 0; i < 15 * 10; i++) {
    const [x, y, z] = [container.x, container.y, container.scale.x];
    cam.update(1 / 15);
    if (container.x === x && container.y === y && container.scale.x === z) { landedAt = i; break; }
  }
  assert.ok(landedAt >= 0, 'the camera never stopped writing the world');
  assert.ok(landedAt < 15 * 3, `landed after ${landedAt} ticks; expected within 3 s`);
  for (let i = 0; i < 150; i++) {
    const [x, y, z] = [container.x, container.y, container.scale.x];
    cam.update(1 / 15);
    assert.equal(container.x, x); assert.equal(container.y, y); assert.equal(container.scale.x, z);
  }
});
