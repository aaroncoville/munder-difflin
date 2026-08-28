'use strict';
/**
 * A shared desk is still a desk: the cards piled at one have to stand on it.
 *
 * `study-desk-layout` holds the FIRST card at each berth against the painted
 * surface under it. That is the only case it can see, because it lays every
 * berth out straight from the manifest — and a berth straight from the
 * manifest is stack index 0. The moment the house holds more assistants than
 * it has reading desks the seating wraps round and starts handing out index 1,
 * and every one of those goes through `stackedBerth` before it is laid out.
 *
 * So this asks the question along the whole path the running scene actually
 * takes: projectScene seats a crowd, stackedBerth deals each occupant back
 * from the one below it, deskLayout lays the place setting out — and after all
 * three, is the card's foot still on the desk, and is the card still in the
 * room?
 *
 * The depths are the test's own, not the implementation's: a house of nine
 * times its desks is a state the seating will happily produce, and no depth it
 * produces is allowed to put a card through the floor. Reading the supported
 * depth out of the module under test would make this agree with whatever that
 * module does.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const readPng = require('./read-png.cjs');
// MUST come before loadTs of any component — it seeds require.cache for react.
require('./render-hooks.cjs');
const loadTs = require('./load-ts.cjs');

const { deskLayout, stackedBerth, studyRoom } =
  loadTs('src/renderer/src/scene/study/StudyScene.tsx');
const { projectScene } = loadTs('src/renderer/src/scene/study/useSceneState.ts');
const { deskBerths } = loadTs('src/renderer/src/scene/study/roomManifest.ts');

const ASSETS = path.resolve(__dirname, '..', 'src/renderer/src/scene/study/assets');

/** How many times over the house is filled. Nine deep at every desk. */
const TIMES_OVER = 9;

/** Same coarse test the berth probe uses: dark warm wood, not wall or glass. */
const isDeskWood = ([r, g, b]) => r >= b + 20 && 0.299 * r + 0.587 * g + 0.114 * b <= 100;

/** How far below the card's foot the desk is looked for, in panel px. */
const PROBE_DEPTHS = [4, 10, 16, 22];

/** How wide a band under the card's foot has to read as desk. Not all of it:
 *  the desks are painted with an open book and a candlestick standing on them,
 *  so a strip of the surface under any card is legitimately something else. */
const ENOUGH_DESK = 0.7;

/** An agent with only the fields the projection is allowed to look at. */
const agent = (id) => ({
  id,
  name: id.toUpperCase(),
  character: 'jim',
  accent: 'sky',
  description: '',
  project: 'p',
  tmuxTarget: '',
  cwd: '/tmp',
  status: 'idle',
  action: '',
  progress: 0
});

/** Which room each berth belongs to, and the berth itself. */
const seatOf = new Map(
  studyRoom.rooms.flatMap((room) => room.berths.map((berth) => [berth.id, { room, berth }]))
);

/** The berth in its panel's own pixels — the view the paint is measured in. */
const boxOf = ({ room, berth }) => ({
  left: berth.x * room.natural.w,
  top: berth.y * room.natural.h,
  width: berth.w * room.natural.w,
  height: berth.h * room.natural.h
});

/** The house seated nine deep, as places on real berths. */
function crowded() {
  const desks = deskBerths(studyRoom);
  const roster = Array.from({ length: desks.length * TIMES_OVER }, (_, i) => agent(`w-${i}`));
  const scene = projectScene(roster, [], [], 0);
  return scene.agents.map((a) => {
    const seat = seatOf.get(a.berthId);
    assert.ok(seat, `${a.berthId} is a berth in the house`);
    return { ...seat, stackIndex: a.stackIndex, id: a.id };
  });
}

test('a card dealt onto a shared desk still stands on the desk', () => {
  const places = crowded();
  const deepest = Math.max(...places.map((p) => p.stackIndex));
  assert.ok(deepest >= TIMES_OVER - 1, `the house piles ${TIMES_OVER} deep, not ${deepest + 1}`);

  const panels = new Map();
  for (const place of places) {
    if (!panels.has(place.room.image)) {
      panels.set(place.room.image, readPng(path.join(ASSETS, place.room.image)));
    }
    const panel = panels.get(place.room.image);
    const { card } = deskLayout(stackedBerth(boxOf(place), place.stackIndex));
    const where = `${place.room.id}/${place.berth.id}#${place.stackIndex}`;

    assert.ok(card.width > 0 && card.height > 0, `${where}: the card has no size`);

    const foot = card.top + card.height;
    let desk = 0;
    let sampled = 0;
    for (let i = 0; i < 7; i++) {
      const x = card.left + (card.width * (i + 0.5)) / 7;
      for (const depth of PROBE_DEPTHS) {
        sampled++;
        if (isDeskWood(panel.at(x, foot + depth))) desk++;
      }
    }
    assert.ok(
      desk / sampled >= ENOUGH_DESK,
      `${where}: ${Math.round((desk / sampled) * 100)}% of the paint under the card's foot `
      + 'is a desk — a card dealt onto a shared desk has slid off it'
    );
  }
});

test('a card dealt onto a shared desk stays inside its room', () => {
  for (const place of crowded()) {
    const berth = boxOf(place);
    const stacked = stackedBerth(berth, place.stackIndex);
    const { card, book } = deskLayout(stacked);
    const where = `${place.room.id}/${place.berth.id}#${place.stackIndex}`;
    const room = place.room.natural;

    assert.ok(card.left >= 0 && card.top >= 0,
      `${where}: the card is dealt off the top or left of the room`);
    assert.ok(card.left + card.width <= room.w + 0.01,
      `${where}: the card is dealt off the right of the room`);
    assert.ok(card.top + card.height <= room.h + 0.01,
      `${where}: the card is dealt through the floor of the room`);

    // The desk's own surface is the berth's bottom edge, and dealing back must
    // not move it: a pile leans back into the room, it does not sink.
    assert.ok(
      Math.abs((stacked.top + stacked.height) - (berth.top + berth.height)) <= 0.01,
      `${where}: dealing back moved the desk surface itself`
    );
    assert.ok(book.left + book.width <= room.w + 0.01,
      `${where}: the volume beside the card is off the end of the room`);
  }
});
