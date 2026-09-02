/**
 * When the covered floor should let go of its GPU resources.
 *
 * The floor already stops its ticker whenever something covers it, and keeps the
 * WebGL context, textures and scene graph alive so that coming back is instant
 * (see OfficeFloor's `paused`). That is the right trade for a glance away and
 * the wrong one for an afternoon: a stopped context still pins its canvas
 * backing store and its textures' GPU shared images, and Chromium purges those
 * under memory pressure — leaving the canvas referencing mailboxes that no
 * longer exist.
 *
 * So the trade is narrowed rather than reversed: keep the resources across a
 * glance, let them go across an afternoon. Below the delay nothing changes at
 * all; above it the scene is torn down and rebuilt on the way back, the same
 * rebuild a theme change or a context loss already performs.
 *
 * Kept as a pure decision, separate from the component, so which case this is
 * can be tested without a browser, a GPU or Pixi — same reasoning as
 * glRecovery.ts next door.
 */

/** How long the floor stays covered before its resources are released.
 *
 *  A minute is far longer than any toggle — glancing at a fullscreen terminal
 *  and coming back never approaches it, so the instant-return property is
 *  untouched — and far shorter than the sessions that motivated this, which run
 *  for hours. Retune here; nothing else reads the number. */
export const FLOOR_RELEASE_DELAY_MS = 60_000;

export type FloorReleasePlan =
  /** Still covered and still holding: arm the release. */
  | { action: 'release-after'; delayMs: number }
  /** Uncovered with nothing on the GPU: build the scene again. */
  | { action: 'restore' }
  /** Nothing to do — already released and still covered, or holding and visible. */
  | { action: 'wait' };

export function planFloorRelease(
  state: { covered: boolean; released: boolean },
  delayMs: number = FLOOR_RELEASE_DELAY_MS
): FloorReleasePlan {
  if (state.covered) {
    // Already released: say so rather than arming a second timer to tear down a
    // scene that is not there.
    return state.released ? { action: 'wait' } : { action: 'release-after', delayMs };
  }
  return state.released ? { action: 'restore' } : { action: 'wait' };
}
