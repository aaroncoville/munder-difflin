/**
 * Frame-rate independence for the per-frame constants the floor was tuned at.
 *
 * The scene was written against a 60 Hz ticker, and two of its knobs are
 * per-FRAME rather than per-second: the camera's lerp (`currentX += (target -
 * current) * 0.08` every tick) and the café's "strike up a chat" roll
 * (`Math.random() < 0.004` every tick). Everything else already integrates
 * `dt`. Those two are what changed when officeMotion.ts capped the ticker at
 * 15 fps: a pan took four times the wall time and table-mates chatted a
 * quarter as often, so "reduced" was quietly a different simulation.
 *
 * The fix is the same for both: a per-frame rate `p` applied once per 60 Hz
 * frame has, over `dt` seconds, the compound effect `1 - (1 - p) ^ (dt * 60)`.
 * Applied once per tick with the tick's real `dt`, a lerp covers the same
 * ground per second and a roll fires with the same probability per second at
 * 15, 60 or 144 fps. Pinned in test/office-frame-rate.test.cjs.
 */

/** The frame rate the per-frame constants were tuned at. */
export const REFERENCE_FPS = 60;

/** The effect, over `dt` seconds, of a per-frame rate tuned at REFERENCE_FPS. */
function compound(perFrame: number, dt: number): number {
  if (!(dt > 0)) return 0;
  return 1 - (1 - perFrame) ** (dt * REFERENCE_FPS);
}

/** The lerp factor to use this tick, given the per-60Hz-frame factor. */
export const smoothingFactor = compound;

/** The chance to use this tick, given the per-60Hz-frame chance. */
export const perTickChance = compound;

/** How many frames' worth of a per-frame IMPULSE lands over `dt` seconds when
 *  something else decays what is left of each one by `decay` per frame — the
 *  camera nudge, pushed against the camera's own lerp. One frame at a time the
 *  impulses add up as the geometric sum 1 + (1-d) + (1-d)² + … over the tick's
 *  frames, which is (1 - (1-d)^n) / d. That is exactly 1 at the reference rate
 *  (today's behaviour, untouched) and a little under n at a slower one, which
 *  is what "the same push, applied per frame" comes to; plain n (velocity ×
 *  dt) overshoots by the decay the finer steps would have applied between
 *  pushes — ~10% at 15 fps for the nudge. With no decay it is n itself. */
export function effectiveFrames(decay: number, dt: number): number {
  if (!(dt > 0)) return 0;
  const n = dt * REFERENCE_FPS;
  if (!(decay > 0)) return n;
  return (1 - (1 - decay) ** n) / decay;
}
