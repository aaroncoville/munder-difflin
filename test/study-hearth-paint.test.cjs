'use strict';
/**
 * The hearth is held against the painting it stands in.
 *
 * `hearth` is Closing Time — the anchor you press to shut the House down — and
 * it is a PROP: a rectangle of the parlour's panel rather than a room of its
 * own. Nothing in the manifest can say whether that rectangle is a fireplace.
 * It was a door for a while, with the fire's glow pooling at its foot, and
 * every other test in the tree passed: the berth validated, the light validated,
 * the plate was clickable, and the room read as a mystery glow beside a door.
 *
 * The only thing that can tell a hearth from a door is the paint under the
 * plate, so that is what is checked here — and separately, that the fire the
 * ambiance layer hangs is hung on the painted flames rather than beside them.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const readPng = require('./read-png.cjs');

const ASSETS = path.resolve(__dirname, '..', 'src/renderer/src/scene/study/assets');
const manifest = JSON.parse(fs.readFileSync(path.join(ASSETS, 'room.json'), 'utf8'));

/** Where the one hearth stands: its room's panel, and its rectangle in it. */
function hearthSeat() {
  for (const room of manifest.rooms) {
    if (room.kind === 'hearth') return { room, berth: room.berths[0] };
    const prop = (room.props ?? []).find((p) => p.kind === 'hearth');
    if (prop) return { room, berth: prop.berth };
  }
  throw new Error('the house has no hearth');
}

/**
 * Whether a colour is burning fire rather than lamplight, wood or wall.
 *
 * Two flames, because a fire is painted in two: a deep orange body, which is
 * the one thing in the parlour that is bright and starved of blue at once, and
 * a near-white core. Both have to exclude the chandeliers, which are the other
 * warm thing in the room — their flames carry far more blue (b=175 against the
 * fire's 142), and the firelight they pool on the floorboards is nowhere near
 * as red-shifted as the flame that casts it.
 */
const isFire = ([r, g, b]) =>
  (r - b > 140 && r > 170) || (r > 235 && g > 200 && b < 160);

test('the hearth plate stands on a fire somebody painted, not on a door', () => {
  const { room, berth } = hearthSeat();
  const panel = readPng(path.join(ASSETS, room.image));
  assert.equal(panel.width, room.natural.w, 'the manifest has the panel’s width');
  assert.equal(panel.height, room.natural.h, 'the manifest has the panel’s height');

  let burning = 0;
  let sampled = 0;
  for (let y = (berth.y + 0.02) * panel.height; y < (berth.y + berth.h) * panel.height; y += 2) {
    for (let x = berth.x * panel.width; x < (berth.x + berth.w) * panel.width; x += 2) {
      sampled++;
      if (isFire(panel.at(x, y))) burning++;
    }
  }
  assert.ok(sampled > 0, 'the hearth berth has area to sample');
  assert.ok(burning / sampled > 0.02,
    `the hearth plate covers ${(burning / sampled * 100).toFixed(1)}% painted fire — `
    + 'it is standing on something that is not burning');
});

test('finding fire under the plate is a fact about the plate, not about the paint', () => {
  // The parlour is a warm red room full of candles. Without this, a probe loose
  // enough to call every warm pixel a fire would pass the test above wherever
  // the plate stood, which is the same as not checking it at all.
  const { room } = hearthSeat();
  const panel = readPng(path.join(ASSETS, room.image));
  let burning = 0;
  let sampled = 0;
  for (let y = 0; y < panel.height; y += 3) {
    for (let x = 0; x < panel.width; x += 3) {
      sampled++;
      if (isFire(panel.at(x, y))) burning++;
    }
  }
  assert.ok(burning / sampled < 0.01,
    `${Math.round((burning / sampled) * 100)}% of the parlour reads as fire, `
    + 'so landing on some says nothing');
});

test('the fire is hung on the painted flames, not beside them', () => {
  const { room } = hearthSeat();
  const panel = readPng(path.join(ASSETS, room.image));
  const fires = room.lightPoints.filter((p) => p.kind === 'hearth');
  assert.equal(fires.length, 1, 'the parlour marks exactly one of its lights as the fire');

  // A small patch rather than the single pixel: the glow is a disc, and asking
  // it to land on one painted pixel of flame would be a coordinate held to a
  // precision nobody can author by eye.
  const [fire] = fires;
  let burning = 0;
  let sampled = 0;
  const reach = Math.round(panel.width * 0.012);
  for (let dy = -reach; dy <= reach; dy++) {
    for (let dx = -reach; dx <= reach; dx++) {
      sampled++;
      if (isFire(panel.at(fire.x * panel.width + dx, fire.y * panel.height + dy))) burning++;
    }
  }
  assert.ok(burning / sampled > 0.3,
    `the fire is marked at (${fire.x}, ${fire.y}), where ${(burning / sampled * 100).toFixed(0)}% `
    + 'of the painting is burning');
});
