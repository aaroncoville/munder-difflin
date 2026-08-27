'use strict';
/**
 * Berths are held against the paintings they were read off.
 *
 * Every reading berth in `room.json` is a place at a desk somebody painted, and
 * the manifest cannot say so: a berth nudged out over the room's window is a
 * perfectly valid rectangle, and every other test in the tree — the projection,
 * the seating, the stacking — keeps passing while the assistants stand in mid
 * air. The one thing that can tell a desk from a window is the paint under the
 * berth's feet, so that is what is checked here.
 *
 * The probe is deliberately narrow: a short column of pixels straight down from
 * the middle of the berth's bottom edge, which is where the desk has to be for
 * a card to look like it is standing at one. It says nothing about the rest of
 * the rectangle, and it is not a substitute for looking at the room.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const readPng = require('./read-png.cjs');

const ASSETS = path.resolve(__dirname, '..', 'src/renderer/src/scene/study/assets');
const manifest = JSON.parse(fs.readFileSync(path.join(ASSETS, 'room.json'), 'utf8'));

/**
 * Whether a colour is a painted desk rather than wall, glass, sill or daylight.
 *
 * Every desk in the Study is dark warm wood, and the things a berth drifts onto
 * instead are either much brighter (a window, a stone sill, a lit wall) or much
 * less red (grey masonry, glass). Two coarse tests separate them by a wide
 * margin, which is what keeps this from failing over a repaint that only
 * changes the light.
 */
const isDeskWood = ([r, g, b]) => r >= b + 20 && 0.299 * r + 0.587 * g + 0.114 * b <= 100;

/** How far below a berth's bottom edge the desk is looked for, in panel px. */
const PROBE_DEPTHS = [4, 10, 16, 22];

const deskRooms = manifest.rooms.filter((room) => room.kind === 'desk');
const panelOf = (room) => readPng(path.join(ASSETS, room.image));

test('the paintings have a desk under every berth, not a wall or a window', () => {
  assert.ok(deskRooms.length > 0, 'there are reading rooms to check');
  for (const room of deskRooms) {
    const panel = panelOf(room);
    assert.equal(panel.width, room.natural.w, `${room.id}: the manifest has the panel's width`);
    assert.equal(panel.height, room.natural.h, `${room.id}: the manifest has the panel's height`);
    for (const berth of room.berths) {
      const x = (berth.x + berth.w / 2) * panel.width;
      const foot = (berth.y + berth.h) * panel.height;
      for (const depth of PROBE_DEPTHS) {
        const paint = panel.at(x, foot + depth);
        assert.ok(
          isDeskWood(paint),
          `${room.id}/${berth.id}: ${depth}px under the berth the painting is `
          + `rgb(${paint.join(', ')}), which is not a desk`
        );
      }
    }
  }
});

test('finding a desk under a berth is a fact about that berth, not about the paint', () => {
  // These are wood-paneled rooms: without this, a probe loose enough to call
  // every warm pixel a desk would pass the test above wherever the berths sat,
  // which is the same as not checking them at all.
  for (const room of deskRooms) {
    const panel = panelOf(room);
    let desk = 0;
    let sampled = 0;
    for (let y = 0; y < panel.height; y += 3) {
      for (let x = 0; x < panel.width; x += 3) {
        sampled++;
        if (isDeskWood(panel.at(x, y))) desk++;
      }
    }
    assert.ok(desk / sampled < 0.6,
      `${room.id}: the probe reads ${Math.round((desk / sampled) * 100)}% of the panel as desk, `
      + 'so landing on one says nothing');
  }
});
