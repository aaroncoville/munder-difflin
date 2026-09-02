/**
 * Letting go of the floor's GPU resources while nobody can see it.
 *
 * The floor stops its ticker whenever something covers it — a fullscreen
 * terminal, the editor, a hidden window — but keeps the WebGL context, its
 * textures and their GPU shared images alive so that coming back is instant.
 *
 * That is the right trade for a glance away and the wrong one for an afternoon:
 * under memory pressure Chromium purges those shared images, and a canvas
 * pinning them through a two-hour focus session is holding memory nobody is
 * looking at. Reported on v0.4.6 as an apparent hang, with the GPU logging a
 * purge storm behind it.
 *
 * So: keep the resources across a glance, let them go across an afternoon. The
 * only question is which one this is, which is what these pin.
 */
const test = require('node:test');
const assert = require('node:assert');
const load = require('./load-ts.cjs');

const { planFloorRelease, FLOOR_RELEASE_DELAY_MS } =
  load('src/renderer/src/scene/office/floorRelease.ts');

const plan = (covered, released) => planFloorRelease({ covered, released });

test('covering the floor schedules a release rather than performing one', () => {
  // The property the existing design is built on: leaving a fullscreen terminal
  // must be instant. Releasing on the way in would spend a scene rebuild on
  // every toggle, which is the thing this is explicitly not allowed to cost.
  const p = plan(true, false);
  assert.equal(p.action, 'release-after');
});

test('the delay is long enough that ordinary toggling never reaches it', () => {
  // Deliberately a bound, not the constant: asserting equality with
  // FLOOR_RELEASE_DELAY_MS would just restate the implementation and would hold
  // just as well if it were retuned to 50ms, which is the failure that matters.
  assert.ok(plan(true, false).delayMs >= 10_000,
    `a floor released after ${plan(true, false).delayMs}ms would rebuild on a glance away`);
  assert.ok(FLOOR_RELEASE_DELAY_MS >= 10_000);
});

test('a floor uncovered before the delay elapses is never released', () => {
  // Cover, then uncover with the timer still pending: nothing has been released,
  // so there is nothing to restore and nothing left to wait for.
  assert.equal(plan(false, false).action, 'wait');
});

test('uncovering a released floor builds it again', () => {
  assert.equal(plan(false, true).action, 'restore');
});

test('a floor already released stays released while it stays covered', () => {
  // Otherwise every re-render would arm another timer and tear down a scene
  // that is already gone.
  assert.equal(plan(true, true).action, 'wait');
});
