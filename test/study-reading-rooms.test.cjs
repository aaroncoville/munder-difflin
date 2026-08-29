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

test('a painting may be hung twice only by rooms a volume tells apart', () => {
  // Sharing a painting is what lets every desk in the house be one the eye can
  // actually reach. The binding is what keeps the rooms that share one from
  // being the same room twice — but a binding can only do that job for a room
  // that DRAWS volumes. A room with no desk in it draws none, so its painting
  // has to be its own.
  //
  // Checked over the whole house in one pass. Two earlier checks did this by
  // kind — reading rooms against reading rooms, the rest against each other —
  // and between them left the crossing case open: a reading room could hang the
  // shelf wall's painting and neither check would look.
  const byPainting = new Map();
  for (const room of studyRoom.rooms) {
    const sharing = byPainting.get(room.image) ?? [];
    sharing.push(room);
    byPainting.set(room.image, sharing);
  }
  for (const [image, sharing] of byPainting) {
    if (sharing.length === 1) continue;
    const who = sharing.map((r) => `${r.id} (${r.kind}/${r.binding ?? 'ledger'})`).join(', ');
    for (const room of sharing) {
      assert.equal(room.kind, 'desk',
        `${room.id} hangs ${image}, which is hung more than once — ${who}`);
      assert.ok(room.berths.length > 0,
        `${room.id} shares a painting but seats nobody, so no volume tells it apart`);
    }
    const bindings = sharing.map((r) => r.binding ?? 'ledger');
    assert.equal(new Set(bindings).size, bindings.length,
      `${image} is hung by rooms that bind their volumes alike — ${who}`);
  }
});

test('the house really does hang a painting twice, so the check above has work', () => {
  // A rule that no arrangement in the tree can break is a rule nobody is
  // keeping. The repetition is deliberate and this is what says so.
  const counts = new Map();
  for (const room of studyRoom.rooms) {
    counts.set(room.image, (counts.get(room.image) ?? 0) + 1);
  }
  assert.ok([...counts.values()].some((n) => n > 1),
    'some painting is hung more than once, or the distinctness rule is vacuous');
});
