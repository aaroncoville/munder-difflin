'use strict';
/**
 * The floor plan's rectangles, held against the paintings they were read off.
 *
 * Four of the rooms had their numbers read by hand. When two more were painted
 * the numbers came from a script instead, and "measured off the panel, to
 * within two thousandths" went into a summary with no method in the tree and
 * nothing that could contradict it. A claim no test can break is a claim
 * nobody is keeping — so here is the method, and here is what it actually
 * supports.
 *
 * `measure-room.cjs` is not told where to look. It finds every painted book by
 * its cover and every flame by its colour and its narrowness, over the whole
 * panel, so that it can DISAGREE with the manifest. A detector handed the
 * answer would agree with anything.
 *
 * What it establishes, and what it does not:
 *
 *   - a declared volume's LEFT EDGE and WIDTH are the painted book's, and its
 *     FOOT is the book's front edge. Those three are measurements and they hold
 *     across every reading room in the house;
 *   - a declared volume's TOP is neither measured nor claimed. The card standing
 *     at that berth rises to it, so the rectangle carries deliberate headroom
 *     above the leaves — a different amount in every room, because each was
 *     somebody's judgement about how much air a card should clear. That the
 *     rectangle CONTAINS the book is a real claim, and
 *     `study-berth-paint.test.cjs` is where it is made;
 *   - every candle the painting lights has a light point declared on it. Not
 *     the converse: a window is a light in the plan and is nothing like a flame
 *     to look at, so the plan may name more lights than this can find.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { measureRoom } = require('./measure-room.cjs');

const ASSETS = path.resolve(__dirname, '..', 'src/renderer/src/scene/study/assets');
const manifest = JSON.parse(fs.readFileSync(path.join(ASSETS, 'room.json'), 'utf8'));
const deskRooms = manifest.rooms.filter((room) => room.kind === 'desk');
const measured = new Map(
  deskRooms.map((room) => [room.id, measureRoom(path.join(ASSETS, room.image.replace('./', '')))]));

/** What a measurement is allowed to differ from the plan by, as a fraction of
 *  the panel. Two thousandths is about three pixels across a 1568px panel. */
const TOL = 0.002;
/** A flame is a soft blob, so its centre is a rounder number than an edge. */
const TOL_LIGHT = 0.008;

test('the measurer finds exactly the books the plan declares', () => {
  assert.ok(deskRooms.length >= 4, 'there are reading rooms to measure');
  for (const room of deskRooms) {
    const declared = room.berths.filter((b) => b.volume);
    assert.equal(measured.get(room.id).volumes.length, declared.length,
      `${room.id}: the painting has ${measured.get(room.id).volumes.length} books on its desks `
      + `and the plan declares ${declared.length}`);
  }
});

/** How far a declared rectangle is from the painted book, on the three edges
 *  it takes from the paint. */
const offBy = (declared, painted) => ({
  x: Math.abs(painted.x - declared.x),
  w: Math.abs(painted.w - declared.w),
  foot: Math.abs(painted.foot - (declared.y + declared.h))
});

test('a declared volume sits on the painted book, edge for edge', () => {
  // The claim the summary made, made checkable. Left, width and foot — the
  // three the rectangle takes from the paint.
  const worst = { x: 0, w: 0, foot: 0 };
  for (const room of deskRooms) {
    const found = measured.get(room.id).volumes;
    const declared = room.berths.filter((b) => b.volume).map((b) => b.volume);
    declared.forEach((v, i) => {
      const d = offBy(v, found[i]);
      for (const key of ['x', 'w', 'foot']) {
        worst[key] = Math.max(worst[key], d[key]);
        assert.ok(d[key] <= TOL,
          `${room.id} volume ${i}: declared ${key} is ${d[key].toFixed(4)} off the painted `
          + 'book, which is more than a measurement');
      }
    });
  }
  // Printed as the record of what the method is worth, so a later change that
  // quietly loosens it has to explain itself.
  assert.ok(worst.x < TOL && worst.w < TOL && worst.foot < TOL,
    `worst seen: x ${worst.x.toFixed(4)}, w ${worst.w.toFixed(4)}, foot ${worst.foot.toFixed(4)}`);
});

test('every candle the painting lights has a light point declared on it', () => {
  for (const room of deskRooms) {
    const flames = measured.get(room.id).lights;
    assert.ok(flames.length >= 2, `${room.id}: found ${flames.length} candles`);
    for (const flame of flames) {
      const near = room.lightPoints.some((p) =>
        Math.abs(p.x - flame.x) <= TOL_LIGHT && Math.abs(p.y - flame.y) <= TOL_LIGHT);
      assert.ok(near,
        `${room.id}: a candle burns at (${flame.x.toFixed(3)}, ${flame.y.toFixed(3)}) `
        + 'with no light point on it');
    }
  }
});

test('the measurer would notice if a rectangle were moved', () => {
  // The tolerance has to be tight enough to catch a real slip, or the check
  // above passes for any plan at all. So it is run against a plan that IS
  // wrong: one book nudged a hundredth of the panel sideways — fifteen pixels,
  // about a tenth of a book — and every edge must be seen to be off.
  const room = deskRooms[0];
  const painted = measured.get(room.id).volumes[0];
  const honest = room.berths.filter((b) => b.volume)[0].volume;
  assert.ok(offBy(honest, painted).x <= TOL, 'the shipped rectangle is on the book');

  const nudged = { ...honest, x: honest.x + 0.01, y: honest.y + 0.01 };
  const off = offBy(nudged, painted);
  assert.ok(off.x > TOL, `a book moved sideways reads as ${off.x.toFixed(4)} off, within tolerance`);
  assert.ok(off.foot > TOL, `a book moved down reads as ${off.foot.toFixed(4)} off, within tolerance`);
});
