'use strict';
/**
 * A place setting is held against the desk it is laid on.
 *
 * `study-berth-paint` checks the BERTH: that the rectangle the manifest gives
 * an assistant has a painted desk under its bottom edge. That is necessary and
 * it is not sufficient, because nothing inside the berth has to reach the
 * bottom of it — the card was drawn in the top 78% of the place setting, so a
 * berth resting perfectly on a desk still put the card a hand's width above it,
 * and the taller the berth the further it floated. The god's study is the worst
 * of them: the grandest seat in the house, and the only card in the room, at a
 * desk it does not touch.
 *
 * So this asks the question the other test cannot: not "is there a desk under
 * the berth" but "is there a desk under the CARD".
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const readPng = require('./read-png.cjs');
const loadTs = require('./load-ts.cjs');

const { deskLayout } = loadTs('src/renderer/src/scene/study/StudyScene.tsx');

const ASSETS = path.resolve(__dirname, '..', 'src/renderer/src/scene/study/assets');
const manifest = JSON.parse(fs.readFileSync(path.join(ASSETS, 'room.json'), 'utf8'));

/** Same coarse test the berth probe uses: dark warm wood, not wall or glass. */
const isDeskWood = ([r, g, b]) => r >= b + 20 && 0.299 * r + 0.587 * g + 0.114 * b <= 100;

/** How far below the card's foot the desk is looked for, in panel px. */
const PROBE_DEPTHS = [4, 10, 16, 22];

/** Every seat in the house: the reading berths, and the god's. */
const seated = manifest.rooms
  .filter((room) => room.kind === 'desk' || room.kind === 'godStudy')
  .flatMap((room) => room.berths.map((berth) => ({ room, berth })));

/** A berth as the scene lays it out, in the panel's own pixels. */
const placeOf = ({ room, berth }) => deskLayout({
  left: berth.x * room.natural.w,
  top: berth.y * room.natural.h,
  width: berth.w * room.natural.w,
  height: berth.h * room.natural.h
});

/** How wide a band under the card's foot has to read as desk. Not all of it:
 *  the desks are painted with an open book and a candlestick standing on them,
 *  so a strip of the surface under any card is legitimately something else. */
const ENOUGH_DESK = 0.7;

test('the card stands ON the desk, not above it', () => {
  assert.ok(seated.length > 0, 'there are seats to check');
  for (const seat of seated) {
    const panel = readPng(path.join(ASSETS, seat.room.image));
    const { card } = placeOf(seat);
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
      `${seat.room.id}/${seat.berth.id}: ${Math.round((desk / sampled) * 100)}% of the paint `
      + "under the CARD's foot is a desk — the card is floating above one"
    );
  }
});

test('the book keeps its own place, clear of the card and inside the berth', () => {
  // The book used to be drawn UNDER the card, which is what left the card in
  // the air: the bottom fifth of every place setting was reserved for it. With
  // the card standing on the desk the book has to move beside it, and the two
  // must not end up as one pile.
  for (const seat of seated) {
    const desk = {
      left: seat.berth.x * seat.room.natural.w,
      top: seat.berth.y * seat.room.natural.h,
      width: seat.berth.w * seat.room.natural.w,
      height: seat.berth.h * seat.room.natural.h
    };
    const { card, book } = deskLayout(desk);
    const where = `${seat.room.id}/${seat.berth.id}`;
    assert.ok(book.left >= card.left + card.width, `${where}: the book is drawn over the card`);
    assert.ok(book.left + book.width <= desk.left + desk.width + 0.01,
      `${where}: the book hangs off the end of the desk`);
    assert.ok(book.top + book.height <= desk.top + desk.height + 0.01,
      `${where}: the book has fallen through the desk`);
    assert.ok(book.width > 0 && book.height > 0, `${where}: the book has no size`);
  }
});
