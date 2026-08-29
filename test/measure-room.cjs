'use strict';
/**
 * Reading a room's furniture off the painting, rather than off somebody's eye.
 *
 * Every berth, volume and light point in `room.json` is a normalized rectangle
 * that has to agree with a painting nothing in the tree compares it to. The
 * first four rooms were read by hand, which is fine once and unrepeatable
 * after: when two more rooms were painted, "measured off the panel" was a claim
 * in a summary with no method behind it and nothing that could contradict it.
 *
 * This is the method, so it can be run again and argued with. It finds two
 * things, and it finds them WITHOUT being told where to look — the point is to
 * have a second opinion about the manifest, and a detector handed the answer
 * cannot disagree with it.
 *
 *   - the open book the painter left on each desk, by its cover: every one of
 *     them is bound in the same saturated pink, which nothing else in these
 *     rooms is. Its left edge, its width and its foot — see `volumes` for why
 *     not its top;
 *   - the flames, by the one colour a candle is: bright in red and green and
 *     clearly darker in blue, in a patch narrow enough to be a wick rather than
 *     a lit page.
 *
 * It is also how a new room's numbers are obtained in the first place. The
 * check that it is worth trusting is that it reproduces the four rooms that
 * were read by hand — see `study-room-measure.test.cjs`.
 */
const readPng = require('./read-png.cjs');

/** The pink boards of the open book on a desk, and nothing else in these rooms. */
const isCover = ([r, g, b]) => r > 140 && r - g > 55 && b - g > 10;

/** A flame: the one thing in a room that is bright and distinctly yellow. */
const isFlame = ([r, g, b]) => r > 235 && g > 215 && b < 190 && g - b > 45;

/** Runs of `true` at least `minLength` long, as [start, end] pairs. */
function runs(flags, minLength) {
  const out = [];
  let start = null;
  for (let i = 0; i <= flags.length; i++) {
    if (flags[i] && start === null) start = i;
    else if (!flags[i] && start !== null) {
      if (i - start >= minLength) out.push([start, i - 1]);
      start = null;
    }
  }
  return out;
}

/** Groups of points whose x values are within `gap` of a neighbour's. */
function cluster(points, gap) {
  const out = [];
  let cur = [];
  for (const p of [...points].sort((a, b) => a.x - b.x)) {
    if (cur.length && p.x - cur[cur.length - 1].x > gap) { out.push(cur); cur = []; }
    cur.push(p);
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * The open books painted on the desks, left to right.
 *
 * Three edges, not a rectangle, and that is the honest shape of what a painting
 * will give up. A book's cover is unmistakable — a wide band of that pink, low
 * in the panel — so its LEFT, its WIDTH and its FOOT can be had to within a
 * couple of pixels. Its top cannot: the leaves narrow as they go back, fade
 * into the desk they lie on at different rates in each room, and there is no
 * row where the book stops and the desk starts.
 *
 * Nothing needs that top, which is what makes leaving it out the right answer
 * rather than a shortcut. A declared volume's top is not the paint's: the card
 * standing at that berth rises to it, so the rectangle carries deliberate
 * headroom above the leaves — a different amount in every room, because each
 * was somebody's judgement about how much air a card should clear. That the
 * rectangle CONTAINS the book is a real claim and `study-berth-paint.test.cjs`
 * is where it is made, by sweeping for stray paint outside it.
 *
 * Returning a rectangle with a top this could not measure would have invited
 * exactly the check nobody can write.
 */
function volumes(panel) {
  const { width: W, height: H } = panel;
  const found = [];
  for (let y = Math.round(H * 0.5); y < Math.round(H * 0.75); y++) {
    for (let x = 0; x < W; x++) if (isCover(panel.at(x, y))) found.push({ x, y });
  }
  // One cluster per book. Gathering the cover as POINTS and grouping them,
  // rather than taking rows as they come, is what keeps a cover interrupted by
  // its own clasp or a shadow from being read as two books side by side.
  // Every cluster is returned, including one too small to be a book. A speck of
  // that pink somewhere unexpected should make the count disagree with the plan
  // and send somebody to look at the painting — a filter that quietly dropped it
  // would hide the one thing worth being told.
  return cluster(found, Math.round(W * 0.03))
    .map((c) => {
      const xs = c.map((p) => p.x);
      const left = Math.min(...xs);
      const right = Math.max(...xs);
      return {
        x: (left - 1) / W,
        w: (right - left + 2) / W,
        // The lowest row of cover is the book's front edge, nearest the viewer.
        foot: (Math.max(...c.map((p) => p.y)) + 2) / H
      };
    })
    .sort((a, b) => a.x - b.x);
}

/**
 * The lit candles and windows, left to right, as normalized points.
 *
 * A flame is narrow. The leaves of an open book catch the same light and are
 * the same colour at their brightest, so a patch wider than a wick is a page
 * and is left out — which is why this is measured by shape and not by hue
 * alone.
 */
function lights(panel, { maxWidth = 0.035 } = {}) {
  const { width: W, height: H } = panel;
  const points = [];
  for (let y = Math.round(H * 0.05); y < Math.round(H * 0.8); y++) {
    for (let x = 0; x < W; x++) if (isFlame(panel.at(x, y))) points.push({ x, y });
  }
  return cluster(points, Math.round(W * 0.02))
    .filter((c) => c.length >= 30)
    .filter((c) => {
      const xs = c.map((p) => p.x);
      return (Math.max(...xs) - Math.min(...xs)) / W <= maxWidth;
    })
    .map((c) => ({
      x: c.reduce((s, p) => s + p.x, 0) / c.length / W,
      y: c.reduce((s, p) => s + p.y, 0) / c.length / H
    }))
    .sort((a, b) => a.x - b.x);
}

function measureRoom(file) {
  const panel = readPng(file);
  return { width: panel.width, height: panel.height, volumes: volumes(panel), lights: lights(panel) };
}

module.exports = { measureRoom, volumes, lights, isCover, isFlame };
