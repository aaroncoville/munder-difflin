'use strict';
/**
 * Berths are held against the paintings they were read off.
 *
 * Every reading berth in `room.json` is a place at a desk somebody painted, and
 * the manifest cannot say so: a berth nudged out over the room's window is a
 * perfectly valid rectangle, and every other test in the tree — the projection,
 * the seating, the stacking — keeps passing while the assistants stand in mid
 * air. The one thing that can tell a desk from a window is the paint under the
 * berth's feet, so that is what is checked here.
 *
 * The probe is deliberately narrow: a short column of pixels straight down from
 * the middle of the berth's bottom edge, which is where the desk has to be for
 * a card to look like it is standing at one. It says nothing about the rest of
 * the rectangle, and it is not a substitute for looking at the room.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const readPng = require('./read-png.cjs');

const ASSETS = path.resolve(__dirname, '..', 'src/renderer/src/scene/study/assets');
const manifest = JSON.parse(fs.readFileSync(path.join(ASSETS, 'room.json'), 'utf8'));

/**
 * Whether a colour is a painted desk rather than wall, glass, sill or daylight.
 *
 * Every desk in the Study is dark warm wood, and the things a berth drifts onto
 * instead are either much brighter (a window, a stone sill, a lit wall), much
 * less red (grey masonry, glass), or much MORE red — a deep oxblood wall is as
 * dark as a desk and warmer than one, and read every panel of the red room as
 * furniture. Wood is warm but nearly grey beside a painted wall: the desks in
 * all four rooms sit between 18 and 43 points of red over green, and the
 * oxblood wall at 90, so the three coarse tests separate them by a wide margin
 * — which is what keeps this from failing over a repaint that only changes the
 * light.
 */
const isDeskWood = ([r, g, b]) =>
  r >= b + 20 && r - g <= 60 && 0.299 * r + 0.587 * g + 0.114 * b <= 100;

/**
 * Whether a colour is the cover of the open book painted on a desk.
 *
 * Every one of them is bound in the same saturated pink, which nothing else in
 * these rooms is: the wood is warm but nearly grey beside it, and the pages
 * above it are near-white. Red well clear of green, with blue coming back up
 * again, is that cover and nothing else in the panel.
 */
const isBookCover = ([r, g, b]) => r > 140 && r - g > 55 && b - g > 10;

/**
 * What counts as finding the desk: its own wood, or the book lying on it.
 *
 * A berth's foot is set on the painted desk surface, and in one room it lands
 * a few pixels inside the volume the painter drew there — which is still a
 * desk, because a book on a wall is not a thing these paintings contain. The
 * probe used to swallow that by accident: the cover's pink passed a rule meant
 * for wood, being both red-over-blue and dark. Now the wood rule is tight
 * enough to refuse pink, so the book has to be named rather than mistaken.
 */
const isDeskSurface = (paint) => isDeskWood(paint) || isBookCover(paint);

/** How far below a berth's bottom edge the desk is looked for, in panel px. */
const PROBE_DEPTHS = [4, 10, 16, 22];

const deskRooms = manifest.rooms.filter((room) => room.kind === 'desk');
const panelOf = (room) => readPng(path.join(ASSETS, room.image));

test('the paintings have a desk under every berth, not a wall or a window', () => {
  assert.ok(deskRooms.length > 0, 'there are reading rooms to check');
  for (const room of deskRooms) {
    const panel = panelOf(room);
    assert.equal(panel.width, room.natural.w, `${room.id}: the manifest has the panel's width`);
    assert.equal(panel.height, room.natural.h, `${room.id}: the manifest has the panel's height`);
    for (const berth of room.berths) {
      const x = (berth.x + berth.w / 2) * panel.width;
      const foot = (berth.y + berth.h) * panel.height;
      for (const depth of PROBE_DEPTHS) {
        const paint = panel.at(x, foot + depth);
        assert.ok(
          isDeskSurface(paint),
          `${room.id}/${berth.id}: ${depth}px under the berth the painting is `
          + `rgb(${paint.join(', ')}), which is not a desk`
        );
      }
    }
  }
});

test('finding a desk under a berth is a fact about that berth, not about the paint', () => {
  // These are wood-paneled rooms: without this, a probe loose enough to call
  // every warm pixel a desk would pass the test above wherever the berths sat,
  // which is the same as not checking them at all.
  for (const room of deskRooms) {
    const panel = panelOf(room);
    let desk = 0;
    let sampled = 0;
    for (let y = 0; y < panel.height; y += 3) {
      for (let x = 0; x < panel.width; x += 3) {
        sampled++;
        if (isDeskWood(panel.at(x, y))) desk++;
      }
    }
    assert.ok(desk / sampled < 0.6,
      `${room.id}: the probe reads ${Math.round((desk / sampled) * 100)}% of the panel as desk, `
      + 'so landing on one says nothing');
  }
});

/** And the leaves above it: near-white, and near enough to neutral that the
 *  room's pink mirror and its lamplit panelling are not mistaken for pages. */
const isPage = ([r, g, b]) =>
  0.299 * r + 0.587 * g + 0.114 * b > 185 && Math.max(r, g, b) - Math.min(r, g, b) < 55;

/** The berths whose painting already has a book lying open at the place. */
const declared = deskRooms.flatMap((room) =>
  room.berths.filter((berth) => berth.volume).map((berth) => ({ room, berth })));

/**
 * A declared volume is the book the painter drew, not a rectangle somebody
 * liked the look of.
 *
 * This is the whole load-bearing claim of the volume: the card is laid out to
 * stop at the volume's top edge, so a volume that is not on the painted book
 * moves the card for nothing and leaves the book covered exactly as before.
 */
test('every declared volume is the open book painted at that place', () => {
  assert.ok(declared.length > 0, 'no berth declares the book painted on its desk');
  for (const { room, berth } of declared) {
    const panel = panelOf(room);
    const v = berth.volume;
    let cover = 0;
    let pages = 0;
    for (let x = v.x * panel.width; x < (v.x + v.w) * panel.width; x += 2) {
      for (let y = v.y * panel.height; y < (v.y + v.h) * panel.height; y += 2) {
        if (isBookCover(panel.at(x, y))) cover++;
        if (y < (v.y + v.h / 2) * panel.height && isPage(panel.at(x, y))) pages++;
      }
    }
    // Both, because either alone has a look-alike in these rooms: the parlour
    // wall carries a pink mirror, and a lit panel or a window is pale.
    assert.ok(cover > 60,
      `${room.id}/${berth.id}: the declared volume covers ${cover} pixels of book cover, `
      + 'so it is a rectangle of wall or desk rather than the painted book');
    assert.ok(pages > 200,
      `${room.id}/${berth.id}: the declared volume has ${pages} pixels of open leaf in its `
      + 'upper half — it is over something pink that is not a book');
  }
});

test('a volume reaches the whole of the book it stands for', () => {
  // A volume short of the paint is worse than no volume: the card would be
  // lifted, and still cover the half of the book that was left out.
  for (const { room, berth } of declared) {
    const panel = panelOf(room);
    const v = berth.volume;
    const near = { x0: (berth.x - 0.06) * panel.width,
      x1: (berth.x + berth.w + 0.06) * panel.width };
    for (let x = Math.max(0, near.x0); x < Math.min(panel.width, near.x1); x++) {
      for (let y = (berth.y + berth.h) * panel.height - 40;
        y < Math.min(panel.height, (berth.y + berth.h) * panel.height + 12); y++) {
        if (!isBookCover(panel.at(x, y))) continue;
        assert.ok(
          x >= v.x * panel.width - 1 && x <= (v.x + v.w) * panel.width + 1
          && y >= v.y * panel.height - 1 && y <= (v.y + v.h) * panel.height + 1,
          `${room.id}/${berth.id}: painted book at (${Math.round(x)}, ${Math.round(y)}) `
          + 'is outside the volume declared for it');
      }
    }
  }
});

test('a berth with no volume has no book painted at it', () => {
  // The other half of the claim: a place setting that declares nothing has to
  // be one the painter left bare, or the card is covering a book unannounced.
  for (const room of deskRooms) {
    const panel = panelOf(room);
    for (const berth of room.berths) {
      if (berth.volume) continue;
      let cover = 0;
      const wide = (berth.x + berth.w + 0.04) * panel.width;
      for (let x = (berth.x - 0.04) * panel.width; x < wide; x++) {
        for (let y = (berth.y + berth.h) * panel.height - 40;
          y < Math.min(panel.height, (berth.y + berth.h) * panel.height + 12); y++) {
          if (isBookCover(panel.at(Math.max(0, x), y))) cover++;
        }
      }
      assert.ok(cover < 40,
        `${room.id}/${berth.id}: ${cover} pixels of painted book at a place that declares none`);
    }
  }
});
