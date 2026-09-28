'use strict';
/**
 * The four reading rooms, and what a reading room has to be.
 *
 * Two of the paintings put their desks small and far back in the room, and the
 * whole house is letterboxed into the window as one drawing — so a desk drawn
 * at the back of its panel arrives on screen at a few pixels, with the card
 * standing at it and the book lying on it both too small to read. Neither of
 * those two rooms had a painted volume on its desk either, so the one thing a
 * reading room is FOR — an open book with its pages turning, saying this is
 * where the work is happening — had nowhere to sit that the painting agreed
 * with.
 *
 * They were briefly answered by hanging the other two rooms' paintings twice,
 * with the binding left to carry the whole weight of telling two identical
 * rooms apart. That was a trade, and it is no longer needed: two panels were
 * painted with the desks forward and a volume on each, so the house has four
 * reading rooms and four paintings again.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { studyRoom } = loadTs('src/renderer/src/scene/study/StudyScene.tsx');
const readingRooms = () => studyRoom.rooms.filter((r) => r.kind === 'desk');

test('every reading desk has the painted volume its card stands behind', () => {
  const rooms = readingRooms();
  assert.ok(rooms.length >= 2, 'the house has reading rooms');
  for (const room of rooms) {
    assert.ok(room.berths.length > 0, `${room.id} seats somebody`);
    for (const berth of room.berths) {
      assert.ok(berth.volume,
        `${room.id}/${berth.id} names the volume the painter put on that desk`);
    }
  }
});

test('no two rooms in the house are the same painting', () => {
  // The rule this house started with, and it is back. Two of the reading rooms
  // briefly hung the paintings of the other two, because their own panels drew
  // their desks small and far back with no volume on them — and a binding was
  // asked to carry the whole weight of telling two identical rooms apart. Two
  // new panels were painted instead, so the exception is gone and the plain
  // rule holds again: a room the eye has already been in is not another room.
  const seen = new Map();
  for (const room of studyRoom.rooms) {
    const twin = seen.get(room.image);
    assert.equal(twin, undefined,
      `${room.id} hangs the same painting as ${twin} — ${room.image}`);
    seen.set(room.image, room.id);
  }
});

/**
 * The top of the house works for its keep.
 *
 * The upper storey beside the shelves was a whole room spent on one prop — an
 * observatory whose only use was a click through to the triggers — and it was
 * the one room on the floor nobody had a reason to look at. It is a reading
 * room now, with two desks, and the almanac it held is a prop on a lectern in
 * that room, the way the parlour holds the petitions and the fire.
 */
test('the upper storey beside the shelves is a reading room, and the almanac is a prop in it', () => {
  const beside = studyRoom.rooms.find((r) => r.row === 0 && r.col === 1);
  assert.ok(beside, 'there is no room beside the shelves');
  assert.equal(beside.kind, 'desk', `${beside.id} is a ${beside.kind}, not a reading room`);
  assert.equal(beside.berths.length, 2, `${beside.id} seats ${beside.berths.length}, not two`);
  assert.ok(beside.props.some((p) => p.kind === 'almanac'),
    'the almanac is not on the lectern in that room');
  assert.ok(!studyRoom.rooms.some((r) => r.kind === 'almanac'),
    'the almanac still takes a room of its own');
});

/**
 * Each reading room is its own colour.
 *
 * What tells two reading rooms apart from across the house is the colour of
 * their walls — the furniture in them is deliberately the same. So the wall
 * colour of every reading room is measured off its panel (the upper third,
 * above the desks and away from the windows' glass) and no two may share a
 * hue.
 */
const readPng = require('./read-png.cjs');
const path = require('node:path');

function wallHue(room) {
  const panel = readPng(path.resolve(__dirname, '..', 'src/renderer/src/scene/study/assets',
    room.image));
  const hues = [];
  for (let y = Math.round(panel.height * 0.08); y < panel.height * 0.4; y += 4) {
    for (const band of [[0.02, 0.28], [0.72, 0.98]]) {
      for (let x = band[0] * panel.width; x < band[1] * panel.width; x += 4) {
        const [r, g, b] = panel.at(Math.round(x), y).map((c) => c / 255);
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        if (max - min < 0.12) continue; // grey stone, glass, ceiling: not wall colour
        let h;
        if (max === r) h = ((g - b) / (max - min) + 6) % 6;
        else if (max === g) h = (b - r) / (max - min) + 2;
        else h = (r - g) / (max - min) + 4;
        hues.push(h * 60);
      }
    }
  }
  assert.ok(hues.length > 500, `${room.id}: too little coloured wall to measure`);
  hues.sort((a, b) => a - b);
  return hues[Math.floor(hues.length / 2)];
}

test('no two reading rooms are painted the same colour', () => {
  const rooms = readingRooms().map((room) => ({ id: room.id, hue: wallHue(room) }));
  for (let i = 0; i < rooms.length; i++) {
    for (let j = i + 1; j < rooms.length; j++) {
      const d = Math.abs(rooms[i].hue - rooms[j].hue);
      const apart = Math.min(d, 360 - d);
      assert.ok(apart >= 20,
        `${rooms[i].id} (${rooms[i].hue.toFixed(0)}°) and ${rooms[j].id} `
        + `(${rooms[j].hue.toFixed(0)}°) are painted nearly the same colour`);
    }
  }
});
