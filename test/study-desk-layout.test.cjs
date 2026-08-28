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

const { deskLayout, volumeBox, stackedBerth, STACK_DEEPEST } =
  loadTs('src/renderer/src/scene/study/StudyScene.tsx');

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

/** The berth's own rectangle, in the panel's own pixels. */
const boxOf = ({ room, berth }) => ({
  left: berth.x * room.natural.w,
  top: berth.y * room.natural.h,
  width: berth.w * room.natural.w,
  height: berth.h * room.natural.h
});

/** The book the painting put on that desk, in the panel's own pixels — or null. */
const volumeOf = ({ room, berth }) =>
  volumeBox(berth, { x: 0, y: 0, w: room.natural.w, h: room.natural.h });

/** A berth as the scene lays it out, in the panel's own pixels. */
const placeOf = (seat) => deskLayout(boxOf(seat), volumeOf(seat));

/** Do two boxes share any area? Edges that meet do not — a card whose foot is
 *  exactly on the volume's top edge is standing behind it, and the arithmetic
 *  that puts it there lands a fraction of a pixel either side of true. */
const TOUCHING = 0.01;
const overlaps = (a, b) =>
  a.left < b.left + b.width - TOUCHING && b.left < a.left + a.width - TOUCHING
  && a.top < b.top + b.height - TOUCHING && b.top < a.top + a.height - TOUCHING;

/** How wide a band under the card's foot has to read as desk. Not all of it:
 *  the desks are painted with an open book and a candlestick standing on them,
 *  so a strip of the surface under any card is legitimately something else. */
const ENOUGH_DESK = 0.7;

test('the card stands ON the desk, not above it', () => {
  assert.ok(seated.length > 0, 'there are seats to check');
  for (const seat of seated) {
    const panel = readPng(path.join(ASSETS, seat.room.image));
    const { card } = placeOf(seat);
    // The setting's foot, which is the painted desk surface. Where the painter
    // left an open book there, the card stops at the book's top edge instead —
    // so the desk is looked for under the SETTING, in the card's own x-span.
    const foot = boxOf(seat).top + boxOf(seat).height;
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
    const desk = boxOf(seat);
    const { card, book } = deskLayout(desk, volumeOf(seat));
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
    const desk = boxOf(seat);
    const { card } = deskLayout(desk, volumeOf(seat));
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
    const desk = boxOf(seat);
    const { card, book } = deskLayout(desk, volumeOf(seat));
    const where = `${seat.room.id}/${seat.berth.id}`;
    assert.ok(book.width > book.height,
      `${where}: the book is ${Math.round(book.width)}×${Math.round(book.height)}, which is a book `
      + 'stood on its end');
    assert.ok(book.left > card.left + card.width, `${where}: the book touches the card`);
    assert.ok(book.left + book.width < desk.left + desk.width - 0.01,
      `${where}: the book is flush with the far corner of the desk`);
  }
});

/**
 * The card stands BEHIND the book the painter already put on the desk.
 *
 * Aaron: *"Cards are centered at the desks now (but they do cover the book)."*
 * Centring them at the chair — which is where an assistant sitting at that desk
 * would be — put every card down on top of the open volume the painting has
 * lying at exactly that spot, because the painter drew the book in front of the
 * chair for the same reason.
 *
 * Beside it is not available: the card is wider than the desk left either side
 * of the book, so sliding it clear would move it off its own chair. Standing
 * the card behind the volume is: its foot rises to the volume's top edge, which
 * is a lift of about a tenth of the setting, and the book then reads as lying
 * open in front of the portrait rather than under it.
 */
test('the card clears the book the painting already put on the desk', () => {
  const withVolume = seated.filter((seat) => seat.berth.volume);
  assert.ok(withVolume.length > 0, 'no seat in the house has a painted book to clear');
  for (const seat of withVolume) {
    const volume = volumeOf(seat);
    const { card, book } = placeOf(seat);
    const where = `${seat.room.id}/${seat.berth.id}`;
    assert.ok(!overlaps(card, volume),
      `${where}: the card is drawn over the book the painting put on the desk`);
    assert.ok(!overlaps(book, volume),
      `${where}: the desk book is laid on top of the painted one`);
    // ...and it is a lift, not a retreat to the far side of the desk: the card
    // stays on the chair it was centred on.
    assert.ok(Math.abs((card.left + card.width / 2) - (seat.berth.x + seat.berth.w / 2)
      * seat.room.natural.w) < 0.01, `${where}: the card left its chair to clear the book`);
    assert.ok(card.height > boxOf(seat).height * 0.8,
      `${where}: clearing the book cost the card ${Math.round(
        100 - (card.height / boxOf(seat).height) * 100)}% of its height`);
  }
});

test('a card sharing a desk clears the painted book too, however deep it sits', () => {
  // Every occupant of a shared desk stands on the same surface — that is what
  // holding the far corner still buys — so every one of them meets the same
  // book. A clearance applied to the first card only would put the second
  // straight back on top of it.
  for (const seat of seated.filter((s) => s.berth.volume)) {
    const volume = volumeOf(seat);
    for (let depth = 0; depth <= STACK_DEEPEST; depth++) {
      const { card } = deskLayout(stackedBerth(boxOf(seat), depth), volumeOf(seat));
      assert.ok(!overlaps(card, volume),
        `${seat.room.id}/${seat.berth.id}: the card ${depth} back covers the painted book`);
    }
  }
});
