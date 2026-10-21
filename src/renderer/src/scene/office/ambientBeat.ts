/**
 * One clock for the floor's ambient animations.
 *
 * The floor draws only when something changed (renderOnChange.ts), and on a
 * software GPU every draw is a full Canvas2D rasterisation of the scene, so
 * what decides the idle cost of the floor is how often its ambient effects —
 * the monitors' screen-life, the steam off a parked coffee — touch the scene
 * graph. Each used to run off its own per-tick timer and redraw whatever the
 * tick brought, so one lit monitor or one cooling cup kept a 15 fps floor
 * drawing fifteen times a second. DeskScreen.ts moved the monitors onto a
 * shared 4 Hz beat: redraw only when the beat moved, and every monitor on the
 * same tick. This is that beat, lifted out so the other ambient effects step
 * on the same one — at most BEATS_PER_SECOND draws a second for all of them
 * together, never one each on different ticks.
 *
 * The floor advances the clock once per tick, before it updates anything that
 * reads it. The clock only ever moves with the ticker, so a paused floor
 * resumes its effects where they stopped, like everything else on it.
 */

/** How often the ambient effects may redraw, together. */
export const BEATS_PER_SECOND = 4;
/** The beat's length in seconds. */
export const BEAT_S = 1 / BEATS_PER_SECOND;

let clock = 0;

/** Advance the shared clock by a tick's `dt` seconds. */
export function advanceAmbientClock(dt: number): void {
  clock += dt;
}

/** The shared clock, in seconds. */
export function ambientClock(): number {
  return clock;
}

/** Which beat the clock is on: a step function of the clock, so two reads
 *  within the same beat agree and an effect that redraws only when this
 *  changes redraws at most BEATS_PER_SECOND times a second. */
export function ambientBeat(): number {
  return Math.floor(clock / BEAT_S);
}

/** The clock, quantised to the start of the current beat — the time an
 *  effect should draw for, so its frame is a function of the beat alone. */
export function ambientBeatTime(): number {
  return ambientBeat() * BEAT_S;
}

/** For tests: start the clock over. */
export function resetAmbientClock(): void {
  clock = 0;
}
