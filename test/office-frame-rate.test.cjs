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

const { smoothingFactor, perTickChance, REFERENCE_FPS } =
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
});
