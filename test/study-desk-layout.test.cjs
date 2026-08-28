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

test('the card stands in the middle of its place setting, where the chair is', () => {
  // A berth is one seat at one desk: it was read off the painting by putting a
  // box round a chair and the surface in front of it, so the middle of the box
  // is the middle of the seat. The card was centred in the LEFT 62% of it
  // instead — the share reserved for the card while the book took the rest —
  // which stood every assistant in the house a card's width to the left of the
  // chair they are sitting in.
  for (const seat of seated) {
    const desk = {
      left: seat.berth.x * seat.room.natural.w,
      top: seat.berth.y * seat.room.natural.h,
      width: seat.berth.w * seat.room.natural.w,
      height: seat.berth.h * seat.room.natural.h
    };
    const { card } = deskLayout(desk);
    const where = `${seat.room.id}/${seat.berth.id}`;
    assert.ok(Math.abs((card.left + card.width / 2) - (desk.left + desk.width / 2)) < 0.01,
      `${where}: the card is ${Math.round((card.left + card.width / 2)
        - (desk.left + desk.width / 2))}px off the middle of its setting`);
    assert.ok(card.left >= desk.left - 0.01 && card.left + card.width <= desk.left + desk.width + 0.01,
      `${where}: the card hangs off the end of its setting`);
  }
});

test('the book lies flat, and keeps a hand of clear desk at both ends', () => {
  // Wider than tall, because that is a book lying open on a table rather than
  // one standing on a shelf — and clear of BOTH ends of the setting: a berth is
  // read out to the corner of its desk, so a book flush with the far end of it
  // is a book over the edge of the desk. The god's study is where that showed.
  for (const seat of seated) {
    const desk = {
      left: seat.berth.x * seat.room.natural.w,
      top: seat.berth.y * seat.room.natural.h,
      width: seat.berth.w * seat.room.natural.w,
      height: seat.berth.h * seat.room.natural.h
    };
    const { card, book } = deskLayout(desk);
    const where = `${seat.room.id}/${seat.berth.id}`;
    assert.ok(book.width > book.height,
      `${where}: the book is ${Math.round(book.width)}×${Math.round(book.height)}, which is a book `
      + 'stood on its end');
    assert.ok(book.left > card.left + card.width, `${where}: the book touches the card`);
    assert.ok(book.left + book.width < desk.left + desk.width - 0.01,
      `${where}: the book is flush with the far corner of the desk`);
  }
});
