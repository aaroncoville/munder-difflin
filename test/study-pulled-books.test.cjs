'use strict';
/**
 * The ring that says which book is under your hand.
 *
 * The shelf wall had it first. It is now shared with the card table's felt, the
 * piles waiting on a desk, and the open book somebody is reading — one
 * implementation, because four rings would diverge the first time anybody tuned
 * one of them.
 *
 * Two things have to hold for that to be a refactor rather than a redesign: the
 * wall must be drawn exactly as it was, and the rule that generalises the ring
 * must be a no-op there rather than a coincidence nobody checked.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
require('./render-hooks.cjs');
const loadTs = require('./load-ts.cjs');

const P = loadTs('src/renderer/src/scene/study/pulledBooks.ts');
const { bookSlot } = loadTs('src/renderer/src/scene/study/shelfBooks.ts');

/* ---- the rule the ring is measured by ------------------------------------ */

test('the ring is measured from the book’s smaller side', () => {
  // A spine standing on a shelf is narrow and tall; a book lying open on a desk
  // is wide and shallow. Measuring from the smaller side gives both the same
  // ring for the same apparent thickness — measuring from the width would put a
  // ring a third of the way across an open book.
  const standing = P.pullRing({ width: 20, height: 90 });
  const lying = P.pullRing({ width: 90, height: 20 });
  assert.equal(standing, lying, 'a book gets a different ring for lying down');
  assert.match(standing, /^0 0 0 [\d.]+px var\(--cth-gilt\)$/, standing);
  // Outset, not inset: an inset ring is drawn under whatever the piece carries.
  assert.ok(!standing.includes('inset'), 'the ring is drawn under the book’s own art');
});

test('the ring never vanishes on a book drawn very small', () => {
  // The house is letterboxed, so a proportional ornament can round to nothing.
  assert.match(P.pullRing({ width: 2, height: 1 }), /^0 0 0 1px /);
});

test('the shelf wall is drawn exactly as it was', () => {
  // The generalisation is only a refactor if it changes no shelf mark. Every
  // slot on the wall is narrower than it is tall, so the smaller side IS the
  // width the wall always used — asserted here rather than assumed, because it
  // is a fact about the shelf geometry that a future re-shelving could break.
  const view = { x: 0, y: 0, w: 1568, h: 672 };
  let checked = 0;
  for (let i = 0; i < 200; i++) {
    const box = bookSlot(i, view);
    if (!box || !(box.width > 0)) continue;
    checked++;
    assert.ok(box.width < box.height,
      `shelf slot ${i} is ${box.width}×${box.height} — wider than it is tall, so the ring `
      + 'the wall used to draw and the one it draws now are no longer the same');
    assert.equal(
      P.pullRing(box),
      `0 0 0 ${Math.max(1, box.width * 0.14)}px var(--cth-gilt)`,
      `shelf slot ${i} would be ringed differently than before`,
    );
  }
  assert.ok(checked >= 100, `only ${checked} shelf slots checked`);
});

/* ---- the two hands ------------------------------------------------------- */

test('a hand only ever lets go of the book it was on', () => {
  // The pointer crossing from one spine to the next fires the leave of the old
  // and the enter of the new, in an order nothing here controls.
  const on1 = P.pullBook(P.NOTHING_PULLED, 'T-1', 'hover', true);
  const moved = P.pullBook(P.pullBook(on1, 'T-2', 'hover', true), 'T-1', 'hover', false);
  assert.ok(P.bookIsPulled(moved, 'T-2'), 'a stale leave cleared the book just entered');
  assert.ok(!P.bookIsPulled(moved, 'T-1'));
});

test('the pointer and the keyboard hold books independently', () => {
  const both = P.pullBook(P.pullBook(P.NOTHING_PULLED, 'T-1', 'focus', true), 'T-1', 'hover', true);
  assert.ok(P.bookIsPulled(P.pullBook(both, 'T-1', 'hover', false), 'T-1'),
    'letting go with the pointer dropped a book the keyboard still holds');
});

test('a surface that tracks no hands is given no handlers', () => {
  // A volume in flight is scenery. It should not be reporting where the
  // pointer is, and it should not be a hand's business that it exists.
  assert.deepEqual(Object.keys(P.pullHands('T-1', P.NOTHING_PULLED)), []);
  const hands = Object.keys(P.pullHands('T-1', P.NOTHING_PULLED, () => {}));
  assert.deepEqual(hands.sort(), ['onBlur', 'onFocus', 'onMouseEnter', 'onMouseLeave'],
    'the keyboard does not reach the ring on the same terms as the pointer');
});
