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
