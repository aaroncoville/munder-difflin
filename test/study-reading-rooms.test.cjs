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
 * So the house hangs the two paintings whose desks come forward, and hangs each
 * of them twice. Repeating a painting was a real objection and it still is: a
 * room the eye has already been in is not another room. What answers it is the
 * BINDING — the two rooms that share a painting bind their volumes differently,
 * so the desks are told apart by what is lying on them, which is the thing the
 * eye is being asked to look at anyway.
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

test('no two reading rooms are the same room to look at', () => {
  // Painting AND binding together. Sharing a painting is what lets every desk
  // in the house be one the eye can actually reach; the binding is what keeps
  // the two rooms that share one from being the same room twice.
  const seen = new Map();
  for (const room of readingRooms()) {
    const face = `${room.image} bound as ${room.binding ?? 'ledger'}`;
    assert.equal(seen.get(face), undefined,
      `${room.id} is indistinguishable from ${seen.get(face)} — ${face}`);
    seen.set(face, room.id);
  }
});

test('the rooms that are not reading rooms each hang their own painting', () => {
  // The objection in full force everywhere it still applies: the shelves, the
  // almanac, the parlour and the god's study are each somewhere in particular,
  // and none of them is told apart by what is lying on a desk.
  const seen = new Map();
  for (const room of studyRoom.rooms.filter((r) => r.kind !== 'desk')) {
    assert.equal(seen.get(room.image), undefined,
      `${room.id} hangs the same painting as ${seen.get(room.image)}`);
    seen.set(room.image, room.id);
  }
});
