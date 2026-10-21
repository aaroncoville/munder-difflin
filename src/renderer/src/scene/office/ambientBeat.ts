/**
 * One clock for the floor's ambient animations.
 *
 * The floor draws only when something changed (renderOnChange.ts), and on a
 * software GPU every draw is a full Canvas2D rasterisation of the scene, so
 * what decides the idle cost of the floor is how often its ambient effects —
 * the monitors' screen-life, the steam off a parked coffee, the ASK ME
 * board's attention pulse — touch the scene graph. Each used to run off its
 * own per-tick timer and redraw whatever the tick brought, so one lit monitor
 * or one cooling cup kept a 15 fps floor drawing fifteen times a second.
 * DeskScreen.ts moved the monitors onto a shared 4 Hz beat: redraw only when
 * the beat moved, and every monitor on the same tick. This is that beat,
 * lifted out so the other ambient effects step on the same one — at most
 * BEATS_PER_SECOND draws a second for all of them together, never one each on
 * different ticks.
 *
 * The floor advances the clock once per tick, before it updates anything that
 * reads it, and starts it over for each scene it builds. The clock only ever
 * moves with the ticker, so a paused floor resumes its effects where they
 * stopped, like everything else on it.
 *
 * The beat is kept as an integer with a bounded remainder rather than read
 * off a float sum: 150 ticks of 1/15 s add up to 9.999999999999984, which a
 * floor(clock / BEAT_S) would call beat 39 at the ten-second mark. A tick
 * that lands within EPSILON of the next beat rolls over to it.
 */

/** How often the ambient effects may redraw, together. */
export const BEATS_PER_SECOND = 4;
/** The beat's length in seconds. */
export const BEAT_S = 1 / BEATS_PER_SECOND;
/** How close to the next beat a tick may land and count as on it. */
const EPSILON = 1e-9;

/** The frame of an ambient effect that is holding still (ambientFrame):
 *  below any beat and below the "never drawn" marker (-1) an effect starts
 *  with, so the next animated beat is a change. */
export const STILL_FRAME = -2;

let beat = 0;
/** Seconds into the current beat, in [0, BEAT_S). */
let remainder = 0;

/** Advance the shared clock by a tick's `dt` seconds. */
export function advanceAmbientClock(dt: number): void {
  if (!(dt > 0)) return;
  remainder += dt;
  while (remainder >= BEAT_S - EPSILON) {
    remainder -= BEAT_S;
    beat += 1;
  }
  if (remainder < 0) remainder = 0;
}

/** The shared clock, in seconds. */
export function ambientClock(): number {
  return beat * BEAT_S + remainder;
}

/** Which beat the clock is on: a step function of the clock, so two reads
 *  within the same beat agree and an effect that redraws only when this
 *  changes redraws at most BEATS_PER_SECOND times a second. */
export function ambientBeat(): number {
  return beat;
}

/** The clock, quantised to the start of the current beat — the time an
 *  effect should draw for, so its frame is a function of the beat alone. */
export function ambientBeatTime(): number {
  return beat * BEAT_S;
}

/** The frame an ambient effect should show: the beat while it animates,
 *  STILL_FRAME while it holds. An effect that redraws only when this changes
 *  draws at most BEATS_PER_SECOND times a second animated, and once when it
 *  stops. */
export function ambientFrame(animate: boolean): number {
  return animate ? beat : STILL_FRAME;
}

/** Start the clock over: the floor does this for every scene it builds, so a
 *  rebuilt floor (theme change, renderer recovery, release and restore) does
 *  not inherit the last one's phase. */
export function resetAmbientClock(): void {
  beat = 0;
  remainder = 0;
}
